/**
 * Shared jsdom board fixture: renders a placement the way chessground does.
 *
 * jsdom has no layout engine, so getBoundingClientRect() is stubbed to derive a
 * rect from the same transform: translate(Xpx, Ypx) that chessground emits. That
 * leaves the real logic under test: square math, orientation and FEN assembly.
 */
import { JSDOM } from 'jsdom';

export const SQUARE = 64;
export const BOARD = SQUARE * 8;
const ROLES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const FILES = 'abcdefgh';

export function stubLayout(dom) {
  dom.window.Element.prototype.getBoundingClientRect = function () {
    if (this.tagName.toLowerCase() === 'cg-board') {
      return { left: 0, top: 0, width: BOARD, height: BOARD, right: BOARD, bottom: BOARD };
    }
    const m = /translate\(\s*(-?[\d.]+)px[ ,]+(-?[\d.]+)px/.exec(this.getAttribute('style') ?? '');
    if (!m) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    const x = Number(m[1]);
    const y = Number(m[2]);
    return { left: x, top: y, width: SQUARE, height: SQUARE, right: x + SQUARE, bottom: y + SQUARE };
  };
}

/** file/rank (0-based, rank 0 == rank 1) -> pixel offsets for an orientation. */
export function squareToPx(file, rank, orientation = 'white') {
  const col = orientation === 'black' ? 7 - file : file;
  const row = orientation === 'black' ? rank : 7 - rank;
  return { x: col * SQUARE, y: row * SQUARE };
}

/** Square name ('e4') -> 0-based file/rank, the inverse of squareToPx's input. */
export function parseSquare(name) {
  return { file: FILES.indexOf(name[0]), rank: Number(name[1]) - 1 };
}

/**
 * @param {string} placement   first field of a FEN
 * @param {'white'|'black'} orientation
 * @param {string} extraHtml   markup injected before the board
 * @param {string[]} lastMove  squares chessground would mark as the last move,
 *   e.g. ['e2', 'e4'] — rendered the way it does, as <square class="last-move">
 */
export function makeBoardDom(placement, orientation = 'white', extraHtml = '', lastMove = []) {
  const pieces = [];
  placement.split('/').forEach((rowStr, rowFromTop) => {
    const rank = 7 - rowFromTop;
    let file = 0;
    for (const ch of rowStr) {
      if (/\d/.test(ch)) { file += Number(ch); continue; }
      const pos = squareToPx(file, rank, orientation);
      const color = ch === ch.toUpperCase() ? 'white' : 'black';
      pieces.push(
        '<piece class="' + color + ' ' + ROLES[ch.toLowerCase()] + '"' +
        ' data-sq="' + FILES[file] + (rank + 1) + '"' +
        ' style="transform: translate(' + pos.x + 'px, ' + pos.y + 'px);"></piece>'
      );
      file++;
    }
  });

  const squares = lastMove.map((name) => {
    const { file, rank } = parseSquare(name);
    const pos = squareToPx(file, rank, orientation);
    return '<square class="last-move"' +
      ' style="transform: translate(' + pos.x + 'px, ' + pos.y + 'px);"></square>';
  });

  const html =
    '<!doctype html><body>' + extraHtml +
    '<div class="cg-wrap orientation-' + orientation + ' manipulable">' +
    '<cg-container><cg-board>' + squares.join('') + pieces.join('') + '</cg-board></cg-container>' +
    '</div></body>';

  const dom = new JSDOM(html);
  stubLayout(dom);
  return dom;
}
