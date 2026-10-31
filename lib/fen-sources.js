/**
 * fen-sources.js — pure FEN extraction from a Lichess DOM.
 *
 * No extension APIs are touched here, so this file can be unit-tested against a
 * jsdom fixture (see test/fen-sources.test.js).
 *
 * Verified against live lichess.org markup:
 *   - <cg-board> is rendered with NO attributes; there is no data-fen on it.
 *     The selector is still tried first because other sites (and older Lichess
 *     builds) do use it, and it costs nothing.
 *   - Mini-boards carry data-state="<fen>,<orientation>,<lastmove>", where the
 *     FEN is frequently the 2-field short form "<placement> <turn>".
 *   - The page global was renamed window.lichess -> window.site, and lives in
 *     the MAIN world, unreachable from a content script (see page-bridge.js).
 */

import { colRowToSquare } from './board-geometry.js';

const ROLE_TO_CHAR = {
  pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k'
};

const PLACEMENT_RE = /^[pnbrqkPNBRQK1-8]+(?:\/[pnbrqkPNBRQK1-8]+){7}$/;

/** Defaults for fields 2..6, used to widen a short FEN to a legal 6-field one. */
const FEN_DEFAULTS = ['w', '-', '-', '0', '1'];

/**
 * Widen "<placement>" or "<placement> <turn>" to a full 6-field FEN.
 * Returns null if the placement field is not a plausible board.
 */
export function normalizeFen(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().split(/\s+/);
  if (!PLACEMENT_RE.test(parts[0] ?? '')) return null;
  while (parts.length < 6) parts.push(FEN_DEFAULTS[parts.length - 1]);
  return parts.slice(0, 6).join(' ');
}

/** True when the FEN carried every field itself rather than borrowing defaults. */
export function isCompleteFen(raw) {
  return typeof raw === 'string' && raw.trim().split(/\s+/).length >= 6;
}

/**
 * Best-guess castling rights from placement alone, for a resync where the
 * source has no real castling field (see FEN_DEFAULTS above, which widens to
 * '-' — no castling, ever again). That default is wrong far more often than
 * this one: a king or rook can only ever be on its home square if it has
 * never moved (short of the rare "moved away and back" case, which chess.js
 * itself has no way to distinguish here either), so treating "still on its
 * home square" as "the right still stands" is the same assumption every
 * from-scratch board-reader makes, and is correct for the overwhelming
 * majority of positions — including, critically, right after a castle has
 * just happened, since the moved king/rook are then plainly not home.
 */
export function inferCastlingRights(placement) {
  const ranks = placement.split('/');
  const expand = (rank) => {
    const squares = [];
    for (const ch of rank) {
      if (/\d/.test(ch)) squares.push(...Array(Number(ch)).fill(null));
      else squares.push(ch);
    }
    return squares;
  };
  const rank1 = expand(ranks[7] ?? '');   // a1..h1
  const rank8 = expand(ranks[0] ?? '');   // a8..h8

  let rights = '';
  if (rank1[4] === 'K') {
    if (rank1[7] === 'R') rights += 'K';
    if (rank1[0] === 'R') rights += 'Q';
  }
  if (rank8[4] === 'k') {
    if (rank8[7] === 'r') rights += 'k';
    if (rank8[0] === 'r') rights += 'q';
  }
  return rights || '-';
}

// --- individual sources ----------------------------------------------------

function fromDataFen(doc) {
  const el = doc.querySelector('cg-board[data-fen], .cg-wrap[data-fen], [data-fen]');
  return el?.getAttribute('data-fen') ?? null;
}

function fromDataState(doc) {
  for (const el of doc.querySelectorAll('[data-state]')) {
    const candidate = (el.getAttribute('data-state') ?? '').split(',')[0];
    if (normalizeFen(candidate)) return candidate;
  }
  return null;
}

function fromFenInput(doc) {
  const el = doc.querySelector(
    '.analyse__underboard .fen input, .copyables .fen input, input.copyable, .fen input'
  );
  const value = el?.value ?? el?.getAttribute('value');
  return normalizeFen(value ?? '') ? value : null;
}

export function pickMainBoard(doc) {
  // A Lichess page can hold several boards at once (sidebar mini-boards, the
  // puzzle of the day, tournament previews). The real one is the biggest board
  // that actually has pieces on it.
  const boards = [...doc.querySelectorAll('cg-board')]
    .map((el) => ({ el, pieces: el.querySelectorAll('piece'), rect: el.getBoundingClientRect() }))
    .filter((b) => b.pieces.length && b.rect.width > 0 && b.rect.height > 0);

  if (!boards.length) return null;
  boards.sort((a, b) =>
    b.rect.width * b.rect.height - a.rect.width * a.rect.height ||
    b.pieces.length - a.pieces.length);
  return boards[0];
}

