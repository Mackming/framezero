/**
 * Use only on analysis boards or private games – never against real opponents.
 *
 * content.js — board reader + data passer.
 *
 * Exposes on the isolated world's global object:
 *   board                    a chess.js Chess instance (the working position)
 *   ready                    promise, resolves to `board` once chess.js loaded
 *   initBoardFromDOM()       read the Lichess board and load it into `board`
 *   getCurrentFEN()          board.fen()
 *   debugFenSources()        show every FEN source and what it produced
 *   analyzeCurrentPosition() send a FEN to the engine, log the best move
 *   analyzeBoard()           initBoardFromDOM() then analyze the result
 *
 * Content scripts are classic scripts, so chess.js and the extraction helpers
 * are pulled in with dynamic imports of the web-accessible copies in lib/.
 */

console.log('[chess-engine] content.js started loading...');

const MODULE_URLS = {
  chess: chrome.runtime.getURL('lib/chess.js'),
  fenSources: chrome.runtime.getURL('lib/fen-sources.js'),
  positionSync: chrome.runtime.getURL('lib/position-sync.js'),
  overlay: chrome.runtime.getURL('lib/overlay.js'),
  ui: chrome.runtime.getURL('lib/ui.js'),
  openingBook: chrome.runtime.getURL('lib/opening-book.js'),
  movePolicy: chrome.runtime.getURL('lib/move-policy.js'),
  socketEvents: chrome.runtime.getURL('lib/socket-events.js'),
  cpuModes: chrome.runtime.getURL('lib/cpu-modes.js'),
  promotion: chrome.runtime.getURL('lib/promotion.js'),
  engines: chrome.runtime.getURL('lib/engines.js'),
  benchPositions: chrome.runtime.getURL('lib/bench-positions.js')
};

let modulesPromise = null;

/**
 * The resolved module namespace, once it exists.
 *
 * `loadModules()` returns a promise, and awaiting an already-resolved promise
 * still costs a microtask turn. That is irrelevant everywhere except the
 * socket hot path, which wants to apply a move and fire the engine request in
 * the very same task the frame arrived in — so that path reads this directly
 * and only falls back to awaiting when the modules genuinely are not in yet.
 */
let mods = null;

function loadModules() {
  modulesPromise ??= Promise.all([
    import(MODULE_URLS.chess),
    import(MODULE_URLS.fenSources),
    import(MODULE_URLS.positionSync),
    import(MODULE_URLS.overlay),
    import(MODULE_URLS.ui),
    import(MODULE_URLS.openingBook),
    import(MODULE_URLS.movePolicy),
    import(MODULE_URLS.socketEvents),
    import(MODULE_URLS.cpuModes),
    import(MODULE_URLS.promotion),
    import(MODULE_URLS.engines),
    import(MODULE_URLS.benchPositions)
  ]).then((loaded) => (mods = Object.assign({}, ...loaded)));
  return modulesPromise;
}

/** The global board. Null until `ready` resolves. */
let board = null;

/** Whatever initBoardFromDOM() last used, for debugging. */
let lastSource = null;

const ready = loadModules().then(({ Chess }) => {
  board = new Chess();
  globalThis.board = board;
  return board;
});

// ---------------------------------------------------------------------------
// Reading the position off the page
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Persistent link to the engine worker
// ---------------------------------------------------------------------------

/**
 * One long-lived port to background.js, instead of a `sendMessage` per move.
 *
 * An MV3 service worker is torn down after ~30 seconds of inactivity, and the
 * first message after that pays for waking it back up and re-evaluating the
 * whole module graph — tens to well over a hundred milliseconds, charged to
 * whichever move happened to arrive first. In a bullet game that is a real
 * share of the moves, because the gap between our reply and the opponent's is
 * short but the gaps between games are not.
 *
 * A connected port keeps the worker alive, and every message resets its idle
 * timer, so the engine is always warm and every request is a plain IPC. The
 * keepalive covers a long think, during which no request is sent at all.
 */
const PORT_NAME = 'engine';

/**
 * Keepalive interval.
 *
 * An MV3 service worker is torn down after ~30s without a message, so this has
 * to land inside that window. It does not always: Chrome throttles timers in a
 * backgrounded tab to roughly one firing a minute, so switching away from the
 * game — the exact thing that happens while multitasking — stops the keepalive
 * arriving in time and the worker dies. `touchEngineLink()` below covers that
 * hole, and `askEngine` retries so that losing the race is survivable rather
 * than fatal.
 */
const KEEPALIVE_MS = 15_000;

/**
 * Failures that mean "the pipe went away", as opposed to "the engine said no".
 *
 * The distinction decides whether retrying is sane. A recycled worker is
 * transient and recoverable in about a hundred milliseconds; a malformed FEN is
 * not going to improve on a second attempt.
 */
const LINK_DROPPED = 'engine link dropped';
const LINK_RETRIES = 2;

/**
 * The one failure that retrying cannot fix.
 *
 * Reloading, updating or disabling the extension invalidates `chrome.runtime`
 * for every content script belonging to the *previous* version — but leaves
 * those scripts running in whatever tabs were already open. From that moment on
 * every `connect()` and `sendMessage()` throws, forever: the port is gone, the
 * service worker it pointed at is gone, and no amount of reconnecting brings
 * either back. Only reloading the page helps, because that is what injects the
 * new version.
 *
 * It is worth naming separately from LINK_DROPPED, which is the opposite case —
 * Chrome recycling the service worker, where reconnecting is exactly right.
 * Treating the two alike meant an orphaned tab logged a cryptic
 * "Extension context invalidated" on every single move while the bot sat
 * there looking broken and telling nobody how to fix it.
 */
const ORPHANED = 'extension reloaded — refresh this page to reconnect';

/**
 * Has this content script been orphaned?
 *
 * `chrome.runtime.id` is the cheap authoritative test: a string while the
 * context is live, undefined once it is not. Matching on the thrown message
 * text would work today and break on whatever Chrome release rewords it.
 */
function contextInvalidated() {
  try { return !chrome.runtime?.id; } catch { return true; }
}


const link = {
  port: null,
  nextId: 1,
  pending: new Map(),
  keepalive: null,
  lastPingAt: 0,
  everConnected: false
};

/** Drop every outstanding request with the same shape a failed reply has. */
function failPending(error) {
  for (const settle of link.pending.values()) settle({ ok: false, error });
  link.pending.clear();
}

/** Latched, because the condition is permanent and reporting it twice is noise. */
let orphaned = false;

/**
 * Shut down cleanly and say the one thing that actually helps.
 *
 * Everything here has to tolerate `chrome.*` throwing, because by definition it
 * already is — which is why stopAutoAnalysis(), whose whole job is to send
 * teardown messages, is called inside a try.
 */
function noteOrphaned() {
  if (orphaned) return;
  orphaned = true;

  clearInterval(link.keepalive);
  link.keepalive = null;
  link.port = null;
  failPending(ORPHANED);

  botActive = false;
  try { stopAutoAnalysis(); } catch { /* the messages it sends are dead too */ }
  uiInstance?.setBotActive?.(false);
  showStatus('Extension reloaded — refresh this page', 'error', { force: true });

  logUI('This tab is running an old copy of the extension, which was reloaded or ' +
    'updated. Refresh the page to reconnect — the bot is stopped until you do.', 'error');
}

function enginePort() {
  if (link.port) return link.port;
  // Checked before connecting rather than catching the throw, so the diagnosis
  // is made from the runtime's own state instead of inferred from an error.
  if (contextInvalidated()) {
    noteOrphaned();
    throw new Error(ORPHANED);
  }

  const port = chrome.runtime.connect({ name: PORT_NAME });
  link.port = port;

  port.onMessage.addListener((msg) => {
    const settle = link.pending.get(msg?.id);
    if (!settle) return;
    link.pending.delete(msg.id);
    settle(msg);
  });

  port.onDisconnect.addListener(() => {
    // Extension reload, or Chrome recycling the worker. Whoever was waiting is
    // told; askEngine() is what decides to try again, because only the caller
    // knows whether the request is worth repeating.
    if (link.port !== port) return;
    link.port = null;
    clearInterval(link.keepalive);
    link.keepalive = null;
    failPending(LINK_DROPPED);
  });

  link.keepalive = setInterval(() => {
    // Without this the interval outlives the extension it was pinging and
    // throws every 15 seconds for as long as the tab stays open.
    if (contextInvalidated()) { noteOrphaned(); return; }
    try {
      port.postMessage({ id: 0, type: 'PING' });
      link.lastPingAt = Date.now();
    } catch { /* onDisconnect handles it */ }
  }, KEEPALIVE_MS);

  // A rebuilt worker has forgotten the CPU mode and fallen back to its default,
  // which would silently undo the setting mid-game. Deferred by a tick so it
  // cannot re-enter enginePort() while this one is still being built.
  if (link.everConnected) {
    setTimeout(() => tellEngine({ type: 'SET_CPU_MODE', mode: cpuMode }), 0);
  }
  link.everConnected = true;
  link.lastPingAt = Date.now();

  return port;
}

/**
 * Keep the worker alive off the back of socket traffic.
 *
 * WebSocket delivery is not throttled in a background tab the way timers are,
 * so while a game is actually being played this fires reliably even when the
 * tab is hidden — precisely when the interval above stops being trustworthy.
 * Rate-limited, so a burst of frames is not a burst of pings.
 */
function touchEngineLink() {
  if (!link.port) return;
  const now = Date.now();
  if (now - link.lastPingAt < KEEPALIVE_MS) return;
  link.lastPingAt = now;
  try { link.port.postMessage({ id: 0, type: 'PING' }); } catch { /* onDisconnect handles it */ }
}

/**
 * One request over the port.
 *
 * Resolves with the reply object either way — `{ok: false, error}` on failure
 * — so callers keep the shape they had with `sendMessage` and none of them
 * has to grow a try/catch it did not need before.
 */
function sendOnce(message, timeoutMs) {
  return new Promise((resolve) => {
    let port;
    try {
      port = enginePort();
    } catch (err) {
      resolve({ ok: false, error: String(err?.message ?? err) });
      return;
    }

    const id = link.nextId++;
    const timer = setTimeout(() => {
      link.pending.delete(id);
      resolve({ ok: false, error: `engine did not answer within ${timeoutMs}ms` });
    }, timeoutMs);

    link.pending.set(id, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });

    try {
      port.postMessage({ id, ...message });
    } catch (err) {
      clearTimeout(timer);
      link.pending.delete(id);
      if (contextInvalidated()) {
        noteOrphaned();
        resolve({ ok: false, error: ORPHANED });
        return;
      }
      resolve({ ok: false, error: String(err?.message ?? err) });
    }
  });
}

/**
 * One request, retried if the *link* failed rather than the engine.
 *
 * The service worker being recycled mid-search is ordinary — Chrome does it
 * under memory pressure, and a backgrounded tab's throttled keepalive makes it
 * likely rather than rare. Reconnecting is nearly free, because the offscreen
 * document and its compiled engine survive the worker; the only thing that made
 * it fatal was giving up. The request that died was the one carrying the move,
 * and since it is our turn no further socket event arrives to start another, so
 * the bot simply sat there until the flag fell.
 */
async function askEngine(message, { timeoutMs = 90_000, retries = LINK_RETRIES } = {}) {
  for (let attempt = 0; ; attempt++) {
    const reply = await sendOnce(message, timeoutMs);
    if (reply?.ok || attempt >= retries) return reply;
    // Compared against the same constant the disconnect handler throws, so the
    // two cannot drift apart and quietly disable retrying. Everything else is
    // returned as-is, which is what keeps ORPHANED from being retried: that one
    // is permanent, and three attempts at it only delay saying so.
    if (reply?.error !== LINK_DROPPED) return reply;

    console.warn(
      '[chess-engine] engine link dropped mid-request — reconnecting ' +
      `(attempt ${attempt + 2}/${retries + 1})`
    );
    showStatus('Reconnecting engine…', 'warn');
    // A short pause, so the reconnect is not racing the teardown it followed.
    await new Promise((r) => setTimeout(r, 60 * (attempt + 1)));
  }
}

/**
 * Fire-and-forget: tell the engine to start chewing on a position nobody is
 * waiting on. Used to spend the opponent's clock instead of idling.
 */
function tellEngine(message) {
  try { enginePort().postMessage({ id: 0, ...message }); } catch { /* reconnects next request */ }
}

/**
 * Send one request to page-bridge.js in the MAIN world.
 * Resolves to null on any page with no bridge (i.e. anything but lichess.org).
 */
