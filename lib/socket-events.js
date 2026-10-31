/**
 * socket-events.js — interpreting Lichess's own round-socket traffic.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every other FEN source in this extension reads the *result* of a move: the
 * DOM after chessground has re-rendered it. That is unavoidably late. The
 * browser has to receive the frame, Lichess's own JS has to apply it,
 * chessground has to lay out pieces, a MutationObserver has to fire, a
 * debounce has to expire, and a ~200ms move animation has to finish before
 * what is on screen is even trustworthy. In a bullet game that chain is worth
 * a third of a second per move, spent doing nothing.
 *
 * The move is already fully described in the WebSocket frame that *caused* all
 * of that — in UCI, in SAN, with the exact clock in seconds and, when it is
 * our turn, the legal destination map. Reading it there is strictly earlier
 * than any DOM read can be, and strictly more accurate: no animation to wait
 * out, no placement-only FEN, no inferring the side to move from a highlight.
 *
 * page-bridge.js taps the socket in the page's MAIN world and forwards raw
 * `{t, d}` events. This module — which runs in the isolated world where the
 * modules and chess.js live, and is therefore testable — turns those into
 * something the bot can act on. The split is deliberate: the bridge stays a
 * dumb pipe with no chess knowledge, and all the interpretation lives here
 * under test.
 *
 * Reference for the frame shapes (lichess-org/lila, round socket v6):
 *   { t: 'move', v: 41, d: { uci, san, ply, fen, clock: {white, black, lag},
 *                            dests, status?, winner? } }
 *   { t: 'b', d: [ <event>, <event>, ... ] }      // batched events
 *   { t: 'endData', d: { status, winner, ... } }
 *   { t: 'reload' } | { t: 'resync' }             // client must refetch
 */

/**
 * Event types worth forwarding across the bridge. Everything else on a round
 * socket (crowd counts, chat, TV feeds, pings) is noise that would cost a
 * postMessage per frame for nothing.
 */
export const FORWARDED_TYPES = Object.freeze([
  'move',      // a ply was played — the whole point of this file
  'b',         // batch envelope; page-bridge unwraps it into its members
  'end',       // game over
  'endData',   // game over, with result detail
  'reload',    // server says our state is stale
  'resync',    // ditto
  'clock'      // clock-only correction
]);

const FORWARDED = new Set(FORWARDED_TYPES);

/** Should page-bridge push this frame to the content script at all? */
export function isForwardedType(type) {
  return typeof type === 'string' && FORWARDED.has(type);
}

/**
 * Flatten a parsed frame into the individual events it carries.
 *
 * A v6 round socket may coalesce several events into one frame under `t: 'b'`
 * (typically a move plus a clock correction, or two plies when a page has been
 * backgrounded). Treating that envelope as a single unknown event would drop
 * the move inside it, which reads exactly like "the bot froze".
 *
 * @param {unknown} frame  already JSON.parse'd
 * @returns {{t: string, d: any}[]}
 */
export function flattenFrame(frame) {
  if (!frame || typeof frame !== 'object') return [];
  const { t, d } = /** @type {any} */ (frame);
  if (t === 'b') {
    if (!Array.isArray(d)) return [];
    return d.flatMap((inner) => flattenFrame(inner));
  }
  if (typeof t !== 'string') return [];
  return [{ t, d }];
}

/** Seconds (Lichess's unit on the wire) to whole milliseconds, or null. */
function toMs(seconds) {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? Math.max(0, Math.round(seconds * 1000))
    : null;
}

/**
 * Whose turn it is *after* the reported ply.
 *
 * `ply` counts plies played, so ply 1 is "White has moved once" and it is
 * Black's turn. Deriving the turn arithmetically like this is exact, which is
 * the whole reason the socket path can skip every one of the turn-inference
 * heuristics in fen-sources.js.
 */
export function turnAfterPly(ply) {
  if (!Number.isInteger(ply) || ply < 0) return null;
  return ply % 2 === 0 ? 'w' : 'b';
}

/**
 * Normalise a `move` event's payload.
 *
 * `dests` is the key extra: Lichess only sends a destination map to the client
 * that is allowed to move, so its presence on the event that hands over the
 * turn is a *definitive* statement of which colour this browser is playing —
 * far better than the board-orientation guess, which spectators, analysis
 * boards and the flip button all break.
 *
 * @returns {{uci: string|null, san: string|null, ply: number|null,
 *   sideToMove: 'w'|'b'|null, whiteMs: number|null, blackMs: number|null,
 *   ourTurn: boolean, over: boolean, winner: string|null}|null}
 */
