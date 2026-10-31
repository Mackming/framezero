/**
 * background.js — the engine worker (MV3 service worker, type: "module")
 *
 * Contract with content.js:
 *   in : { type: 'ANALYZE_FEN', fen: '<fen>', moveTimeMs?: number,
 *           remainingMs?: number, mode?: '<move-policy mode id>' }
 *        `moveTimeMs` is the user's own "Think Time" setting from the UI —
 *        depth is no longer user-facing (see MAX_SEARCH_DEPTH below).
 *        `remainingMs` (the mover's clock, read from Lichess's own DOM by
 *        content.js) tightens that further for fast time controls — see
 *        movetimeBudget() below.
 *        `mode` selects a playing style from lib/move-policy.js.
 *   out: { ok: true, bestmove: 'e2e4', ponder: 'e7e5'|null, depth, score, pv,
 *          engineBest: 'e2e4', mode: 'chaos', reason: '<why this move>',
 *          candidates: [{ move, score, pv }, ...] }
 *        `bestmove` is the move the *style* chose and is what the caller
 *        should play; `engineBest` is what the engine itself would have
 *        picked, so the two can be compared and logged when they differ.
 *        { ok: false, error: '<message>' }
 *
 *   in : { type: 'CLICK_MOVE', points: [{x,y}, ...], delayMs? }
 *        Clicks each point in sequence via chrome.debugger (see "Move
 *        execution" below) — genuinely trusted input, unlike anything a
 *        content script can dispatch on its own.
 *   out: { ok: true } | { ok: false, error: '<message>' }
 *
 * WHERE STOCKFISH ACTUALLY LIVES
 * -----------------------------
 * A service worker global scope has no `Worker` constructor, so the SW cannot
 * spawn stockfish-18-lite-single.js itself. The engine therefore runs in an
 * offscreen document (offscreen.html/offscreen.js), which does have `Worker`.
 * This file still owns the whole engine lifecycle: it decides when the engine
 * exists, it sends the UCI commands, and it parses `bestmove`. See README.md
 * for how that survives service-worker restarts.
 */

import { getMode, pickMove, avoidRepetition } from './lib/move-policy.js';
import { getCpuMode, prewarmMsFor, DEFAULT_CPU_MODE } from './lib/cpu-modes.js';
import { getEngine, DEFAULT_ENGINE } from './lib/engines.js';
import { BENCH_POSITIONS, summarise } from './lib/bench-positions.js';
import {
  isTablebaseEligible,
  fetchTablebase,
  chooseTablebaseMove,
  tablebaseScore,
  describeChoice
} from './lib/tablebase.js';

const OFFSCREEN_DOCUMENT = 'offscreen.html';
const READY_TIMEOUT_MS = 30_000;
const SEARCH_TIMEOUT_MS = 60_000;

/**
 * How long the engine may sit unused before its offscreen document is torn
 * down. Stockfish reserves ~128 MB of wasm linear memory up front, plus the
 * transposition table (see HASH_MB in offscreen.js), and holds all of it for
 * as long as the document exists. Without this the engine outlives the last
 * lichess tab and keeps that memory for the rest of the browser session.
 *
 * The cost of reclaiming it is that the next search after an idle stretch
 * pays for WASM compilation again (a second or two), so the window wants to
 * be comfortably longer than the gap between moves in a slow game.
 */
const ENGINE_IDLE_ALARM = 'engine-idle-shutdown';
// Twenty rather than ten: reclaiming costs a full WASM recompile on the next
// move, and a quarter of an hour between games is entirely ordinary.
const ENGINE_IDLE_MINUTES = 20;

/**
 * Depth is no longer a user-facing dial — "Think Time" in the UI sets
 * `moveTimeMs` directly instead, which is a far more legible thing to reason
 * about than an abstract search-depth number, and it's what actually varies
 * inconsistently anyway (search speed depends heavily on how tactically
 * sharp a position is). Search is always allowed up to this depth; combining
 * it with `movetime` in the `go` command makes Stockfish stop at whichever
 * limit is hit first, and in practice `movetime` is always the binding one —
 * this ceiling only guards against a WASM build somehow blazing through a
 * huge movetime budget in a near-empty endgame.
 */
const MAX_SEARCH_DEPTH = 30;
const DEFAULT_MOVETIME_MS = 1_500;
const MAX_MOVETIME_MS = 15_000;

/**
 * Ceiling on how many candidate moves a style may ask for. MultiPV makes the
 * search prune less aggressively, so every extra line costs depth; past a
 * handful the cost is real and the extra candidates are moves no style would
 * ever choose anyway.
 */
const MAX_MULTIPV = 8;

/**
 * Hard cap on the shallow half of a trap search. It is depth-limited already
 * (see `shallowDepth` in move-policy.js) and should finish in tens of
 * milliseconds; this only stops a pathological position from doubling the
 * think time.
 */
const SHALLOW_MOVETIME_MS = 400;

/**
 * Tighten the requested think time further when the clock (read from
 * Lichess's own DOM by content.js and passed through here) says there isn't
 * time to spare — a fixed think time that's fine for a 10-minute game would
 * burn through most of a 1-minute bullet clock in two or three moves. A flat
 * "budget per remaining move" estimate (30 is a common rough guess for moves
 * left in a game) with a safety buffer for the click + engine round trip.
 */
// This once had to cover the click round trip plus the whole detect-and-
// dispatch chain. That chain is now a socket tap and a single batched IPC, so
// most of the buffer can go back into the search.
const CLOCK_SAFETY_BUFFER_MS = 120;
const ASSUMED_MOVES_LEFT = 30;
const MIN_MOVETIME_MS = 50;
function movetimeBudget(requestedMs, remainingMs) {
  const ceiling = Math.min(
    MAX_MOVETIME_MS,
    Number.isInteger(requestedMs) ? requestedMs : DEFAULT_MOVETIME_MS
  );
  if (!Number.isInteger(remainingMs)) return ceiling;
  const usable = Math.max(0, remainingMs - CLOCK_SAFETY_BUFFER_MS);
  return Math.max(MIN_MOVETIME_MS, Math.min(ceiling, usable / ASSUMED_MOVES_LEFT));
}

