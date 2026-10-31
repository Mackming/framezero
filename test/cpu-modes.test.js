/**
 * Tests for lib/cpu-modes.js.
 *
 * The clamping is the part worth pinning down. `threadCap` is a ceiling, not a
 * request, and the rule that one core is always left for the browser has to
 * hold on machines far smaller and far larger than the one this was written on
 * — including the degenerate single-core case, where "leave one alone" and
 * "use at least one" pull in opposite directions and the second has to win.
 */
import {
  CPU_MODES, DEFAULT_CPU_MODE, getCpuMode, threadsFor, prewarmMsFor
} from '../lib/cpu-modes.js';

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
  if (ok) passed++;
  else { console.log('        expected:', expected, '\n        actual  :', actual); failed++; }
}

const eco = getCpuMode('eco');
const balanced = getCpuMode('balanced');
const max = getCpuMode('max');

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------
{
  check('three modes, weakest first', CPU_MODES.map((m) => m.id), ['eco', 'balanced', 'max']);
  check('every mode carries a label and a hint',
    CPU_MODES.every((m) => m.label && m.hint), true);

  // Balanced, not Max: Max keeps the engine searching for essentially the whole
  // game, which should be opted into rather than inherited.
  check('the default is the middle mode', DEFAULT_CPU_MODE, 'balanced');

  check('an unknown id falls back to the default rather than undefined',
    [getCpuMode('turbo').id, getCpuMode(undefined).id, getCpuMode(null).id],
    ['balanced', 'balanced', 'balanced']);
}

// ---------------------------------------------------------------------------
// Threads: a ceiling, clamped to the machine
// ---------------------------------------------------------------------------
{
  // The machine this was built against.
  check('on 4 cores the modes give 1 / 2 / 3',
    [eco, balanced, max].map((m) => threadsFor(m, 4)), [1, 2, 3]);

  // One core is always left for the browser, so Max never equals the core count.
  check('Max leaves a core alone at every size',
    [2, 4, 8, 16].map((cores) => threadsFor(max, cores)), [1, 3, 7, 8]);

  // A two-core machine cannot honour Balanced's cap of 2 without taking both.
  check('a small machine clamps Balanced down', threadsFor(balanced, 2), 1);

  // Both rules point below 1 here; "use at least one" has to win, or the engine
  // gets asked for zero threads.
  check('a single-core machine still gets one thread',
    [threadsFor(eco, 1), threadsFor(balanced, 1), threadsFor(max, 1)], [1, 1, 1]);

  check('an unknown core count is treated as two',
    [threadsFor(max, 0), threadsFor(max, undefined), threadsFor(max, NaN)], [1, 1, 1]);

  check('the absolute ceiling is respected', threadsFor(max, 64, 4), 4);
  check('a malformed mode asks for one thread', threadsFor({}, 8), 1);
}

// ---------------------------------------------------------------------------
// Prewarm: the duty-cycle half of the setting
// ---------------------------------------------------------------------------
{
  // Eco's whole point: no search at all while the opponent is thinking.
  check('Eco disables the prewarm', prewarmMsFor(eco), 0);

  // Short rather than absent — a search deposits most of its useful table
  // entries early, so this keeps much of the benefit for a fraction of the CPU.
  check('Balanced keeps a brief one', prewarmMsFor(balanced), 2000);
  check('Max keeps the full one', prewarmMsFor(max), 20000);

  // Both dials have to rise together, or a "lower CPU" mode could cost strength
  // without actually costing less CPU.
  check('CPU use rises monotonically across the modes',
    CPU_MODES.map((m) => threadsFor(m, 8) + prewarmMsFor(m) / 1000),
    [1, 4, 27]);

  check('junk means no prewarm',
    [prewarmMsFor({}), prewarmMsFor({ prewarmMs: -5 }), prewarmMsFor(null)], [0, 0, 0]);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
