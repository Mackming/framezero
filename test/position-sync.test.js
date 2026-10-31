/** Tests for lib/position-sync.js and the observer wiring content.js uses. */
import { Chess } from '../lib/chess.js';
import { deriveMoves, debounce, positionAfter, replayHistory, historyReachesFromStart, repetitionContext } from '../lib/position-sync.js';
import { extractFen, pickMainBoard } from '../lib/fen-sources.js';
import { makeBoardDom, squareToPx } from './board-fixture.js';

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
  if (ok) passed++;
  else { console.log('        expected:', expected, '\n        actual  :', actual); failed++; }
}
const placementOf = (fen) => fen.split(' ')[0];
const sans = (moves) => (moves ? moves.map((m) => m.san) : moves);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- deriveMoves ------------------------------------------------------------
{
  const b = new Chess();
  const after = new Chess();
  after.move('e4');
  check('derive: single ply', sans(deriveMoves(b, placementOf(after.fen()))), ['e4']);
  check('derive: turn flipped to black', b.turn(), 'b');
  check('derive: full FEN matches, en passant square included', b.fen(), after.fen());
}
{
  const b = new Chess();
  const after = new Chess();
  after.move('e4');
  after.move('e5');
  check('derive: two plies', sans(deriveMoves(b, placementOf(after.fen()))), ['e4', 'e5']);
  check('derive: two plies leaves white to move', b.turn(), 'w');
}
{
  const b = new Chess();
  check('derive: identical placement -> []', deriveMoves(b, placementOf(b.fen())), []);
  check('derive: board untouched', b.fen(), new Chess().fen());
}
{
  const b = new Chess();
  const before = b.fen();
  check('derive: unreachable -> null', deriveMoves(b, '8/8/8/8/8/8/8/K6k'), null);
  check('derive: board unchanged after failure', b.fen(), before);
}
{
  const start = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  const b = new Chess(start);
  const after = new Chess(start);
  after.move('O-O');
  check('derive: castling', sans(deriveMoves(b, placementOf(after.fen()))), ['O-O']);
  check('derive: castling rights updated', b.fen().split(' ')[2], 'kq');
}
{
  const start = 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3';
  const b = new Chess(start);
  const after = new Chess(start);
  after.move('exf6');
  check('derive: en passant capture', sans(deriveMoves(b, placementOf(after.fen()))), ['exf6']);
}
{
  const start = '8/P6k/8/8/8/8/8/K7 w - - 0 1';
  const b = new Chess(start);
  const after = new Chess(start);
  after.move('a8=Q');
  check('derive: promotion', sans(deriveMoves(b, placementOf(after.fen()))), ['a8=Q']);
}

// The whole reason deriveMoves exists: placement-only sources cannot see whose
// turn it is, so board.load() would peg it to white and analyse the wrong side.
{
  const b = new Chess();
  b.move('e4');
  const after = new Chess();
  after.move('e4');
  after.move('c5');
  const target = placementOf(after.fen());

  check('derive: replays black reply', sans(deriveMoves(b, target)), ['c5']);
  check('derive: side to move is correct (white)', b.turn(), 'w');
  check('derive: move counters kept', b.fen(), after.fen());

  const naive = new Chess();
  naive.load(target + ' w - - 0 1');
  check('naive load loses the counters', naive.fen() === after.fen(), false);
}
{
  // Same test from the other side: after white replies it must be black to move.
  const b = new Chess();
  b.move('e4');
  b.move('c5');
  const after = new Chess(b.fen());
  after.move('Nf3');

  deriveMoves(b, placementOf(after.fen()));
  check('derive: after white reply it is black to move', b.turn(), 'b');

  const naive = new Chess();
  naive.load(placementOf(after.fen()) + ' w - - 0 1');
  check('naive load would say WHITE to move here', naive.turn(), 'w');
}