/** Handlers subscribed to the raw UCI line stream coming back from the engine. */
const lineHandlers = new Set();

/** In-flight offscreen-document creation, so concurrent requests share one. */
let creatingOffscreen = null;

/** Serialises searches: one Stockfish instance means one `go` at a time. */
let searchChain = Promise.resolve();

// ---------------------------------------------------------------------------
// Engine host (offscreen document) lifecycle
// ---------------------------------------------------------------------------

async function offscreenExists() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT)]
  });
  return contexts.length > 0;
}

async function ensureEngine() {
  if (await offscreenExists()) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_DOCUMENT,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Hosts the WebAssembly Stockfish engine in a Web Worker.'
      })
      .catch((err) => {
        // Two callers can race past offscreenExists(); the loser sees this.
        if (!String(err?.message ?? err).includes('Only a single offscreen')) throw err;
      })
      .finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

/**
 * Tear the engine down and reclaim its memory.
 *
 * closeDocument() rejects if there is no document open, which is an entirely
 * ordinary race here (two shutdown paths, or a document that never got
 * created), so a failure is swallowed rather than logged as a problem.
 */
async function shutdownEngine() {
  // Closing the document destroys the engine, and with it every option we
  // set on it. Forgetting that here would leave setMultiPV() believing a
  // brand-new engine had already been configured.
  currentMultiPV = null;
  engineReady = false;
  engineQuiet = false;
  engineBusy = false;
  try {
    await chrome.offscreen.closeDocument();
    console.log('[background] engine idle — offscreen document closed');
  } catch {
    /* already gone */
  }
}

/**
 * Searches still queued or running. The idle alarm must never fire out from
 * under a search in progress, and `searchChain` alone cannot answer that —
 * it is a chain of settled and unsettled promises with no count attached.
 */
let pendingSearches = 0;

function cancelEngineShutdown() {
  return chrome.alarms.clear(ENGINE_IDLE_ALARM).catch(() => {});
}

function scheduleEngineShutdown() {
  // create() resolves to a promise on newer Chrome and returns undefined on
  // older; Promise.resolve() flattens both so neither can reject unhandled.
  return Promise.resolve(
    chrome.alarms.create(ENGINE_IDLE_ALARM, { delayInMinutes: ENGINE_IDLE_MINUTES })
  ).catch(() => {});
}

/**
 * A plain setTimeout cannot do this job: an MV3 service worker is terminated
 * after roughly 30 seconds of inactivity, taking every pending timer with it,
 * so a ten-minute timeout would simply never fire. chrome.alarms survives the
 * teardown and wakes the worker back up to run this.
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ENGINE_IDLE_ALARM) return;
  // A search that started between the alarm being set and it firing wins;
  // whoever finishes it will schedule a fresh one.
  if (pendingSearches > 0) return;
  shutdownEngine();
});

/** Round-trip a request to the offscreen document. */
async function callEngineHost(message) {
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
  if (!response?.ok) throw new Error(response?.error ?? 'Engine host did not respond');
  return response;
}

/** Fire a raw UCI command at the engine. */
function uci(command) {
  return callEngineHost({ type: 'ENGINE_SEND', command });
}

/**
 * Fire several UCI commands as one request.
 *
 * `stop` / `position` / `go` used to be three awaited round trips to the
 * offscreen document, in sequence, at the front of every search. They are
 * strictly ordered, but there is nothing to learn from any of the replies, so
 * paying three latencies to send them bought nothing.
 */
function sendMany(commands) {
  return callEngineHost({ type: 'ENGINE_SEND_MANY', commands });
}

/**
 * Whether a `go` is outstanding, and who is waiting for it to end.
 *
 * `stop` is asynchronous in UCI: the engine finishes what it is doing and
 * *then* prints `bestmove`. Sending `position` before that arrives is how a
 * search ends up reporting a move for the previous position, so anything
 * taking the engine over waits for the acknowledgement first.
 */
let engineBusy = false;
const stopWaiters = new Set();

/**
 * One queue for every sequence that takes the engine over.
 *
 * There are now two kinds of caller — a real search someone is waiting on, and
 * a prewarm nobody is — and each is a *sequence*: stop, wait for the
 * acknowledgement, then `position` and `go`. Interleaving two such sequences
 * leaves the engine on a position neither caller asked for, and because the
 * offscreen worker's queue is FIFO the loser's `position` lands after the
 * winner's `go`. That is not hypothetical: the prewarm's own awaits are exactly
 * long enough for an opponent's move to arrive in the middle of them, and the
 * result would be a `bestmove` for the position *before* our reply — a move for
 * the wrong side.
 *
 * Serialising the sequences rather than the individual commands is what makes
 * each one atomic.
 */
let engineChain = Promise.resolve();

function serialize(fn) {
  const run = () => fn();
  const result = engineChain.then(run, run);
  engineChain = result.catch(() => {});   // one failure must not stall the queue
  return result;
}

/** Registered permanently, ahead of any individual search's own handler. */
lineHandlers.add((line) => {
  if (!line.startsWith('bestmove')) return;
  engineBusy = false;
  for (const resolve of [...stopWaiters]) resolve();
  stopWaiters.clear();
});

const STOP_ACK_TIMEOUT_MS = 500;

/** Bring the engine to a standstill, whatever it was doing. */
async function quiesce() {
  if (!engineBusy) return;
  await sendMany(['stop']);
  await new Promise((resolve) => {
    const settle = () => { stopWaiters.delete(settle); resolve(); };
    stopWaiters.add(settle);
    // An engine that had already finished will never print another bestmove,
    // so this cannot be allowed to wait forever on an acknowledgement that is
    // not coming.
    setTimeout(settle, STOP_ACK_TIMEOUT_MS);
  });
}

