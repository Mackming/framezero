/**
 * Tests for lib/opening-book.js: every entry is a legal move sequence
 * (replayed with chess.js), and lookupOpening() behaves correctly.
 */
import { Chess } from '../lib/chess.js';
import { OPENING_BOOK, GAMBIT_BOOK, BOOKS, getBook, lookupOpening } from '../lib/opening-book.js';

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { console.log('        expected:', expected, '\n        actual  :', actual); failed++; }
  else passed++;
}

// --- every book entry must be a sequence of legal moves --------------------
function countIllegal(book) {
  let illegal = 0;
  for (const entry of book) {
    const board = new Chess();
    for (const uci of entry.moves) {
      const result = board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      if (!result) { illegal++; console.log(`  illegal: [${entry.eco}] ${entry.name} — ${uci}`); break; }
    }
  }
  return illegal;
}

{
  check('every book entry is a legal move sequence', countIllegal(OPENING_BOOK), 0);
  check('book has a substantial number of entries', OPENING_BOOK.length > 50, true);
}

// --- the gambit book --------------------------------------------------------
{
  check('every gambit entry is a legal move sequence', countIllegal(GAMBIT_BOOK), 0);
  check('gambit book is a usable size', GAMBIT_BOOK.length >= 25, true);
  check('every gambit entry has an eco and a name',
    GAMBIT_BOOK.every((e) => e.eco && e.name && e.moves.length), true);

  const names = GAMBIT_BOOK.map((e) => e.name);
  check('gambit entry names are unique', names.length, new Set(names).size);

  check('getBook resolves both books by name',
    [getBook('main') === OPENING_BOOK, getBook('gambit') === GAMBIT_BOOK], [true, true]);
  check('getBook falls back to the mainline book', getBook('nonsense') === OPENING_BOOK, true);
  check('BOOKS exposes exactly the two books', Object.keys(BOOKS).sort(), ['gambit', 'main']);

  // The two books overlap at the very start — the mainline book knows the
  // King's Gambit too — so "reaches a move the other cannot" is the wrong
  // question this shallow. The differences that matter are how heavily each
  // book weights the sharp line, and how far it follows it.
  const shareOf = (book, history, move) => {
    const votes = new Map();
    let total = 0;
    for (const entry of book) {
      if (entry.moves.length <= history.length) continue;
      if (!history.every((m, i) => entry.moves[i] === m)) continue;
      const next = entry.moves[history.length];
      votes.set(next, (votes.get(next) ?? 0) + 1);
      total++;
    }
    return (votes.get(move) ?? 0) / total;
  };

  const afterE4E5 = ['e2e4', 'e7e5'];
  check("gambit book weights the King's Gambit far above the mainline book",
    shareOf(GAMBIT_BOOK, afterE4E5, 'f2f4') > shareOf(OPENING_BOOK, afterE4E5, 'f2f4') * 3, true);

  // Depth: the mainline book abandons the King's Gambit early, the gambit
  // book follows it into the Kieseritzky.
  const kingsGambit = ['e2e4', 'e7e5', 'f2f4', 'e5f4', 'g1f3', 'g7g5'];
  check('mainline book runs out inside the King’s Gambit',
    lookupOpening(kingsGambit).bookMove, null);
  check('gambit book keeps going there', lookupOpening(kingsGambit, { book: GAMBIT_BOOK }).bookMove, 'h2h4');

  // Same position, opposite temperament: quiet c3 versus the Evans Gambit.
  const italian = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5'];
  check('mainline book plays the quiet Giuoco Piano move', lookupOpening(italian).bookMove, 'c2c3');
  check('gambit book plays the Evans Gambit instead',
    lookupOpening(italian, { book: GAMBIT_BOOK }).bookMove, 'b2b4');

  // Black must be covered too, or the style silently vanishes half the time.
  check('gambit book has a reply for Black after 1.d4',
    typeof lookupOpening(['d2d4'], { book: GAMBIT_BOOK }).bookMove, 'string');
  check('gambit book names the line once it is reached',
    lookupOpening(['d2d4', 'e7e5'], { book: GAMBIT_BOOK }).name, 'Englund Gambit');
}

// --- weighted-random selection ----------------------------------------------
{
  // Deterministic by default: the same history must give the same move.
  const twice = [lookupOpening(['e2e4']).bookMove, lookupOpening(['e2e4']).bookMove];
  check('majority vote is deterministic', twice[0], twice[1]);

  // A roll of 0 takes the first candidate in book order; a roll just under 1
  // takes the last. Both must be real, legal book moves.
  const first = lookupOpening(['e2e4'], { book: GAMBIT_BOOK, random: () => 0 }).bookMove;
  const last = lookupOpening(['e2e4'], { book: GAMBIT_BOOK, random: () => 0.999999 }).bookMove;
  check('weighted draw always returns a move',
    [typeof first, typeof last], ['string', 'string']);

  // Sweeping the whole 0..1 range must reach more than one continuation,
  // otherwise the randomisation is not actually doing anything.
  const reached = new Set();
  for (let i = 0; i < 20; i++) {
    reached.add(lookupOpening(['e2e4'], { book: GAMBIT_BOOK, random: () => i / 20 }).bookMove);
  }
  check('weighted draw reaches more than one gambit', reached.size > 1, true);

  // Every move it can reach must be legal in the position.
  const board = new Chess();
  board.move({ from: 'e2', to: 'e4' });
  const legal = new Set(board.moves({ verbose: true }).map((m) => `${m.from}${m.to}${m.promotion ?? ''}`));
  check('every randomly drawn book move is legal',
    [...reached].every((m) => legal.has(m)), true);

  // An empty history still has to work under a weighted draw.
  check('weighted draw handles the initial position',
    typeof lookupOpening([], { book: GAMBIT_BOOK, random: () => 0.5 }).bookMove, 'string');
}

// --- lookupOpening -----------------------------------------------------------
check('empty history suggests 1.e4 or similarly popular first move, unnamed',
  lookupOpening([]).name, null);
check('empty history offers some book move', typeof lookupOpening([]).bookMove, 'string');

check('after 1.e4 c5, named Sicilian with a book reply',
  lookupOpening(['e2e4', 'c7c5']), { name: 'Sicilian Defense', eco: 'B20', bookMove: 'g1f3' });

check('reaching the Najdorf is named precisely',
  lookupOpening(['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6']).name,
  'Sicilian Defense: Najdorf Variation');

check('a line that only partially matches a longer entry is not falsely named',
  lookupOpening(['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'g7g6']).name,
  'Sicilian Defense: Dragon Variation');

check('once play runs past the deepest known continuation, the name is kept but bookMove is null',
  lookupOpening(['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6', 'c1e3']),
  { name: 'Sicilian Defense: Najdorf Variation', eco: 'B90', bookMove: null });

check('a sequence with no matching entry at all -> nothing',
  lookupOpening(['a2a3', 'h7h6']), { name: null, eco: null, bookMove: null });

check('a single reply disagreeing with the book history is not named from a longer entry',
  lookupOpening(['d2d4', 'd7d5', 'e2e4']).name, 'Blackmar-Diemer Gambit');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
