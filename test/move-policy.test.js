/**
 * Tests for lib/move-policy.js: the mode catalogue is well formed, score
 * folding orders mates correctly, and each playing style picks the move its
 * description promises — including the safety rules every style shares.
 */
import { MODES, DEFAULT_MODE, MATE_SCORE, getMode, scoreToCp, pickMove, avoidRepetition, hasClockEdge } from '../lib/move-policy.js';

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { console.log('        expected:', expected, '\n        actual  :', actual); failed++; }
  else passed++;
}

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// Italian, after 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 — Bxf7+ is a capture *and* a
// check, Nxe5 is a plain capture, O-O is quiet. Enough to separate the styles.
const ITALIAN = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

const cp = (move, value) => ({ move, score: { type: 'cp', value }, pv: [move] });
const mate = (move, value) => ({ move, score: { type: 'mate', value }, pv: [move] });

// --- catalogue ---------------------------------------------------------------
{
  const ids = MODES.map((m) => m.id);
  check('mode ids are unique', ids.length, new Set(ids).size);
  check('every mode has label, hint and multiPV',
    MODES.every((m) => m.label && m.hint && Number.isInteger(m.multiPV) && m.multiPV >= 1), true);
  check('every mode declares a known book',
    MODES.every((m) => m.book === 'main' || m.book === 'gambit'), true);
  check('default mode exists in the catalogue', ids.includes(DEFAULT_MODE), true);
  check('unknown mode id falls back to the default', getMode('nonsense').id, DEFAULT_MODE);
  check('only trap requests a shallow search',
    MODES.filter((m) => m.shallowDepth).map((m) => m.id), ['trap']);
}

// --- score folding -----------------------------------------------------------
{
  check('cp score passes through', scoreToCp({ type: 'cp', value: 35 }), 35);
  check('mate for us is huge and positive', scoreToCp({ type: 'mate', value: 3 }), MATE_SCORE - 3);
  check('mate against us is huge and negative', scoreToCp({ type: 'mate', value: -3 }), -MATE_SCORE + 3);
  check('a faster mate outranks a slower one',
    scoreToCp({ type: 'mate', value: 2 }) > scoreToCp({ type: 'mate', value: 5 }), true);
  check('any mate outranks any normal advantage',
    scoreToCp({ type: 'mate', value: 30 }) > scoreToCp({ type: 'cp', value: 2000 }), true);
  check('missing score is null', scoreToCp(null), null);
}

// --- degenerate input --------------------------------------------------------
{
  check('no candidates -> null move', pickMove([], { mode: 'chaos', fen: START }).move, null);
  check('non-array candidates -> null move', pickMove(undefined, { mode: 'chaos', fen: START }).move, null);
  check('illegal candidates are discarded',
    pickMove([cp('a1a8', 500), cp('e2e4', 20)], { mode: 'chaos', fen: START }).move, 'e2e4');
  check('every candidate illegal -> null move',
    pickMove([cp('a1a8', 500)], { mode: 'chaos', fen: START }).move, null);
}

// --- best --------------------------------------------------------------------
{
  const cands = [cp('e2e4', 30), cp('d2d4', 25), cp('g1f3', 20)];
  check('best plays the top candidate', pickMove(cands, { mode: 'best', fen: START }).move, 'e2e4');
  check('unknown mode behaves as best', pickMove(cands, { mode: 'zzz', fen: START }).move, 'e2e4');
  check('a single candidate is played whatever the mode',
    pickMove([cp('d2d4', 5)], { mode: 'drawish', fen: START }).move, 'd2d4');
}

