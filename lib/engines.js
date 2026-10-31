/**
 * engines.js — which Stockfish builds exist, and the order to try them in.
 *
 * TWO ENGINES, TWO LOADING CONTRACTS
 * ----------------------------------
 * The extension ships builds from two different suppliers, and they are loaded
 * in genuinely different ways — which is the whole reason this file exists
 * rather than a pair of constants in offscreen.js.
 *
 *   'worker'  nmrugg/stockfish.js. `new Worker(script)`, UCI in and out as
 *             postMessage strings. The neural net is compiled into the .wasm.
 *
 *   'module'  lichess-org/stockfish-web. An ES module exporting a factory:
 *             import it, await it, then talk through `module.uci(cmd)` with
 *             replies arriving on `module.listen`. The net is NOT in the .wasm
 *             (that is why sf_19_smallnet.wasm is 500 KB rather than 7 MB) and
 *             must be handed over as bytes via `setNnueBuffer` before the first
 *             search.
 *
 * WHY BOTH
 * --------
 * SF19 is the stronger engine, but it needs `SharedArrayBuffer` — the module
 * builds have no single-threaded fallback — and whether an extension offscreen
 * document is cross-origin isolated is not knowable in advance. SF18's
 * single-threaded build needs nothing at all and therefore always runs. Keeping
 * it is what makes "try the good one first" a safe default rather than a bet.
 *
 * A NOTE ON NETS AND SIZE
 * -----------------------
 * SF19 retired the dual big/small net design. `nn-61e7af4bb97d.nnue` is the
 * size-optimised net lichess ships as their default browser engine: 1.1 MB
 * against the 5.2 MB baked into our SF18 build, so that build is the *smaller*
 * download despite being the newer engine.
 *
 * SF19's own full net, `nn-1a298aa575a0.nnue` (93.9 MB), was shipped here for a
 * while and then removed, because it was measured and it lost — see "Which net
 * is actually stronger here" in README.md for the numbers. It runs at half the
 * nps of the 1.1 MB net at every time control from 100 ms to 5 s, and never
 * catches up, because 94 MB cannot sit in CPU cache and WASM's 128-bit SIMD has
 * no VNNI to soften the cost. Re-adding it means restoring five files and one
 * descriptor; re-measure before believing it is worth it, because the honest
 * answer depends on the machine, not on the net.
 */

/**
 * Wasm linear memory, in 64 KB pages.
 *
 * These are the numbers lichess uses, and they are *pages*, not megabytes:
 * 1536 pages is a 96 MB initial allocation and 32767 is a ~2 GB ceiling to grow
 * into. Our SF18 build declares 128 MB initial against the same 2 GB ceiling,
 * so switching engines does not meaningfully change the memory floor — what
 * changes is the resident size of the net, and this net is the smaller one.
 */
const INITIAL_PAGES = 1536;
const MAX_PAGES = 32767;

/**
 * Ordered strongest-first, which is also the order they appear in the UI.
 *
 * `builds` within an engine are likewise strongest-first and are tried in turn:
 * relaxed-SIMD before baseline, threaded before single. That ordering replaces
 * feature detection deliberately — probing for relaxed SIMD means validating a
 * hand-assembled wasm module, and a wrong probe silently costs strength,
 * whereas a build that cannot instantiate fails loudly and immediately.
 */
export const ENGINES = Object.freeze([
  {
    id: 'sf19',
    label: 'Stockfish 19',
    hint: 'Newest engine, 1 MB net — needs shared memory, falls back to 18 without it',
    kind: 'module',
    sharedMemoryRequired: true,
    initialPages: INITIAL_PAGES,
    maxPages: MAX_PAGES,
    /** Expected on disk; the live filename comes from getRecommendedNnue(). */
    nets: Object.freeze(['engine/nn-61e7af4bb97d.nnue']),
    builds: Object.freeze([
      { script: 'engine/sf_19_smallnet_relaxed-simd.js', tag: 'relaxed-simd', threaded: true },
      { script: 'engine/sf_19_smallnet.js', tag: 'baseline', threaded: true }
    ])
  },
  {
    id: 'sf18',
    label: 'Stockfish 18',
    hint: 'The previous build, 5 MB net compiled in — runs anywhere, no shared memory needed',
    kind: 'worker',
    sharedMemoryRequired: false,
    nets: Object.freeze([]),          // compiled into the .wasm
    builds: Object.freeze([
      { script: 'engine/stockfish-18-lite.js', tag: 'threaded', threaded: true },
      { script: 'engine/stockfish-18-lite-single.js', tag: 'single', threaded: false }
    ])
  }
]);

/**
 * What a fresh install gets: the newest engine.
 *
 * Safe as a default only because `engineCandidates` always appends the
 * single-threaded SF18 build as a last resort, so the worst case for a machine
 * that cannot run SF19 is a warning in the log and the engine we shipped before.
 */
export const DEFAULT_ENGINE = 'sf19';

/** The universally-runnable build: no shared memory, no separate net, no threads. */
const LAST_RESORT = Object.freeze({
  engineId: 'sf18',
  label: 'Stockfish 18',
  kind: 'worker',
  script: 'engine/stockfish-18-lite-single.js',
  tag: 'single',
  threads: 1,
  nets: Object.freeze([])
});

/** Look one up, falling back to the default rather than returning undefined. */
export function getEngine(id) {
  return ENGINES.find((engine) => engine.id === id)
    ?? ENGINES.find((engine) => engine.id === DEFAULT_ENGINE);
}

/**
 * Every build worth trying for `id`, best first, ending in something that
 * cannot fail.
 *
 * @param {string} id  engine id; an unknown one resolves to the default
 * @param {{sharedMemory?: boolean, threads?: number}} env
 * @returns {Array<{engineId, label, kind, script, tag, threads, nets,
 *   initialPages?, maxPages?}>}
 */
export function engineCandidates(id, { sharedMemory = false, threads = 1 } = {}) {
  const engine = getEngine(id);
  const candidates = [];

  // An engine whose builds are all threads-only is not merely slower without
  // shared memory, it cannot instantiate — skip it rather than spend a
  // bring-up timeout discovering that.
  if (!(engine.sharedMemoryRequired && !sharedMemory)) {
    const canThread = sharedMemory && threads > 1;
    // Only meaningful where the engine actually ships a non-threaded build:
    // SF18 has one, so on a single thread we skip straight to it. SF19 does
    // not, and running its pthread build on one thread is still both valid and
    // stronger than dropping to SF18 — so the skip must not apply there, which
    // is exactly what an unguarded `threads <= 1` test used to get wrong.
    const hasSingle = engine.builds.some((build) => !build.threaded);
    for (const build of engine.builds) {
      if (build.threaded && hasSingle && !canThread) continue;
      candidates.push({
        engineId: engine.id,
        label: engine.label,
        kind: engine.kind,
        script: build.script,
        tag: build.tag,
        threads: build.threaded ? Math.max(1, threads) : 1,
        nets: engine.nets,
        initialPages: engine.initialPages,
        maxPages: engine.maxPages
      });
    }
  }

  // Appended only when it is not already in the list, so a machine that cannot
  // run this build does not try the identical thing twice before giving up.
  if (!candidates.some((c) => c.script === LAST_RESORT.script)) {
    candidates.push({ ...LAST_RESORT });
  }
  return candidates;
}
