/**
 * page-bridge.js — runs in the page's MAIN world (see manifest.json).
 *
 * A content script lives in an isolated world and cannot see any of the page's
 * own globals. Lichess keeps its live state on `window.site` (renamed from
 * `window.lichess`) and its board on a Chessground instance, so reaching either
 * one requires code that actually runs in the page. This is that code.
 *
 * Protocol, over window.postMessage:
 *   request  { __cbe: 'REQUEST',  id, type, payload }
 *   response { __cbe: 'RESPONSE', id, ok, data }
 *
 * It also taps the round WebSocket (see "Socket tap" at the bottom) and pushes
 * raw events out as:
 *   push     { __cbe: 'SOCKET', at, event: { t, d } }
 *
 * It reads state, and the only thing it writes is Chessground's *autoShapes* —
 * the same arrow layer you get by right-dragging on the board. It never makes a
 * move or touches game state, and it never sends anything on the socket.
 */

(() => {
  const PLACEMENT_RE = /^[pnbrqkPNBRQK1-8]+(?:\/[pnbrqkPNBRQK1-8]+){7}(?:\s|$)/;

  // Analysis boards keep the *current* node's fen live at these paths.
  const ANALYSIS_FEN_PATHS = [
    'site.analysis.node.fen',
    'site.analysis.currentNode.fen',
    'site.analysis.tree.root.fen',
    'lichess.analysis.node.fen',
    'LichessAnalyse.node.fen'
  ];

  // A live round's step list gets a new entry appended on every ply, so its
  // last element is always the current position.
  const ROUND_STEP_PATHS = [
    'site.round.data.steps',
    'lichess.round.data.steps'
  ];

  // `data.game.fen` is set once when the game starts and is NOT updated as
  // moves are played — trusting it directly would freeze detection on the
  // opening position for the whole game. Only used if the step list is gone.
  const ROUND_FEN_PATHS = [
    'site.round.data.game.fen',
    'lichess.round.data.game.fen'
  ];

  const GROUND_PATHS = [
    'site.ground',
    'site.analysis.chessground',
    'site.round.chessground',
    'lichess.ground',
    'lichess.analysis.chessground'
  ];

  const readPath = (path) =>
    path.split('.').reduce((obj, key) => (obj == null ? undefined : obj[key]), window);

  const looksLikeFen = (v) => typeof v === 'string' && PLACEMENT_RE.test(v.trim());
  const looksLikeGround = (v) =>
    v && typeof v === 'object' && typeof v.setAutoShapes === 'function' && v.state;

  /**
   * Bounded breadth-first hunt under a root object.
   * @param {(value: any) => boolean} match
   */
  function scan(root, rootName, match) {
    if (!root || typeof root !== 'object') return null;
    const seen = new WeakSet([root]);
    let frontier = [{ node: root, path: rootName }];

    for (let depth = 0; depth < 4 && frontier.length; depth++) {
      const next = [];
      for (const { node, path } of frontier) {
        for (const key of Object.keys(node)) {
          let value;
          try { value = node[key]; } catch { continue; }   // getters may throw
          if (match(value)) return { value, path: `${path}.${key}` };
          if (value && typeof value === 'object' && !seen.has(value)) {
            seen.add(value);
            if (next.length < 400) next.push({ node: value, path: `${path}.${key}` });
          }
        }
      }
      frontier = next;
    }
    return null;
  }

  function findByPaths(paths, match) {
    for (const path of paths) {
      const value = readPath(path);
      if (match(value)) return { value, path };
    }
    return null;
  }

  function findFen() {
    const analysis = findByPaths(ANALYSIS_FEN_PATHS, looksLikeFen);
    if (analysis) return { fen: analysis.value, path: analysis.path };

    for (const path of ROUND_STEP_PATHS) {
      const steps = readPath(path);
      const fen = Array.isArray(steps) && steps.length ? steps[steps.length - 1]?.fen : null;
      if (looksLikeFen(fen)) return { fen, path: `${path}[last].fen` };
    }

    const round = findByPaths(ROUND_FEN_PATHS, looksLikeFen);
    if (round) return { fen: round.value, path: round.path };

    const found = scan(window.site, 'site', looksLikeFen)
               ?? scan(window.lichess, 'lichess', looksLikeFen);
    return found ? { fen: found.value, path: found.path } : null;
  }

  /**
   * The live round's full move list and our colour, when the page exposes them.
   *
   * Step 0 is the starting position (it carries a fen but no move), every later
   * step is one ply. Starting the bot mid-game replays these so the board has
   * its real history, not just the current placement.
   */
  function findHistory() {
    for (const root of ['site.round.data', 'lichess.round.data']) {
      const data = readPath(root);
      const steps = data?.steps;
      if (!Array.isArray(steps) || !steps.length) continue;
      const sans = steps.slice(1).map((s) => s?.san);
      if (sans.some((san) => typeof san !== 'string')) continue;
      const color = data.player?.color;
      return {
        sans,
        initialFen: looksLikeFen(steps[0]?.fen) ? steps[0].fen : null,
        color: color === 'white' || color === 'black' ? color : null
      };
    }
    return {};
  }

  function findGround() {
    return findByPaths(GROUND_PATHS, looksLikeGround)
        ?? scan(window.site, 'site', looksLikeGround)
        ?? scan(window.lichess, 'lichess', looksLikeGround);
  }

  // -------------------------------------------------------------------------
  // Socket tap
  // -------------------------------------------------------------------------

  /**
   * Event types pushed to the content script.
   *
   * Kept as a literal rather than imported because a MAIN-world content script
   * has no `chrome.runtime`, and therefore no way to resolve the URL of
   * lib/socket-events.js to import it. FORWARDED_TYPES there is the source of
   * truth; test/socket-events.test.js reads this file and asserts the two
   * lists still agree, so the duplication cannot drift silently.
   */
  const FORWARDED_TYPES = ['move', 'b', 'end', 'endData', 'reload', 'resync', 'clock'];
  const FORWARDED = new Set(FORWARDED_TYPES);

  /** Sockets already carrying our listener, so a re-tap cannot double-report. */
  const tapped = new WeakSet();

  /**
   * Push one socket event to the content script.
   *
   * `at` is stamped here, in the same task that the frame arrived in, because
   * that is the earliest observable moment the move existed in this tab. It is
   * what makes the end-to-end latency figure the bot logs an honest one rather
   * than a measurement that starts after its own scheduling delays.
   */
  function pushEvent(event) {
    window.postMessage({ __cbe: 'SOCKET', at: performance.now(), event }, '*');
  }

  /** Unwrap a `t: 'b'` batch into its members; anything else is itself. */
  function forward(frame) {
    if (!frame || typeof frame !== 'object' || typeof frame.t !== 'string') return;
    if (frame.t === 'b') {
      if (Array.isArray(frame.d)) for (const inner of frame.d) forward(inner);
      return;
    }
    if (FORWARDED.has(frame.t)) pushEvent({ t: frame.t, d: frame.d });
  }

  function onFrame(data) {
    // Lichess's keepalives are `0` / `null`, and only text frames carry events.
    if (typeof data !== 'string' || data.length < 2) return;
    let frame;
    try { frame = JSON.parse(data); } catch { return; }
    forward(frame);
  }

  /** Attach to one socket, once. Returns whether it was newly tapped. */
  function tap(ws) {
    if (!ws || tapped.has(ws)) return false;
    tapped.add(ws);
    // Capture phase, so we see the frame before any of Lichess's own handlers
    // get a chance to run — this is the whole point of tapping here.
    ws.addEventListener('message', (event) => {
      try { onFrame(event.data); } catch { /* never break the host page */ }
    }, true);
    return true;
  }

  /**
   * Patch the constructor so every socket Lichess opens from now on is tapped.
   *
   * Returning a native instance from a plain function means `new
   * WebSocket(...)` still produces a real WebSocket — a constructor that
   * returns an object overrides `this` — and re-pointing the prototype chain
   * keeps `instanceof`, the readyState constants and any subclassing Lichess
   * might do working exactly as before. Nothing about the socket's behaviour
   * changes; we only add a listener.
   *
   * This has to run before Lichess's bundle opens its socket, which is why the
   * manifest loads this file at document_start.
   */
  function patchWebSocket() {
    const Native = window.WebSocket;
    if (!Native || Native.__cbePatched) return;

    function Patched(url, protocols) {
      const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
      try { tap(ws); } catch { /* ignore */ }
      return ws;
    }

    Patched.prototype = Native.prototype;
    Object.setPrototypeOf(Patched, Native);
    Patched.__cbePatched = true;
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
      Patched[key] = Native[key];
    }

    try {
      Object.defineProperty(window, 'WebSocket', {
        value: Patched,
        writable: true,
        configurable: true
      });
    } catch {
      window.WebSocket = Patched;
    }
  }

  /**
   * Find and tap sockets that already exist.
   *
   * Needed whenever the constructor patch missed its window — the extension
   * being reloaded mid-game is the common case, and a soft navigation inside
   * Lichess's SPA that reuses an existing socket is the other. Without this,
   * reloading the extension during a game would silently drop the bot back to
   * the slow DOM path with no indication of why.
   */
  function tapExistingSockets() {
    const isSocket = (v) => v instanceof WebSocket || (
      v && typeof v === 'object' &&
      typeof v.readyState === 'number' &&
      typeof v.send === 'function' &&
      typeof v.addEventListener === 'function' &&
      typeof v.url === 'string' && v.url.startsWith('ws')
    );

    let count = 0;
    for (const root of [window.site, window.lichess]) {
      const found = scan(root, 'root', isSocket);
      if (found && tap(found.value)) count++;
    }
    return count;
  }

  patchWebSocket();

  const HANDLERS = {
    /**
     * Re-run the socket hunt on demand. content.js calls this when it starts
     * the bot, so a mid-game extension reload recovers the fast path instead
     * of waiting for a new game.
     */
    RESYNC_SOCKET() {
      patchWebSocket();
      return { tapped: tapExistingSockets() };
    },

    GET_FEN() {
      const found = findFen();
      // Chessground's own `movable.color` says whose pieces are draggable
      // right now — Lichess sets this directly, so it is a much more direct
      // "whose turn is it" signal than parsing any FEN's turn field, and it
      // is available even when every FEN source found is placement-only.
      const ground = findGround();
      const movable = ground?.value?.state?.movable?.color;
      const turn = movable === 'white' || movable === 'black' ? movable : null;
      return { fen: found?.fen ?? null, path: found?.path ?? null, turn, ...findHistory() };
    },

    /** Draw an arrow using Chessground's own autoShapes layer. */
    DRAW_SHAPE({ orig, dest, brush = 'green' }) {
      const ground = findGround();
      if (!ground) return { drawn: false, reason: 'no chessground instance found' };
      ground.value.setAutoShapes([{ orig, dest, brush }]);
      return { drawn: true, path: ground.path };
    },

    CLEAR_SHAPES() {
      const ground = findGround();
      if (!ground) return { cleared: false };
      ground.value.setAutoShapes([]);
      return { cleared: true };
    }
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.__cbe !== 'REQUEST') return;
    const { id, type, payload } = event.data;

    let response;
    try {
      const handler = HANDLERS[type];
      response = handler
        ? { ok: true, data: handler(payload ?? {}) }
        : { ok: false, data: { error: `unknown request: ${type}` } };
    } catch (err) {
      // Never break the host page.
      response = { ok: false, data: { error: String(err?.message ?? err) } };
    }

    window.postMessage({ __cbe: 'RESPONSE', id, ...response }, '*');
  });
})();