// --- debounce ---------------------------------------------------------------
{
  let calls = 0;
  const d = debounce(() => { calls++; }, 40);
  for (let i = 0; i < 5; i++) d();
  check('debounce: pending during window', d.pending(), true);
  await wait(90);
  check('debounce: burst of 5 fires once', calls, 1);
  check('debounce: settled', d.pending(), false);

  d();
  d.cancel();
  await wait(90);
  check('debounce: cancel suppresses', calls, 1);
}

// --- MutationObserver wiring (the shape content.js uses) --------------------
{
  const dom = makeBoardDom('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR', 'white');
  const doc = dom.window.document;

  const board = new Chess();
  const seen = [];
  let isOurMove = false;

  // Mirrors handleBoardMutation() in content.js, including its early returns.
  const onChange = () => {
    if (isOurMove) { seen.push('skipped'); return; }
    const hit = extractFen(doc);
    if (!hit) return;
    if (placementOf(hit.fen) === placementOf(board.fen())) return;   // redraw only
    const played = deriveMoves(board, placementOf(hit.fen));
    seen.push(played && played.length ? played.map((m) => m.san).join(' ') : 'resync');
  };

  const trigger = debounce(onChange, 50);
  const main = pickMainBoard(doc);
  const target = main.el.closest('.cg-wrap').parentElement;
  const observer = new dom.window.MutationObserver(() => trigger());
  observer.observe(target, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'data-state', 'data-fen']
  });

  // e2-e4 the way chessground does it: rewrite the pawn's transform, plus the
  // extra churn a real redraw produces, all inside one debounce window.
  const pawn = doc.querySelector('piece[data-sq="e2"]');
  const to = squareToPx(4, 3, 'white');
  pawn.setAttribute('style', 'transform: translate(' + to.x + 'px, ' + to.y + 'px);');
  pawn.classList.add('anim');
  doc.querySelector('cg-board').appendChild(doc.createElement('square'));

  await wait(140);
  check('observer: burst of mutations -> one callback', seen.length, 1);
  check('observer: derived the move', seen[0], 'e4');
  check('observer: board advanced to black', board.turn(), 'b');

  // A redraw that does not change the placement must not re-analyse.
  doc.querySelector('cg-board').appendChild(doc.createElement('square'));
  await wait(140);
  check('observer: no-op redraw triggers no analysis', seen, ['e4']);

  // Our own move, suppressed by isOurMove: nothing is processed and the
  // internal board deliberately falls behind the DOM.
  isOurMove = true;
  const cPawn = doc.querySelector('piece[data-sq="c7"]');
  const c5 = squareToPx(2, 4, 'white');
  cPawn.setAttribute('style', 'transform: translate(' + c5.x + 'px, ' + c5.y + 'px);');
  await wait(140);
  check('observer: isOurMove skips processing', seen, ['e4', 'skipped']);
  check('observer: board untouched while suppressed', board.turn(), 'b');

  // The opponent replies. The 2-ply search must catch up BOTH our suppressed
  // move and the reply in one go -- this is exactly why maxPlies is 2.
  isOurMove = false;
  const knight = doc.querySelector('piece[data-sq="g1"]');
  const nf3 = squareToPx(5, 2, 'white');
  knight.setAttribute('style', 'transform: translate(' + nf3.x + 'px, ' + nf3.y + 'px);');
  await wait(140);
  check('observer: catches up suppressed move + reply', seen, ['e4', 'skipped', 'c5 Nf3']);
  check('observer: turn still correct after catch-up', board.turn(), 'b');
  check('observer: full FEN correct after catch-up',
    board.fen(), 'rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2');

  observer.disconnect();
  trigger.cancel();
}

