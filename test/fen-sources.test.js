/**
 * Unit tests for lib/fen-sources.js against jsdom fixtures.
 * The board fixture and the getBoundingClientRect stub live in board-fixture.js.
 */
import { JSDOM } from 'jsdom';
import {
  collectFenSources, extractFen, normalizeFen, inferCastlingRights,
  readMoveSignals, readRenderedBoard, resolvePosition,
  readMoveListPlies, readMoveListSans, turnFromPlies
} from '../lib/fen-sources.js';
import { makeBoardDom, squareToPx, SQUARE } from './board-fixture.js';

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { console.log('        expected:', expected, '\n        actual  :', actual); failed++; }
  else passed++;
}

const boardDom = (placement, orientation = 'white', extraHtml = '', lastMove = []) =>
  makeBoardDom(placement, orientation, extraHtml, lastMove).window.document;

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
const MIDGAME = 'r1bq1rk1/pp2ppbp/2np1np1/8/2BNP3/2N1B3/PPP2PPP/R2Q1RK1';

// --- rendered-pieces round trips -------------------------------------------
check('pieces: start position, white orientation',
  extractFen(boardDom(START, 'white')).fen, `${START} w - - 0 1`);

check('pieces: start position, BLACK orientation (flipped)',
  extractFen(boardDom(START, 'black')).fen, `${START} w - - 0 1`);

check('pieces: midgame, white orientation',
  extractFen(boardDom(MIDGAME, 'white')).fen, `${MIDGAME} w - - 0 1`);

check('pieces: midgame, BLACK orientation (flipped)',
  extractFen(boardDom(MIDGAME, 'black')).fen, `${MIDGAME} w - - 0 1`);

check('pieces: source label', extractFen(boardDom(START)).source, 'rendered-pieces');
check('pieces: reported incomplete', extractFen(boardDom(START)).complete, false);

// drag ghosts / fading captures must not be counted as occupants
{
  const doc = boardDom('8/8/8/8/8/8/8/4K2k', 'white');
  const ghost = doc.createElement('piece');
  ghost.className = 'white queen ghost';
  ghost.setAttribute('style', 'transform: translate(0px, 0px);');   // a8
  doc.querySelector('cg-board').appendChild(ghost);
  check('pieces: ghost ignored', extractFen(doc).fen, '8/8/8/8/8/8/8/4K2k w - - 0 1');
}

// --- attribute / input sources ---------------------------------------------
check('data-fen wins when present',
  extractFen(boardDom(START, 'white', '<cg-board data-fen="8/8/8/8/8/8/8/K6k b - - 3 9"></cg-board>')),
  { source: 'data-fen', raw: '8/8/8/8/8/8/8/K6k b - - 3 9', fen: '8/8/8/8/8/8/8/K6k b - - 3 9', complete: true });

// real string captured from lichess.org/tv — short 2-field FEN
check('data-state: real lichess mini-board, widened to 6 fields',
  extractFen(boardDom(START, 'white', '<div class="mini-board" data-state="1Q6/7p/8/3k2P1/8/6PP/7K/8 b,white,b7b8"></div>')).fen,
  '1Q6/7p/8/3k2P1/8/6PP/7K/8 b - - 0 1');

check('fen-input: analysis underboard field',
  extractFen(boardDom(START, 'white',
    '<div class="analyse__underboard"><div class="fen"><input value="8/6Rp/p7/1p5P/3pk3/1P6/5r2/4K3 b - - 7 44"></div></div>')).fen,
  '8/6Rp/p7/1p5P/3pk3/1P6/5r2/4K3 b - - 7 44');

check('window.site value is used when the DOM has nothing else',
  extractFen(new JSDOM('<!doctype html><body></body>').window.document,
    '8/6Rp/p7/1p5P/3pk3/1P6/5r2/4K3 b - - 7 44'),
  { source: 'window.site', raw: '8/6Rp/p7/1p5P/3pk3/1P6/5r2/4K3 b - - 7 44',
    fen: '8/6Rp/p7/1p5P/3pk3/1P6/5r2/4K3 b - - 7 44', complete: true });

// --- selection / fallbacks --------------------------------------------------
check('prefer: forces rendered-pieces over data-fen',
  extractFen(boardDom(START, 'white', '<cg-board data-fen="8/8/8/8/8/8/8/K6k b - - 3 9"></cg-board>'),
    null, { prefer: 'rendered-pieces' }).source,
  'rendered-pieces');

check('no board at all -> null',
  extractFen(new JSDOM('<!doctype html><body><p>hello</p></body>').window.document), null);

check('garbage data-state is skipped, pieces still win',
  extractFen(boardDom(START, 'white', '<div data-state="not-a-fen,white,e2e4"></div>')).source,
  'rendered-pieces');

check('collectFenSources reports all five',
  collectFenSources(boardDom(START), null).map((c) => c.source),
  ['data-fen', 'data-state', 'fen-input', 'window.site', 'rendered-pieces']);

