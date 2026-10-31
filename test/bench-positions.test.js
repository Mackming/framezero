/**
 * Tests for lib/bench-positions.js.
 *
 * The positions are checked against chess.js rather than eyeballed: a FEN with
 * a typo in it is still a string, and the failure it causes shows up as one
 * engine mysteriously scoring worse on one row, which is exactly the kind of
 * wrong answer a benchmark exists to avoid producing.
 */
import { Chess } from '../lib/chess.js';
import { BENCH_POSITIONS, benchDurationMs, summarise, compare } from '../lib/bench-positions.js';

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

// --- the positions ------------------------------------------------------------
check('there are positions to run', BENCH_POSITIONS.length > 0, true);
check('every position has a name', BENCH_POSITIONS.filter((p) => !p.name).length, 0);
check('names are unique, so rows can be told apart',
  BENCH_POSITIONS.length, new Set(BENCH_POSITIONS.map((p) => p.name)).size);

{
  const illegal = [];
  const terminal = [];
  const sparse = [];
  for (const position of BENCH_POSITIONS) {
    let game;
    try {
      game = new Chess(position.fen);
    } catch {
      illegal.push(position.name);
      continue;
    }
    // A position with no moves ends the search instantly and measures nothing.
    if (game.moves().length === 0) terminal.push(position.name);
    // At 7 pieces or fewer the extension would rather consult the tablebase
    // than search, and a sparse position also hits the depth ceiling early —
    // either way the number stops being about search speed.
    const pieces = position.fen.split(' ')[0].replace(/[^a-zA-Z]/g, '').length;
    if (pieces <= 7) sparse.push(position.name);
  }
  check('every FEN is legal', illegal, []);
  check('no position is already over', terminal, []);
  check('no position is sparse enough to hit the depth ceiling', sparse, []);
}

// --- run length ---------------------------------------------------------------
check('duration is positions x engines x think time',
  benchDurationMs(500, 3), BENCH_POSITIONS.length * 3 * 500);
check('a zero think time costs nothing', benchDurationMs(0, 3), 0);
check('rubbish think time does not produce NaN', benchDurationMs('abc', 2), 0);

// --- summarising --------------------------------------------------------------
check('averages depth, nodes and nps',
  summarise([
    { depth: 20, nodes: 1000, nps: 500 },
    { depth: 22, nodes: 2000, nps: 700 }
  ]),
  { positions: 2, depth: 21, nodes: 1500, nps: 600 });

// A failed search has no depth. Counting it as zero would halve the average and
// read as a strength difference that never happened.
check('a failed row is dropped, not counted as zero',
  summarise([
    { depth: 20, nodes: 1000, nps: 500 },
    { name: 'boom', error: 'engine died' }
  ]),
  { positions: 1, depth: 20, nodes: 1000, nps: 500 });

check('all-failed reports nothing rather than dividing by zero',
  summarise([{ error: 'boom' }]), { positions: 0, depth: 0, nodes: 0, nps: 0 });
check('no rows at all is the same', summarise([]), { positions: 0, depth: 0, nodes: 0, nps: 0 });
check('a zero-depth row counts as a failure',
  summarise([{ depth: 0, nodes: 5, nps: 5 }]).positions, 0);

// --- comparing ----------------------------------------------------------------
check('a shallower, slower engine reports both losses',
  compare({ depth: 22, nps: 1000 }, { depth: 20, nps: 500 }),
  { depthDelta: -2, npsRatio: 0.5 });
check('a deeper engine reports a positive delta',
  compare({ depth: 20, nps: 500 }, { depth: 21.5, nps: 750 }),
  { depthDelta: 1.5, npsRatio: 1.5 });
check('comparing against nothing does not divide by zero',
  compare({ depth: 0, nps: 0 }, { depth: 20, nps: 500 }),
  { depthDelta: 20, npsRatio: null });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
