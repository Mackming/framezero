/**
 * offscreen.js — the engine host.
 *
 * Owns the live Stockfish instance and does nothing else: it relays raw UCI
 * text in both directions. All UCI semantics (position / go / bestmove parsing)
 * live in background.js.
 *
 * TWO KINDS OF ENGINE BEHIND ONE INTERFACE
 * ----------------------------------------
 * The builds in engine/ are not loaded the same way — lib/engines.js has the
 * full account. One kind is a Web Worker you postMessage UCI strings to; the
 * other is an ES module you await, hand a neural net to, and drive through
 * method calls. Everything past `bringUp()` is written against `link`
 * ({ send, dispose }) exactly so that the rest of this file — and the whole of
 * background.js — never has to know which one is running.
 *
 * Both kinds self-host their pthread workers, and both derive the `.wasm` path
 * from the script URL, so each build's two files must stay side by side in
 * engine/.
 */

/**
 * The engine catalogue, loaded on demand.
 *
 * This file is a classic script (see offscreen.html), so it cannot use a
 * top-level `import`. That is no loss: the module builds have to be brought in
 * with a dynamic `import()` anyway, so the machinery is needed regardless.
 */
let cataloguePromise = null;
const catalogue = () => (cataloguePromise ??= import(chrome.runtime.getURL('lib/engines.js')));

/** Which engine the user picked. background.js sends the real value at startup. */
let selectedEngine = null;

/**
 * Transposition table size, in MB. Raised again now that the prewarm exists:
 * the table is the mechanism by which work done on the opponent's clock reaches
 * our own search, so a table still large enough to hold that subtree when the
 * reply lands is what makes the warm-up pay. Stockfish's own default is 16,
 * which is very small for anything but a blitz-length search — the engine spends the
 * back half of a long think re-deriving positions it already evaluated and
 * evicted. The wasm module declares an initial linear memory of 128 MB and a
 * 2 GB ceiling, so it has room to grow into this; the cost is that the
 * offscreen document's resident size goes up by roughly this much and stays
 * there for as long as the engine is alive. That trade is only reasonable
 * because the engine no longer *stays* alive indefinitely — background.js
 * tears the whole document down once it has been idle for a while.
 */
const HASH_MB = 512;

/**
 * How many search threads to ask for.
 *
 * Real shared memory is required, so both gates are checked:
 * `SharedArrayBuffer` has existed as a global since long before it was usable,
 * and what actually decides whether a *shared* WebAssembly.Memory can be
 * created is `crossOriginIsolated`. Without both, the threaded build cannot
 * instantiate at all and there is no point trying it.
 *
 * One core is deliberately left alone. This document shares the machine with
 * the Lichess tab, the content script reading the board and the debugger
 * dispatching clicks; a saturated machine makes those slower, which shows up
 * as latency on exactly the path this extension spent its effort making fast.
 */
const MAX_THREADS = 8;

/**
 * Ceiling the chosen CPU mode imposes, set from background.js.
 *
 * Starts permissive because the engine is brought up before anything can tell
 * this document which mode is selected; background.js sends the real cap as
 * soon as the handshake completes.
 */
let threadCap = MAX_THREADS;

const coreCount = () => navigator.hardwareConcurrency || 2;

const sharedMemoryAvailable = () =>
  typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated === true;

function threadBudget() {
  if (!sharedMemoryAvailable()) return 1;
  return Math.max(1, Math.min(threadCap, coreCount() - 1, MAX_THREADS));
}

/**
 * Options have to be sent in the window between `uciok` and `isready`: before
 * `uciok` the engine has not declared them yet, and after `readyok` Stockfish
 * has already sized the transposition table, so a later `setoption name Hash`
 * forces a reallocation mid-session. This is also why option setup lives here
 * rather than in background.js with the rest of the UCI logic — only the side
 * driving the handshake can place a command inside that window.
 */
function engineOptions(threads) {
  const options = [`setoption name Hash value ${HASH_MB}`];
  // Sending `Threads 1` is harmless but noise; the single build ignores it.
  if (threads > 1) options.push(`setoption name Threads value ${threads}`);
  return options;
}