function callBridge(type, payload = {}, timeoutMs = 400) {
  return new Promise((resolve) => {
    const id = `cbe-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const finish = (value) => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(value);
    };

    function onMessage(event) {
      if (event.source !== window) return;
      const data = event.data;
      if (data?.__cbe !== 'RESPONSE' || data.id !== id) return;
      finish(data.ok ? data.data ?? {} : null);
    }

    const timer = setTimeout(() => finish(null), timeoutMs);
    window.addEventListener('message', onMessage);
    window.postMessage({ __cbe: 'REQUEST', id, type, payload }, '*');
  });
}

/** Whatever window.site currently holds, via the bridge. */
async function askPageForFen(timeoutMs) {
  const result = await callBridge('GET_FEN', {}, timeoutMs);
  if (!result) return null;
  return {
    fen: result.fen ?? null,
    path: result.path ?? null,
    turn: result.turn ?? null,
    sans: Array.isArray(result.sans) ? result.sans : null,
    initialFen: result.initialFen ?? null,
    color: result.color ?? null
  };
}

const ANIMATION_POLL_MS = 40;
const ANIMATION_SETTLE_BUDGET_MS = 280;

/**
 * Read the current position off the page — every field of it, not just the
 * pieces.
 *
 * resolvePosition() does the arbitration between sources (see fen-sources.js):
 * a complete FEN wins only once it has been checked against the pieces actually
 * on screen, and otherwise the side to move comes from chessground's own
 * last-move highlight rather than being defaulted to White. What this adds on
 * top is timing — waiting out a move animation before believing what it sees.
 *
 * @param {{prefer?: string, timeoutMs?: number}} options  `prefer` forces a
 *   single source, e.g. 'rendered-pieces' | 'data-fen' | 'data-state' |
 *   'fen-input' | 'window.site', and skips both the arbitration and the wait.
 * @returns {Promise<{fen: string, source: string, complete: boolean,
 *   settled: boolean, turnConfirmed: boolean, path: string|null}|null>}
 */
async function readBoardFen({ prefer = null, timeoutMs } = {}) {
  const { resolvePosition } = await loadModules();
  const page = await askPageForFen(timeoutMs);

  let hit = resolvePosition(document, page?.fen ?? null, { prefer });
  if (!hit) return null;

  // Chessground animates a move over roughly 200ms, and the mutation that wakes
  // us fires at the *start* of that — so the obvious moment to look is the one
  // moment the pieces are still in the air, halfway between the square they
  // left and the square they are heading for. Letting them land is the
  // difference between reading the move that was actually played and reading a
  // position nobody ever played.
  //
  // Polling for it (rather than sleeping a fixed guess) is also what lets the
  // mutation debounce stay short: we can afford to look the instant something
  // changes, because a look taken too early is now recognised as too early
  // instead of being believed.
  for (let waited = 0; !hit.settled && !prefer && waited < ANIMATION_SETTLE_BUDGET_MS;
       waited += ANIMATION_POLL_MS) {
    await new Promise((resolve) => setTimeout(resolve, ANIMATION_POLL_MS));
    hit = resolvePosition(document, page?.fen ?? null, { prefer }) ?? hit;
  }

  // chessground's own movable-color, on the rare page where the bridge can
  // still reach it, is an independent read on the turn — worth taking when the
  // board's own signals came up empty.
  if (!hit.turnConfirmed && page?.turn) {
    const parts = hit.fen.split(' ');
    parts[1] = page.turn === 'black' ? 'b' : 'w';
    hit = { ...hit, fen: parts.join(' '), turnConfirmed: true };
  }

  return {
    ...hit,
    path: hit.source === 'window.site' ? page?.path ?? null : null,
    history: page?.sans ?? null,
    initialFen: page?.initialFen ?? null,
    playerColor: page?.color ?? null
  };
}

/**
 * Give `board` the game's real move history, not just its current placement.
 *
 * A board loaded from a FEN has no history, and everything keyed on history
 * then goes wrong when the bot is switched on mid-game: the opening book
 * thinks it is move one and suggests 1.e4 whatever the position, and
 * auto-play dutifully tries to play it. The round's own step list (via the
 * bridge) is tried first, then Lichess's rendered move list.
 *
 * @returns {boolean} whether the history was restored
 */
function restoreHistory(hit) {
  const { replayHistory, readMoveListSans } = mods ?? {};
  if (!board || !hit || !replayHistory) return false;
  const placement = hit.fen.split(' ')[0];

  if (hit.history && replayHistory(board, hit.history, placement, hit.initialFen ?? undefined)) return true;
  const sans = readMoveListSans?.(document);
  return Boolean(sans?.length) && replayHistory(board, sans, placement);
}

async function initBoardFromDOM({ prefer = null } = {}) {
  await ready;
  const hit = await readBoardFen({ prefer });

  if (!hit) {
    console.warn(
      '[chess-engine] no FEN found on this page. Run debugFenSources() to see what was tried.'
    );
    return null;
  }

  try {
    // resolvePosition() has already filled in the side to move, the castling
    // rights and any en passant square from the board itself, so what arrives
    // here is a position worth loading verbatim rather than a placement with
    // the rest defaulted away.
    board.load(hit.fen);
  } catch (err) {
    console.error('[chess-engine] chess.js rejected', hit.fen, '-', err.message ?? err);
    return null;
  }

  // Replaying the actual moves beats the FEN on every field the FEN had to
  // guess at, and is the only thing that tells the opening book where we are.
  const replayed = restoreHistory(hit);
  lastSource = {
    ...hit,
    fen: board.fen(),
    ...(replayed ? { complete: true, turnConfirmed: true, replayed: board.history().length } : {})
  };

  console.log(
    `[chess-engine] board <- ${lastSource.fen}\n` +
    `  source: ${hit.source}${lastSource.path ? ` (${lastSource.path})` : ''}` +
    `${replayed ? `, history replayed (${lastSource.replayed} plies)` : ''}` +
    `${lastSource.complete || lastSource.turnConfirmed ? '' : '  [turn/castling/counters defaulted - placement only]'}`
  );

  return lastSource;
}

/** Current position of `board` as a FEN string. */
function getCurrentFEN() {
  if (!board) {
    throw new Error('board is not ready yet - `await ready` first');
  }
  return board.fen();
}

/** Print every source and what it yielded. Useful when Lichess changes markup. */
async function debugFenSources() {
  const { collectFenSources } = await loadModules();
  const page = await askPageForFen();
  const rows = collectFenSources(document, page?.fen ?? null).map((c) => ({
    source: c.source,
    found: Boolean(c.fen),
    complete: c.complete,
    fen: c.fen ?? String(c.raw ?? '')
  }));
  console.table(rows);
  if (page?.path) console.log('[chess-engine] window.site hit at:', page.path);
  return rows;
}

// ---------------------------------------------------------------------------
// Move indicator
// ---------------------------------------------------------------------------

const indicator = { enabled: true, via: 'auto', last: null };

/**
 * Distinct palettes per side to move, so a suggestion is identifiable as
 * "White's move" or "Black's move" at a glance — useful since a suggestion is
 * always shown for whoever is actually to move, including the opponent.
 * Target ring stays a consistent red ("lands here") in both.
 */
const SIDE_COLORS = {
  white: { source: '#4aa3f0', target: '#e0563e', arrow: '#4aa3f0' },
  black: { source: '#b98af5', target: '#e0563e', arrow: '#b98af5' }
};

/**
 * Draw the engine's suggestion on the board.
 *
 * @param {string} uciMove  e.g. "e2e4", or "e7e8q" for a promotion.
 * @param {{via?: 'auto'|'chessground'|'svg', sideToMove?: 'white'|'black'}} options
 *   'chessground' asks the page to use its own arrow layer (needs the bridge);
 *   'svg' injects our own overlay; 'auto' tries Chessground, then falls back.
 * @returns {Promise<{via: string, from: string, to: string}|null>}
 */
async function drawBestMove(uciMove, { via = indicator.via, sideToMove } = {}) {
  const { pickMainBoard, buildOverlay, mountOverlay, clearOverlay } = await loadModules();

  const from = uciMove.slice(0, 2);
  const to = uciMove.slice(2, 4);
  const promotion = uciMove.length > 4 ? uciMove[4] : null;

  if (via === 'auto' || via === 'chessground') {
    const brush = sideToMove === 'black' ? 'yellow' : 'blue';
    const drawn = await callBridge('DRAW_SHAPE', { orig: from, dest: to, brush }, 300);
    if (drawn?.drawn) {
      clearOverlay(document);              // never show both at once
      indicator.last = { via: 'chessground', from, to, promotion };
      return indicator.last;
    }
    if (via === 'chessground') {
      console.warn('[chess-engine] chessground unavailable:', drawn?.reason ?? 'no bridge');
      return null;
    }
  }

  const main = pickMainBoard(document);
  if (!main) {
    console.warn('[chess-engine] no board to draw on');
    return null;
  }

  const wrap = main.el.closest('.cg-wrap');
  const flipped = Boolean(wrap?.classList.contains('orientation-black'));
  const colors = SIDE_COLORS[sideToMove];
  const svg = buildOverlay(document, { from, to, flipped, promotion, colors });
  if (!svg) {
    console.warn('[chess-engine] could not build an overlay for', uciMove);
    return null;
  }

  mountOverlay(document, wrap ?? main.el.parentElement, svg);
  indicator.last = { via: 'svg', from, to, promotion };
  return indicator.last;
}

/** Remove whatever is currently drawn, by either method. */
async function clearIndicator() {
  const { clearOverlay } = await loadModules();
  clearOverlay(document);
  if (indicator.last?.via === 'chessground') await callBridge('CLEAR_SHAPES', {}, 300);
  indicator.last = null;
}

/** Turn indicators on or off, and choose how they are drawn. */
function setIndicators(enabled, { via } = {}) {
  indicator.enabled = Boolean(enabled);
  if (via) indicator.via = via;
  if (!indicator.enabled) clearIndicator();
  return { enabled: indicator.enabled, via: indicator.via };
}

// ---------------------------------------------------------------------------
// Bot Automation
// ---------------------------------------------------------------------------

let botActive = false;
/** When false, a found bestmove is only highlighted — never played automatically. */
let autoPlayEnabled = true;
/**
 * 'auto' | 'white' | 'black' — the side you *chose* in "Playing As".
 *
 * Only an explicit choice lives here and is persisted. What auto-detection
 * learns goes in `detectedColor` instead, and is never saved: it used to be
 * written into this setting, so the colour from one game carried into the
 * next — where you might well be playing the other side — and auto-play sat
 * holding "you're playing white, it's black's move" until a move event
 * happened to correct it.
 */
let playingAs = 'auto';
/** This game's colour as auto-detected; 'white' | 'black' | null. */
let detectedColor = null;
/** Where detectedColor came from — 'server' outranks everything else. */
let detectedFrom = null;

/**
 * The side Auto-Play moves for. The server's word beats everything, since it
 * cannot be wrong; then your explicit choice; then whatever else was detected.
 */
function ourColor() {
  if (detectedFrom === 'server') return detectedColor;
  return playingAs === 'white' || playingAs === 'black' ? playingAs : detectedColor;
}

/** Record an auto-detected colour for this game, without overriding a better source. */
function noteDetectedColor(color, from, reason) {
  if (color !== 'white' && color !== 'black') return;
  if (detectedFrom === 'server' && from !== 'server') return;
  const changed = detectedColor !== color;
  detectedColor = color;
  detectedFrom = from;
  if (changed && (playingAs === 'auto' || from === 'server')) {
    uiInstance?.setDetectedColor?.(color);
    if (reason) logUI(`${reason} — playing ${color} this game`, 'info');
  }
}
let moveDelayMs = 1200;
/**
 * Contempt: dodge repetitions when a sound alternative exists (see
 * avoidRepetition in lib/move-policy.js). On by default; `antiDraw = false`
 * from the console turns it off.
 */
let antiDraw = true;
/** A lib/move-policy.js mode id — the playing style, chosen in the UI. */
let botMode = 'best';
/** A lib/cpu-modes.js id — how much of the machine the engine may use. */
let cpuMode = 'balanced';

/**
 * Which engine build to run. Mirrored in background.js, which is the side that
 * actually talks to the engine; this copy exists to seed the panel and to be
 * re-announced when the bot starts, so a service-worker restart cannot quietly
 * demote the choice back to the default.
 */
let engineChoice = 'sf19';
let uiInstance = null;

/**
 * Speed policy — everything that trades a cosmetic nicety for milliseconds.
 *
 * These are separated from the other settings because they are all answers to
 * the same question: in a bullet game, is this delay buying anything? A
 * human-like pause is worth real time on a 1+0 clock, and the two-click move
 * gesture spent 120ms waiting between the clicks for no reason a bullet player
 * would accept.
 *
 * `instant` is the user-facing switch. The rest are here so one specific
 * behaviour can be turned off from the console when Lichess changes something,
 * without giving up the whole fast path.
 */
const speed = {
  instant: true,     // no cosmetic pause before playing, whatever Move Delay says
  prewarm: true,     // search the position while the opponent is on the clock
  dragMove: true,    // one drag gesture rather than two clicks 120ms apart
  clickGapMs: 12     // gap when falling back to the two-click gesture
};

/**
 * Below this much time on the clock, the cosmetic Move Delay is dropped even
 * with Instant off. A pause configured for a 10-minute game will lose a
 * 1-minute one outright, and losing on time is not a pacing preference.
 */
const PANIC_CLOCK_MS = 30_000;

/** How long to pause before playing, given the clock. */
function moveDelayFor(remainingMs) {
  if (speed.instant || moveDelayMs <= 0) return 0;
  if (!Number.isInteger(remainingMs)) return moveDelayMs;
  if (remainingMs < PANIC_CLOCK_MS) return 0;
  // Never more than a sixtieth of what is left, so the configured pause stays
  // configured in a long game and quietly gets out of the way in a short one.
  return Math.min(moveDelayMs, remainingMs / 60);
}

/**
 * Timing of the move in flight, for the latency figure in the UI.
 * `frameAt` is the bridge's `performance.now()` stamp from the moment the
 * opponent's move arrived on the socket — the two worlds share this document's
 * time origin, so the subtraction is meaningful across them.
 */
const hot = { frameAt: 0, dispatchedAt: 0 };

/**
 * The reply the engine expects, from the last `bestmove X ponder Y` it sent.
 *
 * This was previously parsed, printed in a log line, and otherwise discarded —
 * which meant the prewarm searched the position the opponent is thinking about
 * rather than the position we expect to be answering. Keeping it lets the
 * warm-up aim one ply further ahead, at the position most likely to arrive.
 *
 * Cleared as soon as it is used: a prediction two moves stale describes a
 * position that is no longer reachable, and warming that is worse than warming
 * nothing, because it displaces useful entries in the table.
 */
let predictedReply = null;

function getSquareCenter(boardEl, square) {
  if (!boardEl) return null;
  const rect = boardEl.getBoundingClientRect();
  const file = 'abcdefgh'.indexOf(square[0]);
  const rank = parseInt(square[1], 10) - 1;
  const sqSize = rect.width / 8;
  const isFlipped = boardEl.closest('.cg-wrap')?.classList.contains('orientation-black');

  let col = file;
  let row = 7 - rank;
  if (isFlipped) {
    col = 7 - file;
    row = rank;
  }

  const x = rect.left + col * sqSize + sqSize / 2;
  const y = rect.top + row * sqSize + sqSize / 2;
  return { x, y };
}

/**
 * Click each point in sequence through chrome.debugger (background.js) —
 * genuinely trusted input. Verified live against lichess.org: a content
 * script's own `element.dispatchEvent(new PointerEvent(...))` is always
 * `isTrusted: false`, and Chessground (or the browser's pointer-capture
 * handling underneath it) does not react to it at all — correct coordinates,
 * correct target, correct event sequence, nothing happens. A real click
 * dispatched through Chrome DevTools Protocol, the same mechanism DevTools
 * itself uses, selects the piece and completes the move immediately. There
 * is no way for a content script to produce a trusted event on its own;
 * chrome.debugger is the one API that reaches that same input path.
 */
async function clickViaDebugger(points, { gesture = 'click', delayMs = 0 } = {}) {
  const response = await askEngine({ type: 'CLICK_MOVE', points, gesture, delayMs }, { timeoutMs: 5_000 });
  if (!response?.ok) logUI(`Click failed: ${response?.error ?? 'no response'}`, 'error');
  return Boolean(response?.ok);
}

/**
 * Wait for the promotion chooser rather than sleeping a fixed guess at how long
 * it takes to appear. The old fixed 200ms was both too long when it rendered
 * in 20ms and too short when it did not — in which case the promotion was
 * silently skipped and the move left half-played.
 *
 * The window is generous because a promotion that is missed costs the whole
 * move (the pawn sits on the last rank until a human clicks a piece), while
 * waiting costs nothing in the normal case: the loop returns the instant the
 * chooser exists, and `until` ends it early when the move turns out not to need
 * one at all — which is what "Auto-promote to queen" in Lichess's preferences
 * does, submitting the move with no chooser ever rendered.
 */
const PROMOTION_WAIT_MS = 800;
const PROMOTION_POLL_MS = 10;
/** How long to wait for the chooser to go away again after a choice/cancel. */
const PROMOTION_SETTLE_MS = 300;

async function waitForPromotionChooser(until = () => false) {
  const { findPromotionChooser } = await loadModules();
  for (let waited = 0; waited < PROMOTION_WAIT_MS; waited += PROMOTION_POLL_MS) {
    const chooser = findPromotionChooser(document);
    if (chooser) return chooser;
    if (until()) return null;
    await new Promise((resolve) => setTimeout(resolve, PROMOTION_POLL_MS));
  }
  return findPromotionChooser(document);
}

/** Poll until the chooser is gone; false means it is somehow still up. */
async function waitForChooserToClose() {
  const { findPromotionChooser } = await loadModules();
  for (let waited = 0; waited < PROMOTION_SETTLE_MS; waited += PROMOTION_POLL_MS) {
    if (!findPromotionChooser(document)) return true;
    await new Promise((resolve) => setTimeout(resolve, PROMOTION_POLL_MS));
  }
  return !findPromotionChooser(document);
}

/**
 * Pick `piece` out of the promotion chooser.
 *
 * Every failure here used to be a silent `return`, which is why this bug was
 * invisible: the chooser was never found (Lichess identifies it by id, not by
 * the classes this looked for), so nothing was clicked, nothing was logged, and
 * the move simply stopped half-played with the board waiting on a human. Each
 * step now says what it could not find.
 *
 * @param {string} piece  UCI promotion letter: q, r, b or n
 * @param {() => boolean} settled  true once the move is confirmed without a
 *   chooser — Lichess's auto-queen preference never renders one.
 * @returns {Promise<boolean>} whether the piece was chosen
 */
async function handlePromotion(piece, settled = () => false) {
  const { findPromotionOption, promotionClickPoint } = await loadModules();

  const chooser = await waitForPromotionChooser(settled);
  if (!chooser) {
    // Auto-queen submits the move itself, so no chooser is not automatically
    // wrong — it is only wrong if we wanted something other than a queen.
    if (settled()) {
      if (piece.toLowerCase() !== 'q') {
        logUI(`Lichess auto-promoted to a queen — ${piece.toUpperCase()} was not offered`, 'warn');
      }
      return true;
    }
    logUI('Promotion chooser never appeared — the pawn may be waiting on the last rank', 'error');
    return false;
  }

  const option = findPromotionOption(chooser, piece);
  if (!option) {
    logUI(`Promotion chooser has no ${piece.toUpperCase()} to click`, 'error');
    return false;
  }

  const point = promotionClickPoint(option);
  if (!point) {
    logUI('Promotion choice has no on-screen box to click yet', 'error');
    return false;
  }

  if (!await clickViaDebugger([point])) return false;

  // The chooser closes the moment a choice is taken, so it still being up means
  // the click landed on the overlay instead and cancelled the whole move.
  if (!await waitForChooserToClose()) {
    logUI('Promotion chooser is still open after clicking — the choice did not take', 'warn');
    return false;
  }
  return true;
}

/**
 * Cancel a chooser left open by a failed attempt, before retrying the move.
 *
 * Without this the retry's first click — aimed at the from-square — lands on
 * the chooser's full-board overlay, which cancels it rather than picking up the
 * pawn, and the attempt is spent doing nothing.
 */
async function dismissPromotionChooser() {
  const { findPromotionChooser, promotionCancelPoint } = await loadModules();
  const chooser = findPromotionChooser(document);
  if (!chooser) return;
  const point = promotionCancelPoint(chooser);
  if (!point) return;
  logUI('Clearing the leftover promotion chooser before retrying', 'warn');
  await clickViaDebugger([point]);
  await waitForChooserToClose();
}

/** Is there a piece on this square, per the current placement FEN field? */
function squareOccupied(placement, square) {
  const file = 'abcdefgh'.indexOf(square[0]);
  const rank = Number(square[1]) - 1;
  const row = placement.split('/')[7 - rank] ?? '';
  let col = 0;
  for (const ch of row) {
    if (/\d/.test(ch)) { col += Number(ch); continue; }
    if (col === file) return true;
    col++;
  }
  return false;
}

/** Ground truth, independent of whatever we tried to dispatch: did the piece actually move? */
async function moveLanded(sourceSquare, targetSquare) {
  const { extractFen } = await loadModules();
  const hit = extractFen(document, null, { prefer: 'rendered-pieces' });
  if (!hit) return false;
  const placement = hit.fen.split(' ')[0];
  return !squareOccupied(placement, sourceSquare) && squareOccupied(placement, targetSquare);
}

/**
 * How many times to try playing one move before giving up on it, and how long
 * to wait for each attempt to show up on the board.
 *
 * A single fixed wait was the old behaviour and it was too optimistic: the
 * click has to reach the page, Lichess has to accept and echo the move, and
 * chessground has to finish animating it — a chain that occasionally runs
 * longer than any one fixed number, and whose failure looked identical to
 * "that isn't your piece". Polling until it lands (or a real deadline passes)
 * makes a slow move a slow success instead of a false failure, and retrying
 * covers the clicks that genuinely get dropped.
 */
const MOVE_ATTEMPTS = 3;
const MOVE_LAND_TIMEOUT_MS = 1_200;
const MOVE_LAND_POLL_MS = 20;

/**
 * Deadline for the *first* attempt.
 *
 * Lichess renders your own move the moment you make it, without waiting for
 * the server, so a click that worked shows on the board within a frame or two.
 * Waiting the full 1200ms before conceding therefore only ever delays the
 * retry — and a retry that starts 1200ms late has already cost more than the
 * dropped click did. Later attempts keep the long deadline, where the real
 * question is whether the move is legal at all.
 */
const FIRST_ATTEMPT_TIMEOUT_MS = 600;

/**
 * Deadline for a promotion, which is two gestures with a dialog between them.
 * It has to outlast the whole of that: up to PROMOTION_WAIT_MS for the chooser
 * to render, the click, and PROMOTION_SETTLE_MS for it to close — otherwise the
 * confirmation window can expire while the promotion is still being made, and a
 * move that worked gets retried on top of itself.
 */
const PROMOTION_MOVE_TIMEOUT_MS = PROMOTION_WAIT_MS + PROMOTION_SETTLE_MS + MOVE_LAND_TIMEOUT_MS;

/** Poll until the piece is standing on its destination, or the deadline passes. */
async function waitForMoveToLand(sourceSquare, targetSquare, timeoutMs = MOVE_LAND_TIMEOUT_MS) {
  for (let waited = 0; waited < timeoutMs; waited += MOVE_LAND_POLL_MS) {
    if (await moveLanded(sourceSquare, targetSquare)) return true;
    await new Promise((resolve) => setTimeout(resolve, MOVE_LAND_POLL_MS));
  }
  return moveLanded(sourceSquare, targetSquare);
}

/**
 * Confirm our own move the way Lichess itself confirms it: the server echoes
 * every accepted move back down the round socket. That echo is authoritative
 * and arrives long before chessground has finished animating, so on a live
 * game this replaces reading the board back to find out whether our click
 * worked.
 *
 * Resolves false slightly *after* waitForMoveToLand's own deadline, so that
 * when the two are raced and both fail, it is the board read that reports it.
 */
const ourMoveWatch = { uci: null, settle: null };

function awaitSocketConfirm(uci, timeoutMs) {
  return new Promise((resolve) => {
    ourMoveWatch.uci = uci.slice(0, 4);
    ourMoveWatch.settle = resolve;
    setTimeout(() => {
      if (ourMoveWatch.settle !== resolve) return;
      ourMoveWatch.uci = null;
      ourMoveWatch.settle = null;
      resolve(false);
    }, timeoutMs + 100);
  });
}

/** Called from the socket handler when a move it just applied was ours. */
function noteOwnMoveConfirmed(uci) {
  if (!ourMoveWatch.settle || !uci || uci.slice(0, 4) !== ourMoveWatch.uci) return false;
  const settle = ourMoveWatch.settle;
  ourMoveWatch.uci = null;
  ourMoveWatch.settle = null;
  settle(true);
  return true;
}

async function executeMove(moveString, { remainingMs, sideToMove } = {}) {
  // The configured delay is a deliberate human-like pause, not a floor — in
  // a 1-minute bullet game it can eat the clock faster than the opponent
  // does. Scale it down as time runs low rather than ignore it outright, so
  // it still behaves as configured whenever there's plenty of time to spare.
  const delay = moveDelayFor(remainingMs);
  if (delay > 0) {
    logUI(`Waiting ${Math.round(delay)}ms...`, 'info');
    await new Promise(r => setTimeout(r, delay));
  }

  // Must match how every other read/draw in this file finds the board — a
  // plain `document.querySelector('cg-board')` grabs whichever <cg-board> is
  // first in DOM order, which on a page with a sidebar TV/mini-board is not
  // necessarily the real game board.
  const { pickMainBoard } = await loadModules();
  const main = pickMainBoard(document);
  if (!main) {
    logUI('Auto-play failed — could not find the board to execute the move on', 'error');
    return;
  }

  const sourceSq = moveString.substring(0, 2);
  const targetSq = moveString.substring(2, 4);
  const promotionPiece = moveString.length === 5 ? moveString[4] : null;

  const source = getSquareCenter(main.el, sourceSq);
  const target = getSquareCenter(main.el, targetSq);
  if (!source || !target) {
    logUI('Auto-play failed — could not compute square coordinates', 'error');
    return;
  }

  logUI(`Executing ${moveString}...`, 'info');

  // Self-calibrate "Playing As" from a verified outcome rather than a DOM
  // guess: Lichess only ever lets this browser session move its own side's
  // pieces, so the first real, confirmed attempt tells us with certainty
  // which color that is. Left on "Auto-detect", this is what stops it from
  // repeatedly (and pointlessly) trying to play the opponent's side too.
  // Never persisted, and never allowed to overrule what the server said.
  const calibrate = (color, reason) => {
    if (playingAs === 'auto' && color) noteDetectedColor(color, 'move', reason);
  };

  for (let attempt = 1; attempt <= MOVE_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      logUI(`Move ${moveString} did not take — retrying (${attempt}/${MOVE_ATTEMPTS})`, 'warn');
      // A chooser still standing from the last attempt would swallow this
      // attempt's first click as a cancel. Clear it deliberately instead.
      if (promotionPiece) await dismissPromotionChooser();
    }
    markOurMove(OUR_MOVE_SUPPRESS_MS);

    // A drag is one gesture with nothing to wait for in the middle of it,
    // where the two-click form needed a gap between the clicks to keep the
    // browser from folding them into a double-click. Clicking is kept as the
    // retry: it is the form that was verified against Lichess first, and the
    // one to fall back to if a drag is ever refused.
    const asDrag = attempt === 1 && speed.dragMove;
    // A promotion opens a dialog, so the move is not finished when the gesture
    // is; give that case its own, longer deadline whichever attempt it is on.
    const deadline = promotionPiece
      ? PROMOTION_MOVE_TIMEOUT_MS
      : attempt === 1 ? FIRST_ATTEMPT_TIMEOUT_MS : MOVE_LAND_TIMEOUT_MS;

    const confirmed = awaitSocketConfirm(moveString, deadline);
    // Read by handlePromotion: with Lichess's auto-queen preference on, the
    // move is already accepted and no chooser will ever render, so there is
    // nothing to wait for.
    let confirmedEarly = false;
    confirmed.then((ok) => { confirmedEarly ||= ok; });

    const clicked = await clickViaDebugger([source, target],
      asDrag ? { gesture: 'drag' } : { gesture: 'click', delayMs: speed.clickGapMs });
    if (!clicked) {
      logUI('Auto-play failed — could not send input via chrome.debugger', 'error');
      showStatus('Auto-play failed — play it yourself', 'error');
      return;
    }

    if (promotionPiece) await handlePromotion(promotionPiece, () => confirmedEarly);

    // On a live game the server's echo is authoritative and arrives in tens of
    // milliseconds, so polling the board alongside it walks all 32 pieces every
    // 20ms for an answer we are already getting — wasted work on the same
    // thread as the socket handler and the next engine request. The board read
    // is still the answer anywhere the socket is not carrying the game.
    const landed = socketOwnsDetection()
      ? await confirmed
      : await Promise.race([confirmed, waitForMoveToLand(sourceSq, targetSq, deadline)]);

    if (landed) {
      reportLatency(moveString);
      logUI(`Move ${moveString} confirmed on the board`, 'success');
      calibrate(sideToMove, `Confirmed you can move ${sideToMove}'s pieces`);
      showStatus("Opponent's move", 'wait');
      return;
    }

    // The drag is the faster gesture but the less proven one. If it does not
    // take, stop paying for it: retrying with clicks costs a deadline on every
    // single move, which is far worse than the 120ms the drag was saving.
    if (asDrag) {
      speed.dragMove = false;
      logUI('Drag input was not accepted — switching to clicks for this session', 'warn');
    }
  }

  // Every attempt failed. Only *now* is it fair to conclude these are not our
  // pieces: a single miss is far more often a dropped click, a redraw or an
  // animation than a genuine "not your turn", and treating one as proof of
  // colour used to permanently mislabel which side we play — after which the
  // bot politely held still for the rest of the game.
  logUI(`Move ${moveString} did not register after ${MOVE_ATTEMPTS} attempts — play it manually`, 'error');
  showStatus('Move failed — play it yourself', 'error');
  // Only a guess of last resort: a failed move is weak evidence, so it may
  // fill in an unknown colour but never flip one we already had.
  if (!detectedColor) {
    calibrate(
      sideToMove === 'white' ? 'black' : sideToMove === 'black' ? 'white' : null,
      `Couldn't move ${sideToMove}'s piece in ${MOVE_ATTEMPTS} tries (not yours to move)`
    );
  }
}

