/**
 * tablebase.js — perfect endgame play, from Lichess's public Syzygy server.
 *
 * WHY THIS EXISTS
 * ---------------
 * A search is an estimate. In an endgame that estimate is often wrong in a
 * specific and expensive way: the engine sees that a position is winning but
 * not *how* to win it, because the win is forty moves deep behind a series of
 * quiet moves that no amount of pruning will reach at bullet time. That is the
 * "endgame accuracy was not that good" signature exactly — the evaluation is
 * right and the moves are not.
 *
 * Syzygy tablebases replace the estimate with the answer. Every position with
 * seven pieces or fewer has been solved exhaustively, so there is a provably
 * optimal move and a provably correct result. This is not "stronger": inside
 * the tablebase it is perfect, and no engine at any depth or time control can
 * do better.
 *
 * The engine build here cannot load Syzygy files itself — the WASM glue has no
 * `SyzygyPath` option and no filesystem to point it at — so the only route is
 * Lichess's own public server. It is also, conveniently, *faster* than
 * searching: one request answers in well under the time a search would take,
 * so consulting it saves clock rather than spending it.
 *
 * Everything except `fetchTablebase` is pure, so the ranking logic — the part
 * that is easy to get subtly backwards — is unit-tested.
 *
 * Response shape (https://tablebase.lichess.ovh/standard?fen=...):
 *   {
 *     category: 'win', dtz: 14, dtm: 21, checkmate: false, stalemate: false,
 *     moves: [ { uci: 'a2a3', san: 'a3', category: 'loss',
 *                dtz: -13, dtm: -20, zeroing: false }, ... ]
 *   }
 */

/** Syzygy is solved to seven pieces; an eighth makes the lookup pointless. */
export const TABLEBASE_MAX_PIECES = 7;

export const TABLEBASE_URL = 'https://tablebase.lichess.ovh/standard';

/** Pieces on the board, from a FEN's placement field. */
export function countPieces(fen) {
  const placement = String(fen ?? '').trim().split(/\s+/)[0] ?? '';
  let pieces = 0;
  for (const ch of placement) if (/[pnbrqkPNBRQK]/.test(ch)) pieces++;
  return pieces;
}

/** Is this position small enough to have been solved? */
export function isTablebaseEligible(fen) {
  const pieces = countPieces(fen);
  return pieces > 0 && pieces <= TABLEBASE_MAX_PIECES;
}

/**
 * What a category is worth to the side about to move in the position that
 * category describes.
 *
 * `cursed-win` and `blessed-loss` are wins and losses that the fifty-move rule
 * turns into draws, so they are worth exactly a draw and nothing more.
 */
const OUTCOME = {
  win: 1,
  'maybe-win': 1,
  'syzygy-win': 1,
  'cursed-win': 0,
  draw: 0,
  'blessed-loss': 0,
  'maybe-loss': -1,
  'syzygy-loss': -1,
  loss: -1
};

/**
 * The result of a move, from the point of view of whoever played it.
 * +1 we win, 0 draw, -1 we lose, null unknown.
 *
 * The subtlety that earns this its own function: a category on an entry in
 * `moves[]` describes the position *after* that move, so it is stated from the
 * opponent's side. A move whose category is `loss` is the move we want — it is
 * the opponent who loses. Reading these the right way round is the whole job.
 */
export function outcomeForMover(childCategory) {
  const forOpponent = OUTCOME[childCategory];
  if (forOpponent === undefined) return null;      // 'unknown', or a new value
  return -forOpponent;
}

/**
 * Plies to the decisive event, preferring distance-to-mate over
 * distance-to-zeroing.
 *
 * DTZ counts to the next capture or pawn move, not to mate, so ranking two
 * winning moves by DTZ can prefer one that merely resets the fifty-move
 * counter over one that mates sooner. DTM is the number actually wanted; DTZ
 * is the fallback for positions where the server does not publish DTM.
 */
function distance(move) {
  const dtm = Number.isFinite(move?.dtm) ? Math.abs(move.dtm) : null;
  const dtz = Number.isFinite(move?.dtz) ? Math.abs(move.dtz) : null;
  return dtm ?? dtz ?? Number.POSITIVE_INFINITY;
}

/**
 * Pick the optimal move out of a tablebase response.
 *
 * Ranked by outcome first, then by speed — fastest conversion when winning,
 * slowest capitulation when losing. That second half matters more than it
 * sounds: a lost position played for maximum length is one the opponent still
 * has to convert, and at bullet time controls they frequently do not.
 *
 * @returns {{uci: string, san: string|null, outcome: number|null,
 *   dtz: number|null, dtm: number|null}|null}
 */
