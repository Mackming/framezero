/**
 * promotion.js — finding Lichess's promotion chooser and the piece to click in it.
 *
 * Split out of content.js because it is the one part of move execution that
 * cannot be checked by playing a move and reading the board back: if the
 * chooser is not found, nothing happens at all, and the failure looks exactly
 * like a move that was never sent. Here it can be tested against the markup
 * Lichess actually renders (see test/promotion.test.js).
 *
 * WHAT LICHESS RENDERS
 * --------------------
 * From lila's ui/lib/src/game/promotion.ts, `renderPromotion`:
 *
 *   <div id="promotion-choice" class="top">          <- click = cancel
 *     <square style="top:0%;left:50%">               <- click = choose
 *       <piece class="queen white"></piece>
 *     </square>
 *     ... knight, rook, bishop
 *   </div>
 *
 * Two things matter and both were wrong before. The container is identified by
 * an *id*, not by any `.promotion-modal`/`.promo-choices` class — those match
 * nothing on Lichess, so the chooser was never found and the pawn sat on the
 * eighth rank waiting for a human. And the click handler is on the <square>,
 * not on the <piece> inside it; the piece works only because the event bubbles,
 * so aiming at the square is the one that cannot be broken by a piece being
 * rendered as a background image with no box of its own.
 *
 * The role order in the chooser is queen, knight, rook, bishop — never assume
 * an index, always match the role class.
 */

/** UCI promotion letter -> the role class Lichess puts on the <piece>. */
export const PROMOTION_ROLES = Object.freeze({
  q: 'queen',
  r: 'rook',
  b: 'bishop',
  n: 'knight'
});

/**
 * The open promotion chooser, or null.
 *
 * `#promotion-choice` is what Lichess renders on every board it owns — round,
 * analysis, puzzles. The class selectors after it cost nothing and keep this
 * working if the chooser is ever restyled or the extension meets a board that
 * borrows the older markup.
 */
export function findPromotionChooser(doc) {
  return doc?.querySelector('#promotion-choice, .promotion-choice, .promotion-modal, .promo-choices') ?? null;
}

/**
 * The element to click for `piece` ('q' | 'r' | 'b' | 'n'), or null if this
 * chooser does not offer it.
 *
 * Returns the <square>, which is where the choice handler lives, falling back
 * to whatever element carried the role if there is no square around it.
 */
export function findPromotionOption(chooser, piece) {
  const role = PROMOTION_ROLES[String(piece ?? '').toLowerCase()];
  if (!chooser || !role) return null;
  const marked = chooser.querySelector(
    `square[data-role="${role}"], [data-role="${role}"], piece.${role}, .${role}`
  );
  if (!marked) return null;
  return marked.closest?.('square') ?? marked;
}

/**
 * Viewport centre of an element, or null if it has no box yet.
 *
 * The null case is the one worth having: a zero-sized rect means the chooser is
 * in the DOM but not laid out, and clicking (0, 0) there would land in the page
 * corner — which on Lichess is a cancel, i.e. exactly the bug this file exists
 * to prevent, with a click to make it look deliberate.
 */
export function promotionClickPoint(el) {
  const rect = el?.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * A point inside the chooser that is *not* on any choice, i.e. where a click
 * cancels it.
 *
 * Needed before retrying a move: the chooser is an overlay across the whole
 * board, so a retry that just re-clicks the from-square hits the overlay
 * instead and cancels — burning an attempt and, worse, doing it in a way that
 * looks like the click was refused. Cancelling deliberately first puts the
 * board back in the state the retry expects.
 *
 * Returns null when every corner is covered, which is not a case Lichess's
 * one-file-wide chooser produces, but is the right answer if it ever does:
 * better no click than a click that promotes to whatever was under it.
 */
export function promotionCancelPoint(chooser) {
  const rect = chooser?.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const inset = Math.max(2, Math.min(rect.width, rect.height) * 0.02);
  const taken = [...(chooser.querySelectorAll?.('square') ?? [])]
    .map((sq) => sq.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
  const corners = [
    { x: rect.left + inset, y: rect.top + inset },
    { x: rect.right - inset, y: rect.top + inset },
    { x: rect.left + inset, y: rect.bottom - inset },
    { x: rect.right - inset, y: rect.bottom - inset }
  ];
  return corners.find((p) =>
    !taken.some((r) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom)
  ) ?? null;
}
