/**
 * Tests for lib/tablebase.js.
 *
 * The ranking logic here is worth testing precisely because it is so easy to
 * get backwards: a category in `moves[]` describes the position *after* the
 * move, so it is stated from the opponent's side, and a move marked `loss` is
 * the one to play. An inverted sign would not crash or look wrong — it would
 * quietly play the fastest way to lose, in exactly the positions where the
 * tablebase was supposed to make the bot perfect.
 *
 * `tb-kqvk.json` is a real captured response, so the shape being parsed is the
 * shape the server actually sends rather than the one the docs describe.
 */
import { readFileSync } from 'node:fs';
import {
  TABLEBASE_MAX_PIECES,
  countPieces,
  isTablebaseEligible,
  outcomeForMover,
  chooseTablebaseMove,
  tablebaseScore,
  describeChoice,
  fetchTablebase
} from '../lib/tablebase.js';

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
  if (ok) passed++;
  else { console.log('        expected:', expected, '\n        actual  :', actual); failed++; }
}

const KQVK = JSON.parse(
  readFileSync(new URL('./fixtures/tb-kqvk.json', import.meta.url), 'utf8')
);

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------
{
  check('pieces are counted off the placement field only',
    countPieces('8/8/8/4k3/8/8/8/K1Q5 w - - 0 1'), 3);

  // The move counters contain digits too; counting the whole string would
  // include them and quietly disqualify small positions.
  check('the full opening position counts 32',
    countPieces('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'), 32);

  check('seven pieces is in, thirty-two is out',
    [
      isTablebaseEligible('8/8/4k3/8/8/2KQ4/4P3/6r1 w - - 0 1'),
      isTablebaseEligible('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')
    ],
    [true, false]);

  check('the limit is seven', TABLEBASE_MAX_PIECES, 7);

  check('nonsense is not eligible',
    [isTablebaseEligible(''), isTablebaseEligible(null), isTablebaseEligible(undefined)],
    [false, false, false]);
}

// ---------------------------------------------------------------------------
// Reading a category the right way round
// ---------------------------------------------------------------------------
{
  // The single most important assertion in this file.
  check('a child marked loss is a win for the mover', outcomeForMover('loss'), 1);
  check('a child marked win is a loss for the mover', outcomeForMover('win'), -1);
  check('a draw stays a draw', outcomeForMover('draw'), 0);

  // The fifty-move rule turns these into draws, so they are worth a draw and
  // must not be chased as if they were wins.
  check('cursed-win is only worth a draw', outcomeForMover('cursed-win'), 0);
  check('blessed-loss is only worth a draw', outcomeForMover('blessed-loss'), 0);

  check('an unrecognised category is unknown, not a guess',
    [outcomeForMover('unknown'), outcomeForMover('something-new'), outcomeForMover(undefined)],
    [null, null, null]);
}

// ---------------------------------------------------------------------------
// Choosing among moves
// ---------------------------------------------------------------------------
{
  const choice = chooseTablebaseMove({
    moves: [
      { uci: 'a1a2', san: 'Ka2', category: 'draw', dtz: 0, dtm: 0 },
      { uci: 'c1c8', san: 'Qc8', category: 'loss', dtz: -20, dtm: -20 },
      { uci: 'c1f1', san: 'Qf1', category: 'loss', dtz: -16, dtm: -16 },
      { uci: 'c1c5', san: 'Qc5', category: 'win', dtz: 8, dtm: 8 }
    ]
  });
  check('a win is taken over a draw, and the fastest win at that',
    [choice.uci, choice.outcome], ['c1f1', 1]);
}
{
  // Nothing wins, so the draw must be taken rather than the loss.
  const choice = chooseTablebaseMove({
    moves: [
      { uci: 'a1b1', san: 'Kb1', category: 'win', dtz: 12, dtm: 12 },
      { uci: 'a1a2', san: 'Ka2', category: 'draw', dtz: 0, dtm: 0 }
    ]
  });
  check('a draw is taken over a loss', [choice.uci, choice.outcome], ['a1a2', 0]);
}
{
  // Everything loses. Losing slowly is strictly better: the opponent still has
  // to convert, and on a bullet clock they often fail to.
  const choice = chooseTablebaseMove({
    moves: [
      { uci: 'a1a2', san: 'Ka2', category: 'win', dtz: 4, dtm: 4 },
      { uci: 'a1b1', san: 'Kb1', category: 'win', dtz: 30, dtm: 30 }
    ]
  });
  check('a lost position is played out as slowly as possible',
    [choice.uci, choice.outcome], ['a1b1', -1]);
}
{
  // DTZ resets on a capture or pawn move, so it can rank a slower mate first.
  // DTM is the number that actually answers "which wins sooner".
  const choice = chooseTablebaseMove({
    moves: [
      { uci: 'a1a2', san: 'Ka2', category: 'loss', dtz: -1, dtm: -18 },
      { uci: 'c1c5', san: 'Qc5', category: 'loss', dtz: -14, dtm: -6 }
    ]
  });
  check('dtm outranks dtz when both are present', choice.uci, 'c1c5');
}
{
  const choice = chooseTablebaseMove({
    moves: [
      { uci: 'a1a2', san: 'Ka2', category: 'unknown' },
      { uci: 'c1f1', san: 'Qf1', category: 'loss', dtz: -16, dtm: -16 }
    ]
  });
  check('a known outcome beats an unknown one', choice.uci, 'c1f1');
}
{
  // A stalemate really does come back as valid JSON with an empty list —
  // verified against the server. Returning null is what lets the caller fall
  // through to the engine instead of playing junk.
  check('a terminal position yields no move',
    [
      chooseTablebaseMove({ category: 'draw', stalemate: true, moves: [] }),
      chooseTablebaseMove({}),
      chooseTablebaseMove(null),
      chooseTablebaseMove({ moves: [{ san: 'Ka2' }] })        // no uci
    ],
    [null, null, null, null]);
}