// --- chaos -------------------------------------------------------------------
{
  const cands = [cp('e2e4', 30), cp('d2d4', 25), cp('g1f3', 20), cp('b1c3', 15)];
  check('chaos picks the first when the RNG says so',
    pickMove(cands, { mode: 'chaos', fen: START, random: () => 0 }).move, 'e2e4');
  check('chaos picks the last when the RNG says so',
    pickMove(cands, { mode: 'chaos', fen: START, random: () => 0.99 }).move, 'b1c3');

  // 30 -> 15 is inside the 60cp window, so all four stay in play.
  const seen = new Set();
  for (let i = 0; i < 4; i++) seen.add(pickMove(cands, { mode: 'chaos', fen: START, random: () => i / 4 }).move);
  check('chaos can reach every near-equal move', seen.size, 4);

  // ...but a move well outside the window must never be reachable.
  const wide = [cp('e2e4', 30), cp('a2a3', -400)];
  const reached = new Set();
  for (let i = 0; i < 10; i++) reached.add(pickMove(wide, { mode: 'chaos', fen: START, random: () => i / 10 }).move);
  check('chaos never reaches a move outside the concession window', [...reached], ['e2e4']);
}

// --- the shared safety rules -------------------------------------------------
{
  // A forced mate sits ~30000cp above everything, so no concession window can
  // include an alternative — every fun mode is forced onto the mate.
  const mating = [mate('e2e4', 2), cp('d2d4', 300), cp('g1f3', 290)];
  for (const mode of ['chaos', 'aggro', 'greedy', 'trap']) {
    check(`${mode} cannot decline a forced mate`,
      pickMove(mating, { mode, fen: START, random: () => 0.99 }).move, 'e2e4');
  }

  // Tease and drawish waive the concession cap, but not the losing floor.
  const cliff = [cp('e2e4', 500), cp('a2a3', -900)];
  check('tease will not step below the losing floor',
    pickMove(cliff, { mode: 'tease', fen: START }).move, 'e2e4');
  check('drawish will not step below the losing floor',
    pickMove(cliff, { mode: 'drawish', fen: START }).move, 'e2e4');

  // Already lost: the floor drops to meet the position instead of emptying
  // the pool, and the best move is still available to play.
  const lost = [cp('e2e4', -600), cp('d2d4', -640)];
  check('an already-lost position still yields a move',
    pickMove(lost, { mode: 'chaos', fen: START, random: () => 0 }).move, 'e2e4');
}

// --- aggro vs greedy ---------------------------------------------------------
{
  // Nxe5 scores best, Bxf7+ is the same size capture but also a check, O-O is
  // quiet. Both captures take a pawn, so greedy falls through to the score
  // while aggro is pulled to the check — the two styles must diverge here.
  const cands = [cp('f3e5', 40), cp('c4f7', 20), cp('e1g1', 10)];
  check('aggro prefers the capture that also checks',
    pickMove(cands, { mode: 'aggro', fen: ITALIAN }).move, 'c4f7');
  check('greedy breaks a material tie on evaluation',
    pickMove(cands, { mode: 'greedy', fen: ITALIAN }).move, 'f3e5');

  const quiet = [cp('e1g1', 30), cp('d2d3', 25)];
  check('greedy says so when there is nothing to take',
    pickMove(quiet, { mode: 'greedy', fen: ITALIAN }).reason.includes('nothing to take'), true);

  // Material must beat a quiet move inside the window regardless of score order.
  const sizes = [cp('e1g1', 40), cp('f3e5', 15)];
  check('greedy takes material over a quiet move inside the window',
    pickMove(sizes, { mode: 'greedy', fen: ITALIAN }).move, 'f3e5');
}

// --- tease -------------------------------------------------------------------
{
  const winning = [cp('e2e4', 500), cp('d2d4', 200), cp('g1f3', 150), cp('a2a3', -300)];
  // Band is 80..250, so the midpoint is 165: g1f3 at 150 sits 15 away and
  // d2d4 at 200 sits 35 away.
  check('tease settles inside the band, nearest its midpoint',
    pickMove(winning, { mode: 'tease', fen: START }).move, 'g1f3');

  const notYet = [cp('e2e4', 50), cp('d2d4', 40), cp('g1f3', 30)];
  check('tease plays best when not actually winning',
    pickMove(notYet, { mode: 'tease', fen: START }).move, 'e2e4');
  check('tease says why it played best when not winning',
    pickMove(notYet, { mode: 'tease', fen: START }).reason.includes('not winning yet'), true);

  const crushing = [cp('e2e4', 900), cp('d2d4', 700), cp('g1f3', 600)];
  check('tease eases off when every move is above the band',
    pickMove(crushing, { mode: 'tease', fen: START }).move, 'g1f3');
}