export function chooseTablebaseMove(payload) {
  const moves = Array.isArray(payload?.moves) ? payload.moves : [];
  const legal = moves.filter((m) => typeof m?.uci === 'string' && m.uci.length >= 4);
  if (!legal.length) return null;                  // mate, stalemate, or no data

  let best = null;
  let bestOutcome = null;
  let bestDistance = 0;

  for (const move of legal) {
    const outcome = outcomeForMover(move.category);
    const dist = distance(move);

    if (best === null) {
      best = move; bestOutcome = outcome; bestDistance = dist;
      continue;
    }

    // A known outcome always beats an unknown one; between known outcomes,
    // higher is better.
    if (outcome === null && bestOutcome !== null) continue;
    if (bestOutcome === null && outcome !== null) {
      best = move; bestOutcome = outcome; bestDistance = dist;
      continue;
    }
    if (outcome !== bestOutcome) {
      if (outcome > bestOutcome) { best = move; bestOutcome = outcome; bestDistance = dist; }
      continue;
    }

    // Same outcome: win fast, lose slowly, and do not care when drawing.
    const better = bestOutcome > 0 ? dist < bestDistance
      : bestOutcome < 0 ? dist > bestDistance
      : false;
    if (better) { best = move; bestOutcome = outcome; bestDistance = dist; }
  }

  if (!best) return null;
  return {
    uci: best.uci,
    san: typeof best.san === 'string' ? best.san : null,
    outcome: bestOutcome,
    dtz: Number.isFinite(best.dtz) ? best.dtz : null,
    dtm: Number.isFinite(best.dtm) ? best.dtm : null
  };
}

/** Large enough to read as decisive without pretending to be a mate distance. */
const TABLEBASE_DECISIVE_CP = 10_000;

/**
 * Mate distance in *moves*, from a child move's DTM in *plies*.
 *
 * Two conversions, and both are easy to drop. The DTM on an entry in `moves[]`
 * belongs to the position after that move, so the move itself has to be added
 * back before counting; and UCI states mate in moves while Syzygy states it in
 * plies. Verified against the server: KQvK at `8/8/8/4k3/8/8/8/K1Q5 w - - 0 1`
 * reports a root DTM of 17 plies with its best children at -16, and 17 plies is
 * mate in 9 — which only comes out right if the ply for the move being chosen
 * is counted.
 */
function matesIn(childDtm) {
  return Math.ceil((Math.abs(childDtm) + 1) / 2);
}

/**
 * A UCI-shaped score for the chosen move, so the eval bar and the log can
 * treat a tablebase answer exactly like a search result.
 *
 * `score mate` is counted in moves while DTM is in plies, hence the halving.
 */
export function tablebaseScore(choice) {
  if (!choice || choice.outcome === null) return null;
  if (choice.outcome === 0) return { type: 'cp', value: 0 };

  if (Number.isFinite(choice.dtm) && choice.dtm !== 0) {
    return { type: 'mate', value: choice.outcome > 0 ? matesIn(choice.dtm) : -matesIn(choice.dtm) };
  }

  return { type: 'cp', value: choice.outcome > 0 ? TABLEBASE_DECISIVE_CP : -TABLEBASE_DECISIVE_CP };
}

/** Human-readable summary, for the move log. */
export function describeChoice(choice) {
  if (!choice) return 'tablebase: no data';
  const verdict = choice.outcome > 0 ? 'winning'
    : choice.outcome < 0 ? 'losing'
    : choice.outcome === 0 ? 'drawn'
    : 'unknown';
  const detail = Number.isFinite(choice.dtm) && choice.dtm !== 0
    ? `, mate in ${matesIn(choice.dtm)}`
    : Number.isFinite(choice.dtz)
      ? `, DTZ ${Math.abs(choice.dtz)}`
      : '';
  return `tablebase: ${verdict}${detail} — provably optimal`;
}

/**
 * Ask the server. Resolves null on anything at all going wrong, because a
 * tablebase miss must cost the move nothing but a fallback to the engine.
 *
 * @param {string} fen
 * @param {{timeoutMs?: number, fetchImpl?: Function}} options
 */
export async function fetchTablebase(fen, { timeoutMs = 700, fetchImpl = fetch } = {}) {
  if (!isTablebaseEligible(fen)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `${TABLEBASE_URL}?fen=${encodeURIComponent(fen)}`,
      { signal: controller.signal, cache: 'force-cache' }
    );
    if (!response?.ok) return null;
    return await response.json();
  } catch {
    return null;      // aborted, offline, rate-limited, malformed — all the same here
  } finally {
    clearTimeout(timer);
  }
}