/**
 * The live engine, whichever kind it is.
 *
 * `send` takes one UCI line. `dispose` is best-effort by design: a Worker can
 * be terminated outright, but a module build spawns pthread workers it owns and
 * offers no teardown beyond `quit` — which is acceptable only because
 * background.js reclaims the memory by destroying this whole document rather
 * than by asking the engine nicely.
 *
 * @type {{send: (cmd: string) => void, dispose: () => void, script: string}|null}
 */
let link = null;
let readyPromise = null;

/** Which build is actually live, and on how many threads. Reported upstream. */
let engineInfo = {
  script: null, engineId: null, label: null, tag: null, threads: 1, shared: false, cores: 0
};

/**
 * Whether to drop `info` lines.
 *
 * background.js turns this on for a prewarm search, whose output nothing reads.
 * Such a search runs for as long as the opponent is thinking and would
 * otherwise print a few hundred `info` lines, each crossing a process boundary
 * to be discarded at the other end. `bestmove` and the handshake are never
 * dropped — those are how the other side knows where it stands.
 */
let quiet = false;

/**
 * The line feed to background.js.
 *
 * A port is far cheaper per message than `chrome.runtime.sendMessage`, which
 * matters at a few hundred lines per search. It is opened lazily and rebuilt on
 * disconnect, with sendMessage as the fallback for the window in between —
 * losing engine output silently would look exactly like the engine hanging.
 */
let linePort = null;

function getLinePort() {
  if (linePort) return linePort;
  try {
    linePort = chrome.runtime.connect({ name: 'engine-lines' });
    linePort.onDisconnect.addListener(() => { linePort = null; });
  } catch {
    linePort = null;
  }
  return linePort;
}

/** Push one line of engine output up to the service worker. */
function relay(line) {
  if (quiet && line.startsWith('info ')) return;

  const port = getLinePort();
  if (port) {
    try {
      port.postMessage({ type: 'ENGINE_LINE', line });
      return;
    } catch {
      linePort = null;        // fall through to sendMessage
    }
  }

  chrome.runtime
    .sendMessage({ target: 'background', type: 'ENGINE_LINE', line })
    .catch(() => { /* service worker asleep or restarting; nothing to do */ });
}

/**
 * How long one build gets to reach `readyok`.
 *
 * Non-final candidates get much less than the last one. The list is walked in
 * order, so a generous deadline on every entry means a machine that cannot run
 * the preferred engine waits the full timeout several times over before
 * anything works at all — minutes of apparent hang to reach a fallback that
 * would have started immediately. The final candidate is the one that must not
 * be abandoned prematurely, so it keeps the long deadline.
 */
const BRINGUP_TIMEOUT_MS = 12_000;
const FINAL_BRINGUP_TIMEOUT_MS = 30_000;

/**
 * A shared WebAssembly.Memory, shrinking the ceiling until the browser agrees.
 *
 * Ported from lichess's `sharedWasmMemory`. The maximum is an address-space
 * reservation rather than committed memory, but a browser under pressure will
 * still refuse a large one with a RangeError — and refusing to start at all
 * because 2 GB of address space was unavailable would be absurd when the engine
 * runs perfectly well in a quarter of it. Sizes are in 64 KB pages.
 */
function sharedWasmMemory(initialPages, maxPages) {
  let hi = maxPages;
  let shrink = 4;
  for (;;) {
    try {
      return new WebAssembly.Memory({ initial: initialPages, maximum: hi, shared: true });
    } catch (err) {
      if (hi <= initialPages || !(err instanceof RangeError)) throw err;
      hi = Math.max(initialPages, Math.ceil(hi - hi / shrink));
      shrink = shrink === 4 ? 3 : 4;
    }
  }
}