// --- drawish -----------------------------------------------------------------
{
  const cands = [cp('e2e4', 500), cp('d2d4', 200), cp('g1f3', 10), cp('a2a3', -300)];
  check('drawish steers to the flattest evaluation',
    pickMove(cands, { mode: 'drawish', fen: START }).move, 'g1f3');

  const belowZero = [cp('e2e4', 60), cp('d2d4', -20)];
  check('drawish crosses zero from either side',
    pickMove(belowZero, { mode: 'drawish', fen: START }).move, 'd2d4');
}

// --- trap --------------------------------------------------------------------
{
  const deep = [cp('e2e4', 50), cp('d2d4', 45), cp('g1f3', 40)];

  const shallow = [cp('e2e4', 50), cp('d2d4', -200), cp('g1f3', 38)];
  check('trap plays the move the shallow search most misjudges',
    pickMove(deep, { mode: 'trap', fen: START, shallow }).move, 'd2d4');
  check('trap reports how much bait it found',
    pickMove(deep, { mode: 'trap', fen: START, shallow }).reason.includes('bait'), true);

  check('trap degrades to best with no shallow search',
    pickMove(deep, { mode: 'trap', fen: START, shallow: null }).move, 'e2e4');
  check('trap says why it degraded',
    pickMove(deep, { mode: 'trap', fen: START, shallow: [] }).reason.includes('no shallow search'), true);

  // A move the shallow search never listed at all is the strongest bait of
  // all, and must beat one it merely scored low.
  const omitted = [cp('e2e4', 50), cp('d2d4', 45), cp('g1f3', 44)];
  const partial = [cp('e2e4', 50), cp('d2d4', 20)];
  check('trap treats an unlisted move as maximally underestimated',
    pickMove(omitted, { mode: 'trap', fen: START, shallow: partial }).move, 'g1f3');

  // Shallow and deep agreeing means there is no trap to find.
  const agrees = [cp('e2e4', 50), cp('d2d4', 45)];
  check('trap plays best when nothing is misjudged',
    pickMove(agrees, { mode: 'trap', fen: START, shallow: agrees }).move, 'e2e4');
}

// --- anti-draw ---------------------------------------------------------------
{
  const cp = (v) => ({ type: 'cp', value: v });
  // The engine, seeing history, scores the repeat as a dead draw.
  const cands = [
    { move: 'g1f3', score: cp(0) },     // repeats
    { move: 'b1c3', score: cp(-20) },
    { move: 'h2h4', score: cp(-60) },
    { move: 'f2f3', score: cp(-200) }
  ];
  const avoid = ['g1f3'];

  check('anti-draw: non-repeating move is left alone',
    avoidRepetition('b1c3', cands, avoid).move, 'b1c3');
  check('anti-draw: near-free alternative replaces the repeat (even clocks)',
    avoidRepetition('g1f3', cands, avoid, { ourMs: 20_000, theirMs: 19_000 }).move, 'b1c3');

  const tight = [{ move: 'g1f3', score: cp(0) }, { move: 'h2h4', score: cp(-40) }];
  check('anti-draw: even clocks will not give up 0.40 to avoid a draw',
    avoidRepetition('g1f3', tight, avoid, { ourMs: 20_000, theirMs: 19_000 }).move, 'g1f3');
  check('anti-draw: with a big clock lead it will',
    avoidRepetition('g1f3', tight, avoid, { ourMs: 40_000, theirMs: 10_000 }).move, 'h2h4');

  const bad = [{ move: 'g1f3', score: cp(0) }, { move: 'f2f3', score: cp(-200) }];
  check('anti-draw: never walks into a clearly worse position, even with a clock lead',
    avoidRepetition('g1f3', bad, avoid, { ourMs: 40_000, theirMs: 10_000 }).move, 'g1f3');

  check('anti-draw: clock edge needs both margin and ratio',
    [hasClockEdge(40_000, 10_000), hasClockEdge(11_000, 10_000), hasClockEdge(4_000, 2_500), hasClockEdge(null, 1)],
    [true, false, false, false]);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