/**
 * Say how long that whole round trip actually took.
 *
 * Two numbers, because they answer different questions: the total is what the
 * clock lost, and the overhead — everything before the engine was even asked —
 * is the part this extension is responsible for. A single-digit overhead means
 * the socket tap is doing its job; a three-digit one means something fell back
 * to reading the DOM.
 */
function reportLatency(moveString) {
  if (!hot.frameAt) return;
  const total = Math.round(performance.now() - hot.frameAt);
  const overhead = hot.dispatchedAt ? Math.round(hot.dispatchedAt - hot.frameAt) : null;
  hot.frameAt = 0;
  hot.dispatchedAt = 0;

  uiInstance?.updateLatency?.(total, overhead);
  console.log(
    `[chess-engine] ${moveString} landed ${total}ms after the opponent's move hit the socket` +
    `${overhead === null ? '' : ` (${overhead}ms of that before the engine started)`}`
  );
}

/** Start the bot, from the toggle or from auto-resume. */
async function startBot() {
  const started = await startAutoAnalysis({ moveTimeMs: auto.moveTimeMs });
  botActive = Boolean(started);
  if (started) {
    rememberBotOn(true);
    logUI(
      `Bot started — ${autoPlayEnabled ? 'moves will be played automatically' : 'suggest only, you play the moves'}`,
      'success'
    );
  } else {
    logUI('Bot could not start — no board found on this page', 'error');
    uiInstance?.setBotActive(false);
  }
  return botActive;
}

