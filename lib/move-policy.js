/**
 * move-policy.js — playing styles, as a pure function over engine candidates.
 *
 * Stockfish does not have a "style" knob. What it has is MultiPV: ask for the
 * top N moves and it reports each one with its own score. Everything in here
 * is a policy for choosing among that list — no engine changes, no second
 * build, no weakening options. A mode is a filter plus a ranking.
 *
 * Pure data + pure logic, no extension or DOM APIs, so it is unit-tested
 * directly (test/move-policy.test.js) the same way opening-book.js is.
 *
 * Scores arrive in UCI's frame: relative to whoever is on move, positive =
 * good for them. Since the side on move is always the side we are choosing
 * for, that is already "our" frame and no sign flipping happens in this file.
 */

import { Chess } from './chess.js';

/**
 * Mate scores are folded into the centipawn scale so that one comparison
 * works for both. The offset by distance keeps "mate in 2" ahead of "mate in
 * 5", and the magnitude puts any mate far outside the concession windows
 * below — which is what stops a fun mode from casually declining a forced
 * win. No mode needs a special case for mate; the arithmetic handles it.
 */
export const MATE_SCORE = 30_000;

/**
 * A mode may give up evaluation to get the move it wants, but never so much
 * that it walks into a genuinely lost position. Modes whose whole point is
 * bleeding away an advantage (tease, drawish) opt out of the concession cap,
 * but every mode respects this floor.
 */
const LOSING_FLOOR_CP = -80;

/** Roughly standard piece values, for "how big is this capture" questions. */
const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

/**
 * How far below the shallow search's worst *listed* move to score a candidate
 * it never listed at all. Scoring it equal to the worst listed move would
 * understate things: missing the shallow MultiPV cut means it genuinely
 * evaluated below everything that made the cut, so the gap it opens against
 * the deep search is correspondingly larger.
 */
const UNLISTED_SHALLOW_PENALTY_CP = 50;

/** The eval band "teasing" tries to stay inside: winning, but never converting. */
const TEASE_MIN_CP = 80;
const TEASE_MAX_CP = 250;

/**
 * The catalogue. `multiPV` is how many candidates the engine is asked for,
 * `concessionCp` how far below the best move this mode may reach, and
 * `shallowDepth` (trap only) requests the extra shallow search described in
 * pickTrap() below.
 *
 * `book` picks which opening book runs before the engine is consulted at all
 * — the sharp modes get the gambit lines, so a style choice changes the game
 * from move one rather than only once theory runs out.
 */
export const MODES = [
  {
    id: 'best',
    label: 'Best move',
    hint: 'Full strength — plays the engine top choice',
    multiPV: 1,
    concessionCp: 0,
    book: 'main'
  },
  {
    id: 'chaos',
    label: 'Chaos',
    hint: 'Random pick among near-equal moves — same strength, different games',
    multiPV: 5,
    concessionCp: 60,
    book: 'main'
  },
  {
    id: 'aggro',
    label: 'Aggressive',
    hint: 'Prefers checks and captures when they cost almost nothing',
    multiPV: 5,
    concessionCp: 90,
    book: 'gambit'
  },
  {
    id: 'greedy',
    label: 'Greedy',
    hint: 'Grabs the biggest material it can without spoiling the position',
    multiPV: 5,
    concessionCp: 80,
    book: 'main'
  },
  {
    id: 'trap',
    label: 'Trap',
    hint: 'Baits — plays moves that look bad shallow but are good deep',
    multiPV: 5,
    concessionCp: 120,
    shallowDepth: 6,
    book: 'gambit'
  },
  {
    id: 'tease',
    label: 'Teasing',
    hint: 'Stays winning but refuses to convert — keeps you alive and suffering',
    multiPV: 6,
    concessionCp: Infinity,
    book: 'main'
  },
  {
    id: 'drawish',
    label: 'Drawish',
    hint: 'Steers every position back toward dead level',
    multiPV: 6,
    concessionCp: Infinity,
    book: 'main'
  }
];

export const DEFAULT_MODE = 'best';

/** Look up a mode by id, falling back to `best` for anything unrecognised. */
export function getMode(id) {
  return MODES.find((m) => m.id === id) ?? MODES.find((m) => m.id === DEFAULT_MODE);
}

/** UCI `score` object -> a single comparable number. */
export function scoreToCp(score) {
  if (!score) return null;
  if (score.type === 'mate') {
    return score.value > 0 ? MATE_SCORE - score.value : -MATE_SCORE - score.value;
  }
  return score.value;
}

/**
 * Attach what the raw UCI line cannot tell us — whether a move is a check, a
 * capture, and of what — by replaying it in the actual position. Candidates
 * the position rejects are dropped rather than trusted: a move that will not
 * play is a move we must never hand to the auto-player.
 */
