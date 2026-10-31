/**
 * cpu-modes.js — how much of the machine the engine is allowed to use.
 *
 * WHY THERE ARE TWO DIALS, NOT ONE
 * --------------------------------
 * Thread count is the obvious one, and it sets how *high* CPU use goes: three
 * search threads on a four-core machine is three quarters of it, for as long as
 * the search runs.
 *
 * The one that gets missed is the *duty cycle*, and it is the reason this file
 * exists. Before the prewarm was added the engine sat idle for the whole of the
 * opponent's turn — roughly half the wall-clock time of a game. The prewarm
 * fills that gap with a bounded search, which is exactly the point (see
 * `prewarm` in background.js), but it also turns intermittent CPU use into
 * continuous CPU use. Cutting threads alone would lower the ceiling while
 * leaving the engine busy the entire game; cutting the prewarm alone would idle
 * half the time at full tilt. A mode has to set both.
 *
 * `threadCap` is a ceiling, not a request: the live number is
 * `min(threadCap, cores - 1, 8)`, so "Max" means something sensible on a
 * two-core laptop as well as a sixteen-core desktop. One core is always left
 * alone — the browser still has to render the board and dispatch our clicks,
 * and starving it shows up as latency on the exact path the socket tap exists
 * to keep short.
 *
 * The Elo figures in the hints are rough. They follow the usual "one doubling
 * of effective search is worth 50-70 Elo" rule applied to thread count, plus a
 * smaller allowance for losing the prewarm's carried-over work.
 */

/**
 * Ordered weakest-first, which is also the order they appear in the UI.
 *
 * `prewarmMs` of 0 disables the prewarm outright. The middle mode keeps a short
 * one rather than none: a search deposits most of its useful entries in the
 * transposition table early, so two seconds captures much of the benefit for a
 * tenth of the duty cycle a full one costs.
 */
export const CPU_MODES = Object.freeze([
  {
    id: 'eco',
    label: 'Eco',
    threadCap: 1,
    prewarmMs: 0,
    hint: 'One thread, no background search — lowest CPU, roughly 100 Elo below Max'
  },
  {
    id: 'balanced',
    label: 'Balanced',
    threadCap: 2,
    prewarmMs: 2_000,
    hint: 'Two threads and a brief warm-up — about half the CPU, roughly 40 Elo below Max'
  },
  {
    id: 'max',
    label: 'Max',
    threadCap: 99,          // clamped down to cores - 1
    prewarmMs: 20_000,
    hint: 'Every spare core, searching through the opponent’s turn — full strength'
  }
]);

/**
 * What a fresh install gets.
 *
 * Balanced rather than Max deliberately: Max keeps the engine searching for
 * essentially the whole game, which is the right default only for someone who
 * has asked for it.
 */
export const DEFAULT_CPU_MODE = 'balanced';

/** Look one up, falling back to the default rather than returning undefined. */
export function getCpuMode(id) {
  return CPU_MODES.find((mode) => mode.id === id)
    ?? CPU_MODES.find((mode) => mode.id === DEFAULT_CPU_MODE);
}

/**
 * Never take the last core, and never ask for more threads than the mode
 * allows.
 *
 * @param {{threadCap: number}} mode
 * @param {number} cores  navigator.hardwareConcurrency, or 0 if unknown
 * @param {number} [ceiling]  absolute upper bound, whatever the machine reports
 */
export function threadsFor(mode, cores, ceiling = 8) {
  const usable = (Number(cores) || 2) - 1;
  const cap = Number(mode?.threadCap) || 1;
  return Math.max(1, Math.min(cap, usable, ceiling));
}

/** How long a prewarm search may run under this mode; 0 means do not run one. */
export function prewarmMsFor(mode) {
  const ms = Number(mode?.prewarmMs);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}
