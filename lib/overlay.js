/**
 * overlay.js — draws the engine's suggested move on top of the board.
 *
 * An SVG with viewBox="0 0 8 8" is stretched over the board, so every coordinate
 * is expressed in squares. The board can be resized, the window zoomed or the
 * layout reflowed and the drawing stays correct with no resize listener.
 *
 * The overlay is inert: pointer-events are off, so it never intercepts a click
 * or a drag meant for the board underneath.
 */

import { squareCenterUnits } from './board-geometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export const OVERLAY_CLASS = 'cbe-move-overlay';

export const DEFAULT_COLORS = {
  source: '#22b455',   // green ring on the square the piece leaves
  target: '#e03e36',   // red ring on the square it lands on
  arrow: '#22b455'
};

/** Geometry of the arrow, in board units (1 unit == 1 square). */
const ARROW = {
  ringRadius: 0.40,
  ringWidth: 0.085,
  shaftWidth: 0.15,
  startGap: 0.46,      // clear the source ring
  tipGap: 0.30,        // stop short of the target centre
  headLength: 0.40,
  headHalfWidth: 0.26
};

function el(doc, name, attrs) {
  const node = doc.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

const round = (n) => Math.round(n * 1000) / 1000;

/**
 * A king only ever moves two squares in one legal case: castling. Our engine
 * is never put into Chess960 mode (no `UCI_Chess960` option is set), so a
 * `bestmove` always reports castling as the king's own two-square move — this
 * table is exhaustive and needs no input from the caller about move type.
 */
const CASTLE_ROOK_MOVE = {
  e1g1: { from: 'h1', to: 'f1' },
  e1c1: { from: 'a1', to: 'd1' },
  e8g8: { from: 'h8', to: 'f8' },
  e8c8: { from: 'a8', to: 'd8' }
};

/** Shaft + arrowhead from `a` to `b`, in board units. Drops the shaft if too short for one. */
function drawArrow(doc, svg, a, b, color, opacity) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return;

  const ux = dx / length;
  const uy = dy / length;
  const tip = { x: b.x - ux * ARROW.tipGap, y: b.y - uy * ARROW.tipGap };
  const base = { x: tip.x - ux * ARROW.headLength, y: tip.y - uy * ARROW.headLength };

  // Only draw a shaft if there is room for one between the ring and the head.
  const start = { x: a.x + ux * ARROW.startGap, y: a.y + uy * ARROW.startGap };
  if ((base.x - start.x) * ux + (base.y - start.y) * uy > 0) {
    svg.appendChild(el(doc, 'line', {
      x1: round(start.x), y1: round(start.y),
      x2: round(base.x), y2: round(base.y),
      stroke: color,
      'stroke-width': ARROW.shaftWidth,
      'stroke-linecap': 'round',
      opacity
    }));
  }

  const px = -uy;
  const py = ux;
  const points = [
    [tip.x, tip.y],
    [base.x + px * ARROW.headHalfWidth, base.y + py * ARROW.headHalfWidth],
    [base.x - px * ARROW.headHalfWidth, base.y - py * ARROW.headHalfWidth]
  ].map(([x, y]) => `${round(x)},${round(y)}`).join(' ');

  svg.appendChild(el(doc, 'polygon', { points, fill: color, opacity }));
}

/** Source/target rings around `a` and `b`, in board units. */
function drawRings(doc, svg, a, b, paint, radius, width, opacity) {
  for (const [center, stroke] of [[a, paint.source], [b, paint.target]]) {
    svg.appendChild(el(doc, 'circle', {
      cx: round(center.x), cy: round(center.y), r: radius,
      fill: 'none', stroke, 'stroke-width': width, opacity
    }));
  }
}

/**
 * Build the overlay for one move. Returns null if the squares are unparseable.
 *
 * @param {Document} doc
 * @param {{from: string, to: string, flipped?: boolean, promotion?: string|null,
 *          colors?: object}} options
 */
export function buildOverlay(doc, { from, to, flipped = false, promotion = null, colors = {} }) {
  const paint = { ...DEFAULT_COLORS, ...colors };
  const a = squareCenterUnits(from, flipped);
  const b = squareCenterUnits(to, flipped);
  if (!a || !b) return null;

  const svg = el(doc, 'svg', {
    class: OVERLAY_CLASS,
    viewBox: '0 0 8 8',
    'data-move': `${from}${to}${promotion ?? ''}`,
    'aria-hidden': 'true'
  });
  // overflow:visible keeps the ring stroke from being clipped at the board edge.
  svg.style.cssText =
    'position:absolute;left:0;top:0;width:100%;height:100%;' +
    'pointer-events:none;z-index:6;overflow:visible';

  drawArrow(doc, svg, a, b, paint.arrow, 0.9);
  drawRings(doc, svg, a, b, paint, ARROW.ringRadius, ARROW.ringWidth, 0.95);

  // Castling moves both the king and the rook; showing only the king's own
  // two-square hop reads as an ordinary move and hides half of what happens.
  // A second, dimmer arrow+rings for the rook makes the castle unambiguous
  // without needing the caller to say "this one is a castle".
  const rookMove = CASTLE_ROOK_MOVE[`${from}${to}`];
  if (rookMove) {
    const ra = squareCenterUnits(rookMove.from, flipped);
    const rb = squareCenterUnits(rookMove.to, flipped);
    if (ra && rb) {
      drawArrow(doc, svg, ra, rb, paint.arrow, 0.5);
      drawRings(doc, svg, ra, rb, paint, ARROW.ringRadius * 0.75, ARROW.ringWidth, 0.55);
    }
  }

  if (promotion) {
    const label = el(doc, 'text', {
      x: round(b.x), y: round(b.y + 0.12),
      'text-anchor': 'middle', 'font-size': 0.36,
      'font-family': 'system-ui, sans-serif', 'font-weight': 700,
      fill: paint.target
    });
    label.textContent = promotion.toUpperCase();
    svg.appendChild(label);
  }

  return svg;
}

/** Remove any overlay we previously drew, restoring the host's position style. */
export function clearOverlay(doc) {
  let removed = 0;
  for (const node of [...doc.querySelectorAll(`.${OVERLAY_CLASS}`)]) {
    const host = node.parentElement;
    if (host?.dataset && 'cbePositioned' in host.dataset) {
      host.style.position = host.dataset.cbePositioned;
      delete host.dataset.cbePositioned;
    }
    node.remove();
    removed++;
  }
  return removed;
}

/**
 * Put the overlay over the board. Clears the previous one first, so repeated
 * calls never stack.
 *
 * An absolutely positioned child needs a positioned ancestor. Chessground styles
 * .cg-wrap as position:relative, but if a theme has not, we set it and remember
 * the old value so clearOverlay() can put it back.
 */
export function mountOverlay(doc, host, svg) {
  clearOverlay(doc);
  if (!host || !svg) return null;

  const computed = doc.defaultView?.getComputedStyle?.(host);
  if (computed && computed.position === 'static') {
    host.dataset.cbePositioned = host.style.position ?? '';
    host.style.position = 'relative';
  }

  host.appendChild(svg);
  return svg;
}