/**
 * Keep the bot on from one game to the next, within this tab.
 *
 * A new game is a new page load, which used to leave the bot off every time —
 * and by the time you had clicked it back on, the opponent had often already
 * moved. sessionStorage is per tab and dies with it, so this only ever resumes
 * a bot you switched on in this same tab and have not switched off since; the
 * toggle's "off" clears it.
 */
const BOT_ON_KEY = 'cbe-bot-on';
const RESUME_POLL_MS = 500;
let resumeTimer = null;

function rememberBotOn(on) {
  try {
    if (on) sessionStorage.setItem(BOT_ON_KEY, '1');
    else sessionStorage.removeItem(BOT_ON_KEY);
  } catch { /* storage blocked: the bot simply will not auto-resume */ }
}

function botWasOn() {
  try { return sessionStorage.getItem(BOT_ON_KEY) === '1'; } catch { return false; }
}

/**
 * Wait for a live game, then start the bot on it.
 *
 * @param {{sameGameOk?: boolean}} options  false after a game ends, so the bot
 *   waits for the *next* game (a different URL) rather than restarting on the
 *   finished one.
 */
function armAutoResume({ sameGameOk = false } = {}) {
  clearInterval(resumeTimer);
  if (!botWasOn()) return;
  const endedOn = location.pathname;
  // Visible, so a bot that will switch itself back on is never a surprise.
  showStatus(sameGameOk ? 'Waiting for a game — will auto-start' : 'Next game: bot will auto-start',
    'wait', { force: true });

  resumeTimer = setInterval(async () => {
    if (botActive || orphaned || !botWasOn() || !uiInstance) {
      clearInterval(resumeTimer);
      return;
    }
    if (!sameGameOk && location.pathname === endedOn) return;
    // orientationColor() is only non-null on a game you are actually playing.
    if (!orientationColor() || !mods?.pickMainBoard?.(document)) return;

    clearInterval(resumeTimer);
    logUI('New game — switching the bot back on', 'info');
    uiInstance.setBotActive(true);
    await startBot();
  }, RESUME_POLL_MS);
}

const SETTINGS_KEY = 'chessEngineSettings';

/**
 * Persisted so a page reload (a new game loading, a manual refresh) cannot
 * silently revert a choice you made — e.g. Auto-Play being off looking like
 * it turned itself back on because a fresh content-script instance quietly
 * restarted at its hardcoded defaults. `botActive` itself is deliberately
 * NOT persisted: never resume driving the board without an explicit toggle.
 */
async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    return stored?.[SETTINGS_KEY] ?? {};
  } catch {
    return {};   // storage unavailable (e.g. extension mid-reload) — use defaults
  }
}

function saveSettings(patch) {
  chrome.storage.local.get(SETTINGS_KEY)
    .then((stored) => chrome.storage.local.set({
      [SETTINGS_KEY]: { ...(stored?.[SETTINGS_KEY] ?? {}), ...patch }
    }))
    .catch(() => { /* non-critical: worst case, defaults apply next load */ });
}