/**
 * Handshake state worth not re-asking about.
 *
 * `ENGINE_WAIT_READY` was awaited before every search. Its answer only ever
 * changes when the offscreen document is torn down and rebuilt, which is a
 * decision this file makes — so it can be remembered instead.
 */
let engineReady = false;

/** Which build the offscreen document actually brought up. */
let engineInfo = { script: null, threads: 1, shared: false, cores: 0 };

/**
 * How much of the machine the engine may use. Owned here rather than in the
 * content script because this is the side that talks to the engine, and it has
 * to survive being re-sent after a service-worker restart — which is why the
 * content script announces the mode when it starts the bot rather than only
 * when the user changes it.
 */
let cpuMode = getCpuMode(DEFAULT_CPU_MODE);

/**
 * Which engine build the user picked.
 *
 * Held here for the same reason as `cpuMode`: the offscreen document is
 * rebuilt whenever it is torn down for idleness, and it comes up knowing only
 * the default. This is the copy that survives to tell it otherwise.
 */
let engineChoice = DEFAULT_ENGINE;

async function waitReady() {
  if (engineReady) return engineInfo;
  const response = await callEngineHost({ type: 'ENGINE_WAIT_READY', timeoutMs: READY_TIMEOUT_MS });
  if (response?.engine) engineInfo = response.engine;
  engineReady = true;
  // The offscreen document brings the engine up before it can know which mode
  // is selected, so the live thread count is brought into line here — once,
  // while nothing is searching.
  const capped = await callEngineHost({ type: 'ENGINE_SET_THREADS', cap: cpuMode.threadCap });
  if (capped?.engine) engineInfo = capped.engine;

  // Same reasoning for the engine build: a document that was torn down for
  // idleness comes back on the default, and silently demoting the user's
  // choice after a break is exactly the kind of drift nobody would notice.
  if (engineChoice !== DEFAULT_ENGINE && engineInfo?.engineId !== engineChoice) {
    const switched = await callEngineHost({ type: 'ENGINE_SET_ENGINE', id: engineChoice });
    if (switched?.engine) engineInfo = switched.engine;
  }
  return engineInfo;
}

/**
 * Switch engine build, taking effect now rather than on the next game.
 *
 * Behind the same `serialize` + `quiesce` as applyCpuMode, and for a stronger
 * reason: this does not reconfigure the running engine, it destroys it and
 * builds another. A search in flight would otherwise deliver its `bestmove`
 * from an engine that no longer exists.
 */
async function applyEngine(id) {
  engineChoice = getEngine(id).id;
  await ensureEngine();
  await waitReady();

  const response = await serialize(async () => {
    await quiesce();
    return callEngineHost({ type: 'ENGINE_SET_ENGINE', id: engineChoice });
  });
  if (response?.engine) engineInfo = response.engine;

  console.log(`[background] engine -> ${engineInfo.label ?? engineChoice} ` +
    `(${engineInfo.tag}, ${engineInfo.threads} threads)`);
  return engineInfo;
}

/**
 * Switch CPU mode, taking effect on the current game rather than the next one.
 *
 * Routed through `serialize` and behind a `quiesce` because Stockfish rebuilds
 * its thread pool on `setoption name Threads`: doing that underneath a running
 * search is how you get a `bestmove` from a search that no longer exists.
 */
async function applyCpuMode(id) {
  cpuMode = getCpuMode(id);
  await ensureEngine();
  await waitReady();

  const response = await serialize(async () => {
    await quiesce();
    return callEngineHost({ type: 'ENGINE_SET_THREADS', cap: cpuMode.threadCap });
  });
  if (response?.engine) engineInfo = response.engine;

  console.log(`[background] CPU mode -> ${cpuMode.id} (${engineInfo.threads} threads, ` +
    `prewarm ${prewarmMsFor(cpuMode) || 'off'})`);
  return engineInfo;
}

/**
 * Whether the offscreen document is currently dropping `info` lines.
 *
 * A prewarm search runs for as long as the opponent is thinking and nobody
 * reads its output, yet every `info` line would still cross a process
 * boundary. Muting them at the source is the difference between a silent
 * warm-up and a few hundred pointless IPCs per move.
 */
let engineQuiet = false;

async function setQuiet(quiet) {
  if (engineQuiet === quiet) return;
  await callEngineHost({ type: 'ENGINE_SET_QUIET', quiet });
  engineQuiet = quiet;
}

/**
 * Search the position the opponent is thinking about, and throw the answer
 * away.
 *
 * The point is not the move — it is Stockfish's transposition table, which
 * persists between searches. Whatever the opponent plays, our next search
 * starts from a table already holding the surrounding tree and reaches
 * meaningfully deeper inside the same think time. This is why the bot can
 * answer a bullet move at a depth it could not have reached from cold.
 *
 * Bounded rather than `go infinite`: nothing here is guaranteed to be told
 * when to stop (a closed tab, a dropped port), and an unbounded search would
 * then hold a core until the browser closed.
 */
async function prewarm(fen) {
  // Eco mode turns this off outright. Checked first, so the cheapest mode does
  // not even open the engine in order to decline.
  const budget = prewarmMsFor(cpuMode);
  if (!budget) return;

  if (pendingSearches > 0) return;      // a real search already owns the engine
  try {
    assertFenShape(fen);
    await ensureEngine();
    await waitReady();
    await serialize(async () => {
      // Re-checked inside the slot: `pendingSearches` is incremented
      // synchronously when a search is queued, so a move that arrived during
      // the awaits above has already registered itself there. Yielding to it
      // is the whole point — a warm-up must never outrank the move.
      if (pendingSearches > 0) return;
      await setQuiet(true);
      await quiesce();
      engineBusy = true;
      await sendMany([`position fen ${fen}`, `go movetime ${budget}`]);
    });
  } catch (err) {
    console.warn('[engine] prewarm failed:', err?.message ?? err);
  }
}

