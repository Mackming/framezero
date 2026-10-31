/**
 * board-geometry.js — square <-> board-coordinate mapping, in both directions.
 *
 * Shared by lib/fen-sources.js (pixels -> square, when reading pieces off the
 * DOM) and lib/overlay.js (square -> board units, when drawing on top of it), so
 * the two can never disagree about which corner is a8.
 *
 * "col/row" are as-drawn: col 0 is the leftmost column on screen, row 0 the top.
 * "file/rank" are chess coordinates: file 0 = a, rank 0 = rank 1.
 */

export const FILES = 'abcdefgh';

export function squareName(file, rank) {
  return FILES[file] + (rank + 1);
}

export function parseSquare(name) {
  if (typeof name !== 'string' || name.length < 2) return null;
  const file = FILES.indexOf(name[0].toLowerCase());
  const rank = Number(name[1]) - 1;
  if (file < 0 || !Number.isInteger(rank) || rank < 0 || rank > 7) return null;
  return { file, rank };
}

/** As-drawn position -> chess coordinates. */
export function colRowToSquare(col, row, flipped = false) {
  return { file: flipped ? 7 - col : col, rank: flipped ? row : 7 - row };
}

/** Chess coordinates -> as-drawn position. */
export function squareToColRow(file, rank, flipped = false) {
  return { col: flipped ? 7 - file : file, row: flipped ? rank : 7 - rank };
}

/**
 * Centre of a square in board units, where the whole board is 8x8 and y grows
 * downward. Feeding these straight into an SVG with viewBox="0 0 8 8" means the
 * drawing scales with the board for free, with no resize handling.
 */
export function squareCenterUnits(name, flipped = false) {
  const square = parseSquare(name);
  if (!square) return null;
  const { col, row } = squareToColRow(square.file, square.rank, flipped);
  return { x: col + 0.5, y: row + 0.5 };
}