function initBotUI() {
  Promise.all([loadModules(), loadSettings()]).then(([{ BotUI, MODES, CPU_MODES, DEFAULT_CPU_MODE, ENGINES, DEFAULT_ENGINE, getEngine }, settings]) => {
    if (!BotUI) {
      console.error('[chess-engine] BotUI not found in modules');
      return;
    }
    auto.moveTimeMs = settings.moveTimeMs ?? auto.moveTimeMs ?? 1500;
    moveDelayMs = settings.moveDelayMs ?? moveDelayMs;
    autoPlayEnabled = settings.autoPlayEnabled ?? autoPlayEnabled;
    indicator.enabled = settings.arrowsEnabled ?? indicator.enabled;
    // A new key on purpose: the old `playingAs` value was mostly written by
    // auto-detection, i.e. it is last game's colour, not a choice anyone made.
    playingAs = settings.playingAsChoice ?? 'auto';
    botMode = settings.mode ?? botMode;
    speed.instant = settings.instantMode ?? speed.instant;
    cpuMode = settings.cpuMode ?? DEFAULT_CPU_MODE;
    // Resolved through the catalogue rather than trusted: an engine that has
    // since been removed is still sitting in storage for anyone who selected it,
    // and a stale id would leave the picker with nothing pressed while every bot
    // start sent a name the catalogue no longer knows.
    engineChoice = getEngine(settings.engineId ?? DEFAULT_ENGINE).id;

    uiInstance = new BotUI({
      initialMoveTimeMs: auto.moveTimeMs,
      initialDelay: moveDelayMs,
      initialInstant: speed.instant,
      initialArrows: indicator.enabled,
      initialAutoPlay: autoPlayEnabled,
      initialPlayingAs: playingAs,
      initialMode: botMode,
      modes: MODES,
      cpuModes: CPU_MODES,
      initialCpuMode: cpuMode,
      engines: ENGINES,
      initialEngine: engineChoice,
      onToggleBot: async (active) => {
        if (active) {
          await startBot();
        } else {
          // An explicit "off" is the one thing that ends auto-resume.
          rememberBotOn(false);
          botActive = false;
          stopAutoAnalysis();
          uiInstance.log('Bot stopped', 'warn');
        }
      },
      onMoveTimeChange: (moveTimeMs) => {
        auto.moveTimeMs = moveTimeMs;
        saveSettings({ moveTimeMs });
        uiInstance.log(`Think time set to ${moveTimeMs}ms`, 'info');
      },
      onDelayChange: (delay) => {
        moveDelayMs = delay;
        saveSettings({ moveDelayMs: delay });
        uiInstance.log(
          speed.instant
            ? `Move delay set to ${delay}ms — takes effect once Instant is off`
            : `Move delay set to ${delay}ms`,
          'info'
        );
      },
      onInstantChange: (enabled) => {
        speed.instant = enabled;
        saveSettings({ instantMode: enabled });
        uiInstance.log(
          enabled
            ? 'Instant on — the move goes out as soon as the engine answers'
            : `Instant off — pausing up to ${moveDelayMs}ms before each move`,
          'info'
        );
      },
      onHighlightChange: (enabled) => {
        setIndicators(enabled);
        saveSettings({ arrowsEnabled: enabled });
        uiInstance.log(`Highlights ${enabled ? 'enabled' : 'disabled'}`, 'info');
      },
      onAutoPlayChange: (enabled) => {
        autoPlayEnabled = enabled;
        saveSettings({ autoPlayEnabled: enabled });
        // Keep the attachment in step: turning Auto-Play off mid-game should
        // drop the banner, turning it back on while the bot runs should take
        // it once rather than at the next move.
        if (botActive) setDebuggerHold(enabled);
        uiInstance.log(
          enabled ? 'Auto-play enabled — moves will be played automatically' : 'Suggest only — moves will be highlighted, not played',
          'info'
        );
      },
      onModeChange: async (value) => {
        botMode = value;
        saveSettings({ mode: value });
        const { getMode } = await loadModules();
        const style = getMode(value);
        uiInstance.log(`Style: ${style.label} — ${style.hint}`, 'info');
      },
      /**
       * Measure every engine over the same positions at the current think time.
       *
       * The whole point is to answer the big-net question with numbers from
       * this machine rather than from someone's Elo table, so it deliberately
       * uses the think time that is actually configured — benchmarking at a
       * setting you never play at would prove nothing about how you play.
       */
      onBenchmarkClick: async () => {
        if (botActive) {
          uiInstance.log('Stop the bot before benchmarking — they would compete for the engine', 'warn');
          return;
        }
        const { ENGINES: catalogue, benchDurationMs, compare } = mods ?? {};
        const ids = (catalogue ?? []).map((engine) => engine.id);
        const moveTimeMs = auto.moveTimeMs ?? 1500;
        const seconds = Math.ceil(benchDurationMs(moveTimeMs, ids.length) / 1000);
        uiInstance.log(
          `Benchmarking ${ids.length} engines at ${moveTimeMs}ms — about ${seconds}s, ` +
          'the first run of each also pays to load its net', 'info'
        );

        const reply = await askEngine(
          { type: 'BENCHMARK', moveTimeMs, engines: ids },
          { timeoutMs: (seconds + 120) * 1000 }
        );
        if (!reply?.ok) {
          uiInstance.log(`Benchmark failed: ${reply?.error ?? 'no response'}`, 'error');
          return;
        }

        const results = reply.results ?? [];
        const baseline = results.find((r) => r.summary?.positions)?.summary;
        for (const result of results) {
          const s = result.summary;
          if (!s?.positions) {
            uiInstance.log(`${result.requested}: no usable searches`, 'warn');
            continue;
          }
          // Says what actually ran, because a machine without shared memory
          // benchmarks SF18 three times and the averages would look mysterious.
          const ran = result.engineId === result.requested
            ? `${result.label} (${result.tag})`
            : `${result.label} — fell back from ${result.requested}`;
          const rel = baseline && s !== baseline
            ? (() => {
                const { depthDelta, npsRatio } = compare(baseline, s);
                return `, ${depthDelta >= 0 ? '+' : ''}${depthDelta} depth` +
                  (npsRatio ? ` and ${npsRatio}x nps vs the first` : '');
              })()
            : '';
          uiInstance.log(
            `${ran}: depth ${s.depth} avg, ${(s.nps / 1000).toFixed(0)}k nps, ` +
            `${result.threads} thread${result.threads === 1 ? '' : 's'}${rel}`,
            'success'
          );
        }
        // Depth only compares like with like. The two SF19 builds share a
        // search and differ only in net, so depth between them is a fair
        // measure of what the bigger net costs. SF18 is a different major
        // version with different pruning, so its "depth 17" is not the same
        // unit of work as SF19's — reading that row as a straight win is how
        // you talk yourself into running the older engine.
        uiInstance.log(
          'Depth compares fairly between the two SF19 builds — same search, ' +
          'different net, so deeper is stronger. SF18 runs a different search, ' +
          'so its depth is not the same unit: treat that row as indicative only.',
          'info'
        );
      },

      /**
       * Switch engine build.
       *
       * Reports what actually came up rather than what was asked for: SF19
       * needs shared memory and has no single-threaded build, so on a machine
       * that cannot provide it the offscreen document falls back to SF18 — and
       * a picker that claimed otherwise would be lying.
       */
      onEngineChange: async (value) => {
        engineChoice = value;
        saveSettings({ engineId: value });
        uiInstance.log('Switching engine — reloading the neural net...', 'info');
        const reply = await askEngine({ type: 'SET_ENGINE', id: value }, { timeoutMs: 60_000 });
        if (reply?.engine) uiInstance.updateEngine?.(reply.engine);
        const live = reply?.engine;
        if (!live) {
          uiInstance.log('Engine switch failed — see the extension console', 'error');
          return;
        }
        const asked = mods?.getEngine?.(value);
        uiInstance.log(
          live.engineId === value
            ? `Engine: ${live.label} (${live.tag}) — ${live.threads} thread${live.threads === 1 ? '' : 's'}`
            : `Engine: asked for ${asked?.label ?? value}, got ${live.label} — that build would not start here`,
          live.engineId === value ? 'success' : 'warn'
        );
      },
      onCpuModeChange: async (value) => {
        cpuMode = value;
        saveSettings({ cpuMode: value });
        // Applied immediately rather than at the next game: the point of the
        // control is to turn the fans down now.
        const reply = await askEngine({ type: 'SET_CPU_MODE', mode: value }, { timeoutMs: 30_000 });
        if (reply?.engine) uiInstance.updateEngine?.(reply.engine);
        const chosen = mods?.getCpuMode?.(value);
        uiInstance.log(
          `CPU: ${chosen?.label ?? value}${reply?.engine ? ` — ${reply.engine.threads} thread` +
            `${reply.engine.threads === 1 ? '' : 's'}` : ''}`,
          'info'
        );
      },
      onSyncClick: () => forceSync(),
      onPlayingAsChange: (value) => {
        playingAs = value;
        saveSettings({ playingAsChoice: value });
        if (botActive) socketFeed.ourColor = ourColor()?.[0] ?? null;
        uiInstance.log(
          value === 'auto' ? 'Playing as: auto-detect (from board orientation)' : `Playing as: ${value}`,
          'info'
        );
      }
    });
    uiInstance.log('Bot UI loaded successfully', 'info');
    // The bot was on in this tab's previous game: carry it into this one.
    armAutoResume({ sameGameOk: true });
  }).catch(err => {
    console.error('[chess-engine] Failed to initialize Bot UI:', err);
    alert('FrameZero Extension Error: Check console. ' + err.message);
  });
}

/**
 * The manifest already scopes this script to lichess.org, but a second check
 * here keeps the widget off any page it has no business on if the extension is
 * ever injected by hand (chrome.scripting, a DevTools snippet, a wider match
 * pattern added later). Bare host or any subdomain both count.
 */
function isLichess() {
  const host = location.hostname;
  return host === 'lichess.org' || host.endsWith('.lichess.org');
}

if (!isLichess()) {
  console.log('[chess-engine] not lichess.org — bot UI not mounted');
} else if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initBotUI);
} else {
  initBotUI();
}

// ---------------------------------------------------------------------------
// Engine round trip
// ---------------------------------------------------------------------------

/**
 * Read a side's remaining time straight off Lichess's own clock DOM —
 * verified live: `.rclock-white .time` / `.rclock-black .time`, text like
 * "1:00" (or "1 minute" before the clock has ticked even once, which is
 * intentionally left unparsed below — plenty of time remains at that point
 * anyway, so falling back to the requested Think Time is harmless).
 */
function parseClockText(text) {
  const parts = text.trim().split(':').map(Number);
  if (parts.length < 2 || parts.some(Number.isNaN)) return null;
  return parts.reduce((seconds, part) => seconds * 60 + part, 0) * 1000;
}

function getRemainingMs(color) {
  const el = document.querySelector(`.rclock-${color} .time`);
  return el ? parseClockText(el.textContent) : null;
}

/**
 * Auto-play gate shared by the engine path and the opening-book path: only
 * enforced once a color is known, either because you explicitly picked one
 * in "Playing As" or because executeMove() self-calibrated it from a
 * verified move — there is no reliable way to guess it from the DOM alone
 * up front (board orientation is the closest signal, but it's also flipped
 * by spectators, analysis boards, and anyone who has just turned the view
 * around). Left ungated, "Auto-detect" would otherwise attempt to play
 * *both* sides' moves — including White's opening move before White has
 * even moved, if you're set up to play Black.
 */
function maybeAutoPlay(bestmove, sideToMove, remainingMs) {
  if (!(botActive && bestmove)) return;

  if (!autoPlayEnabled) {
    const ours = ourColor() ?? orientationColor();
    if (ours && ours !== sideToMove) showStatus("Opponent's move", 'wait');
    else showStatus('Your move — play the suggestion', 'on');
    return;
  }

  const color = ourColor();
  if (color) {
    if (color === sideToMove) {
      showStatus('Playing move…', 'busy');
      executeMove(bestmove, { remainingMs, sideToMove });
    } else {
      showStatus("Opponent's move", 'wait');
      logUI(`Auto-play holding — you're playing ${color}, but it's ${sideToMove}'s move`, 'info');
    }
    return;
  }

  const assumed = orientationColor();
  if (assumed && assumed !== sideToMove) {
    showStatus("Opponent's move", 'wait');
    logUI(`Auto-play holding — the board is set up from ${assumed}'s side, and it's ${sideToMove}'s move`, 'info');
    return;
  }
  showStatus('Playing move…', 'busy');
  executeMove(bestmove, { remainingMs, sideToMove });
}

/**
 * Your colour on a page where you are actually playing.
 *
 * Board orientation is a poor guess in general — spectators, analysis boards
 * and anyone who has hit the flip button all break it — but on a live game
 * Lichess draws the board from your own side, and `body.playing` is what marks
 * that page out. Restricted that way it is a sound default for "Playing As:
 * auto", and it is the difference between holding still and confidently
 * playing White's opening move while you are sitting behind Black.
 */
function orientationColor() {
  // `body.playing` is the cleanest marker of a live game, but it is not the
  // only one and it is not always set the moment the page settles — and when
  // it is missing this used to return null, which left Auto-Play with no
  // opinion at all and made starting the bot mid-game feel dead until a move
  // or two had gone by. A board you are allowed to drag pieces on
  // (`.manipulable`) alongside a running clock is the same fact stated a
  // different way: spectator boards are never manipulable, and analysis
  // boards have no clock.
  const playing = document.body?.classList.contains('playing');
  const manipulable = document.querySelector('.cg-wrap.manipulable');
  const hasClock = document.querySelector('.rclock, .clock');
  if (!playing && !(manipulable && hasClock)) return null;

  const wrap = manipulable ?? document.querySelector('.cg-wrap');
  if (!wrap) return null;
  return wrap.classList.contains('orientation-black') ? 'black' : 'white';
}

/**
 * A known opening doesn't need Stockfish to re-derive moves that have been
 * standard theory for decades — instant, and shows the opening's name, the
 * way a human recognizes a position from memory rather than calculating it.
 * Only consulted for the first BOOK_MAX_PLIES plies of the game; beyond
 * that (or the moment a line runs past what's in the book) this defers to
 * the engine exactly as before.
 *
 * @returns {Promise<boolean>} true if a book move was found and handled —
 *   the caller should skip calling the engine for this position.
 */
const BOOK_MAX_PLIES = 30;   // ~15 full moves, per how far this book goes