/** Stop whatever the engine is doing, and stop muting it. */
function haltEngine() {
  return serialize(async () => {
    try {
      if (engineBusy) await sendMany(['stop']);
      await setQuiet(false);
    } catch { /* engine already gone */ }
  });
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** Cheap structural check; content.js does the real chess.js validation. */
/** How many candidates to ask for when a repetition needs dodging. */
const ANTI_DRAW_MULTIPV = 4;

const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
function isUciMove(m) { return typeof m === 'string' && UCI_MOVE.test(m); }

/**
 * The UCI `position` command, with the game's recent moves when we have them.
 *
 * A bare FEN hides every earlier position from Stockfish, so it cannot know a
 * position has occurred before — and plays into threefold repetition without
 * realising it is a draw, even from a winning position. Given the moves since
 * the last irreversible one, it scores repetitions correctly. Anything
 * malformed falls back to the bare FEN rather than risk confusing the engine.
 */
function positionCommand(fen, history) {
  const moves = history?.moves;
  const root = history?.rootFen;
  if (!Array.isArray(moves) || !moves.length || typeof root !== 'string' || !moves.every(isUciMove)) {
    return `position fen ${fen}`;
  }
  try { assertFenShape(root); } catch { return `position fen ${fen}`; }
  return `position fen ${root} moves ${moves.join(' ')}`;
}

function assertFenShape(fen) {
  if (typeof fen !== 'string' || fen.trim().split(/\s+/).length < 4) {
    throw new Error(`Malformed FEN: ${JSON.stringify(fen)}`);
  }
}

/**
 * Turn one `info` line into a candidate record, or null if it is not one.
 * e.g. "info depth 10 seldepth 14 multipv 1 score cp 31 ... pv e2e4 e7e5 g1f3"
 *
 * Lines flagged `lowerbound`/`upperbound` are skipped: those scores come from
 * a search window that was never closed, so they are a bound rather than an
 * evaluation, and comparing them against real scores is how a style ends up
 * choosing a move on a number that was never true.
 */
function parseInfo(line) {
  if (line.includes('lowerbound') || line.includes('upperbound')) return null;

  const pv = /\bpv (.+)$/.exec(line);
  const depth = /\bdepth (\d+)/.exec(line);
  if (!pv || !depth) return null;          // "info string ..." and friends

  const cp = /\bscore cp (-?\d+)/.exec(line);
  const mate = /\bscore mate (-?\d+)/.exec(line);
  const score =
    cp   ? { type: 'cp', value: Number(cp[1]) } :
    mate ? { type: 'mate', value: Number(mate[1]) } :
    null;
  if (!score) return null;

  const multipv = /\bmultipv (\d+)/.exec(line);
  const moves = pv[1].trim().split(/\s+/);

  // Search effort, for the engine benchmark. Three more regexes on a line that
  // already runs five, a few hundred times per search — microseconds against a
  // search measured in hundreds of milliseconds, and it is the only way to
  // answer "how much depth is this net costing me" without a second code path
  // that could measure something subtly different from what actually plays.
  const nodes = /\bnodes (\d+)/.exec(line);
  const nps = /\bnps (\d+)/.exec(line);
  const time = /\btime (\d+)/.exec(line);

  return {
    depth: Number(depth[1]),
    index: multipv ? Number(multipv[1]) : 1,   // absent when MultiPV is 1
    move: moves[0],
    score,
    pv: moves,
    nodes: nodes ? Number(nodes[1]) : null,
    nps: nps ? Number(nps[1]) : null,
    timeMs: time ? Number(time[1]) : null
  };
}

/**
 * Reduce every info line seen during one search to the candidate list from
 * its deepest *complete* iteration.
 *
 * This matters because a search is almost always cut off mid-iteration by
 * the movetime budget. Taking simply "the last thing seen at each MultiPV
 * index" would mix a half-finished depth 22 with a finished depth 21 and
 * compare scores from different searches — exactly the kind of false
 * comparison a style then acts on. Preferring the deepest iteration that
 * reported its full width keeps every score commensurable.
 */
function completedCandidates(byDepth) {
  let widest = 0;
  for (const atDepth of byDepth.values()) widest = Math.max(widest, atDepth.size);
  if (!widest) return { candidates: [], depth: null };

  let chosen = null;
  let chosenDepth = -1;
  for (const [depth, atDepth] of byDepth) {
    if (atDepth.size === widest && depth > chosenDepth) { chosen = atDepth; chosenDepth = depth; }
  }

  const candidates = [...chosen.entries()]
    .sort((a, b) => a[0] - b[0])        // MultiPV index 1 is the engine's own pick
    .map(([, record]) => ({ move: record.move, score: record.score, pv: record.pv }));

  return { candidates, depth: chosenDepth };
}

/** MultiPV currently set on the live engine, or null if unknown/unset. */
let currentMultiPV = null;

/** Set MultiPV only when it actually changes — every setoption costs a round trip. */
async function setMultiPV(requested) {
  const want = Math.max(1, Math.min(MAX_MULTIPV, Math.trunc(requested) || 1));
  if (currentMultiPV === want) return;
  await uci(`setoption name MultiPV value ${want}`);
  currentMultiPV = want;
}

/**
 * One engine search.
 *
 * @param {string} fen
 * @param {object} opts
 * @param {number} [opts.moveTimeMs]      "Think Time", before clock tightening.
 * @param {number} [opts.remainingMs]     The mover's clock, if known.
 * @param {number} [opts.multiPV]         How many candidate moves to ask for.
 * @param {number} [opts.depthLimit]      Search depth ceiling.
 * @param {number} [opts.fixedMovetimeMs] Bypass the clock budget entirely —
 *   used by the shallow half of a trap search, which is depth-bound and must
 *   not eat into the think time the deep search was given.
 * @returns {Promise<{bestmove, ponder, candidates, depth, score, pv}>}
 */
async function runSearch(fen, {
  moveTimeMs,
  remainingMs,
  multiPV = 1,
  depthLimit = MAX_SEARCH_DEPTH,
  fixedMovetimeMs = null,
  history = null
} = {}) {
  assertFenShape(fen);
  const positionCmd = positionCommand(fen, history);
  await ensureEngine();
  await waitReady();
  await setMultiPV(multiPV);

  /** depth -> (multipv index -> record), so a whole iteration can be taken at once. */
  const byDepth = new Map();

  /** The most recent info line, whose node/nps totals cover the whole search. */
  let lastSeen = null;

  /**
   * Whether this search's handler is listening yet.
   *
   * It has to be subscribed before `go` is sent — output can arrive
   * immediately — but it must not hear the *previous* occupant's output, which
   * is still arriving while we are stopping it. Without this gate the tail of a
   * prewarm's info lines would be filed under this position's depths, and its
   * `bestmove` would settle this promise: a move calculated for a different
   * position, played as if it were ours.
   */
  let armed = false;

  const result = new Promise((resolve, reject) => {
    const finish = (fn) => (arg) => {
      clearTimeout(timer);
      lineHandlers.delete(onLine);
      fn(arg);
    };

    const onLine = (line) => {
      if (!armed) return;
      if (line.startsWith('info ')) {
        const record = parseInfo(line);
        if (!record) return;
        // Cumulative totals, so the newest line covers the whole search — which
        // is not the deepest *complete* iteration the candidates come from, and
        // must not be taken from it.
        lastSeen = record;
        if (!byDepth.has(record.depth)) byDepth.set(record.depth, new Map());
        byDepth.get(record.depth).set(record.index, record);
        return;
      }
      if (line.startsWith('bestmove')) {
        const [, move, , ponder] = line.split(/\s+/);
        if (!move || move === '(none)') {
          done(new Error('No legal move in this position (mate or stalemate)'));
          return;
        }
        const { candidates, depth } = completedCandidates(byDepth);
        const top = candidates[0] ?? null;
        settle({
          bestmove: move,
          ponder: ponder ?? null,
          candidates,
          depth,
          score: top?.score ?? null,
          pv: top?.pv ?? [],
          nodes: lastSeen?.nodes ?? null,
          nps: lastSeen?.nps ?? null,
          searchMs: lastSeen?.timeMs ?? null,
          // The deepest iteration *started* — `depth` above is the deepest one
          // actually finished, and comparing two engines wants both numbers.
          reachedDepth: lastSeen?.depth ?? null
        });
      }
    };

    const timer = setTimeout(
      () => done(new Error(`Engine did not return bestmove within ${SEARCH_TIMEOUT_MS} ms`)),
      SEARCH_TIMEOUT_MS
    );
    const settle = finish(resolve);
    const done = finish(reject);

    lineHandlers.add(onLine);
  });

  const movetime = Number.isFinite(fixedMovetimeMs)
    ? fixedMovetimeMs
    : movetimeBudget(moveTimeMs, remainingMs);

  await serialize(async () => {
    await setQuiet(false);
    await quiesce();                    // abandon any search still running
    // Only now: everything the engine says from here on is about our position.
    armed = true;
    // Set before sending, not after: `bestmove` can land while the send is
    // still in flight, and a late `engineBusy = true` would strand the next
    // quiesce() waiting on an acknowledgement that has already gone by.
    engineBusy = true;
    await sendMany([positionCmd, `go depth ${depthLimit} movetime ${movetime}`]);
  });

  return result;
}

// ---------------------------------------------------------------------------
// Endgames: the answer, not an estimate
// ---------------------------------------------------------------------------

/**
 * Positions already looked up, including the ones that came back with nothing.
 *
 * Caching the misses matters as much as caching the hits: without it, a
 * position the server has no data for is re-requested — and re-waited-for — on
 * every repetition, which in an endgame is often.
 */
const tablebaseCache = new Map();
const TABLEBASE_CACHE_MAX = 500;

/**
 * How long to wait for the server.
 *
 * Measured at roughly 430ms from a cold cache, which is well under the think
 * time a search would have taken — so on a hit this is not a cost at all. It
 * replaces a ~1500ms search with a ~430ms lookup *and* returns a provably
 * optimal move rather than an estimated one. The clock-scaled ceiling is for
 * the miss case, which is the only one that spends time for nothing.
 */
const TABLEBASE_TIMEOUT_MS = 700;
const TABLEBASE_MIN_TIMEOUT_MS = 150;

function tablebaseTimeout(remainingMs) {
  if (!Number.isInteger(remainingMs)) return TABLEBASE_TIMEOUT_MS;
  return Math.max(TABLEBASE_MIN_TIMEOUT_MS, Math.min(TABLEBASE_TIMEOUT_MS, remainingMs / 12));
}

/**
 * Try to answer from the tablebase instead of searching.
 *
 * @returns a result in the same shape a search returns, or null to search.
 */
async function tryTablebase(fen, remainingMs) {
  if (!isTablebaseEligible(fen)) return null;

  let payload;
  if (tablebaseCache.has(fen)) {
    payload = tablebaseCache.get(fen);
  } else {
    payload = await fetchTablebase(fen, { timeoutMs: tablebaseTimeout(remainingMs) });
    // A Map preserves insertion order, so the oldest key is the first one.
    if (tablebaseCache.size >= TABLEBASE_CACHE_MAX) {
      tablebaseCache.delete(tablebaseCache.keys().next().value);
    }
    tablebaseCache.set(fen, payload);
  }

  const choice = chooseTablebaseMove(payload);
  if (!choice) return null;      // mate, stalemate, or no data — let the engine speak

  // Nothing is waiting on the prewarm any more, and it would otherwise run to
  // its own deadline holding a core for a search whose answer we already have.
  haltEngine();

  const candidate = { move: choice.uci, score: tablebaseScore(choice), pv: [choice.uci] };
  return {
    bestmove: choice.uci,
    engineBest: choice.uci,        // same move, so no "style overrode the engine" noise
    ponder: null,
    candidates: [candidate],
    depth: null,
    score: candidate.score,
    pv: candidate.pv,
    mode: 'tablebase',
    reason: describeChoice(choice)
  };
}

/**
 * A search plus the style's choice of what to do with its candidates.
 *
 * Styles live in the service worker rather than in content.js for one
 * concrete reason: trap mode needs a *second* engine search, and only this
 * side of the extension can talk to the engine at all.
 */
async function runStyledSearch(fen, { moveTimeMs, remainingMs, opponentMs, mode, history, avoidMoves }) {
  const style = getMode(mode);
  const avoiding = Array.isArray(avoidMoves) && avoidMoves.length > 0;

  const deep = await runSearch(fen, {
    moveTimeMs,
    remainingMs,
    history,
    // A repetition is only dodged if there is a scored alternative to dodge
    // to, so widen the search — but only on the moves where a repeat is
    // actually on the board, so every other move keeps full depth.
    multiPV: avoiding ? Math.max(style.multiPV, ANTI_DRAW_MULTIPV) : style.multiPV
  });

  // Nothing to choose between: hand back exactly what the engine said.
  if (deep.candidates.length <= 1) {
    return { ...deep, engineBest: deep.bestmove, mode: style.id, reason: 'engine best' };
  }

  let shallow = null;
  if (style.shallowDepth) {
    // The shallow half of a trap search: what an opponent who is not
    // calculating as far as we are would see in this same position.
    try {
      const quick = await runSearch(fen, {
        multiPV: style.multiPV,
        depthLimit: style.shallowDepth,
        fixedMovetimeMs: SHALLOW_MOVETIME_MS
      });
      shallow = quick.candidates;
    } catch (err) {
      // A failed shallow probe costs the style its bait, not its move —
      // pickMove() degrades trap mode to `best` when shallow is missing.
      console.warn('[engine] shallow trap search failed:', err?.message ?? err);
    }
  }

  const picked = pickMove(deep.candidates, { mode: style.id, fen, shallow });
  // Contempt, applied after the style so it works with every style: if the
  // pick repeats a position, trade it for a sound non-repeating move.
  const dodge = avoiding
    ? avoidRepetition(picked.move ?? deep.bestmove, deep.candidates, avoidMoves,
        { ourMs: remainingMs, theirMs: opponentMs })
    : { move: picked.move, reason: null };
  const move = dodge.move;
  const reason = dodge.reason ?? picked.reason;
  const chosen = deep.candidates.find((c) => c.move === move);

  return {
    ...deep,
    // What the caller plays. Falling back to the engine's own move keeps a
    // policy that somehow produced nothing from stalling the bot.
    bestmove: move ?? deep.bestmove,
    engineBest: deep.bestmove,
    mode: style.id,
    reason,
    // Report the evaluation of the move actually being played, not of the
    // move the engine would rather have played — otherwise the eval bar
    // quietly describes a different game than the one on the board.
    score: chosen?.score ?? deep.score,
    pv: chosen?.pv ?? deep.pv
  };
}

/** Queue a search behind any in-flight one. */
function analyzeFen(fen, { moveTimeMs, remainingMs, opponentMs, mode, history, avoidMoves } = {}) {
  pendingSearches++;
  cancelEngineShutdown();

  const start = async () =>
    (await tryTablebase(fen, remainingMs)) ??
    (await runStyledSearch(fen, { moveTimeMs, remainingMs, opponentMs, mode, history, avoidMoves }));
  const result = searchChain.then(start, start);
  searchChain = result.catch(() => {});   // a failure must not poison the queue

  // Restart the idle countdown once the last search settles — including a
  // failed one, which still leaves an engine sitting there holding memory.
  result
    .finally(() => { if (--pendingSearches === 0) scheduleEngineShutdown(); })
    .catch(() => {});   // the caller owns the real rejection; this branch is bookkeeping

  return result;
}

/**
 * Run every engine over the same positions at the same think time.
 *
 * This exists because the interesting question about a bigger neural net has no
 * published answer: how much search depth it costs is a function of this
 * machine, this thread count, WASM's 128-bit SIMD and the think time actually
 * being played at — none of which appear in anyone's Elo table. Measuring it
 * takes a few seconds and settles it.
 *
 * Two details make the numbers comparable rather than merely plausible:
 *
 *   - `runSearch` directly, not `runStyledSearch`, so no MultiPV widening and
 *     no tablebase shortcut — either would measure something other than the
 *     search whose speed is in question.
 *   - `fixedMovetimeMs`, so the clock-scaling that normally shortens a search
 *     when time is low cannot hand one engine a different budget than another.
 *
 * The engine selection is restored afterwards even if a search throws, because
 * silently leaving someone on a 94 MB net they were only trying out is a
 * genuinely unpleasant surprise.
 */
async function runBenchmark({ moveTimeMs, engines }) {
  const previous = engineChoice;

  // The benchmark is a long stretch of searches that `analyzeFen` knows nothing
  // about, so without this the idle alarm can tear the engine down midway.
  pendingSearches++;
  cancelEngineShutdown();

  const results = [];
  try {
    for (const id of engines) {
      await applyEngine(id);
      const rows = [];
      for (const position of BENCH_POSITIONS) {
        try {
          const search = await runSearch(position.fen, { fixedMovetimeMs: moveTimeMs });
          rows.push({
            name: position.name,
            depth: search.depth,
            reachedDepth: search.reachedDepth,
            nodes: search.nodes,
            nps: search.nps
          });
        } catch (err) {
          // One position failing is worth reporting, not worth abandoning the
          // rest of the run for.
          rows.push({ name: position.name, error: String(err?.message ?? err) });
        }
      }
      results.push({
        requested: id,
        // What actually came up, which is not always what was asked for — a
        // machine without shared memory silently benchmarks SF18 three times.
        engineId: engineInfo.engineId,
        label: engineInfo.label,
        tag: engineInfo.tag,
        threads: engineInfo.threads,
        rows,
        summary: summarise(rows)
      });
    }
  } finally {
    try { await applyEngine(previous); } catch { /* reported by the next search */ }
    if (--pendingSearches === 0) scheduleEngineShutdown();
  }
  return results;
}

// ---------------------------------------------------------------------------
// Move execution (chrome.debugger)
// ---------------------------------------------------------------------------

/**
 * A content script's `element.dispatchEvent(new PointerEvent(...))` is always
 * `isTrusted: false` — a hard Web Platform guarantee, not a bug to work
 * around from script. Verified live against lichess.org: an untrusted
 * PointerEvent/MouseEvent sequence at the exact right coordinates, on the
 * exact right element, does nothing; a genuinely trusted click (dispatched
 * through Chrome DevTools Protocol, the same mechanism DevTools itself uses)
 * selects the piece and completes the move instantly. `chrome.debugger` is
 * the one API that lets an extension reach that same trusted-input path —
 * `Input.dispatchMouseEvent` is injected at the browser process level, not
 * through the page's JS event system, so it carries the same weight as real
 * hardware input.
 *
 * Only the background/service-worker context can hold a debugger attachment,
 * hence this lives here rather than in content.js.
 */

/** Tabs we currently hold a debugger attachment on. */
const debuggedTabs = new Set();

chrome.debugger.onDetach.addListener((source, reason) => {
  debuggedTabs.delete(source.tabId);
  // A hold is only meaningful while the attachment exists. Dropping it here
  // covers the tab closing and the user dismissing the attachment themselves,
  // so the next move re-attaches cleanly instead of assuming it still holds one.
  heldTabs.delete(source.tabId);
  if (reason !== 'target_closed') console.warn('[debugger] detached:', reason);
});

async function withDebugger(tabId, fn) {
  if (!debuggedTabs.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggedTabs.add(tabId);
  }
  try {
    return await fn();
  } finally {
    // Detaching after every move was the original choice, on the theory that
    // the "being debugged" banner is better shown briefly than continuously.
    // In practice it is worse: Chrome re-shows the banner on every *attach*,
    // so a game turns into the banner reappearing after each move, and
    // dismissing it accomplishes nothing because the next move brings it
    // straight back. Holding the attachment for as long as the bot is running
    // means the banner appears once, and a dismissal sticks.
    if (!heldTabs.has(tabId)) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
      debuggedTabs.delete(tabId);
    }
  }
}

