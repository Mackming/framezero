/**
 * Tests for lib/promotion.js, against the markup lichess actually renders.
 *
 * The reference is lila's ui/lib/src/game/promotion.ts `renderPromotion`:
 *
 *   div#promotion-choice.top  >  square[style]  >  piece.<role>.<color>
 *
 * with the choice handler bound to the <square> and a cancel handler on the
 * container. Everything here exists because the old selectors
 * ('div.promotion-modal, div.promo-choices') matched none of it, so autoplay
 * never clicked a promotion piece.
 */
import { JSDOM } from 'jsdom';
import {
  PROMOTION_ROLES, findPromotionChooser, findPromotionOption,
  promotionClickPoint, promotionCancelPoint
} from '../lib/promotion.js';

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

const BOARD = 512;
const SQUARE = BOARD / 8;

/** The chooser as lichess renders it: one file wide, four roles deep. */
function makeChooser({ file = 4, color = 'white', vertical = 'top' } = {}) {
  const roles = ['queen', 'knight', 'rook', 'bishop'];
  const left = 12.5 * file;
  const squares = roles
    .map((role, i) => `<square style="top: ${i * 12.5}%;left: ${left}%">` +
      `<piece class="${role} ${color}"></piece></square>`)
    .join('');
  const dom = new JSDOM(
    `<div class="cg-wrap"><cg-container><cg-board></cg-board>` +
    `<div id="promotion-choice" class="${vertical}">${squares}</div>` +
    `</cg-container></div>`
  );
  // jsdom has no layout: derive boxes from the same percentages lichess writes.
  dom.window.Element.prototype.getBoundingClientRect = function () {
    if (this.id === 'promotion-choice') {
      return { left: 0, top: 0, width: BOARD, height: BOARD, right: BOARD, bottom: BOARD };
    }
    if (this.tagName.toLowerCase() === 'square') {
      const style = this.getAttribute('style') ?? '';
      const top = Number(/top:\s*([\d.]+)%/.exec(style)?.[1] ?? 0) / 100 * BOARD;
      const l = Number(/left:\s*([\d.]+)%/.exec(style)?.[1] ?? 0) / 100 * BOARD;
      return { left: l, top, width: SQUARE, height: SQUARE, right: l + SQUARE, bottom: top + SQUARE };
    }
    // <piece> is a background image filling its square, with no box of its own.
    return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  };
  return dom.window.document;
}

// --- finding the chooser ----------------------------------------------------
{
  const doc = makeChooser();
  const chooser = findPromotionChooser(doc);
  check('finds lichess #promotion-choice', chooser?.id, 'promotion-choice');
}

{
  const doc = new JSDOM('<div class="cg-wrap"><cg-board></cg-board></div>').window.document;
  check('no chooser on a board without one', findPromotionChooser(doc), null);
}

{
  // Kept working if the chooser is ever restyled onto a class.
  const doc = new JSDOM('<div class="promotion-modal"><span class="queen"></span></div>').window.document;
  check('still finds a class-named chooser', Boolean(findPromotionChooser(doc)), true);
}

check('null document is not a crash', findPromotionChooser(null), null);

// --- picking the right piece ------------------------------------------------
{
  const doc = makeChooser();
  const chooser = findPromotionChooser(doc);
  for (const [letter, role] of Object.entries(PROMOTION_ROLES)) {
    const option = findPromotionOption(chooser, letter);
    check(`${letter} -> the <square> holding the ${role}`,
      [option?.tagName?.toLowerCase(), option?.firstElementChild?.className],
      ['square', `${role} white`]);
  }
  check('uppercase letters work too',
    findPromotionOption(chooser, 'Q')?.firstElementChild?.className, 'queen white');
  check('an unknown piece letter picks nothing', findPromotionOption(chooser, 'x'), null);
  check('no piece letter picks nothing', findPromotionOption(chooser, undefined), null);
}