async function tryBookMove({ remainingMs: clockOverride } = {}) {
  const verbose = board.history({ verbose: true });
  if (verbose.length >= BOOK_MAX_PLIES) return false;

  const { lookupOpening, getBook, getMode, historyReachesFromStart, Chess } = await loadModules();
  const uciHistory = verbose.map((m) => `${m.from}${m.to}${m.promotion ?? ''}`);

  // The book is keyed on the moves since move one. If the board was loaded
  // mid-game and its history could not be restored, an empty (or short)
  // history is not "the opening" — consulting the book then is how the bot
  // used to suggest 1.e4 in a middlegame. Let the engine handle it.
  if (!historyReachesFromStart(Chess, uciHistory, board.fen().split(' ')[0])) return false;

  // The style picks the book, so a sharp mode is already sharp on move one
  // rather than only once theory runs out. The gambit book is drawn from at
  // random (weighted by how many lines back each move) — a deterministic
  // majority vote would mean the same gambit every single game, which is the
  // opposite of what a "fun mode" is for. The mainline book stays
  // deterministic: it exists to play the main line.
  const style = getMode(botMode);
  const book = getBook(style.book);
  const { name, eco, bookMove } = lookupOpening(uciHistory, {
    book,
    ...(style.book === 'gambit' ? { random: Math.random } : {})
  });

  if (uiInstance) uiInstance.updateOpening?.(name);

  if (!bookMove) {
    if (name) logUI(`Leaving book: ${name}${eco ? ` (${eco})` : ''} — switching to engine analysis`, 'info');
    return false;
  }

  const sideToMove = board.turn() === 'w' ? 'white' : 'black';
  const remainingMs = Number.isInteger(clockOverride)
    ? clockOverride
    : getRemainingMs(sideToMove);

  // Resolve to SAN for a readable log, the same way engine moves are shown.
  const moveObj = board.moves({ verbose: true })
    .find((m) => `${m.from}${m.to}${m.promotion ?? ''}` === bookMove);
  const sanMove = moveObj?.san ?? bookMove;

  logUI(
    `Book move ${sanMove}${name ? ` — ${name}${eco ? ` (${eco})` : ''}` : ''} — ${sideToMove} to move`,
    'success'
  );
  uiInstance?.updateBestMove?.(sanMove, `book · ${whoseMoveNote(sideToMove)}`);

  if (indicator.enabled) {
    drawBestMove(bookMove, { sideToMove }).catch((err) =>
      console.warn('[chess-engine] could not draw indicator:', err.message ?? err));
  }

  // A book move is the decision, so this is the moment a search would
  // otherwise have started — which keeps the reported overhead comparable
  // between a book move and an engine move.
  hot.dispatchedAt = performance.now();

  // No search ran, so there is no prediction — and the previous move's would
  // describe a position two plies back.
  predictedReply = null;

  maybeAutoPlay(bookMove, sideToMove, remainingMs);
  return true;
}

/**
 * Send a FEN to the background engine and log the best move.
 *
 * @param {string} fenString           Position in FEN notation.
 * @param {{moveTimeMs?: number}} opts  Engine think time — the "Think Time" UI
 *   setting; defaults in background.js when omitted.
 * @returns {Promise<object|null>} The engine's reply, or null if it failed.
 */
async function analyzeCurrentPosition(fenString, { moveTimeMs, remainingMs: clockOverride, opponentMs: opponentOverride } = {}) {
  const { validateFen, Chess, repetitionContext } = mods ?? await loadModules();

  const check = validateFen(fenString);
  if (!check.ok) {
    logUI(`Rejected FEN: ${check.error}`, 'error');
    return null;
  }

  const position = new Chess(fenString);
  const sideToMove = position.turn() === 'w' ? 'white' : 'black';
  // The socket carries the clock as an exact millisecond figure; Lichess's own
  // clock DOM is rounded to the second and reads "1 minute" until the first
  // tick. Prefer the exact one whenever the fast path supplied it.
  const remainingMs = Number.isInteger(clockOverride)
    ? clockOverride
    : getRemainingMs(sideToMove);

  // The gap between "opponent moved" and "Best move ..." showing up in the
  // log used to be silent — indistinguishable from the extension having
  // missed the move entirely. It's really just the engine's think time (now
  // directly configurable, see Think Time) plus the debounce/board-read
  // overhead; showing it explicitly makes that visible instead of mysterious.
  // The status strip says the engine is working; the eval tile keeps the last
  // score rather than flickering to a placeholder on every move.
  showStatus('Thinking…', 'busy');

  // Stamped here rather than at the call site so it means the same thing for
  // every caller: the moment the engine actually started working.
  hot.dispatchedAt = performance.now();

  const opponentMs = Number.isInteger(opponentOverride)
    ? opponentOverride
    : getRemainingMs(sideToMove === 'white' ? 'black' : 'white');

  // The game's recent moves, so the engine can see repetitions, plus which of
  // our moves would repeat a position — only when this is the tracked board.
  const repetition = board && fenString === board.fen() ? repetitionContext(board) : null;

  const response = await askEngine({
    type: 'ANALYZE_FEN',
    fen: fenString,
    mode: botMode,
    ...(Number.isInteger(moveTimeMs) ? { moveTimeMs } : {}),
    ...(Number.isInteger(remainingMs) ? { remainingMs } : {}),
    ...(Number.isInteger(opponentMs) ? { opponentMs } : {}),
    ...(repetition?.moves.length ? { history: { rootFen: repetition.rootFen, moves: repetition.moves } } : {}),
    ...(repetition?.avoid.length && antiDraw ? { avoidMoves: repetition.avoid } : {})
  });

  if (!response?.ok) {
    logUI(`Engine error: ${response?.error ?? 'no response'}`, 'error');
    showStatus('Engine error — see log', 'error');
    return null;
  }

  const { bestmove, ponder, depth: reachedDepth, score, pv, engineBest, reason } = response;
  predictedReply = ponder ?? null;

  // UCI's `score cp`/`score mate` is relative to whoever is on move in this
  // position, not to White. Left as-is, the same winning-for-White position
  // reads as positive when White is to move and negative when Black is to
  // move — flipping the sign for Black puts it in the conventional "positive
  // = good for White" frame every chess eval bar (Lichess included) uses.
  const fromWhite = sideToMove === 'black' ? -1 : 1;
  const pawns = score?.type === 'cp' ? (fromWhite * score.value) / 100 : null;
  const mateIn = score?.type === 'mate' ? fromWhite * score.value : null;
  const evaluation =
    mateIn !== null ? `mate in ${Math.abs(mateIn)} (${mateIn > 0 ? 'White' : 'Black'})` :
    pawns !== null  ? `${pawns > 0 ? '+' : ''}${pawns.toFixed(2)}` :
    'n/a';

  // Shown from your side when your colour is known — the log keeps the
  // White-relative figure, which is the convention for a written record.
  uiInstance?.updateScore?.({ pawns, mateIn }, ourColor() ?? orientationColor());

  // "e1g1" is unambiguous to the engine but not to a human reading the log —
  // resolving it to SAN in this exact position is what turns that into "O-O"
  // and makes a recommended castle actually readable as a castle.
  const moveObj = bestmove
    ? position.moves({ verbose: true }).find((m) => `${m.from}${m.to}${m.promotion ?? ''}` === bestmove)
    : null;
  const sanMove = moveObj?.san ?? bestmove;
  uiInstance?.updateBestMove?.(sanMove,
    response.mode === 'tablebase' ? `tablebase · ${whoseMoveNote(sideToMove)}`
      : `depth ${reachedDepth ?? '?'} · ${whoseMoveNote(sideToMove)}`);

  logUI(
    `Best move ${sanMove}${ponder ? ` (ponder ${ponder})` : ''} — ` +
    `${sideToMove} to move, depth ${reachedDepth ?? '?'}, eval ${evaluation}`,
    'success'
  );

  // A tablebase move is not an opinion, so it is worth saying so: inside seven
  // pieces the move is provably optimal, and the depth and eval above come from
  // a solved table rather than from a search.
  if (response.mode === 'tablebase') logUI(reason, 'success');

  // Only worth saying when the style actually overrode the engine. Saying it
  // every move would bury the fact in noise on the moves where the style
  // agreed with the engine anyway — which is most of them.
  if (engineBest && bestmove !== engineBest) {
    const engineObj = position.moves({ verbose: true })
      .find((m) => `${m.from}${m.to}${m.promotion ?? ''}` === engineBest);
    const who = reason?.startsWith('avoided repetition') ? 'Anti-draw' : `Style "${botMode}"`;
    logUI(`${who} — ${reason} (engine wanted ${engineObj?.san ?? engineBest})`, 'info');
  }
  if (pv?.length) console.log(`[chess-engine] pv: ${pv.join(' ')}`);

  if (indicator.enabled && bestmove) {
    // Drawing must never take down the analysis result.
    drawBestMove(bestmove, { sideToMove }).catch((err) =>
      console.warn('[chess-engine] could not draw indicator:', err.message ?? err));
  }
  
  maybeAutoPlay(bestmove, sideToMove, remainingMs);

  return response;
}

/**
 * Spend the opponent's clock instead of watching it run.
 *
 * Stockfish keeps a 128 MB transposition table (see HASH_MB in offscreen.js)
 * that survives between searches. Searching the position the opponent is
 * currently thinking about fills that table with the exact subtree our next
 * search will walk, so when their move lands the real search starts warm and
 * reaches several plies deeper inside the same think time.
 *
 * Deliberately not UCI `ponder`: real pondering commits to one predicted
 * reply and throws the work away on a miss. Searching the parent position
 * covers every reply, so the warm-up pays off whatever the opponent plays.
 */
function prewarmEngine() {
  if (!(botActive && speed.prewarm)) return;

  // One ply further on than the current position, when the engine told us what
  // it expects. `positionAfter` plays the predicted reply on the board and
  // undoes it, so it hands back the child FEN with the real board untouched.
  const expected = predictedReply;
  predictedReply = null;
  const child = expected && mods?.positionAfter
    ? mods.positionAfter(board, expected)
    : null;

  // Falling back to the current position is the old behaviour, and it is the
  // right fallback: it still warms the table, just spread across every reply
  // instead of concentrated on one. A book move has no prediction attached, so
  // this is the normal path early in a game.
  tellEngine({ type: 'PREWARM', fen: child ?? board.fen() });
  if (child) console.debug(`[chess-engine] prewarming past predicted ${expected}`);
}

/** Read the board off the page, then analyse it. */
async function analyzeBoard(options = {}) {
  const read = await initBoardFromDOM(options);
  if (!read) return null;
  return analyzeCurrentPosition(getCurrentFEN(), options);
}

// ---------------------------------------------------------------------------
// Auto-detection: watch the board and analyse when the position changes
// ---------------------------------------------------------------------------

const auto = {
  observer: null,
  target: null,
  trigger: null,       // debounced callback
  inFlight: false,     // an analysis round trip is running
  moveTimeMs: undefined,
  ourMoveTimer: null
};

/**
 * Set while we are driving the board ourselves, so the observer ignores the
 * mutations we caused. Nothing in this extension sets it yet; it exists as the
 * guard hook for a future caller.
 */
let isOurMove = false;

/**
 * Set whenever a mutation arrives while suppressed, so it isn't lost outright.
 * A fast opponent (a low-level engine especially) can reply within the same
 * suppression window our own move opened; without this, that mutation was
 * simply discarded, and detection only resumed whenever some *unrelated*
 * mutation happened to occur afterward (a clock re-render, a hover state,
 * anything in the observed subtree) — unpredictable, and often several
 * seconds later. This is exactly the "detects late" symptom: not a slow
 * detector, a dropped one.
 */
let pendingRecheck = false;

/**
 * How long to ignore our own move's DOM churn.
 *
 * This used to be 1200ms, which in a bullet game was worse than the problem it
 * solved: a fast opponent replies inside that window, and detection did not
 * resume until the timer expired. It can be short now because the socket path
 * lifts the suppression the moment the server echoes our move back (see
 * onSocketEvent) — this timer is only the backstop for a page with no socket.
 */
const OUR_MOVE_SUPPRESS_MS = 400;

/** Suppress observer processing for `ms`, then release and catch up on anything missed. */
function markOurMove(ms = OUR_MOVE_SUPPRESS_MS) {
  isOurMove = true;
  clearTimeout(auto.ourMoveTimer);
  auto.ourMoveTimer = setTimeout(() => {
    isOurMove = false;
    if (pendingRecheck) {
      pendingRecheck = false;
      handleBoardMutation();
    }
  }, ms);
  return isOurMove;
}