/**
 * Tabs whose debugger attachment is deliberately held open between moves.
 * Populated while the bot is active, emptied when it stops or the tab goes.
 */
const heldTabs = new Set();

/** Take the attachment now, so the banner appears once at start rather than mid-game. */
async function holdDebugger(tabId) {
  heldTabs.add(tabId);
  if (!debuggedTabs.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggedTabs.add(tabId);
  }
}

/** Give it back — the banner goes away and stays away until the bot runs again. */
async function releaseDebugger(tabId) {
  heldTabs.delete(tabId);
  if (debuggedTabs.has(tabId)) {
    await chrome.debugger.detach({ tabId }).catch(() => {});
    debuggedTabs.delete(tabId);
  }
}

const mouse = (tabId, params) =>
  chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', params);

/**
 * One full click (press + release) at viewport coordinates (x, y).
 *
 * Issued together rather than awaited one at a time. CDP preserves the order of
 * commands within a session, so the press cannot overtake the release; what
 * awaiting each one bought was a round trip to the browser process per event,
 * and there were six of them on every move.
 */
async function clickAt(tabId, x, y) {
  const base = { x, y, button: 'left', clickCount: 1 };
  await Promise.all([
    mouse(tabId, { ...base, type: 'mousePressed' }),
    mouse(tabId, { ...base, type: 'mouseReleased' })
  ]);
}