check('normalizeFen rejects a 7-rank placement', normalizeFen('8/8/8/8/8/8/8'), null);

// --- inferCastlingRights -----------------------------------------------------
check('castling: all four rights on the starting position',
  inferCastlingRights(START), 'KQkq');
check('castling: white king moved -> no white rights',
  inferCastlingRights('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQ1KNR'), 'kq');
check('castling: white just castled kingside -> no white rights',
  inferCastlingRights('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQ1RK1'), 'kq');
check('castling: only kingside rook missing -> queenside right survives',
  inferCastlingRights('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQK3'), 'Qkq');
check('castling: bare kings -> no rights at all',
  inferCastlingRights('8/8/8/8/8/8/8/4K2k'), '-');

// --- readMoveSignals: who moved last, and therefore whose turn it is ---------
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR';
const AFTER_E4_C5 = 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR';
const AFTER_NF3 = 'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R';
const WHITE_CASTLED = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQ1RK1';
const BLACK_CASTLED = 'rnbq1rk1/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

check('signals: nothing highlighted means nobody has moved yet -> white',
  readMoveSignals(boardDom(START, 'white')),
  { turn: 'w', ep: null, lastMove: null });

check('signals: the white pawn standing on e4 says black is to move',
  readMoveSignals(boardDom(AFTER_E4, 'white', '', ['e2', 'e4'])),
  { turn: 'b', ep: 'e3', lastMove: ['e2', 'e4'] });

check('signals: unchanged when the board is flipped to black',
  readMoveSignals(boardDom(AFTER_E4, 'black', '', ['e2', 'e4'])),
  { turn: 'b', ep: 'e3', lastMove: ['e2', 'e4'] });

check('signals: a black pawn on c5 says white is to move',
  readMoveSignals(boardDom(AFTER_E4_C5, 'white', '', ['c7', 'c5'])),
  { turn: 'w', ep: 'c6', lastMove: ['c7', 'c5'] });

check('signals: a knight move leaves no en passant square',
  readMoveSignals(boardDom(AFTER_NF3, 'white', '', ['g1', 'f3'])),
  { turn: 'b', ep: null, lastMove: ['g1', 'f3'] });

check('signals: white has just castled -> black to move',
  readMoveSignals(boardDom(WHITE_CASTLED, 'white', '', ['e1', 'g1'])).turn, 'b');

check('signals: black has just castled -> white to move',
  readMoveSignals(boardDom(BLACK_CASTLED, 'white', '', ['e8', 'g8'])).turn, 'w');

check('signals: a castle marked king-takes-rook leaves both squares empty, ' +
      'but the back rank still names the player',
  readMoveSignals(boardDom(WHITE_CASTLED, 'white', '', ['e1', 'h1'])).turn, 'b');

// --- resolvePosition: fields that are justified, not defaulted ----------------
check('resolve: a placement-only board still yields a real turn, castling and ep',
  resolvePosition(boardDom(AFTER_E4, 'white', '', ['e2', 'e4'])).fen,
  `${AFTER_E4} b KQkq e3 0 1`);

check('resolve: and says so, rather than passing a guess off as knowledge',
  resolvePosition(boardDom(AFTER_E4, 'white', '', ['e2', 'e4'])).turnConfirmed, true);

check('resolve: black to move is reported when black is to move (the old default bug)',
  resolvePosition(boardDom(AFTER_E4, 'black', '', ['e2', 'e4'])).fen.split(' ')[1], 'b');

check('resolve: a complete FEN describing the same pieces wins outright',
  resolvePosition(boardDom(AFTER_E4, 'white',
    `<div class="fen"><input value="${AFTER_E4} b KQkq e3 5 3"></div>`, ['e2', 'e4'])),
  { settled: true, source: 'fen-input', raw: `${AFTER_E4} b KQkq e3 5 3`,
    fen: `${AFTER_E4} b KQkq e3 5 3`, complete: true, turnConfirmed: true });

check('resolve: a complete FEN for some *other* board is ignored, pieces win',
  resolvePosition(boardDom(AFTER_E4, 'white',
    '<div class="mini-board" data-state="1Q6/7p/8/3k2P1/8/6PP/7K/8 b - - 0 1,white,b7b8"></div>',
    ['e2', 'e4'])).source,
  'rendered-pieces');

// --- mid-animation detection -------------------------------------------------
{
  const doc = makeBoardDom(AFTER_E4, 'white', '', ['e2', 'e4']).window.document;
  check('rendered: a board at rest reads as settled', readRenderedBoard(doc).settled, true);

  // Put the e4 pawn half a square off-centre, exactly as chessground does
  // while it is transitioning the piece into place.
  const pos = squareToPx(4, 3, 'white');
  doc.querySelector('piece[data-sq="e4"]')
    .setAttribute('style', `transform: translate(${pos.x}px, ${pos.y + SQUARE / 2}px);`);
  check('rendered: a piece still in flight reads as unsettled',
    readRenderedBoard(doc).settled, false);
}