/** Above this much of a square off-centre, a piece is still in flight. */
const SETTLED_DRIFT = 0.15;

const squareName = (file, rank) => 'abcdefgh'[file] + (rank + 1);

/**
 * Shared geometry for one rendered board: maps any element inside it to the
 * square it sits on, and reports how far off-centre it was.
 *
 * That `drift` is what makes an animation visible to us. Chessground plays a
 * move by transitioning a piece's transform, so for the ~200ms that takes, the
 * piece is literally between two squares -- and rounding its centre to the
 * nearest one yields a placement that was never actually on the board (a pawn
 * "on e3" halfway through e2-e4). Reading during that window is the difference
 * between recognising a move and inventing a position nobody played.
 *
 * Squares come from bounding boxes rather than by parsing the transform, which
 * keeps this working for translate(), translate3d() and any future variation.
 */
function boardFrame(main) {
  const { el: cgBoard, rect } = main;
  const size = rect.width / 8;
  const flipped = !!cgBoard.closest('.cg-wrap')?.classList.contains('orientation-black');

  const locate = (el) => {
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    const x = (box.left + box.width / 2 - rect.left - size / 2) / size;
    const y = (box.top + box.height / 2 - rect.top - size / 2) / size;
    const col = Math.round(x);
    const row = Math.round(y);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    // row 0 is the top of the board; with white at the bottom that is rank 8.
    return {
      ...colRowToSquare(col, row, flipped),
      drift: Math.max(Math.abs(x - col), Math.abs(y - row))
    };
  };

  return { cgBoard, locate };
}

/** Real occupants of the board — drag ghosts and fading captures excluded. */
function readOccupants(cgBoard, locate) {
  const found = [];
  for (const piece of cgBoard.querySelectorAll('piece')) {
    if (piece.classList.contains('ghost') || piece.classList.contains('fading')) continue;

    const role = [...piece.classList].find((c) => c in ROLE_TO_CHAR);
    const white = piece.classList.contains('white');
    if (!role || (!white && !piece.classList.contains('black'))) continue;

    const at = locate(piece);
    if (at) found.push({ ...at, role, white });
  }
  return found;
}

/**
 * Who just moved, read straight off the two squares chessground marks as the
 * last move — and therefore whose turn it is now.
 *
 * This is the turn signal the extension never had. Every other DOM source is
 * placement-only, which is why the side to move used to fall back to a default
 * of White and stay there. But chessground highlights the origin and the
 * destination of the last move on *every* Lichess board (verified live on both
 * a round page and the analysis board), the origin is by definition now empty,
 * and the piece standing on the destination belongs to whoever played it — so
 * the side to move is simply the other colour.
 *
 * The same two squares also give away an en passant target for free: a pawn
 * that moved two ranks up its own file leaves the square it skipped capturable.
 *
 * @returns {{turn: 'w'|'b'|null, ep: string|null, lastMove: [string, string]|null}}
 */
/**
 * Anything that looks like a move in algebraic notation, and nothing that
 * doesn't. Move lists interleave move numbers, evaluations, clock times and
 * annotation glyphs with the moves themselves, and counting any of those as a
 * ply flips the answer to exactly the wrong colour.
 */