function annotate(candidates, fen) {
  let legal = [];
  try {
    legal = new Chess(fen).moves({ verbose: true });
  } catch {
    /* unparseable FEN — fall through with no annotation */
  }

  const byUci = new Map(
    legal.map((m) => [`${m.from}${m.to}${m.promotion ?? ''}`, m])
  );

  return candidates
    .map((candidate) => {
      const move = byUci.get(candidate.move);
      // With no legal-move list at all (bad FEN) we cannot verify anything, so
      // candidates pass through unannotated rather than being thrown away.
      if (!move && legal.length) return null;
      const san = move?.san ?? '';
      return {
        ...candidate,
        cp: scoreToCp(candidate.score),
        san,
        isCheck: san.includes('+') || san.includes('#'),
        isMate: san.includes('#'),
        captureValue: move?.captured ? PIECE_VALUES[move.captured] ?? 0 : 0
      };
    })
    .filter((c) => c !== null && Number.isFinite(c.cp));
}

/**
 * The moves a mode is allowed to consider: close enough to the best move, and
 * not below the point where "fun" turns into "losing on purpose".
 *
 * When the best available move is itself below the floor the position is
 * already lost, and clamping to the floor would empty the set — so the floor
 * drops to meet it and the concession window does the work alone.
 */
function safeSet(ranked, concessionCp) {
  const bestCp = ranked[0].cp;
  const floor = Math.min(LOSING_FLOOR_CP, bestCp);
  return ranked.filter((c) => c.cp >= bestCp - concessionCp && c.cp >= floor);
}

/** Pick the pool member scoring highest under `rank`; ties keep engine order. */
function bestOf(pool, rank) {
  let winner = pool[0];
  let winningRank = rank(pool[0]);
  for (const candidate of pool.slice(1)) {
    const r = rank(candidate);
    if (r > winningRank) { winner = candidate; winningRank = r; }
  }
  return winner;
}

/**
 * A trap is not "a move that looks weird" — it has a testable definition: a
 * move a shallow search dislikes and a deep search likes. Playing the move
 * with the largest such disagreement is playing the move most likely to be
 * misjudged by an opponent who is not calculating as far as we are.
 *
 * Falls back to the engine's own pick when there is no shallow search to
 * disagree with, so trap mode degrades to `best` rather than to nonsense.
 */
function pickTrap(pool, shallow) {
  if (!shallow?.length) return { move: pool[0].move, reason: 'no shallow search — played best' };

  const shallowCp = new Map(shallow.map((c) => [c.move, scoreToCp(c.score)]));
  const worstSeen = Math.min(...shallowCp.values());

  let bait = null;
  let widestGap = -Infinity;
  for (const candidate of pool) {
    const seen = shallowCp.get(candidate.move);
    // A move the shallow search never even listed is the strongest possible
    // form of "it does not see this" — scored below everything it did list,
    // rather than treated as missing data.
    const shallowValue = seen ?? worstSeen - UNLISTED_SHALLOW_PENALTY_CP;
    const gap = candidate.cp - shallowValue;
    if (gap > widestGap) { widestGap = gap; bait = candidate; }
  }

  if (!bait || widestGap <= 0) {
    return { move: pool[0].move, reason: 'nothing looked like bait — played best' };
  }
  return {
    move: bait.move,
    reason: `bait: ${bait.san || bait.move} looks ${(widestGap / 100).toFixed(2)} worse than it is`
  };
}

/**
 * Anti-draw ("contempt"): how much evaluation we will give up to dodge a
 * repetition, and how bad a position we will accept to do it.
 *
 * Two settings, because the right answer depends on the clock. With a real
 * time lead a draw throws away a likely win on time, so it is worth a small
 * concession — but only a small one: the floor is what stops this from ever
 * walking into a genuinely worse position for the sake of avoiding a draw.
 * Without a clock lead the bar is much tighter: only near-free alternatives.
 */
export const ANTI_DRAW = Object.freeze({
  clockEdge: { concessionCp: 70, floorCp: -50 },
  even:      { concessionCp: 25, floorCp: -25 },
  /** "Clock lead" means at least this much more time, and this ratio. */
  minLeadMs: 3_000,
  minLeadRatio: 1.3
});

/** Is our clock far enough ahead that a draw is costing us a win on time? */
export function hasClockEdge(ourMs, theirMs) {
  if (!Number.isFinite(ourMs) || !Number.isFinite(theirMs)) return false;
  return ourMs - theirMs >= ANTI_DRAW.minLeadMs && ourMs >= theirMs * ANTI_DRAW.minLeadRatio;
}

/**
 * Swap a repeating move for the best non-repeating one, if one is good enough.
 *
 * @param {string} chosen  the move the style picked
 * @param {Array<{move: string, score: object}>} candidates  MultiPV list, best first
 * @param {string[]} avoidMoves  moves that land on an already-seen position
 * @param {{ourMs?: number, theirMs?: number}} clocks
 * @returns {{move: string, reason: string|null}}  reason is null when unchanged
 */