/**
 * The board changed. Work out what happened and, if the position really moved
 * on, analyse it.
 *
 * Only the placement field is compared. The rendered-pieces source cannot see
 * turn, castling, en passant or the move counters, so a full-FEN comparison
 * would report a difference on every single tick.
 */
/** Log to the on-page UI when it exists, always to console too. */
function logUI(message, type = 'info') {
  if (type === 'error') console.error('[chess-engine]', message);
  else console.log('[chess-engine]', message);
  uiInstance?.log(message, type);
}

/**
 * Update the panel's status strip. Ignored while the bot is off, so a late
 * reply cannot paint "Thinking…" over OFF — unless `force`, for the states
 * that only exist while it is off (refresh needed, waiting for the next game).
 */
function showStatus(label, kind = 'on', { force = false } = {}) {
  if (!botActive && !force) return;
  uiInstance?.setStatus?.(label, kind);
}

/** "your move" / "their move", or plain "white to move" when our colour is unknown. */
function whoseMoveNote(sideToMove) {
  const ours = ourColor() ?? orientationColor();
  if (!ours) return `${sideToMove} to move`;
  return ours === sideToMove ? 'your move' : 'their move';
}

/**
 * Bring `board` in line with a freshly read position, however that turns out
 * to be possible — shared by the auto-detect resync path and the Sync
 * button, so both get the same fixes instead of one quietly lacking what the
 * other already has (which is exactly how the Sync button ended up always
 * defaulting to White: it hard-reloaded from the DOM without ever going
 * through the turn-inference logic this function centralizes).
 *
 * Tries the honest way first — replaying an actual legal move sequence via
 * chess.js, which gets turn/castling/en passant/counters exactly right for
 * free — before falling back to a best-effort reset.
 *
 * @returns {Promise<{kind: 'unchanged'} | {kind: 'derived', played: object[]} | {kind: 'reset', turnKnown: boolean}>}
 */
/** board.load() that reports failure instead of throwing. */
function tryLoad(fen) {
  try {
    board.load(fen);
    return true;
  } catch {
    return false;
  }
}

async function reconcileBoard(hit) {
  const parts = hit.fen.split(' ');
  const seen = parts[0];

  // The side to move as the *page* reports it. Now that readMoveSignals() can
  // read it off the last-move highlight, this is almost always a real answer
  // rather than a default, which is what lets everything below stop guessing.
  const known = hit.complete || hit.turnConfirmed ? parts[1] : null;

  if (seen === board.fen().split(' ')[0]) {
    // Identical pieces and an agreeing turn means nothing actually happened.
    if (!known || known === board.turn()) return { kind: 'unchanged' };
    // Same pieces but the page says it is the other side's turn: our own
    // record drifted — typically a move we thought we played and didn't. Fall
    // through and rebuild from the page rather than defend a stale turn.
  } else {
    const { deriveMoves } = await loadModules();
    const played = deriveMoves(board, seen);

    // Replaying real moves is the best outcome: turn, castling, en passant and
    // the counters all stay exact, and we learn the move in SAN for the log.
    // But it only counts if it also lands on the side to move the page is
    // showing — otherwise it found a same-placement transposition of the wrong
    // length, and honouring it would flip the turn the wrong way.
    if (played?.length && (!known || board.turn() === known)) return { kind: 'derived', played };
    for (let i = 0; i < (played?.length ?? 0); i++) board.undo();
  }

  // Too far apart to bridge move by move — but the game's own move list can
  // rebuild the whole thing exactly, history included, before resorting to a
  // reset that has to guess.
  if (restoreHistory(hit) && (!known || board.turn() === known)) {
    return { kind: 'reset', turnKnown: true };
  }

  const { inferCastlingRights } = await loadModules();
  // Without a known turn the only remaining signal is "not whoever was on move
  // before", since a normal game advances one ply between reads.
  const turn = known ?? (board.turn() === 'w' ? 'b' : 'w');
  const castling = hit.complete ? parts[2] : inferCastlingRights(seen);
  const ep = parts[3] ?? '-';

  // An en passant square is a guess about legality as much as geometry, so if
  // chess.js will not take it, keep the position and drop the square.
  if (!tryLoad(`${seen} ${turn} ${castling} ${ep} 0 1`)) {
    tryLoad(`${seen} ${turn} ${castling} - 0 1`);
  }
  return { kind: 'reset', turnKnown: known !== null };
}

// ---------------------------------------------------------------------------
// Fast path: Lichess's own round socket
// ---------------------------------------------------------------------------

/**
 * How long after a socket event the DOM watchdog stays out of the way.
 *
 * The socket path has already updated `board` before chessground even begins
 * animating, so a mutation arriving inside this window is the render of a move
 * we have handled. Letting handleBoardMutation() run anyway would not be wrong
 * — its placement check no-ops — but it would first pay for a full board read
 * and the animation settle loop, on the same thread the engine request is
 * queued on. Past this window, silence means something changed that the socket
 * did not report, and the watchdog should look.
 */
const WATCHDOG_QUIET_MS = 1_500;

const socketFeed = {
  moves: 0,            // move events successfully applied this session
  desyncs: 0,
  lastEventAt: 0,
  ourColor: null,      // 'w' | 'b', ideally straight from the server's dests
  queued: null         // newest event that arrived while we were still busy
};

/** Is the socket carrying this game, such that the DOM watchdog should hold off? */
function socketOwnsDetection() {
  return socketFeed.moves > 0 && Date.now() - socketFeed.lastEventAt < WATCHDOG_QUIET_MS;
}

/** Shared game-over handling, whatever noticed it. */
function finishGame(message, type = 'warn') {
  botActive = false;
  stopAutoAnalysis();
  // The next game may well be played with the other colour.
  detectedColor = null;
  detectedFrom = null;
  socketFeed.ourColor = null;
  uiInstance?.setDetectedColor?.(null);
  uiInstance?.setGameOver();
  logUI(message, type);
  armAutoResume();
}

/**
 * Our colour, learned from the one source that cannot be wrong about it.
 *
 * Lichess sends a `dests` map only to the client it is expecting a move from,
 * so a move event that hands us the turn *and* carries dests is the server
 * stating which side this browser plays. That is strictly better than the
 * board-orientation guess (spectators, analysis boards and the flip button all
 * break it) and than waiting for executeMove() to calibrate from a move that
 * happened to work — and it is known before we have played anything.
 */
function noteOurColor(color) {
  if (!color) return;
  noteDetectedColor(color === 'w' ? 'white' : 'black', 'server', 'Lichess says so');
  socketFeed.ourColor = ourColor()?.[0] ?? color;
}

/**
 * One event from page-bridge's socket tap.
 *
 * This is the hot path, and it is deliberately flat: no DOM read, no bridge
 * round trip, no animation wait, no move derivation. The frame already says
 * exactly what was played, by whom, and with how much time left, so the whole
 * job is to apply it and decide.
 */
async function onSocketEvent(raw, frameAt) {
  const t = raw?.t;
  if (!t) return;
  socketFeed.lastEventAt = Date.now();
  // Socket frames are the one heartbeat a hidden tab still delivers on time.
  touchEngineLink();

  if (t === 'reload' || t === 'resync') {
    if (botActive) {
      logUI('Lichess asked the client to resync — re-reading the board', 'warn');
      forceSync();
    }
    return;
  }

  if (t === 'end' || t === 'endData') {
    if (botActive) finishGame('Game over (reported by Lichess)');
    return;
  }

  if (t !== 'move') return;   // 'clock' carries no position information

  const m = mods ?? await loadModules();
  const event = m.normalizeMoveEvent(raw.d);
  if (!event) return;

  // Worth learning even with the bot off, so that turning it on mid-game
  // already knows which side it is allowed to move for.
  if (event.ourTurn && event.sideToMove) noteOurColor(event.sideToMove);

  if (!board || !botActive) return;

  const applied = m.applySocketMove(board, event);
  if (!applied.ok) {
    // Joined mid-game, or our record drifted. The DOM path is the one that
    // knows how to rebuild a position from scratch, so hand over to it rather
    // than carry on from a board that is now fiction.
    socketFeed.desyncs++;
    console.debug('[chess-engine] socket move did not apply:', event.san ?? event.uci);
    forceSync();
    return;
  }

  socketFeed.moves++;
  lastSource = {
    fen: board.fen(),
    source: 'round-socket',
    complete: true,
    settled: true,
    turnConfirmed: true,
    path: null
  };

  // The server has confirmed a move, so whatever we were suppressing is
  // settled — there is nothing left to guess about and nothing to catch up on.
  isOurMove = false;
  pendingRecheck = false;
  clearTimeout(auto.ourMoveTimer);
  const wasOurs = noteOwnMoveConfirmed(event.uci ?? '');

  const decision = m.decideResponse(event, { ourColor: socketFeed.ourColor });

  if (decision.act === 'stop') {
    finishGame(`Game over${event.winner ? ` — ${event.winner} wins` : ''}`);
    return;
  }

  if (decision.act === 'ponder') {
    // Our own move going out, or the opponent's clock starting. Either way the
    // next thing to happen is their move, so start filling the table now.
    if (!wasOurs) logUI(`${applied.move.san} played — opponent to move`, 'info');
    showStatus("Opponent's move", 'wait');
    prewarmEngine();
    return;
  }

  if (decision.act !== 'respond') return;

  logUI(`Opponent played ${applied.move.san} — our move`, 'success');
  socketRespond(event, frameAt);
}

/**
 * Answer a move the socket just delivered.
 *
 * Shares `auto.inFlight` with the DOM watchdog so the two can never run a
 * search at the same time, and keeps only the *newest* event that arrives
 * while busy — an older one describes a position that has already been
 * superseded, and answering it would be playing into the past.
 */
/**
 * How many times a turn that produced no move is re-attempted, and how long to
 * wait between tries.
 *
 * This is the backstop, not the fix — askEngine() retrying the dropped request
 * is the fix. It exists because a turn with no move on it is the one failure
 * this design cannot recover from by itself: it is our move, so nothing further
 * arrives on the socket to re-trigger anything, and the bot waits until the flag
 * falls. Whatever the cause, one more attempt beats sitting still.
 */
const RESPOND_RETRIES = 2;
const RESPOND_RETRY_MS = 400;

async function socketRespond(event, frameAt, attempt = 0) {
  if (auto.inFlight) {
    socketFeed.queued = { event, frameAt };
    return;
  }

  auto.inFlight = true;
  hot.frameAt = frameAt ?? performance.now();
  hot.dispatchedAt = 0;
  let answered = false;

  try {
    // Not awaited: clearing a stale arrow is cosmetic, and awaiting it puts a
    // bridge round trip in front of the engine request.
    clearIndicator().catch(() => {});

    if (board.isGameOver()) {
      finishGame('Game Over detected');
      return;
    }

    const side = board.turn();
    const remainingMs = mods?.remainingMsFor(event, side) ?? null;
    const opponentMs = mods?.remainingMsFor(event, side === 'w' ? 'b' : 'w') ?? null;

    answered = (await tryBookMove({ remainingMs }))
      || Boolean(await analyzeCurrentPosition(board.fen(), {
        moveTimeMs: auto.moveTimeMs,
        remainingMs,
        opponentMs
      }));
  } catch (err) {
    logUI(`Fast-path analysis failed: ${err.message ?? err}`, 'error');
  } finally {
    auto.inFlight = false;
    const next = socketFeed.queued;
    socketFeed.queued = null;

    if (next) {
      // A newer position supersedes this one, so there is nothing to retry.
      socketRespond(next.event, next.frameAt);
    } else if (!answered && botActive && attempt < RESPOND_RETRIES) {
      logUI(`No move came back — retrying (${attempt + 1}/${RESPOND_RETRIES})`, 'warn');
      // The original frameAt is kept deliberately: the latency figure should
      // say how long the opponent actually waited, retries included.
      setTimeout(() => socketRespond(event, frameAt, attempt + 1), RESPOND_RETRY_MS);
    } else if (!answered && botActive) {
      logUI('Engine could not be reached — press Sync to try again', 'error');
    }
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.__cbe !== 'SOCKET') return;
  onSocketEvent(event.data.event, event.data.at).catch((err) =>
    console.warn('[chess-engine] socket event failed:', err?.message ?? err));
});

