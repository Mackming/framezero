/** Tests for lib/board-geometry.js and lib/overlay.js. */
import {
  parseSquare, squareName, colRowToSquare, squareToColRow, squareCenterUnits
} from '../lib/board-geometry.js';
import { buildOverlay, mountOverlay, clearOverlay, OVERLAY_CLASS } from '../lib/overlay.js';
import { makeBoardDom } from './board-fixture.js';

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
  if (ok) passed++;
  else {
    console.log('        expected:', expected);
    console.log('        actual  :', actual);
    failed++;
  }
}

// --- geometry ---------------------------------------------------------------
check('parseSquare a1', parseSquare('a1'), { file: 0, rank: 0 });
check('parseSquare h8', parseSquare('h8'), { file: 7, rank: 7 });
check('parseSquare rejects junk', parseSquare('z9'), null);
check('squareName round trip', squareName(4, 3), 'e4');

check('a1 is bottom-left when white is at the bottom', squareToColRow(0, 0, false), { col: 0, row: 7 });
check('a1 is top-right when flipped', squareToColRow(0, 0, true), { col: 7, row: 0 });
check('col/row -> square inverts cleanly', colRowToSquare(0, 7, false), { file: 0, rank: 0 });
check('col/row -> square inverts cleanly, flipped', colRowToSquare(7, 0, true), { file: 0, rank: 0 });

// Every square must survive a there-and-back trip at both orientations. This is
// the invariant that keeps the reader (pixels -> square) and the drawing
// (square -> pixels) from ever disagreeing about which corner is a8.
{
  let mismatches = 0;
  for (const flipped of [false, true]) {
    for (let file = 0; file < 8; file++) {
      for (let rank = 0; rank < 8; rank++) {
        const { col, row } = squareToColRow(file, rank, flipped);
        const back = colRowToSquare(col, row, flipped);
        if (back.file !== file || back.rank !== rank) mismatches++;
      }
    }
  }
  check('all 128 square round trips agree', mismatches, 0);
}

check('e4 centre, white at bottom', squareCenterUnits('e4', false), { x: 4.5, y: 4.5 });
check('e4 centre, flipped', squareCenterUnits('e4', true), { x: 3.5, y: 3.5 });
check('a8 centre is the top-left square', squareCenterUnits('a8', false), { x: 0.5, y: 0.5 });
check('h1 centre is the bottom-right square', squareCenterUnits('h1', false), { x: 7.5, y: 7.5 });
check('bad square -> null', squareCenterUnits('zz', false), null);

// --- overlay ----------------------------------------------------------------
const dom = makeBoardDom('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR', 'white');
const doc = dom.window.document;

{
  const svg = buildOverlay(doc, { from: 'e2', to: 'e4' });
  check('overlay: is an svg', svg.tagName.toLowerCase(), 'svg');
  check('overlay: viewBox is in square units', svg.getAttribute('viewBox'), '0 0 8 8');
  check('overlay: carries the move', svg.getAttribute('data-move'), 'e2e4');
  check('overlay: hidden from the a11y tree', svg.getAttribute('aria-hidden'), 'true');
  check('overlay: does not eat clicks', svg.style.pointerEvents, 'none');
  check('overlay: two rings drawn', svg.querySelectorAll('circle').length, 2);
  check('overlay: arrow head drawn', svg.querySelectorAll('polygon').length, 1);
  check('overlay: shaft drawn', svg.querySelectorAll('line').length, 1);

  const [source, target] = svg.querySelectorAll('circle');
  check('overlay: green ring on the source square',
    [source.getAttribute('cx'), source.getAttribute('cy'), source.getAttribute('stroke')],
    ['4.5', '6.5', '#22b455']);
  check('overlay: red ring on the target square',
    [target.getAttribute('cx'), target.getAttribute('cy'), target.getAttribute('stroke')],
    ['4.5', '4.5', '#e03e36']);

  // e2 -> e4 is straight up the board.
  const line = svg.querySelector('line');
  check('overlay: shaft runs up the e-file', line.getAttribute('x1'), line.getAttribute('x2'));
  check('overlay: shaft points upward (y decreasing)',
    Number(line.getAttribute('y1')) > Number(line.getAttribute('y2')), true);
}

{
  // Flipping the board must move the drawing, not merely relabel it.
  const white = buildOverlay(doc, { from: 'e2', to: 'e4', flipped: false });
  const black = buildOverlay(doc, { from: 'e2', to: 'e4', flipped: true });
  const ringOf = (svg) => {
    const c = svg.querySelector('circle');
    return [c.getAttribute('cx'), c.getAttribute('cy')];
  };
  check('overlay: source ring moves when flipped',
    JSON.stringify(ringOf(white)) !== JSON.stringify(ringOf(black)), true);
  check('overlay: flipped source ring is mirrored', ringOf(black), ['3.5', '1.5']);
  const blackLine = black.querySelector('line');
  check('overlay: flipped arrow points downward',
    Number(blackLine.getAttribute('y1')) < Number(blackLine.getAttribute('y2')), true);
}

{
  const svg = buildOverlay(doc, { from: 'e7', to: 'e8', promotion: 'q' });
  check('overlay: promotion labelled', svg.querySelector('text')?.textContent, 'Q');
  check('overlay: promotion recorded in data-move', svg.getAttribute('data-move'), 'e7e8q');
}

{
  // Adjacent squares leave no room for a shaft; the head alone must still draw.
  const svg = buildOverlay(doc, { from: 'e2', to: 'e3' });
  check('overlay: adjacent move drops the shaft', svg.querySelectorAll('line').length, 0);
  check('overlay: adjacent move keeps the head', svg.querySelectorAll('polygon').length, 1);
  check('overlay: adjacent move keeps both rings', svg.querySelectorAll('circle').length, 2);
}

check('overlay: unparseable squares -> null', buildOverlay(doc, { from: 'zz', to: 'e4' }), null);

// --- mount / clear ----------------------------------------------------------
{
  const wrap = doc.querySelector('.cg-wrap');
  mountOverlay(doc, wrap, buildOverlay(doc, { from: 'e2', to: 'e4' }));
  check('mount: attached to the board wrap', doc.querySelectorAll('.' + OVERLAY_CLASS).length, 1);
  check('mount: parent is the cg-wrap',
    doc.querySelector('.' + OVERLAY_CLASS).parentElement.className.includes('cg-wrap'), true);

  // Drawing again must replace, never stack.
  mountOverlay(doc, wrap, buildOverlay(doc, { from: 'd2', to: 'd4' }));
  check('mount: redraw replaces rather than stacks',
    doc.querySelectorAll('.' + OVERLAY_CLASS).length, 1);
  check('mount: shows the newest move',
    doc.querySelector('.' + OVERLAY_CLASS).getAttribute('data-move'), 'd2d4');

  check('clear: removes the overlay', clearOverlay(doc), 1);
  check('clear: nothing left', doc.querySelectorAll('.' + OVERLAY_CLASS).length, 0);
  check('clear: idempotent', clearOverlay(doc), 0);
  check('clear: board pieces untouched', doc.querySelectorAll('piece').length, 32);
}

{
  // A host with position:static must be fixed up, then restored on clear.
  const wrap = doc.querySelector('.cg-wrap');
  wrap.style.position = 'static';
  mountOverlay(doc, wrap, buildOverlay(doc, { from: 'e2', to: 'e4' }));
  check('mount: static host promoted to relative', wrap.style.position, 'relative');
  clearOverlay(doc);
  check('clear: host position restored', wrap.style.position, 'static');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
