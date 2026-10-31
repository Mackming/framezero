/**
 * position-sync.js — keeping a chess.js board in step with a redrawn DOM board.
 *
 * Pure logic, no extension or DOM APIs, so it is unit-tested directly
 * (test/position-sync.test.js).
 */

/**
 * Find the move (or short sequence) that turns `board`'s current position into
 * `targetPlacement`, and play it.
 *
 * Why not just board.load(fen)? Because the most reliable DOM source is the
 * rendered pieces, which show *placement only* — no side to move, no castling
 * rights, no en passant square, no move counters. Loading that FEN would peg the
 * turn to white forever and break analysis whenever you are playing black.
 * Replaying the actual move keeps every one of those fields correct, and gets
 * castling, en passant and promotion right for free.
 *
 * Searches up to `maxPlies` deep so a missed move of our own followed by the
 * opponent's reply still reconciles.
 *
 * Searched shallowest-depth-first (iterative deepening), never depth-first to
 * `maxPlies`: two different move sequences can land on the same *placement*
 * (a transposition — e.g. c7-c6-c5 vs. c7-c5 with a white move in between),
 * and a longer one flips the side to move relative to the true, shorter
 * answer. Exhausting every 1-ply candidate before trying any 2-ply one (and
 * so on) guarantees the shortest — and therefore correct-parity — match is
 * always the one returned.
 *
 * `maxPlies` stays at 2 deliberately: this runs synchronously on the page's
 * main thread, and the *failure* path — no match at any depth, meaning a
 * resync is needed — is also the worst case for cost, since every depth up
 * to maxPlies is exhausted before giving up. With ~40 legal moves in a
 * typical middlegame position that is ~40+40² ≈ 1,600 move/undo calls at
 * maxPlies=2 versus ~40+40²+40³ ≈ 66,000 at maxPlies=3 — the latter is long
 * enough to visibly freeze the tab exactly when a resync fires. A resync is
 * cheap and correct on its own now (see the turn-inference in content.js's
 * handleBoardMutation), so there is little to gain from chasing a 3rd ply
 * at 40x the worst-case cost.
 *
 * @param {object} board  chess.js Chess instance; mutated on success only.
 * @param {string} targetPlacement  first field of the target FEN.
 * @param {number} maxPlies
 * @returns {object[]|null} verbose moves played, or null if unreachable.
 */
export function deriveMoves(board, targetPlacement, maxPlies = 2) {
  if (board.fen().split(' ')[0] === targetPlacement) return [];

  const searchExactly = (remaining) => {
    for (const candidate of board.moves({ verbose: true })) {
      board.move(candidate);

      if (remaining === 1) {
        if (board.fen().split(' ')[0] === targetPlacement) return [candidate];   // leave it applied
        board.undo();
        continue;
      }

      const rest = searchExactly(remaining - 1);
      if (rest) return [candidate, ...rest];   // leave it applied

      board.undo();
    }
    return null;
  };

  for (let depth = 1; depth <= maxPlies; depth++) {
    const found = searchExactly(depth);
    if (found) return found;
  }
  return null;
}

/**
 * The position one move later, without disturbing the board.
 *
 * Used to aim the prewarm search. Every search hands back the engine's own
 * prediction of the reply (`bestmove e2e4 ponder e7e5`), and warming the
 * position *after* that reply concentrates the opponent's whole thinking time
 * on the position most likely to actually arrive — rather than spreading it
 * across every reply, which is what warming the current position does.
 *
 * The move is played and then undone, so the caller's board comes back exactly
 * as it went in. Nothing is undone when the move was rejected, because nothing
 * was played.
 *
 * @param {{move: Function, fen: Function, undo: Function}} board  chess.js instance
 * @param {string} uci  e.g. "e7e5", or "e7e8q" for a promotion
 * @returns {string|null} the resulting FEN, or null if the move is not legal here
 */
export function positionAfter(board, uci) {
  if (typeof uci !== 'string' || uci.length < 4) return null;

  const move = {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    ...(uci.length > 4 ? { promotion: uci[4].toLowerCase() } : {})
  };

  try {
    if (!board.move(move)) return null;
  } catch {
    return null;              // chess.js throws on an illegal move
  }

  const fen = board.fen();
  board.undo();
  return fen;
}

