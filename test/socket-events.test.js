/** Tests for lib/socket-events.js — the fast path's reading of Lichess's round socket. */
import { readFileSync } from 'node:fs';
import { Chess } from '../lib/chess.js';
import {
  FORWARDED_TYPES,
  isForwardedType,
  flattenFrame,
  turnAfterPly,
  normalizeMoveEvent,
  applySocketMove,
  decideResponse,
  remainingMsFor
} from '../lib/socket-events.js';

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
  if (ok) passed++;
  else { console.log('        expected:', expected, '\n        actual  :', actual); failed++; }
}

/** A round-socket `move` payload, carrying only the fields this code reads. */
const moveFrame = (over = {}) => ({
  uci: 'e2e4',
  san: 'e4',
  ply: 1,
  fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR',
  clock: { white: 57.34, black: 60, lag: 2 },
  ...over
});

// ---------------------------------------------------------------------------
// Frame plumbing
// ---------------------------------------------------------------------------
{
  check('only round events are forwarded',
    ['move', 'crowd', 'chat', 'endData'].map(isForwardedType),
    [true, false, false, true]);

  check('a plain event flattens to itself',
    flattenFrame({ t: 'move', d: { uci: 'e2e4' } }),
    [{ t: 'move', d: { uci: 'e2e4' } }]);

  // A batch carrying a move is the case that matters: treating the envelope as
  // one unknown event would silently drop the move inside it, which looks
  // exactly like the bot freezing.
  check('a batch flattens to its members',
    flattenFrame({ t: 'b', d: [{ t: 'move', d: { ply: 1 } }, { t: 'clock', d: {} }] }),
    [{ t: 'move', d: { ply: 1 } }, { t: 'clock', d: {} }]);

  check('a nested batch still flattens',
    flattenFrame({ t: 'b', d: [{ t: 'b', d: [{ t: 'move', d: { ply: 3 } }] }] }),
    [{ t: 'move', d: { ply: 3 } }]);

  check('keepalives and junk flatten to nothing',
    [flattenFrame(0), flattenFrame(null), flattenFrame({ v: 12 }), flattenFrame({ t: 'b', d: 'x' })],
    [[], [], [], []]);
}

// ---------------------------------------------------------------------------
// Turn arithmetic
// ---------------------------------------------------------------------------
{
  // ply counts plies *played*, so an odd ply means White has just moved.
  check('ply parity gives the side to move',
    [0, 1, 2, 41].map(turnAfterPly),
    ['w', 'b', 'w', 'b']);

  check('a missing ply gives no answer', [turnAfterPly(undefined), turnAfterPly(-1)], [null, null]);
}

// ---------------------------------------------------------------------------
// Normalising a move event
// ---------------------------------------------------------------------------
{
  const event = normalizeMoveEvent(moveFrame());
  check('uci and san survive', [event.uci, event.san], ['e2e4', 'e4']);

  // Lichess sends seconds as a float; everything downstream wants whole ms.
  check('clocks become whole milliseconds', [event.whiteMs, event.blackMs], [57340, 60000]);
  check('the side to move comes from the ply', event.sideToMove, 'b');

  check('the mover-side clock is the one selected',
    [remainingMsFor(event, 'w'), remainingMsFor(event, 'b'), remainingMsFor(event, null)],
    [57340, 60000, null]);

  // No dests means the server is not waiting on this client.
  check('no dests means not our turn', event.ourTurn, false);

  // An *empty* dests map is still our turn — it means our turn with no legal
  // moves, which is a real position, not an absent one.
  check('an empty dests map is still our turn',
    normalizeMoveEvent(moveFrame({ dests: {} })).ourTurn, true);
  check('a populated dests map is our turn',
    normalizeMoveEvent(moveFrame({ dests: { e7: 'e5e6' } })).ourTurn, true);

  check('a clockless event reports no clocks',
    (() => {
      const e = normalizeMoveEvent(moveFrame({ clock: undefined }));
      return [e.whiteMs, e.blackMs];
    })(),
    [null, null]);

  check('an event with no move in it is rejected',
    [normalizeMoveEvent({ ply: 4 }), normalizeMoveEvent(null), normalizeMoveEvent({ uci: 'e2' })],
    [null, null, null]);
}

// ---------------------------------------------------------------------------
// Game over
// ---------------------------------------------------------------------------
{
  check('a winner means the game is over',
    normalizeMoveEvent(moveFrame({ winner: 'white' })).over, true);

  // Lichess status ids: created 10, started 20, everything above has a result.
  check('a finished status id means the game is over',
    [30, 25].map((id) => normalizeMoveEvent(moveFrame({ status: { id } })).over),
    [true, true]);

  check('a running status id does not',
    [10, 20].map((id) => normalizeMoveEvent(moveFrame({ status: { id } })).over),
    [false, false]);

  check('a bare numeric status is read too',
    normalizeMoveEvent(moveFrame({ status: 35 })).over, true);
}