export function normalizeMoveEvent(d) {
  if (!d || typeof d !== 'object') return null;

  const uci = typeof d.uci === 'string' && d.uci.length >= 4 ? d.uci : null;
  const san = typeof d.san === 'string' && d.san ? d.san : null;
  if (!uci && !san) return null;                 // nothing playable in here

  const ply = Number.isInteger(d.ply) ? d.ply : null;
  const clock = d.clock && typeof d.clock === 'object' ? d.clock : null;

  // An empty `dests` object means "your turn, and you have no legal moves" —
  // still our turn. Absent `dests` means the server is not expecting input
  // from us, which is the opponent's turn (or we are a spectator).
  const ourTurn = Boolean(d.dests) && typeof d.dests === 'object';

  const status = d.status && typeof d.status === 'object' ? d.status : null;
  // Lichess status ids: created=10, started=20; anything above 20 means the
  // game has a result. `status` also arrives as a bare number on some events.
  const statusId = Number.isInteger(status?.id) ? status.id
    : Number.isInteger(d.status) ? d.status
    : null;
  const over = Boolean(d.winner) || (statusId !== null && statusId > 20);

  return {
    uci,
    san,
    ply,
    sideToMove: turnAfterPly(ply),
    whiteMs: toMs(clock?.white),
    blackMs: toMs(clock?.black),
    ourTurn,
    over,
    winner: typeof d.winner === 'string' ? d.winner : null
  };
}

/**
 * Play a socket-reported move onto a chess.js board.
 *
 * SAN is tried before UCI on purpose. Lichess always sends it, chess.js parses
 * it strictly, and it is unambiguous about castling ("O-O") and promotions
 * ("e8=Q") — the two cases where UCI notation varies between producers and
 * where a silent mis-parse would desynchronise the board for the rest of the
 * game. UCI is the fallback, and a bare 4-character promotion push is retried
 * as a queen promotion since that is the only legal completion.
 *
 * @param {{move: Function, turn: Function}} board  a chess.js Chess instance
 * @param {{uci: string|null, san: string|null}} event
 * @returns {{ok: true, move: object} | {ok: false, reason: string}}
 */
export function applySocketMove(board, event) {
  const attempt = (arg) => {
    try {
      const move = board.move(arg);
      return move ? { ok: true, move } : null;
    } catch {
      return null;                 // chess.js throws on an illegal move
    }
  };

  if (event?.san) {
    const played = attempt(event.san);
    if (played) return played;
  }

  const uci = event?.uci;
  if (uci) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4].toLowerCase() : undefined;

    const played = attempt(promotion ? { from, to, promotion } : { from, to });
    if (played) return played;

    // A pawn reaching the last rank with no promotion letter on the wire.
    if (!promotion && (to[1] === '8' || to[1] === '1')) {
      const queened = attempt({ from, to, promotion: 'q' });
      if (queened) return queened;
    }
  }

  return { ok: false, reason: 'move does not apply to the tracked position' };
}

/**
 * Decide what the bot should do with a normalised move event.
 *
 * Separated from the side effects so the decision itself is testable, and so
 * the hot path in content.js reads as one branch rather than a pile of
 * conditions. `ourColor` may be null early in a game, before either the
 * "Playing As" setting or a `dests` map has pinned it down; the answer then is
 * to wait rather than to guess, because guessing means playing a move for the
 * opponent's side.
 *
 * @param {{sideToMove: 'w'|'b'|null, ourTurn: boolean, over: boolean}} event
 * @param {{ourColor: 'w'|'b'|null}} state
 * @returns {{act: 'respond'|'ponder'|'stop'|'wait', reason: string}}
 */
export function decideResponse(event, { ourColor = null } = {}) {
  if (!event) return { act: 'wait', reason: 'no event' };
  if (event.over) return { act: 'stop', reason: 'game over' };

  // The server's own `dests` map outranks anything we inferred: it is a direct
  // statement that this client is the one on move.
  if (event.ourTurn) return { act: 'respond', reason: 'server sent our dests' };

  if (!ourColor) return { act: 'wait', reason: 'our colour not established yet' };
  if (!event.sideToMove) return { act: 'wait', reason: 'no ply in event' };

  return event.sideToMove === ourColor
    ? { act: 'respond', reason: 'our turn by ply parity' }
    // Opponent to move: their think time is ours to use, so warm the engine
    // on this position instead of sitting idle.
    : { act: 'ponder', reason: 'opponent to move' };
}

/**
 * Milliseconds left for whoever is on move, from a normalised event.
 * Exact, unlike parsing Lichess's clock text — which is rounded to the second
 * and shows "1 minute" rather than a time until the first tick.
 */
export function remainingMsFor(event, side) {
  if (!event) return null;
  return side === 'w' ? event.whiteMs : side === 'b' ? event.blackMs : null;
}
