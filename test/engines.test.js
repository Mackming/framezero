/**
 * Tests for lib/engines.js.
 *
 * Two jobs. The first is the candidate ordering, which is the logic that
 * decides what actually runs and, more importantly, what runs *instead* when
 * the preferred build cannot start — the case nobody exercises by hand because
 * it only happens on someone else's machine.
 *
 * The second is duller and catches a whole class of shipping mistake: every
 * file the catalogue names must exist in engine/. A module build carries its
 * neural net as a separate download, so "upgraded the wasm, forgot the net" is
 * a one-line change away at all times, and its symptom at runtime is a silent
 * fallback to the older engine.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ENGINES, DEFAULT_ENGINE, getEngine, engineCandidates } from '../lib/engines.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

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

/** Candidate list as a readable "tag@threads -> ..." trace. */
const trace = (id, env) => engineCandidates(id, env).map((c) => `${c.tag}@${c.threads}`).join(' -> ');

// --- the catalogue itself ----------------------------------------------------
check('the default engine exists', Boolean(ENGINES.find((e) => e.id === DEFAULT_ENGINE)), true);
check('engine ids are unique', ENGINES.length, new Set(ENGINES.map((e) => e.id)).size);
check('an unknown id resolves to the default', getEngine('nope').id, DEFAULT_ENGINE);
check('every engine has at least one build',
  ENGINES.filter((e) => !e.builds?.length).map((e) => e.id), []);
check('every engine has a label and a hint',
  ENGINES.filter((e) => !e.label || !e.hint).map((e) => e.id), []);

// --- what actually ships -----------------------------------------------------
{
  const missing = [];
  for (const engine of ENGINES) {
    for (const build of engine.builds) {
      if (!existsSync(join(root, build.script))) missing.push(build.script);
      // Emscripten derives the .wasm URL from the script URL, so the pair must
      // travel together; shipping one without the other fails at instantiation.
      const wasm = build.script.replace(/\.js$/, '.wasm');
      if (!existsSync(join(root, wasm))) missing.push(wasm);
    }
    for (const net of engine.nets) {
      if (!existsSync(join(root, net))) missing.push(net);
    }
  }
  check('every file the catalogue names is present in engine/', missing, []);
}

// --- ordering: SF19 -----------------------------------------------------------
check('SF19 tries relaxed SIMD first, then baseline, then falls back to SF18',
  trace('sf19', { sharedMemory: true, threads: 3 }),
  'relaxed-simd@3 -> baseline@3 -> single@1');

// SF19 ships no single-threaded build, so one thread is not a reason to skip
// it — running it on one thread still beats dropping a whole engine version.
check('SF19 still runs on a single thread',
  trace('sf19', { sharedMemory: true, threads: 1 }),
  'relaxed-simd@1 -> baseline@1 -> single@1');

// Its builds are pthread builds: without shared memory they cannot instantiate
// at all, so spending two bring-up timeouts to discover that is pure delay.
check('SF19 is skipped entirely without shared memory',
  trace('sf19', { sharedMemory: false, threads: 3 }),
  'single@1');

// --- ordering: SF18 -----------------------------------------------------------
check('SF18 prefers its threaded build when threads are available',
  trace('sf18', { sharedMemory: true, threads: 4 }),
  'threaded@4 -> single@1');

// Here the skip *is* right: the threaded build offers nothing over the single
// one on one thread, and the engine ships a real single-threaded build to use.
check('SF18 goes straight to single on one thread',
  trace('sf18', { sharedMemory: true, threads: 1 }),
  'single@1');
check('SF18 goes straight to single without shared memory',
  trace('sf18', { sharedMemory: false, threads: 4 }),
  'single@1');

// --- the last resort ----------------------------------------------------------
for (const [id, env] of [
  ['sf19', { sharedMemory: true, threads: 3 }],
  ['sf19', { sharedMemory: false, threads: 1 }],
  ['sf18', { sharedMemory: true, threads: 2 }],
  ['nope', { sharedMemory: false, threads: 1 }],
  ['', {}]
]) {
  const last = engineCandidates(id, env).at(-1);
  check(`'${id}' ends on something that cannot fail`,
    [last.script, last.threads, last.kind],
    ['engine/stockfish-18-lite-single.js', 1, 'worker']);
}

// The fallback must never be listed twice, or a machine that cannot run it
// would try the identical build a second time before giving up.
check('the last resort is not duplicated when it is already a candidate',
  engineCandidates('sf18', { sharedMemory: false, threads: 1 })
    .filter((c) => c.script === 'engine/stockfish-18-lite-single.js').length,
  1);

check('no candidate list is ever empty',
  ENGINES.some((e) => engineCandidates(e.id, {}).length === 0), false);

// A module build without its net path would fetch nothing and hand the engine
// no weights, so the pairing is part of the contract, not an optimisation.
check('every module build carries a net',
  ENGINES.filter((e) => e.kind === 'module' && e.nets.length === 0).map((e) => e.id), []);
check('no worker build declares one, because its net is inside the .wasm',
  ENGINES.filter((e) => e.kind === 'worker' && e.nets.length > 0).map((e) => e.id), []);
check('no two engines share a net file',
  ENGINES.flatMap((e) => e.nets).length,
  new Set(ENGINES.flatMap((e) => e.nets)).size);

check('module builds declare their memory budget',
  ENGINES.filter((e) => e.kind === 'module')
    .every((e) => Number.isInteger(e.initialPages) && Number.isInteger(e.maxPages)),
  true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