// --- where to click ---------------------------------------------------------
{
  const doc = makeChooser({ file: 4 });          // e-file, white promoting
  const chooser = findPromotionChooser(doc);
  // Queen is first in lichess's order, so it sits on the promotion square.
  check('queen click point is the top square of the e-file',
    promotionClickPoint(findPromotionOption(chooser, 'q')),
    { x: 4 * SQUARE + SQUARE / 2, y: SQUARE / 2 });
  // Knight is second: one square below, never a fixed guess at an index.
  check('knight click point is one square lower',
    promotionClickPoint(findPromotionOption(chooser, 'n')),
    { x: 4 * SQUARE + SQUARE / 2, y: SQUARE + SQUARE / 2 });
  check('rook is third', promotionClickPoint(findPromotionOption(chooser, 'r')).y, 2 * SQUARE + SQUARE / 2);
  check('bishop is fourth', promotionClickPoint(findPromotionOption(chooser, 'b')).y, 3 * SQUARE + SQUARE / 2);
}

{
  const doc = makeChooser({ file: 0 });
  const chooser = findPromotionChooser(doc);
  check('a-file promotion clicks the a-file',
    promotionClickPoint(findPromotionOption(chooser, 'q')).x, SQUARE / 2);
}

{
  // An element with no box must not resolve to (0, 0) — on lichess that corner
  // is inside the chooser overlay, so clicking it cancels the promotion.
  const doc = makeChooser();
  const piece = doc.querySelector('piece.queen');
  check('an unlaid-out element yields no click point', promotionClickPoint(piece), null);
  check('a missing element yields no click point', promotionClickPoint(null), null);
}

// --- cancelling before a retry ----------------------------------------------
{
  const doc = makeChooser({ file: 4 });
  const chooser = findPromotionChooser(doc);
  const point = promotionCancelPoint(chooser);
  const squares = [...doc.querySelectorAll('square')].map((s) => s.getBoundingClientRect());
  const onAChoice = squares.some((r) =>
    point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom);
  check('cancel point is inside the chooser', [
    point.x > 0 && point.x < BOARD, point.y > 0 && point.y < BOARD
  ], [true, true]);
  check('cancel point is not on any choice', onAChoice, false);
}

{
  // Promotion on the a-file: the left corners are covered, so the cancel point
  // has to be found on the other side rather than assumed.
  const doc = makeChooser({ file: 0 });
  const chooser = findPromotionChooser(doc);
  const point = promotionCancelPoint(chooser);
  const squares = [...doc.querySelectorAll('square')].map((s) => s.getBoundingClientRect());
  check('a-file chooser still yields a safe cancel point',
    squares.some((r) => point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom),
    false);
}

check('no chooser, no cancel point', promotionCancelPoint(null), null);

// --- black promoting from the other end -------------------------------------
{
  // When the promoting colour is not the board's orientation lichess renders
  // the chooser upwards ('bottom'): same DOM order, but `top` counts down from
  // the eighth rank, so the queen is drawn at the bottom of the screen instead
  // of the top. Reading each square's own position rather than assuming the
  // first one is nearest the promotion square is what keeps this working.
  const doc = makeChooser({ color: 'black', vertical: 'bottom' });
  const chooser = findPromotionChooser(doc);
  const tops = ['87.5', '75', '62.5', '50'];   // (7 - i) * 12.5, as lila does
  [...doc.querySelectorAll('square')].forEach((sq, i) =>
    sq.setAttribute('style', `top: ${tops[i]}%;left: 50%`));

  check('black queen is still found, wherever it is drawn',
    findPromotionOption(chooser, 'q')?.firstElementChild?.className, 'queen black');
  check('black queen is clicked at its own square, nearest the last rank',
    promotionClickPoint(findPromotionOption(chooser, 'q')).y, 0.875 * BOARD + SQUARE / 2);
  check('black knight is clicked one square away from it',
    promotionClickPoint(findPromotionOption(chooser, 'n')).y, 0.75 * BOARD + SQUARE / 2);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