// ---------------------------------------------------------------------------
// The real captured response
// ---------------------------------------------------------------------------
{
  const choice = chooseTablebaseMove(KQVK);
  check('the real KQvK response yields a winning move', choice.outcome, 1);

  // The server publishes a root dtm of 17 plies and its best children at -16.
  check('and it agrees with the server about the distance',
    [KQVK.dtm, choice.dtm], [17, -16]);

  // 17 plies is mate in 9. Getting there from a child's -16 requires adding
  // back the ply for the move being chosen before halving — the off-by-one
  // this fixture exists to pin down.
  check('a child dtm of -16 reads as mate in 9',
    tablebaseScore(choice), { type: 'mate', value: 9 });

  check('the server put a best move first, and so did we',
    choice.uci, KQVK.moves[0].uci);
}

// ---------------------------------------------------------------------------
// Scores and descriptions
// ---------------------------------------------------------------------------
{
  check('a draw scores dead level',
    tablebaseScore({ outcome: 0, dtz: 0, dtm: 0 }), { type: 'cp', value: 0 });

  check('being mated scores as a negative mate',
    tablebaseScore({ outcome: -1, dtz: 9, dtm: 9 }), { type: 'mate', value: -5 });

  // Won, but the server gave no mate distance — there is no honest mate count
  // to report, so it reads as decisive in centipawns instead of inventing one.
  check('a win with no dtm falls back to a decisive centipawn score',
    tablebaseScore({ outcome: 1, dtz: -30, dtm: null }), { type: 'cp', value: 10000 });

  check('an unknown outcome has no score', tablebaseScore({ outcome: null }), null);
  check('no choice has no score', tablebaseScore(null), null);

  check('a win is described with its mate distance',
    describeChoice({ outcome: 1, dtz: -16, dtm: -16 }),
    'tablebase: winning, mate in 9 — provably optimal');

  check('a dtm-less result is described by dtz',
    describeChoice({ outcome: 0, dtz: -30, dtm: null }),
    'tablebase: drawn, DTZ 30 — provably optimal');
}

// ---------------------------------------------------------------------------
// fetchTablebase: a miss must cost nothing but a fallback
// ---------------------------------------------------------------------------
{
  const results = [];
  const never = () => { throw new Error('fetch should not have been called'); };

  // Too many pieces: no request at all, so a middlegame never pays for this.
  results.push(await fetchTablebase(
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    { fetchImpl: never }
  ));

  // An HTTP error. The server answers an illegal FEN with a plain-text body
  // rather than JSON, so this path has to survive both the status and an
  // unparseable payload.
  results.push(await fetchTablebase('8/8/8/4k3/8/8/8/K1Q5 w - - 0 1', {
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => { throw new Error('not json'); } })
  }));

  // A 200 whose body is not JSON.
  results.push(await fetchTablebase('8/8/8/4k3/8/8/8/K1Q5 w - - 0 1', {
    fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('not json'); } })
  }));

  // The network simply failing.
  results.push(await fetchTablebase('8/8/8/4k3/8/8/8/K1Q5 w - - 0 1', {
    fetchImpl: async () => { throw new Error('offline'); }
  }));

  check('every failure mode resolves to null rather than throwing',
    results, [null, null, null, null]);

  const ok = await fetchTablebase('8/8/8/4k3/8/8/8/K1Q5 w - - 0 1', {
    fetchImpl: async (url) => {
      // The FEN has spaces and a slash-heavy placement; it must arrive encoded.
      if (!url.includes('K1Q5%20w')) throw new Error(`fen was not encoded: ${url}`);
      return { ok: true, json: async () => KQVK };
    }
  });
  check('a good response comes back parsed, from an encoded url', ok.category, 'win');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