/**
 * Hand a module build its neural net.
 *
 * The build is asked which net it wants rather than being told: the filename
 * encodes the net's own SHA-256 prefix and is tied to the architecture compiled
 * into that `.wasm`, so the binary is the only correct authority on it. The
 * catalogue's list is the cross-check — a disagreement means engine/ and
 * lib/engines.js have drifted apart, which is worth saying out loud.
 */
async function loadNets(module, candidate) {
  const wanted = [];
  for (let i = 0; i < 4; i++) {
    const name = module.getRecommendedNnue?.(i);
    if (!name) break;
    wanted.push(name);
  }

  const shipped = (candidate.nets ?? []).map((path) => path.split('/').pop());
  if (wanted.length && shipped.length && wanted[0] !== shipped[0]) {
    console.warn(`[offscreen] ${candidate.script} wants ${wanted[0]}, ` +
      `but lib/engines.js lists ${shipped[0]} — using the build's answer`);
  }

  const names = wanted.length ? wanted : shipped;
  for (let i = 0; i < names.length; i++) {
    const response = await fetch(chrome.runtime.getURL(`engine/${names[i]}`));
    if (!response.ok) {
      throw new Error(`missing net ${names[i]} — add it to engine/ (HTTP ${response.status})`);
    }
    module.setNnueBuffer(new Uint8Array(await response.arrayBuffer()), i);
  }
  return names;
}

/**
 * Run the `uci` -> options -> `isready` handshake over whichever transport this
 * build speaks, and resolve once it answers `readyok`.
 *
 * Options have to land in the window between `uciok` and `isready`: before
 * `uciok` the engine has not declared them yet, and after `readyok` Stockfish
 * has already sized the transposition table, so a later `setoption name Hash`
 * forces a reallocation mid-session. That timing is why option setup lives here
 * rather than in background.js with the rest of the UCI logic — only the side
 * driving the handshake can place a command inside that window.
 *
 * Handshake lines are relayed upstream like any other output, which is what the
 * Worker path used to do implicitly by having two listeners attached at once.
 */
function handshake({ send, dispose, onLine, threads, timeoutMs, script }) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const timer = setTimeout(() => {
      dispose();
      finish(reject, new Error(`${script} did not report readyok in time`));
    }, timeoutMs);

    onLine(
      (line) => {
        relay(line);
        if (line.startsWith('uciok')) {
          for (const option of engineOptions(threads)) send(option);
          send('isready');
        } else if (line.startsWith('readyok')) {
          finish(resolve);
        }
      },
      (err) => {
        dispose();
        finish(reject, err instanceof Error ? err : new Error(String(err)));
      }
    );

    send('uci');
  });
}

/** nmrugg-style build: a Worker that speaks UCI over postMessage. */
async function bringUpWorker(candidate, timeoutMs) {
  const worker = new Worker(candidate.script);
  const dispose = () => worker.terminate();

  const readLine = (event) =>
    typeof event.data === 'string' ? event.data : String(event.data?.data ?? '');

  await handshake({
    script: candidate.script,
    threads: candidate.threads,
    timeoutMs,
    dispose,
    send: (cmd) => worker.postMessage(cmd),
    onLine: (onText, onFail) => {
      worker.onmessage = (event) => {
        const line = readLine(event);
        if (line) onText(line);
      };
      // A threaded build that cannot get shared memory fails here rather than
      // at construction, which is exactly why this path has to reject.
      worker.onerror = (event) =>
        onFail(new Error(String(event?.message ?? `${candidate.script} failed to start`)));
    }
  });

  // Past the handshake the only job left is relaying, so replace the
  // handshake's listener rather than leave it re-testing every line.
  worker.onmessage = (event) => {
    const line = readLine(event);
    if (line) relay(line);
  };
  worker.onerror = (event) => {
    console.error('[offscreen] engine worker error', event.message ?? event);
    relay(`error ${event.message ?? 'engine worker failed'}`);
  };

  return { send: (cmd) => worker.postMessage(cmd), dispose, script: candidate.script };
}