/**
 * Drag from the first point to the last: press, move, release.
 *
 * This is what a human does, and it has no gap to wait out. The two-click form
 * needs one — two presses in the same instant on different squares risk being
 * folded into a double-click — and that gap was 120ms of every single move.
 *
 * `buttons: 1` on the move is what makes it a drag rather than a hover, and
 * the midpoint exists because chessground begins a drag on the first movement
 * after a press; one straight jump to the destination is easier for it to read
 * as a click that happened to land elsewhere.
 */
async function dragBetween(tabId, from, to) {
  const base = { button: 'left', clickCount: 1 };
  // Same reasoning as clickAt: ordered by CDP, so issued in one go.
  await Promise.all([
    mouse(tabId, { ...base, type: 'mousePressed', x: from.x, y: from.y }),
    mouse(tabId, {
      ...base, type: 'mouseMoved', buttons: 1,
      x: (from.x + to.x) / 2, y: (from.y + to.y) / 2
    }),
    mouse(tabId, { ...base, type: 'mouseMoved', buttons: 1, x: to.x, y: to.y }),
    mouse(tabId, { ...base, type: 'mouseReleased', x: to.x, y: to.y })
  ]);
}

/**
 * Play one move as pointer input.
 *
 * @param {'click'|'drag'} gesture  'drag' needs exactly two points.
 */