const SAN_MOVE = /^(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?[!?]*$/;

/**
 * How many half-moves have been played, counted off Lichess's own move list.
 *
 * This exists because the last-move highlight — good as it is — can come up
 * empty: the board is redrawn without it, the page was just opened onto a game
 * already in progress, or the two highlighted squares do not resolve cleanly.
 * When that happens the side to move used to fall back to White and stay wrong
 * until somebody played a move, which is exactly the "start it mid-game and it
 * plays the wrong side" failure.
 *
 * The move list is immune to all of that: it is the game's own record, it is
 * present on both round and analysis pages, and its length has one meaning.
 * Even parity means White is to move.
 *
 * Selectors are tried most-specific first. `kwdb` (live game) and `.tview2`
 * (analysis) hold one move per element with the move numbers in separate
 * `<index>` nodes, so nothing but moves is counted; the SAN filter is a second
 * line of defence for the looser fallbacks and for markup changes.
 *
 * @returns {number|null} Ply count, or null if no move list could be read.
 */
export function readMoveListPlies(doc) {
  return readMoveListSans(doc)?.length ?? null;
}

/**
 * The game's moves in SAN, in order, off Lichess's own move list.
 *
 * Starting the bot on a game already in progress used to load the position as
 * a bare FEN, with no history behind it — so the opening book believed every
 * game was on move one and suggested 1.e4 whatever the board showed. Replaying
 * this list from the start position gives the board its real history back.
 *
 * @returns {string[]|null} SAN moves, or null if no move list could be read.
 */
export function readMoveListSans(doc) {
  const selectors = ['l4x kwdb', 'rm6 kwdb', '.tview2 > move san', '.tview2 > move', '.moves move'];

  for (const selector of selectors) {
    const nodes = doc.querySelectorAll(selector);
    if (!nodes.length) continue;

    const sans = [];
    let rejected = 0;
    for (const node of nodes) {
      const text = (node.textContent ?? '').trim();
      if (!text) continue;
      if (SAN_MOVE.test(text)) sans.push(text.replace(/[!?]+$/, ''));
      else rejected++;
    }

    // A selector that matched plenty of nodes but almost none of them moves is
    // the wrong selector (or changed markup), not a game with no moves. Better
    // to fall through to the next candidate than to report a confident zero.
    if (sans.length && rejected <= sans.length) return sans;
  }

  return null;
}

/** Side to move implied by a ply count, or null when there is no count. */
export function turnFromPlies(plies) {
  if (!Number.isInteger(plies) || plies < 0) return null;
  return plies % 2 === 0 ? 'w' : 'b';
}

/**
 * Is chessground actually highlighting a last move right now?
 *
 * readMoveSignals() answers "White to move" when it finds no highlight, on the
 * reasoning that an unmarked board is a board nobody has moved on yet. That is
 * right at a real first move and wrong in the one case that matters most: a
 * game already in progress whose highlight is absent because the board was
 * just redrawn, or because the page was opened onto it mid-game. Telling those
 * two apart needs to happen before that answer is trusted, and this is the
 * question that separates them.
 */
export function hasLastMoveHighlight(doc) {
  const main = pickMainBoard(doc);
  if (!main) return false;
  const { cgBoard } = boardFrame(main);
  return cgBoard.querySelectorAll('square.last-move').length > 0;
}

export function readMoveSignals(doc) {
  const blank = { turn: null, ep: null, lastMove: null };
  const main = pickMainBoard(doc);
  if (!main) return blank;

  const { cgBoard, locate } = boardFrame(main);
  const marks = [...cgBoard.querySelectorAll('square.last-move')].map(locate).filter(Boolean);

  // Nothing highlighted means nothing has been played on this board yet, which
  // is White to move — true both at a real game's first move and after
  // rewinding an analysis board to the start.
  if (!marks.length) return { turn: 'w', ep: null, lastMove: null };
  if (marks.length !== 2) return blank;

  const occupants = readOccupants(cgBoard, locate);
  const at = (m) => occupants.find((o) => o.file === m.file && o.rank === m.rank);
  const landed = marks.filter(at);

  if (landed.length === 1) {
    const to = landed[0];
    const from = marks.find((m) => m !== to);
    const piece = at(to);
    const ep = piece.role === 'pawn' && from.file === to.file && Math.abs(from.rank - to.rank) === 2
      ? squareName(to.file, (from.rank + to.rank) / 2)
      : null;
    return {
      turn: piece.white ? 'b' : 'w',
      ep,
      lastMove: [squareName(from.file, from.rank), squareName(to.file, to.rank)]
    };
  }

  // Both marked squares empty means a castle recorded as king-takes-rook: the
  // king and rook have both left the marked squares. Which back rank they are
  // on still identifies the player who castled.
  if (!landed.length && marks[0].rank === marks[1].rank && (marks[0].rank === 0 || marks[0].rank === 7)) {
    return { turn: marks[0].rank === 0 ? 'b' : 'w', ep: null, lastMove: null };
  }

  return blank;
}

/**
 * Rebuild the placement from the pieces chessground actually rendered.
 *
 * This is the only source that is always current on every Lichess board, but it
 * can only see where the pieces are -- turn, castling rights, en passant and the
 * move counters are not represented in the DOM, so they fall back to defaults.
 *
 * `settled` reports whether the pieces were standing still when we looked; see
 * boardFrame() for why a read taken mid-animation has to be thrown away.
 *
 * @returns {{placement: string, settled: boolean}|null}
 */
export function readRenderedBoard(doc) {
  const main = pickMainBoard(doc);
  if (!main) return null;

  const { cgBoard, locate } = boardFrame(main);
  const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
  let maxDrift = 0;

  for (const { file, rank, role, white, drift } of readOccupants(cgBoard, locate)) {
    const char = ROLE_TO_CHAR[role];
    grid[rank][file] = white ? char.toUpperCase() : char;
    if (drift > maxDrift) maxDrift = drift;
  }

  const placement = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = '';
    let gap = 0;
    for (let file = 0; file < 8; file++) {
      const piece = grid[rank][file];
      if (piece) {
        if (gap) { row += gap; gap = 0; }
        row += piece;
      } else {
        gap++;
      }
    }
    if (gap) row += gap;
    placement.push(row);
  }
  return { placement: placement.join('/'), settled: maxDrift <= SETTLED_DRIFT };
}