// ---------------------------------------------------------------------------
// positionAfter: aiming the prewarm one ply ahead
// ---------------------------------------------------------------------------
{
  const board = new Chess();
  board.move('e4');
  const before = board.fen();

  const child = positionAfter(board, 'e7e5');
  check('the predicted reply yields the position after it',
    child.split(' ').slice(0, 2),
    ['rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR', 'w']);

  // The whole point: this runs on the live board mid-game, so leaving it
  // advanced by one ply would desynchronise everything downstream of it.
  check('and the board is handed back untouched', board.fen(), before);

  check('an illegal prediction is refused', positionAfter(board, 'a1a8'), null);
  check('and refusing still leaves the board alone', board.fen(), before);

  check('malformed input is refused',
    [positionAfter(board, 'zz'), positionAfter(board, null), positionAfter(board, undefined)],
    [null, null, null]);
}
{
  // A predicted promotion carries its piece letter, which has to survive.
  const board = new Chess('8/P7/8/7k/8/8/8/K7 w - - 0 1');
  const before = board.fen();
  check('a predicted promotion is applied with its piece',
    positionAfter(board, 'a7a8q').split(' ')[0], 'Q7/8/8/7k/8/8/8/K7');
  check('and that board is untouched too', board.fen(), before);
}

// --- replayHistory / historyReachesFromStart -------------------------------
// Starting the bot mid-game: the board must get the game's real history, or
// the opening book reads an empty history as move one and suggests 1.e4.
{
  const game = new Chess();
  for (const m of ['e4', 'c5', 'Nf3', 'd6', 'd4']) game.move(m);
  const target = placementOf(game.fen());

  const b = new Chess('rnbqkbnr/pp2pppp/3p4/2p5/3PP3/5N2/PPP2PPP/RNBQKB1R b KQkq - 0 3');
  check('replay: matching move list is applied', replayHistory(b, ['e4', 'c5', 'Nf3', 'd6', 'd4'], target), true);
  check('replay: board now carries the full history', b.history(), ['e4', 'c5', 'Nf3', 'd6', 'd4']);
  check('replay: side to move comes from the moves', b.turn(), 'b');

  const c = new Chess('8/8/8/4k3/8/8/8/4K3 w - - 0 1');
  const before = c.fen();
  check('replay: list that does not reach the board is refused', replayHistory(c, ['e4', 'e5'], target), false);
  check('replay: and the board is left as it was', c.fen(), before);
  check('replay: illegal move is refused', replayHistory(c, ['e4', 'e4'], null), false);
  check('replay: board untouched after illegal move', c.fen(), before);
  check('replay: not an array is refused', replayHistory(c, null, null), false);
}
{
  const start = placementOf(new Chess().fen());
  check('book guard: empty history at the start position is the opening',
    historyReachesFromStart(Chess, [], start), true);
  const mid = new Chess('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
  check('book guard: empty history on a mid-game board is NOT the opening',
    historyReachesFromStart(Chess, [], placementOf(mid.fen())), false);
  check('book guard: real history from the start is accepted',
    historyReachesFromStart(Chess, ['e2e4', 'e7e5', 'g1f3', 'b8c6'], placementOf(mid.fen())), true);
  // Loaded mid-game, then one move played on top: a 1-ply history that is not an opening.
  mid.move('Bb5');
  check('book guard: short history on top of a FEN load is rejected',
    historyReachesFromStart(Chess, ['f1b5'], placementOf(mid.fen())), false);
}

// --- repetitionContext ---------------------------------------------------------
{
  const b = new Chess();
  for (const m of ['e4', 'e5', 'Nf3', 'Nc6', 'Ng1', 'Nb8']) b.move(m);
  const ctx = repetitionContext(b);
  check('repetition: history starts after the last pawn move',
    ctx.moves, ['g1f3', 'b8c6', 'f3g1', 'c6b8']);
  check('repetition: root is the position after 1...e5',
    placementOf(ctx.rootFen), 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR');
  check('repetition: Nf3 again would repeat a seen position', ctx.avoid.includes('g1f3'), true);
  check('repetition: a fresh move is not flagged', ctx.avoid.includes('b1c3'), false);

  const fresh = new Chess();
  fresh.move('e4');
  check('repetition: nothing to avoid right after a pawn move', repetitionContext(fresh),
    { rootFen: fresh.fen(), moves: [], avoid: [] });
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
