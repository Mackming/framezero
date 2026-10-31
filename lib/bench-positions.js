/**
 * bench-positions.js — the fixed set of positions the engine benchmark runs.
 *
 * WHY THESE, AND WHY FIXED
 * ------------------------
 * The benchmark exists to answer one question: how much search depth does a
 * bigger neural net cost at the think time you actually play at? That is only
 * answerable if both engines are given identical work, so the positions are
 * pinned here rather than sampled from whatever game happens to be open.
 *
 * The spread matters as much as the count. Evaluation-heavy middlegames are
 * where a larger net earns its keep, and thin, forcing positions are where its
 * extra cost per node is pure loss — an average over both is the honest answer,
 * and either one alone is a way to get the result you were hoping for.
 *
 * Every position is deliberately piece-dense. With `go depth 30 movetime N` the
 * depth limit can be reached early in a sparse endgame, at which point the
 * engine stops and the measurement becomes "how fast did it hit the ceiling"
 * rather than "how deep did it get in the time" — the two engines would then
 * look identical no matter how far apart they really are. Nothing here also
 * falls inside the 7-piece tablebase, so the benchmark measures the search
 * rather than a network lookup.
 */

export const BENCH_POSITIONS = Object.freeze([
  {
    name: 'Opening',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  },
  {
    name: 'Ruy Lopez',
    fen: 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4'
  },
  {
    name: 'Najdorf',
    fen: 'rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6'
  },
  {
    // Closed and manoeuvring: little forcing, so the evaluation function does
    // the work rather than the tactics. The case that most favours a big net.
    name: 'Closed middlegame',
    fen: 'r1bq1rk1/pp2nppp/2n1p3/2ppP3/3P4/2PB1N2/PP1N1PPP/R1BQ1RK1 w - - 0 10'
  },
  {
    // The opposite: heavy pieces, open lines, long forcing sequences, where
    // raw depth beats a better static judgement of each position.
    name: 'Open tactical',
    fen: 'r3k2r/pp1n1ppp/2pbpn2/q7/2BP4/2N1PN2/PP1BQPPP/R3K2R w KQkq - 0 11'
  }
]);

/** Total wall-clock a full run costs, for warning before it starts. */
export function benchDurationMs(moveTimeMs, engineCount) {
  const perSearch = Math.max(0, Number(moveTimeMs) || 0);
  return BENCH_POSITIONS.length * engineCount * perSearch;
}

/**
 * Average depth, nodes and nps across one engine's rows.
 *
 * Searches that failed are dropped rather than counted as zero: one position
 * the engine could not finish would otherwise drag an average down far enough
 * to look like a strength difference, which is exactly the wrong conclusion.
 */
export function summarise(rows) {
  const usable = rows.filter((row) => Number.isFinite(row.depth) && row.depth > 0);
  if (!usable.length) return { positions: 0, depth: 0, nodes: 0, nps: 0 };
  const mean = (pick) => usable.reduce((sum, row) => sum + (Number(pick(row)) || 0), 0) / usable.length;
  return {
    positions: usable.length,
    depth: Number(mean((r) => r.depth).toFixed(1)),
    nodes: Math.round(mean((r) => r.nodes)),
    nps: Math.round(mean((r) => r.nps))
  };
}

/**
 * Turn two summaries into the sentence the user actually wants.
 *
 * Depth is the headline because it is what a shorter time control takes away
 * first: a net that judges each position better but searches two plies less far
 * is usually the weaker player at 500 ms, however good its evaluation is.
 */
export function compare(baseline, other) {
  const depthDelta = Number((other.depth - baseline.depth).toFixed(1));
  const npsRatio = baseline.nps > 0 ? Number((other.nps / baseline.nps).toFixed(2)) : null;
  return { depthDelta, npsRatio };
}