/**
 * Every source, in priority order. `pageFen` is whatever page-bridge.js dug out
 * of window.site in the MAIN world (null when unavailable).
 *
 * The rendered-pieces entry carries an extra `settled` flag; no other source is
 * subject to animation, so none of them needs one.
 */
export function collectFenSources(doc, pageFen = null) {
  const rendered = readRenderedBoard(doc);
  return [
    { source: 'data-fen', raw: fromDataFen(doc) },
    { source: 'data-state', raw: fromDataState(doc) },
    { source: 'fen-input', raw: fromFenInput(doc) },
    { source: 'window.site', raw: pageFen },
    { source: 'rendered-pieces', raw: rendered?.placement ?? null, settled: rendered?.settled ?? false }
  ].map(({ source, raw, settled }) => ({
    source,
    raw,
    fen: normalizeFen(raw ?? ''),
    complete: isCompleteFen(raw ?? ''),
    ...(settled === undefined ? {} : { settled })
  }));
}

/** First usable source, or null when the page has no board we understand. */
export function extractFen(doc, pageFen = null, { prefer = null } = {}) {
  const found = collectFenSources(doc, pageFen).filter((c) => c.fen);
  if (!found.length) return null;
  return found.find((c) => c.source === prefer) ?? found[0];
}

/**
 * The best full position the page can give us, with every field it can actually
 * justify — the reader the extension should use for real work.
 *
 * extractFen() takes the highest-priority source that parses and stops there,
 * which loses in both directions: a stale or mini-board FEN outranks the pieces
 * you can see, while a placement-only read silently defaults the side to move to
 * White and the castling rights to none. This instead decides *per field* where
 * the answer is allowed to come from:
 *
 *   - A complete 6-field FEN wins outright, but only once it has been checked
 *     against the rendered pieces, so a sidebar mini-board or a source lagging a
 *     move behind cannot hijack the read.
 *   - Otherwise the rendered pieces give the placement, readMoveSignals() gives
 *     the side to move and any en passant square, and the castling rights are
 *     inferred from where the kings and rooks are standing.
 *   - A board caught mid-animation is the one case where the rendered read is
 *     the untrustworthy one, so a complete FEN is preferred even if it disagrees.
 *
 * `turnConfirmed` says whether the side to move was actually established rather
 * than defaulted, so callers can tell a known turn from a guess.
 *
 * @returns {{source: string, raw: string|null, fen: string, complete: boolean,
 *            settled: boolean, turnConfirmed: boolean,
 *            lastMove?: [string, string]|null}|null}
 */
export function resolvePosition(doc, pageFen = null, { prefer = null } = {}) {
  const usable = collectFenSources(doc, pageFen).filter((c) => c.fen);
  if (!usable.length) return null;

  if (prefer) {
    const forced = usable.find((c) => c.source === prefer);
    if (forced) return { settled: true, ...forced, turnConfirmed: forced.complete };
  }

  const rendered = usable.find((c) => c.source === 'rendered-pieces');
  const placementOf = (c) => c.fen.split(' ')[0];

  const agreeing = usable.find((c) =>
    c.complete &&
    c.source !== 'rendered-pieces' &&
    (!rendered || !rendered.settled || placementOf(c) === placementOf(rendered))
  );
  if (agreeing) return { settled: true, ...agreeing, turnConfirmed: true };

  if (!rendered) {
    const first = usable[0];
    return { settled: true, ...first, turnConfirmed: first.complete };
  }

  const signals = readMoveSignals(doc);
  const highlighted = hasLastMoveHighlight(doc);

  // A resolved highlight is the best signal there is: it pins the turn *and*
  // yields the en passant square and the last move, neither of which a ply
  // count can give. It is only trusted when a highlight genuinely exists —
  // readMoveSignals() answers "White" for an unmarked board, which is right at
  // move one and catastrophically wrong on a game already in progress whose
  // highlight simply is not drawn.
  //
  // The move list settles that case. It is the game's own record: present on
  // round and analysis pages alike, unaffected by redraws, and its length has
  // exactly one meaning. Only when there is no list either does the
  // start-of-game assumption get to stand.
  const fromHighlight = highlighted ? signals.turn : null;
  const fromMoveList = fromHighlight ? null : turnFromPlies(readMoveListPlies(doc));
  const turn = fromHighlight ?? fromMoveList ?? signals.turn;

  const parts = rendered.fen.split(' ');
  if (turn) parts[1] = turn;
  parts[2] = inferCastlingRights(parts[0]);
  parts[3] = signals.ep ?? '-';

  return {
    ...rendered,
    fen: parts.join(' '),
    turnConfirmed: turn !== null,
    turnSource:
      fromHighlight ? 'last-move-highlight' :
      fromMoveList  ? 'move-list' :
      turn          ? 'start-of-game' :
      null,
    lastMove: signals.lastMove
  };
}