/** lichess-style build: an ES module factory, with the net supplied separately. */
async function bringUpModule(candidate, timeoutMs) {
  const url = chrome.runtime.getURL(candidate.script);
  const { default: factory } = await import(url);

  const module = await factory({
    wasmMemory: sharedWasmMemory(candidate.initialPages, candidate.maxPages),
    locateFile: (file) => chrome.runtime.getURL(`engine/${file}`),
    mainScriptUrlOrBlob: url
  });

  // Reassigned by the handshake so a failure during bring-up rejects it, and
  // again afterwards so a later fault is reported rather than swallowed.
  let onFail = (err) => console.error('[offscreen] engine module error', err);
  const dispose = () => { try { module.uci('quit'); } catch { /* already gone */ } };

  // Attached before the net loads: a rejected net reports itself through here.
  module.onError = (msg) => onFail(new Error(String(msg)));

  const nets = await loadNets(module, candidate);

  await handshake({
    script: candidate.script,
    threads: candidate.threads,
    timeoutMs,
    dispose,
    send: (cmd) => module.uci(cmd),
    onLine: (onText, fail) => {
      onFail = fail;
      module.listen = onText;
    }
  });

  module.listen = relay;
  onFail = (err) => {
    console.error('[offscreen] engine module error', err);
    relay(`error ${err?.message ?? err}`);
  };
  console.log(`[offscreen] ${candidate.script} loaded net ${nets.join(', ') || '(none)'}`);

  return { send: (cmd) => module.uci(cmd), dispose, script: candidate.script };
}

const bringUp = (candidate, timeoutMs) =>
  candidate.kind === 'module'
    ? bringUpModule(candidate, timeoutMs)
    : bringUpWorker(candidate, timeoutMs);

/**
 * Bring up the best build that will actually run here. Resolves once, then
 * memoised.
 *
 * The walk down the candidate list is not defensive padding: whether an
 * extension's offscreen document is cross-origin isolated — and therefore
 * whether shared memory, pthreads and the whole SF19 module build work at all —
 * is not something this code can know in advance, and being wrong about it must
 * cost a warning rather than a bot that will not start.
 */
function initEngine() {
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    const { engineCandidates, DEFAULT_ENGINE } = await catalogue();
    // Record what was *asked for*, not what came up. ENGINE_SET_ENGINE compares
    // against this, so re-sending the same choice after a fallback is a no-op
    // rather than a fresh attempt at a build already known not to start here.
    selectedEngine ??= DEFAULT_ENGINE;
    const shared = sharedMemoryAvailable();
    const threads = threadBudget();
    const candidates = engineCandidates(selectedEngine, { sharedMemory: shared, threads });

    const failures = [];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const last = i === candidates.length - 1;
      try {
        link = await bringUp(candidate, last ? FINAL_BRINGUP_TIMEOUT_MS : BRINGUP_TIMEOUT_MS);
        engineInfo = {
          script: candidate.script,
          engineId: candidate.engineId,
          label: candidate.label,
          tag: candidate.tag,
          threads: candidate.threads,
          shared: shared && candidate.threads > 1,
          cores: coreCount()
        };
        if (failures.length) {
          console.warn(`[offscreen] fell back to ${candidate.script} after: ${failures.join('; ')}`);
        }
        return;
      } catch (err) {
        failures.push(`${candidate.script}: ${err?.message ?? err}`);
        disposeLink();
      }
    }
    throw new Error(`no engine build would start — ${failures.join('; ')}`);
  })();

  readyPromise.catch(() => { readyPromise = null; });   // allow a retry
  return readyPromise;
}

/**
 * Tear down the running engine, leaving the in-flight `readyPromise` alone.
 *
 * This is the one the candidate walk needs. disposeEngine() also clears
 * `readyPromise`, and calling *that* from inside the async function
 * `readyPromise` points at would null it while the next bring-up is still
 * running — after which a concurrent initEngine() would see no memoised promise
 * and start a second engine. Two Stockfish instances, twice the memory, and UCI
 * commands going to whichever one won the race.
 */
function disposeLink() {
  try { link?.dispose(); } catch { /* already gone */ }
  link = null;
}