// ---------------------------------------------------------------------------
// Applying a socket move to the tracked board
// ---------------------------------------------------------------------------
{
  const board = new Chess();
  const applied = applySocketMove(board, normalizeMoveEvent(moveFrame()));
  check('a move applies and reports its SAN', [applied.ok, applied.move.san], [true, 'e4']);
  check('the board advanced',
    board.fen().split(' ').slice(0, 2),
    ['rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR', 'b']);
}
{
  // Castling: SAN says "O-O", UCI says "e1g1". It has to land on a rook move
  // as well as a king move, which is exactly what a naive from/to gets wrong.
  const board = new Chess('r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5');
  const applied = applySocketMove(board, { uci: 'e1g1', san: 'O-O' });
  check('castling applies', [applied.ok, applied.move.san], [true, 'O-O']);
  check('the rook moved too', board.fen().split(' ')[0].split('/')[7], 'R1BQ1RK1');
}
{
  // A promotion with the piece letter on the wire.
  const board = new Chess('8/P7/8/7k/8/8/8/K7 w - - 0 1');
  check('a promotion applies from uci',
    applySocketMove(board, { uci: 'a7a8q', san: null }).move.san, 'a8=Q');
}
{
  // The same push with no promotion letter. Queen is the only legal
  // completion, so completing it beats desynchronising the board.
  const board = new Chess('8/P7/8/7k/8/8/8/K7 w - - 0 1');
  const applied = applySocketMove(board, { uci: 'a7a8', san: null });
  check('a bare promotion push is completed as a queen',
    [applied.ok, applied.move.san], [true, 'a8=Q']);
}
{
  // SAN is tried first, so a garbled UCI never gets a chance to mislead.
  const board = new Chess();
  check('san wins over an unusable uci',
    applySocketMove(board, { uci: 'zz99', san: 'Nf3' }).move.san, 'Nf3');
}
{
  const board = new Chess();
  const before = board.fen();
  const applied = applySocketMove(board, { uci: 'e7e5', san: 'e5' });
  check('a move for the wrong side is refused', applied.ok, false);
  check('and the board is left alone', board.fen(), before);
}

// ---------------------------------------------------------------------------
// Deciding what to do
// ---------------------------------------------------------------------------
{
  const at = (over) => normalizeMoveEvent(moveFrame(over));

  // The server's own dests map is the strongest possible statement of "your
  // move", and outranks anything we inferred.
  check('dests means respond, even with no colour known',
    decideResponse(at({ dests: { e7: 'e5' } }), { ourColor: null }).act, 'respond');

  check('our turn by parity means respond',
    decideResponse(at({ ply: 2 }), { ourColor: 'w' }).act, 'respond');

  // The opponent's clock is running, so the engine should be warming up rather
  // than idling — this is the branch that makes the prewarm happen.
  check('the opponent to move means ponder',
    decideResponse(at({ ply: 1 }), { ourColor: 'w' }).act, 'ponder');

  // Guessing here would mean playing a move for the opponent's side.
  check('an unknown colour waits rather than guesses',
    decideResponse(at({ ply: 1 }), { ourColor: null }).act, 'wait');

  check('a finished game stops, dests or not',
    [decideResponse(at({ winner: 'black', dests: {} }), { ourColor: 'w' }).act,
      decideResponse(at({ status: { id: 31 } }), { ourColor: 'w' }).act],
    ['stop', 'stop']);

  check('no event at all waits', decideResponse(null, { ourColor: 'w' }).act, 'wait');

  check('every decision carries a reason',
    [decideResponse(at({ dests: {} }), {}).reason.length > 0,
      decideResponse(at({ ply: 1 }), { ourColor: 'w' }).reason.length > 0],
    [true, true]);
}

// ---------------------------------------------------------------------------
// The duplicated list in page-bridge.js
// ---------------------------------------------------------------------------
{
  // page-bridge.js runs in the page's MAIN world, where there is no
  // chrome.runtime and therefore no way to resolve this module's URL to import
  // it — so it carries its own copy of the list. This is the check that keeps
  // the copy honest: a type added here but not there would be dropped at the
  // tap and never reach the bot at all.
  const source = readFileSync(new URL('../page-bridge.js', import.meta.url), 'utf8');
  const literal = /const FORWARDED_TYPES = \[([^\]]*)\]/.exec(source);
  const inBridge = literal
    ? literal[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
    : null;

  check('page-bridge forwards exactly the types this module knows about',
    inBridge, [...FORWARDED_TYPES]);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