async function handleBoardMutation() {
  // The socket already handled this move, before the pixels even moved.
  if (socketOwnsDetection()) return;

  if (isOurMove) {
    pendingRecheck = true;
    console.debug('[chess-engine] skipped — isOurMove (will recheck once suppression lifts)');
    return;
  }
  if (auto.inFlight) return;                    // still analysing the last change

  const hit = await readBoardFen({ timeoutMs: 80 });
  if (!hit) return;

  // A redraw with no real change — but "no change" now means the pieces *and*
  // the side to move both still agree, so a turn that has drifted out of step
  // is treated as work to do instead of being skipped over.
  const knownTurn = hit.complete || hit.turnConfirmed ? hit.fen.split(' ')[1] : null;
  if (hit.fen.split(' ')[0] === board.fen().split(' ')[0] &&
      (!knownTurn || knownTurn === board.turn())) return;

  auto.inFlight = true;
  try {
    await clearIndicator();               // the old arrow is stale now
    const result = await reconcileBoard(hit);

    if (result.kind === 'derived') {
      // Replaying the move keeps turn / castling / en passant / counters honest.
      logUI(
        `Opponent played ${result.played.map((m) => m.san).join(' ')} — ` +
        `${board.turn() === 'w' ? 'white' : 'black'} to move`,
        'success'
      );
    } else if (result.kind === 'reset') {
      logUI(
        result.turnKnown
          ? 'Position resynced (no single move explains the change)'
          : `Position resynced — assuming ${board.turn() === 'w' ? 'white' : 'black'} to move (no turn info available)`,
        'warn'
      );
    }

    lastSource = { ...hit, fen: board.fen() };

    if (board.isGameOver()) {
      finishGame('Game Over detected');
      return;
    }

    if (!(await tryBookMove())) {
      await analyzeCurrentPosition(board.fen(), { moveTimeMs: auto.moveTimeMs });
    }
  } catch (err) {
    logUI(`Auto-analysis failed: ${err.message ?? err}`, 'error');
  } finally {
    auto.inFlight = false;
  }
}

/**
 * Re-read the board from scratch (the same full-priority lookup
 * `initBoardFromDOM()` uses, not the fast auto-detect path) and reconcile it
 * through the exact same logic as auto-detect — trying a real move replay
 * first, only falling back to a best-effort reset if that's not possible.
 */
async function forceSync() {
  if (auto.inFlight) {
    logUI('Still analysing — try again in a second', 'warn');
    return;
  }
  auto.inFlight = true;
  try {
    await clearIndicator();
    await ready;
    const hit = await readBoardFen();
    if (!hit) {
      logUI('Sync failed — no board found on this page', 'error');
      return;
    }

    const result = await reconcileBoard(hit);
    lastSource = { ...hit, fen: board.fen() };
    const sideToMove = board.turn() === 'w' ? 'White' : 'Black';

    if (result.kind === 'unchanged') {
      logUI(`Already in sync — ${sideToMove} to move`, 'info');
    } else if (result.kind === 'derived') {
      logUI(
        `Synced by replaying ${result.played.map((m) => m.san).join(' ')} — ${sideToMove} to move`,
        'success'
      );
    } else {
      logUI(
        result.turnKnown
          ? `Synced — ${sideToMove} to move (source: ${hit.source})`
          : `Synced — assuming ${sideToMove} to move (source: ${hit.source} has no turn info — double-check the board)`,
        result.turnKnown ? 'success' : 'warn'
      );
    }

    if (board.isGameOver()) {
      finishGame('Game Over detected');
      return;
    }

    if (!(await tryBookMove())) {
      await analyzeCurrentPosition(board.fen(), { moveTimeMs: auto.moveTimeMs });
    }
  } catch (err) {
    logUI(`Sync failed: ${err.message ?? err}`, 'error');
  } finally {
    auto.inFlight = false;
  }
}

/**
 * Start watching the board. Syncs the position first, so the first mutation is
 * compared against something real rather than the starting position.
 *
 * @param {{debounceMs?: number, moveTimeMs?: number}} options
 */
async function startAutoAnalysis({ debounceMs = 70, moveTimeMs } = {}) {
  const { pickMainBoard, debounce } = await loadModules();

  const initial = await initBoardFromDOM();
  if (!initial) {
    logUI('No board found on this page — bot not started', 'warn');
    return null;
  }

  // A placement-only source (see FEN_DEFAULTS in fen-sources.js) defaults the
  // side to move to White rather than actually knowing it — fine at a real
  // game's opening position (White genuinely is first to move), wrong exactly
  // half the time if the bot starts mid-game from that kind of source. Saying
  // so up front means a bad guess is visible immediately instead of silently
  // producing a move for the wrong side.
  const sideToMove = board.turn() === 'w' ? 'White' : 'Black';
  const confident = initial.complete || initial.turnConfirmed;
  logUI(
    confident
      ? `Synced — ${sideToMove} to move (source: ${initial.source})`
      : `Synced — assuming ${sideToMove} to move (source: ${initial.source} has no turn info — double-check the board)`,
    confident ? 'info' : 'warn'
  );

  stopAutoAnalysis();
  // Last game's evaluation, opening and latency describe a game that is over.
  uiInstance?.resetStatus?.();
  // Grab the debugger up front so its banner shows once, now, rather than
  // ambushing you again after every move. Only when we will actually click.
  if (autoPlayEnabled) setDebuggerHold(true);
  auto.moveTimeMs = moveTimeMs;

  // Open the engine link and warm the WASM now, so that no move ever pays for
  // waking the service worker or compiling Stockfish. The reply says which
  // build came up: threading is the largest strength gain this extension has,
  // and whether it is live depends on whether the offscreen document could get
  // shared memory — worth stating outright rather than leaving to be inferred
  // from how well the bot plays.
  // SET_CPU_MODE rather than a bare PING: it warms the engine *and* re-applies
  // the thread cap, which a restarted service worker will otherwise have
  // forgotten, and its reply carries the build that came up.
  //
  // The engine choice goes first and the thread cap second, because switching
  // builds tears the engine down and rebuilds it — a cap applied before that
  // would be thrown away with the engine it was applied to.
  askEngine({ type: 'SET_ENGINE', id: engineChoice }, { timeoutMs: 60_000 })
    .then(() => askEngine({ type: 'SET_CPU_MODE', mode: cpuMode }, { timeoutMs: 30_000 }))
    .then((reply) => {
      const engine = reply?.engine;
      if (!engine?.script) return;
      const name = engine.label ?? engine.script.replace(/^engine\//, '').replace(/\.js$/, '');
      // Both: the tile is the persistent answer to "is threading live", the log
      // line is the timestamped record of what happened on this start.
      uiInstance?.updateEngine?.(engine);
      logUI(
        `Engine: ${name} — ${engine.threads} thread${engine.threads === 1 ? '' : 's'}` +
        (engine.engineId && engine.engineId !== engineChoice ? ' (fell back from your choice)' : ''),
        engine.threads > 1 && engine.engineId === engineChoice ? 'info' : 'warn'
      );
    });

  // A mid-game extension reload misses the constructor patch, because the
  // socket was opened before this script existed. Asking the bridge to hunt
  // for the live one recovers the fast path instead of silently spending the
  // rest of the game on the slow DOM path.
  socketFeed.moves = 0;
  socketFeed.desyncs = 0;
  // Pin our colour now, from the page, rather than waiting for a move event to
  // reveal it: the round data says it outright when the bridge can reach it,
  // and on a live game the board is drawn from your own side otherwise.
  noteDetectedColor(initial.playerColor, 'server', 'Lichess says so');
  if (!detectedColor) noteDetectedColor(orientationColor(), 'board', 'Board is set up from your side');
  socketFeed.ourColor = ourColor()?.[0] ?? null;
  const retap = await callBridge('RESYNC_SOCKET', {}, 300);
  logUI(
    retap
      ? `Move feed: Lichess round socket${retap.tapped ? ` (re-attached ${retap.tapped})` : ''}, board watch as backup`
      : 'Move feed: board watch only — no page bridge on this page',
    'info'
  );

  // Observe a stable ancestor: Lichess can replace <cg-board> wholesale on a
  // redraw or a new game, and an observer bound to a detached node goes silent.
  const main = pickMainBoard(document);
  const wrap = main?.el.closest('.cg-wrap');
  auto.target = wrap?.parentElement ?? wrap ?? main?.el ?? null;
  if (!auto.target) {
    console.warn('[chess-engine] could not resolve a board container');
    return null;
  }

  auto.trigger = debounce(() => { handleBoardMutation(); }, debounceMs);
  auto.observer = new MutationObserver(() => auto.trigger());
  auto.observer.observe(auto.target, {
    childList: true,        // pieces added/removed on captures and redraws
    subtree: true,
    attributes: true,
    // chessground moves a piece by rewriting its transform; highlights are classes.
    attributeFilter: ['style', 'class', 'data-state', 'data-fen']
  });

  console.log(
    `[chess-engine] watching <${auto.target.tagName.toLowerCase()}` +
    `${auto.target.className ? '.' + String(auto.target.className).split(/\s+/)[0] : ''}> ` +
    `— debounce ${debounceMs}ms, starting from ${board.fen()}`
  );

  // Analyse the position as it stands right now, instead of only reacting to
  // the *next* detected change. Without this, starting the bot mid-move-list
  // (or at the very start of a game) shows nothing until someone moves —
  // which looks broken and, worse, means the very first analysis the user
  // sees always comes from the resync path rather than a known-good initial
  // read. Fire-and-forget: startAutoAnalysis() should return immediately so
  // "Bot started" logs before the engine's reply, not after.
  // Live from this point, not once the caller gets around to saying so. The
  // first answer below can come straight from the opening book, a few
  // microtasks from now — before onToggleBot's await resumes — and auto-play
  // checks this flag; left false, that first move was shown but never played,
  // and the bot sat there until the opponent moved again.
  botActive = true;

  if (board.isGameOver()) {
    logUI('Game is already over — nothing to analyze', 'warn');
  } else if (!auto.inFlight) {
    auto.inFlight = true;
    tryBookMove()
      .then((played) => played ? null : analyzeCurrentPosition(board.fen(), { moveTimeMs: auto.moveTimeMs }))
      .catch((err) => logUI(`Initial analysis failed: ${err.message ?? err}`, 'error'))
      .finally(() => { auto.inFlight = false; });
  }

  return auto.target;
}

/**
 * Take or give back the debugger attachment for this tab.
 *
 * Chrome shows its "controlled by a debug extension" banner on every attach,
 * so attaching per move made it flash back after each one and made dismissing
 * it pointless. Held across the whole bot session it appears once, and the
 * cross button actually works.
 *
 * Auto-Play off means no clicks are ever dispatched, so there is nothing to
 * hold and no reason to show the banner at all.
 */
function setDebuggerHold(hold) {
  chrome.runtime
    .sendMessage({ type: hold ? 'DEBUGGER_HOLD' : 'DEBUGGER_RELEASE' })
    .catch(() => { /* worker restarting; the next move re-attaches on demand */ });
}

/** Stop watching. Safe to call when nothing is running. */
function stopAutoAnalysis() {
  // A prewarm search has no caller waiting on it, so nothing else would ever
  // tell it to stop — it would keep a core busy after the bot was switched off.
  tellEngine({ type: 'ENGINE_STOP' });
  setDebuggerHold(false);
  clearIndicator();
  auto.observer?.disconnect();
  auto.trigger?.cancel();
  auto.observer = null;
  auto.trigger = null;
  auto.target = null;
  auto.inFlight = false;
}

// Reachable from the DevTools console: pick this extension's context in the
// console's top-left context dropdown, then call any of these.
Object.assign(globalThis, {
  ready,
  initBoardFromDOM,
  readBoardFen,
  getCurrentFEN,
  debugFenSources,
  analyzeCurrentPosition,
  analyzeBoard,
  startAutoAnalysis,
  stopAutoAnalysis,
  forceSync,
  markOurMove,
  drawBestMove,
  clearIndicator,
  setIndicators,
  speed,
  socketFeed
});

// Live views; a plain assignment would freeze these at their current value.
Object.defineProperty(globalThis, 'lastFenSource', {
  get: () => lastSource,
  configurable: true
});
Object.defineProperty(globalThis, 'antiDraw', {
  get: () => antiDraw,
  set: (value) => { antiDraw = Boolean(value); },
  configurable: true
});
Object.defineProperty(globalThis, 'isOurMove', {
  get: () => isOurMove,
  set: (value) => { isOurMove = Boolean(value); },
  configurable: true
});

ready.then(() => {
  console.log(
    '[chess-engine] ready — board, initBoardFromDOM(), getCurrentFEN(), ' +
    'analyzeBoard(), startAutoAnalysis()'
  );
});