async function sendPointerInput(tabId, points, { gesture = 'click', delayMs = 0 } = {}) {
  await withDebugger(tabId, async () => {
    if (gesture === 'drag' && points?.length === 2) {
      await dragBetween(tabId, points[0], points[1]);
      return;
    }
    for (let i = 0; i < points.length; i++) {
      if (i > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      await clickAt(tabId, points[i].x, points[i].y);
    }
  });
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

/**
 * The content script's long-lived port.
 *
 * Requests used to arrive as one-off `sendMessage` calls, which meant the first
 * move after any 30-second lull also paid to restart this worker. A connected
 * port keeps it alive and every message resets the idle timer, so the engine is
 * warm whenever a move arrives. The port is also the signal for when to stop:
 * if the tab goes away mid-prewarm, its disconnect is the only thing that would
 * ever tell the engine to stop searching.
 */
function handleClientPort(port) {
  const tabId = port.sender?.tab?.id;

  const post = (payload) => {
    try { port.postMessage(payload); } catch { /* port already closed */ }
  };

  const answer = (id, promise) => {
    promise
      .then((value) => post({ id, ok: true, ...value }))
      .catch((err) => post({ id, ok: false, error: String(err?.message ?? err) }));
  };

  port.onMessage.addListener((message) => {
    const id = message?.id;

    switch (message?.type) {
      case 'PING':
        // Keepalive, and the warm-up the content script fires when it starts.
        // The reply carries which build came up, so the panel can say whether
        // threading is actually live rather than leaving it a mystery.
        if (id) {
          ensureEngine()
            .then(waitReady)
            .then((engine) => post({ id, ok: true, engine }))
            .catch(() => post({ id, ok: true, engine: null }));
        } else {
          ensureEngine().then(waitReady).catch(() => {});
        }
        return;

      case 'ANALYZE_FEN':
        answer(id, analyzeFen(message.fen, {
          moveTimeMs: Number.isInteger(message.moveTimeMs) ? message.moveTimeMs : undefined,
          remainingMs: Number.isInteger(message.remainingMs) ? message.remainingMs : undefined,
          opponentMs: Number.isInteger(message.opponentMs) ? message.opponentMs : undefined,
          mode: message.mode,
          history: message.history ?? null,
          avoidMoves: Array.isArray(message.avoidMoves) ? message.avoidMoves.filter(isUciMove) : []
        }));
        return;

      case 'PREWARM':
        prewarm(message.fen);        // nobody waits on this
        return;

      case 'SET_CPU_MODE':
        answer(id, applyCpuMode(message.mode).then((engine) => ({ engine })));
        return;

      case 'SET_ENGINE':
        answer(id, applyEngine(message.id).then((engine) => ({ engine })));
        return;

      case 'BENCHMARK':
        answer(id, runBenchmark({
          moveTimeMs: Number(message.moveTimeMs) || DEFAULT_MOVETIME_MS,
          engines: Array.isArray(message.engines) ? message.engines : []
        }).then((results) => ({ results })));
        return;

      case 'ENGINE_STOP':
        haltEngine();
        return;

      case 'CLICK_MOVE':
        if (!tabId) {
          if (id) post({ id, ok: false, error: 'no tab id on port' });
          return;
        }
        answer(id, sendPointerInput(tabId, message.points, {
          gesture: message.gesture,
          delayMs: message.delayMs
        }).then(() => ({})));
        return;

      default:
        if (id) post({ id, ok: false, error: `unknown request: ${message?.type}` });
    }
  });

  port.onDisconnect.addListener(() => {
    // The tab navigated away or the extension reloaded. Nothing will read a
    // prewarm result now, and it would otherwise run to its own deadline
    // holding a core.
    haltEngine();
  });
}

/**
 * The offscreen document's line feed.
 *
 * Every `info` line Stockfish prints used to be its own `chrome.runtime
 * .sendMessage` — several hundred per search once MultiPV is above one. A port
 * carries them for a fraction of the cost and, unlike sendMessage, cannot
 * arrive after this worker has been put to sleep and wake it back up.
 */
function handleLinePort(port) {
  port.onMessage.addListener((message) => {
    if (message?.type !== 'ENGINE_LINE') return;
    for (const handler of [...lineHandlers]) {
      try { handler(message.line); } catch (err) { console.error('[engine] handler', err); }
    }
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'engine') handleClientPort(port);
  else if (port.name === 'engine-lines') handleLinePort(port);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Raw UCI output relayed from the offscreen document. Kept alongside the
  // port above because the offscreen document falls back to sendMessage
  // whenever its own port is not connected.
  if (message?.target === 'background' && message.type === 'ENGINE_LINE') {
    for (const handler of [...lineHandlers]) {
      try { handler(message.line); } catch (err) { console.error('[engine] handler', err); }
    }
    return false;
  }

  if (message?.type === 'ANALYZE_FEN') {
    const moveTimeMs = Number.isInteger(message.moveTimeMs) ? message.moveTimeMs : undefined;
    const remainingMs = Number.isInteger(message.remainingMs) ? message.remainingMs : undefined;
    analyzeFen(message.fen, { moveTimeMs, remainingMs, mode: message.mode })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;   // keep the port open for the async reply
  }

  // Bot started / stopped. Holding the attachment across the session is what
  // keeps Chrome's "being debugged" banner from reappearing after every move.
  if (message?.type === 'DEBUGGER_HOLD' || message?.type === 'DEBUGGER_RELEASE') {
    const tabId = _sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'no tab id on sender' });
      return false;
    }
    const action = message.type === 'DEBUGGER_HOLD' ? holdDebugger : releaseDebugger;
    action(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }

  if (message?.type === 'CLICK_MOVE') {
    const tabId = _sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'no tab id on sender' });
      return false;
    }
    sendPointerInput(tabId, message.points, {
      gesture: message.gesture,
      delayMs: message.delayMs
    })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }

  return false;
});

// Warm the engine as soon as the worker starts, so the first FEN is not the
// request that also pays for WASM compilation. The idle countdown is armed
// alongside it: a browser that starts up and never visits lichess should not
// keep a warmed engine — and its memory — for the whole session.
function warmEngine() {
  ensureEngine()
    .then(() => scheduleEngineShutdown())
    .catch(console.error);
}
chrome.runtime.onInstalled.addListener(warmEngine);
chrome.runtime.onStartup.addListener(warmEngine);

console.log('[background] chess engine worker ready');