// --- move list ply counting -------------------------------------------------
// The turn signal of last resort: when the last-move highlight is missing or
// unreadable, the game's own move list still knows whose turn it is.
{
  const moveList = (html) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document;

  const live = (moves) => moveList(
    `<rm6><l4x>${moves.map((m, i) =>
      `${i % 2 === 0 ? `<index>${i / 2 + 1}</index>` : ''}<kwdb>${m}</kwdb>`).join('')}</l4x></rm6>`);

  check('no move list at all -> null', readMoveListPlies(moveList('<div>nothing</div>')), null);
  check('empty move list -> null', readMoveListPlies(live([])), null);
  check('one move counted', readMoveListPlies(live(['e4'])), 1);
  check('four moves counted', readMoveListPlies(live(['e4', 'c5', 'Nf3', 'd6'])), 4);
  check('move numbers are not counted as plies',
    readMoveListPlies(live(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'])), 5);

  check('castling, captures, checks, promotions all count',
    readMoveListPlies(live(['O-O', 'exd5', 'Qxf7+', 'e8=Q', 'O-O-O', 'Nbd7', 'Rxa8#'])), 7);

  check('annotation glyphs do not break the match',
    readMoveListPlies(live(['e4!', 'e5?', 'Nf3!?'])), 3);

  // Clock times and evals sit alongside moves in some layouts; a selector that
  // sweeps them up must be rejected rather than trusted.
  check('a selector matching mostly non-moves is rejected',
    readMoveListPlies(moveList('<rm6><l4x>' +
      '<kwdb>e4</kwdb><kwdb>1:59</kwdb><kwdb>2:01</kwdb><kwdb>+0.3</kwdb><kwdb>1:47</kwdb>' +
      '</l4x></rm6>')), null);

  check('analysis board move list is read too',
    readMoveListPlies(moveList('<div class="tview2"><move>e4</move><move>e5</move><move>Nf3</move></div>')), 3);

  check('move list read back as SAN, glyphs stripped',
    readMoveListSans(live(['e4!', 'c5', 'Nf3?!', 'd6'])), ['e4', 'c5', 'Nf3', 'd6']);
  check('no move list -> null SANs', readMoveListSans(moveList('<div>nothing</div>')), null);

  check('even plies means White to move', turnFromPlies(0), 'w');
  check('odd plies means Black to move', turnFromPlies(1), 'b');
  check('a full move returns to White', turnFromPlies(2), 'w');
  check('no ply count -> no turn', turnFromPlies(null), null);
  check('a negative count is not a turn', turnFromPlies(-1), null);

  // The whole point, end to end: a mid-game board with no last-move highlight
  // used to default to White. It must now read Black off the move list.
  const noHighlight = boardDom(MIDGAME, 'white',
    '<rm6><l4x><kwdb>e4</kwdb><kwdb>c5</kwdb><kwdb>Nf3</kwdb></l4x></rm6>');
  check('no highlight: turn comes from the move list, not a default',
    resolvePosition(noHighlight).fen.split(' ')[1], 'b');
  check('no highlight: that turn is reported as confirmed',
    resolvePosition(noHighlight).turnConfirmed, true);
  check('no highlight: the source is named',
    resolvePosition(noHighlight).turnSource, 'move-list');

  // With a *resolvable* highlight the highlight still wins — it is the better
  // signal and also yields en passant and the last move. f3 is empty and d4
  // holds a white knight, so this reads as "white just played Nf3-d4".
  const withHighlight = boardDom(MIDGAME, 'white',
    '<rm6><l4x><kwdb>e4</kwdb><kwdb>c5</kwdb><kwdb>Nf3</kwdb></l4x></rm6>', ['f3', 'd4']);
  check('highlight beats the move list when both are available',
    resolvePosition(withHighlight).turnSource, 'last-move-highlight');

  // A highlight that exists but cannot be resolved (both marked squares still
  // occupied) must not block the move list — that is a "we don't know", not an
  // answer, and falling back is the whole point of having a second source.
  const murkyHighlight = boardDom(MIDGAME, 'white',
    '<rm6><l4x><kwdb>e4</kwdb><kwdb>c5</kwdb><kwdb>Nf3</kwdb></l4x></rm6>', ['e4', 'd4']);
  check('an unreadable highlight falls through to the move list',
    resolvePosition(murkyHighlight).turnSource, 'move-list');

  // Neither signal available. A real Lichess page always has a move list, so
  // this only happens in fixtures; the start-of-game assumption stands, but it
  // is labelled as such rather than passed off as a reading of the board.
  const bare = boardDom(MIDGAME, 'white');
  check('no highlight and no move list falls back to start-of-game',
    resolvePosition(bare).turnSource, 'start-of-game');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