/** Tear the engine down and forget it was ready, so the next call rebuilds. */
function disposeEngine() {
  disposeLink();
  readyPromise = null;
}

// ---------------------------------------------------------------------------
// Requests from background.js
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;

  const reply = (promise) => {
    promise
      .then((value) => sendResponse({ ok: true, ...value }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  };

  switch (message.type) {
    case 'ENGINE_WAIT_READY':
      return reply(initEngine().then(() => ({ engine: engineInfo })));

    case 'ENGINE_SEND':
      return reply(
        initEngine().then(() => {
          link.send(message.command);
          return { sent: message.command };
        })
      );

    case 'ENGINE_SEND_MANY':
      return reply(
        initEngine().then(() => {
          // Order matters and is preserved: both transports deliver in the
          // order given, so `position` cannot overtake the `stop` in front of it.
          const commands = Array.isArray(message.commands) ? message.commands : [];
          for (const command of commands) link.send(command);
          return { sent: commands.length };
        })
      );

    /**
     * Change how many search threads the engine uses, live.
     *
     * Stockfish rebuilds its thread pool on `setoption name Threads`, which is
     * only safe between searches — background.js is responsible for having
     * stopped the engine first, which is why this does no quiescing of its own.
     * The single-threaded build has no pool to rebuild and ignores the option,
     * so it is not sent one.
     */
    case 'ENGINE_SET_THREADS': {
      const cap = Number(message.cap);
      threadCap = Number.isFinite(cap) && cap > 0 ? cap : MAX_THREADS;
      return reply(initEngine().then(() => {
        const want = threadBudget();
        if (engineInfo.shared && want !== engineInfo.threads) {
          link.send(`setoption name Threads value ${want}`);
          engineInfo = { ...engineInfo, threads: want };
          console.log(`[offscreen] search threads -> ${want}`);
        }
        return { engine: engineInfo };
      }));
    }

    /**
     * Switch to a different engine build entirely.
     *
     * Unlike the thread count, this cannot be applied to a running engine —
     * the two kinds of build are different objects loaded in different ways —
     * so the live one is torn down and the next request rebuilds from the new
     * selection. background.js is responsible for having stopped the search
     * first, exactly as it is for ENGINE_SET_THREADS.
     *
     * A no-op when the selection has not actually changed: rebuilding costs a
     * WASM compile and a net load, which is not something to spend on a
     * settings panel re-sending the value it already had.
     */
    case 'ENGINE_SET_ENGINE': {
      const wanted = String(message.id ?? '').trim();
      // An id-less request is a no-op, not a reset: it would otherwise blank
      // `selectedEngine`, which is the value every later comparison is made
      // against, and quietly tear down a working engine to rebuild the default.
      if (!wanted || (wanted === selectedEngine && link)) {
        return reply(Promise.resolve({ engine: engineInfo, changed: false }));
      }
      selectedEngine = wanted;
      disposeEngine();
      quiet = false;
      return reply(initEngine().then(() => ({ engine: engineInfo, changed: true })));
    }

    case 'ENGINE_SET_QUIET':
      quiet = Boolean(message.quiet);
      sendResponse({ ok: true, quiet });
      return false;

    case 'ENGINE_RESET':
      disposeEngine();
      quiet = false;
      return reply(initEngine().then(() => ({})));

    default:
      sendResponse({ ok: false, error: `Unknown engine request: ${message.type}` });
      return false;
  }
});

// Compile the WASM immediately rather than on the first FEN.
initEngine()
  .then(() => console.log(
    `[offscreen] ${engineInfo.label ?? engineInfo.script} (${engineInfo.tag}) ready — ` +
    `${engineInfo.threads} thread${engineInfo.threads === 1 ? '' : 's'}, Hash ${HASH_MB}MB` +
    `${engineInfo.shared ? '' : ` (no shared memory: crossOriginIsolated=${globalThis.crossOriginIsolated})`}`
  ))
  .catch((err) => console.error('[offscreen] engine init failed', err));