export function avoidRepetition(chosen, candidates, avoidMoves, { ourMs, theirMs } = {}) {
  const avoid = new Set(avoidMoves ?? []);
  if (!chosen || !avoid.has(chosen) || !Array.isArray(candidates)) return { move: chosen, reason: null };

  const edge = hasClockEdge(ourMs, theirMs);
  const { concessionCp, floorCp } = edge ? ANTI_DRAW.clockEdge : ANTI_DRAW.even;
  const repeatCp = scoreToCp(candidates.find((c) => c.move === chosen)?.score);
  if (repeatCp === null) return { move: chosen, reason: null };

  const alternative = candidates
    .filter((c) => !avoid.has(c.move))
    .map((c) => ({ move: c.move, cp: scoreToCp(c.score) }))
    .filter((c) => c.cp !== null && c.cp >= floorCp && c.cp >= repeatCp - concessionCp)
    .sort((a, b) => b.cp - a.cp)[0];

  if (!alternative) {
    return { move: chosen, reason: 'repetition accepted — every alternative is clearly worse' };
  }
  return {
    move: alternative.move,
    reason: `avoided repetition (${(alternative.cp / 100).toFixed(2)} vs ${(repeatCp / 100).toFixed(2)}` +
      `${edge ? ', ahead on the clock' : ''})`
  };
}

/**
 * Choose a move from the engine's MultiPV candidates according to a style.
 *
 * @param {Array<{move: string, score: {type: 'cp'|'mate', value: number}, pv?: string[]}>} candidates
 *   Engine candidates, best first, scored from the moving side's point of view.
 * @param {object}   opts
 * @param {string}   opts.mode      A MODES id; anything unknown falls back to `best`.
 * @param {string}   opts.fen       The position, for check/capture annotation.
 * @param {Array}    [opts.shallow] Candidates from a shallow search (trap mode).
 * @param {Function} [opts.random]  Injectable RNG, so `chaos` is testable.
 * @returns {{move: string|null, reason: string}}
 */
export function pickMove(candidates, { mode = DEFAULT_MODE, fen, shallow = null, random = Math.random } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { move: null, reason: 'no candidates' };
  }

  const style = getMode(mode);
  const ranked = annotate(candidates, fen);
  if (ranked.length === 0) return { move: null, reason: 'no legal candidates' };
  if (ranked.length === 1 || style.id === 'best') {
    return { move: ranked[0].move, reason: 'engine best' };
  }

  const pool = safeSet(ranked, style.concessionCp);
  if (pool.length === 1) {
    return { move: pool[0].move, reason: 'only one safe move' };
  }

  switch (style.id) {
    case 'chaos': {
      const pick = pool[Math.floor(random() * pool.length)] ?? pool[0];
      return { move: pick.move, reason: `chaos: ${pick.san || pick.move} of ${pool.length} near-equal moves` };
    }

    case 'aggro': {
      // Mate ends it, a check forces a reply, a capture wins material; the raw
      // score only breaks ties between equally forcing moves.
      const pick = bestOf(pool, (c) =>
        (c.isMate ? 1e9 : 0) + (c.isCheck ? 1e6 : 0) + c.captureValue * 100 + c.cp);
      return { move: pick.move, reason: `aggressive: ${pick.san || pick.move}` };
    }

    case 'greedy': {
      const pick = bestOf(pool, (c) => c.captureValue * 1000 + c.cp);
      return {
        move: pick.move,
        reason: pick.captureValue
          ? `greedy: took ${pick.san || pick.move}`
          : `greedy: nothing to take, played ${pick.san || pick.move}`
      };
    }

    case 'trap':
      return pickTrap(pool, shallow);

    case 'tease': {
      const bestCp = pool[0].cp;
      // Not actually winning yet, so there is no advantage to sit on.
      if (bestCp < TEASE_MIN_CP) {
        return { move: pool[0].move, reason: 'not winning yet — played best' };
      }
      const inBand = pool.filter((c) => c.cp >= TEASE_MIN_CP && c.cp <= TEASE_MAX_CP);
      if (inBand.length) {
        const midpoint = (TEASE_MIN_CP + TEASE_MAX_CP) / 2;
        const pick = bestOf(inBand, (c) => -Math.abs(c.cp - midpoint));
        return { move: pick.move, reason: `teasing: holding at ${(pick.cp / 100).toFixed(2)}` };
      }
      // Every move keeps a bigger advantage than we want; take the smallest.
      const pick = bestOf(pool, (c) => -c.cp);
      return { move: pick.move, reason: `teasing: easing off to ${(pick.cp / 100).toFixed(2)}` };
    }

    case 'drawish': {
      const pick = bestOf(pool, (c) => -Math.abs(c.cp));
      return { move: pick.move, reason: `levelling: ${(pick.cp / 100).toFixed(2)}` };
    }

    default:
      return { move: ranked[0].move, reason: 'engine best' };
  }
}