/**
 * Replay a game's move list onto `board` from `startFen` (the standard start
 * when omitted), keeping it only if it ends on the placement the page shows.
 *
 * This is what gives a board loaded mid-game its history back. A bare FEN is
 * correct about the position but knows nothing of how it was reached, and the
 * opening book — which looks things up by move sequence — reads an empty
 * history as "move one". A replay also gets castling rights, en passant and
 * the side to move exactly right, with nothing inferred.
 *
 * The placement check matters: a move list that is a ply ahead of or behind
 * the rendered board (mid-animation, or the user stepping back through the
 * moves) would otherwise silently put the bot on the wrong position.
 *
 * @param {object} board  chess.js instance; left untouched on failure.
 * @param {string[]} sans  moves in SAN.
 * @param {string|null} targetPlacement  first FEN field to land on, or null to skip the check.
 * @param {string} [startFen]
 * @returns {boolean} whether `board` now holds the replayed game.
 */
export function replayHistory(board, sans, targetPlacement, startFen) {
  if (!Array.isArray(sans)) return false;
  const before = board.fen();
  const restore = () => { try { board.load(before); } catch { /* was valid a moment ago */ } };

  try {
    if (startFen) board.load(startFen);
    else board.reset();
    for (const san of sans) {
      if (!board.move(san)) { restore(); return false; }
    }
  } catch {
    restore();                 // chess.js throws on an illegal or unparsable move
    return false;
  }

  if (targetPlacement && board.fen().split(' ')[0] !== targetPlacement) {
    restore();
    return false;
  }
  return true;
}

/**
 * Does `uciHistory`, played from the standard start, really reach `placement`?
 *
 * The opening book is keyed on the moves since move one, so it is only safe to
 * consult when the history it is handed actually begins there. A board that was
 * loaded from a mid-game FEN and has had a few moves played on top of it has a
 * short history that *looks* like an opening and is not.
 *
 * @param {Function} Chess  chess.js constructor
 */
export function historyReachesFromStart(Chess, uciHistory, placement) {
  const replay = new Chess();
  try {
    for (const uci of uciHistory) {
      const move = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
      if (uci.length > 4) move.promotion = uci[4];
      if (!replay.move(move)) return false;
    }
  } catch {
    return false;
  }
  return replay.fen().split(' ')[0] === placement;
}

/** The part of a FEN that decides whether two positions are "the same" for repetition. */
const repetitionKey = (fen) => fen.split(' ').slice(0, 4).join(' ');

const toUci = (m) => `${m.from}${m.to}${m.promotion ?? ''}`;

/**
 * What the engine needs to see repetitions, and which of our moves repeat.
 *
 * Sending Stockfish a bare FEN hides the game's history from it, so it cannot
 * tell a fresh position from one that has already occurred twice — it walks
 * into threefold repetition without knowing, even when it is winning. Sending
 * `position fen <root> moves ...` instead lets it score a repetition as the
 * draw it is.
 *
 * Only the moves since the last capture or pawn move are needed: nothing
 * before an irreversible move can ever recur, and it keeps the command short.
 *
 * `avoid` lists our legal moves that land on a position already seen. Breaking
 * off at the *second* occurrence rather than the third leaves room to manoeuvre
 * — by the time a third is one move away, every alternative may be worse.
 *
 * @param {object} board  chess.js instance (read-only here)
 * @returns {{rootFen: string, moves: string[], avoid: string[]}}
 */
export function repetitionContext(board) {
  const played = board.history({ verbose: true });
  let start = played.length;
  while (start > 0) {
    const m = played[start - 1];
    if (m.piece === 'p' || m.captured) break;
    start--;
  }
  const tail = played.slice(start);

  const seen = new Set(tail.map((m) => repetitionKey(m.before)));
  const avoid = seen.size
    ? board.moves({ verbose: true }).filter((m) => seen.has(repetitionKey(m.after))).map(toUci)
    : [];

  return {
    rootFen: tail.length ? tail[0].before : board.fen(),
    moves: tail.map(toUci),
    avoid
  };
}

/**
 * Trailing-edge debounce. `.cancel()` drops a pending call, `.pending()` reports
 * whether one is queued.
 */
export function debounce(fn, ms) {
  let timer = null;

  const wrapped = (...args) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };

  wrapped.cancel = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  wrapped.pending = () => timer !== null;
  return wrapped;
}
