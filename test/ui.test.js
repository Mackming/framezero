/**
 * Tests for lib/ui.js.
 *
 * Every assertion here corresponds to something that was actually wrong with
 * the panel, so this file doubles as the record of what "buggy and messy"
 * meant:
 *
 *   - sliders fired their callback on every `input` event, so one drag meant
 *     ~100 chrome.storage writes and ~100 log lines
 *   - the Activity log was never trimmed
 *   - the panel could be dragged off screen with no way to retrieve it
 *   - position and collapse state were forgotten on reload
 *   - the latency and opening readouts described the previous game forever
 *   - Move Delay stayed live-looking while Instant silently ignored it
 *   - a style hint containing a quote would break the markup it was
 *     interpolated into
 *
 * jsdom has no layout engine, so anything needing real geometry is stubbed
 * rather than guessed at; the clamping test states exactly what it assumes.
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://lichess.org/abcd1234',
  pretendToBeVisual: true
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

const { BotUI } = await import('../lib/ui.js');

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
  if (ok) passed++;
  else { console.log('        expected:', expected, '\n        actual  :', actual); failed++; }
}

const CPU = [
  { id: 'eco', label: 'Eco', hint: 'One thread, no background search' },
  { id: 'balanced', label: 'Balanced', hint: 'Two threads and a brief warm-up' },
  { id: 'max', label: 'Max', hint: 'Every spare core' }
];

const ENGINES = [
  { id: 'sf19', label: 'Stockfish 19', hint: 'Newest engine, 1 MB net' },
  { id: 'sf18', label: 'Stockfish 18', hint: 'The previous build, runs anywhere' }
];

const MODES = [
  { id: 'best', label: 'Best move', hint: 'The engine\'s own choice' },
  // A hint carrying both quote characters, because it goes into an attribute.
  { id: 'trap', label: 'Trap', hint: 'Bait the "obvious" reply — it\'s a trap' }
];

/** A panel with counters for every callback it can fire. */
function makePanel(overrides = {}) {
  const calls = {
    moveTime: [], delay: [], instant: [], mode: [],
    colour: [], autoplay: [], arrows: [], bot: [], cpu: [], engine: [], bench: 0
  };
  const ui = new BotUI({
    initialMoveTimeMs: 1500,
    initialDelay: 1200,
    initialInstant: false,
    initialArrows: true,
    initialAutoPlay: true,
    initialPlayingAs: 'auto',
    initialMode: 'best',
    modes: MODES,
    cpuModes: CPU,
    initialCpuMode: 'balanced',
    onCpuModeChange: (v) => calls.cpu.push(v),
    engines: ENGINES,
    initialEngine: 'sf19',
    onEngineChange: (v) => calls.engine.push(v),
    onBenchmarkClick: async () => { calls.bench++; await new Promise((r) => setTimeout(r, 0)); },
    onMoveTimeChange: (v) => calls.moveTime.push(v),
    onDelayChange: (v) => calls.delay.push(v),
    onInstantChange: (v) => calls.instant.push(v),
    onModeChange: (v) => calls.mode.push(v),
    onPlayingAsChange: (v) => calls.colour.push(v),
    onAutoPlayChange: (v) => calls.autoplay.push(v),
    onHighlightChange: (v) => calls.arrows.push(v),
    onToggleBot: (v) => calls.bot.push(v),
    ...overrides
  });
  const q = (sel) => ui.container.querySelector(sel);
  return { ui, calls, q };
}

const fire = (el, type) => el.dispatchEvent(new dom.window.Event(type, { bubbles: true }));

function teardown(ui) {
  ui.host.remove();
  localStorage.clear();
}

// ---------------------------------------------------------------------------
// Sliders commit, they do not stream
// ---------------------------------------------------------------------------
{
  const { ui, calls, q } = makePanel();
  const slider = q('#ag-movetime-slider');

  // Dragging: the label must track the thumb so the number stays live...
  for (const value of ['2000', '3000', '4000']) {
    slider.value = value;
    fire(slider, 'input');
  }
  check('the label follows the thumb during a drag', q('#ag-movetime-val').textContent, '4000ms');
  // ...but nothing is persisted or logged until the drag is let go. This is the
  // storage-and-log flood: it used to fire on every one of these.
  check('no callback fires while dragging', calls.moveTime, []);

  fire(slider, 'change');
  check('exactly one callback fires on release', calls.moveTime, [4000]);

  const delay = q('#ag-delay-slider');
  delay.value = '300';
  fire(delay, 'input');
  fire(delay, 'change');
  check('the delay slider behaves the same way', calls.delay, [300]);
  teardown(ui);
}

// ---------------------------------------------------------------------------
// The log is bounded
// ---------------------------------------------------------------------------
{
  const { ui } = makePanel();
  for (let i = 0; i < 260; i++) ui.log(`line ${i}`, 'info');

  check('the log stops growing at its cap', ui.logEl.childElementCount, 200);
  // Trimmed from the front, so the newest entries are the ones kept.
  check('and it is the oldest entries that are dropped',
    ui.logEl.lastElementChild.textContent.includes('line 259'), true);
  check('the very oldest is gone', ui.logEl.textContent.includes('line 0 '), false);

  // A message is inserted as a text node, never as markup.
  ui.log('<img src=x onerror=alert(1)>', 'warn');
  check('a log message cannot inject markup',
    ui.logEl.lastElementChild.querySelector('img'), null);
  teardown(ui);
}

// ---------------------------------------------------------------------------
// The panel cannot be dragged out of reach
// ---------------------------------------------------------------------------
{
  const { ui } = makePanel();
  // jsdom reports a zero-sized rect, so give the panel a real width to clamp
  // against. Height is not needed: the vertical rule keeps a strip of the
  // header on screen rather than fitting the whole panel.
  ui.container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 318, height: 700 });

  ui.moveTo(-9999, -9999);
  check('dragging past the top-left pins to the corner',
    [ui.host.style.left, ui.host.style.top], ['0px', '0px']);

  ui.moveTo(99999, 99999);
  check('dragging past the bottom-right leaves it reachable',
    // 1024 - 318 = 706 across; 768 - 44 = 724 down, so the header stays visible.
    [ui.host.style.left, ui.host.style.top], ['706px', '724px']);

  ui.moveTo(120, 60);
  check('a position inside the viewport is left alone',
    [ui.host.style.left, ui.host.style.top], ['120px', '60px']);
  check('and the default right-anchoring is released', ui.host.style.right, 'auto');
  teardown(ui);
}

// ---------------------------------------------------------------------------
// Position and collapse survive a reload
// ---------------------------------------------------------------------------
{
  const first = makePanel();
  first.ui.container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 318, height: 700 });
  first.ui.moveTo(200, 90);
  first.ui.setCollapsed(true);
  first.ui.saveLayout();
  first.ui.host.remove();

  const second = makePanel();
  check('a reopened panel is where it was left',
    [second.ui.host.style.left, second.ui.host.style.top], ['200px', '90px']);
  check('and still collapsed', second.ui.bodyEl.classList.contains('ag-collapsed'), true);
  check('with the chevron and aria state agreeing',
    [second.ui.collapseBtnEl.classList.contains('ag-collapsed'),
      second.ui.collapseBtnEl.getAttribute('aria-expanded')],
    [true, 'false']);
  teardown(second.ui);
}
{
  // A saved position from a larger window must not strand the panel off screen.
  localStorage.setItem('ag-bot-ui:layout', JSON.stringify({ left: 5000, top: 4000, collapsed: false }));
  const { ui } = makePanel();
  const left = parseInt(ui.host.style.left, 10);
  const top = parseInt(ui.host.style.top, 10);
  check('a saved position is re-clamped, not trusted',
    [left <= window.innerWidth, top <= window.innerHeight], [true, true]);
  teardown(ui);
}
{
  localStorage.setItem('ag-bot-ui:layout', '{not json');
  const { ui } = makePanel();
  check('a corrupt saved layout falls back to the default position',
    [ui.host.style.top, ui.host.style.right], ['20px', '20px']);
  teardown(ui);
}

// ---------------------------------------------------------------------------
// Move Delay and Instant stop contradicting each other
// ---------------------------------------------------------------------------
{
  const { ui, calls, q } = makePanel({ initialInstant: true });
  check('Move Delay starts disabled when Instant is on',
    [q('#ag-delay-slider').disabled, q('#ag-delay-field').classList.contains('ag-disabled')],
    [true, true]);

  const instant = q('#ag-toggle-instant');
  instant.checked = false;
  fire(instant, 'change');
  check('turning Instant off hands Move Delay back',
    [q('#ag-delay-slider').disabled, q('#ag-delay-field').classList.contains('ag-disabled')],
    [false, false]);
  check('and the change is reported once', calls.instant, [false]);
  teardown(ui);
}

// ---------------------------------------------------------------------------
// Readouts
// ---------------------------------------------------------------------------
{
  const { ui, q } = makePanel();

  check('the latency tile is hidden until there is a reply to report',
    q('#ag-latency-stat').hidden, true);

  ui.updateLatency(842, 9);
  check('a reply shows total and overhead',
    [q('#ag-latency-stat').hidden, q('#ag-latency-text').textContent, q('#ag-latency-sub').textContent],
    [false, '842ms', '9ms overhead']);

  ui.updateOpening('Italian Game');
  check('an opening shows its name',
    [q('#ag-opening-stat').hidden, q('#ag-opening-text').textContent], [false, 'Italian Game']);
  ui.updateOpening(null);
  check('and hides once out of book', q('#ag-opening-stat').hidden, true);

  ui.updateEval('+0.42', 0.42);
  ui.updateOpening('Sicilian Defence');
  ui.updateLatency(500, 200);
  // Starting a new game must not leave the previous one's numbers on display.
  ui.resetStatus();
  check('resetStatus clears every per-game readout',
    [q('#ag-eval-text').textContent, q('#ag-opening-stat').hidden, q('#ag-latency-stat').hidden],
    ['N/A', true, true]);
  teardown(ui);
}
{
  const { ui, q } = makePanel();
  ui.updateEngine({ script: 'engine/stockfish-18-lite.js', threads: 3, shared: true });
  check('the engine tile reports live threading',
    [q('#ag-engine-stat').hidden, q('#ag-engine-text').textContent],
    [false, 'stockfish-18-lite · 3 threads']);

  ui.updateEngine({ script: 'engine/stockfish-18-lite-single.js', threads: 1, shared: false });
  check('and singular when it fell back',
    q('#ag-engine-text').textContent, 'stockfish-18-lite-single · 1 thread');
  check('with the reason in the tooltip',
    q('#ag-engine-stat').title.includes('Shared memory was unavailable'), true);

  ui.updateEngine(null);
  check('no engine information hides the tile', q('#ag-engine-stat').hidden, true);
  teardown(ui);
}

// ---------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------
{
  const { ui } = makePanel();
  ui.setBotActive(true);
  check('an active bot reads ON',
    [ui.statusTextEl.textContent, ui.statusTextEl.classList.contains('ag-status-on')], ['ON', true]);

  ui.setGameOver();
  check('game over unchecks the toggle and says so',
    [ui.toggleBotEl.checked, ui.statusTextEl.textContent], [false, 'GAME OVER']);
  check('and is styled as game over, not as off',
    [ui.statusTextEl.classList.contains('ag-status-over'),
      ui.statusTextEl.classList.contains('ag-status-on')],
    [true, false]);

  // Restarting has to clear the game-over styling, or the pill stays orange.
  ui.setBotActive(true);
  check('restarting clears the game-over styling',
    ui.statusTextEl.classList.contains('ag-status-over'), false);

  ui.setStatus('Thinking…', 'busy');
  check('setStatus shows what the bot is doing, with one kind at a time',
    [ui.statusTextEl.textContent, ui.statusTextEl.classList.contains('ag-status-busy'),
      ui.statusTextEl.classList.contains('ag-status-on')],
    ['Thinking…', true, false]);
  teardown(ui);
}

// ---------------------------------------------------------------------------
// Power button and Alt+B
// ---------------------------------------------------------------------------
{
  const { ui, calls, q } = makePanel();
  check('the power button starts as Start', q('#ag-power-label').textContent, 'Start');

  const key = (init) => document.dispatchEvent(new dom.window.KeyboardEvent('keydown',
    { bubbles: true, cancelable: true, code: 'KeyB', ...init }));

  key({ altKey: true });
  check('Alt+B starts the bot', [calls.bot, q('#ag-power-label').textContent], [[true], 'Stop']);
  key({ altKey: true });
  check('and stops it again', calls.bot, [true, false]);
  key({ altKey: true, ctrlKey: true });
  key({});
  check('plain B and Ctrl+Alt+B are left alone', calls.bot, [true, false]);

  const chat = document.createElement('input');
  document.body.appendChild(chat);
  chat.dispatchEvent(new dom.window.KeyboardEvent('keydown',
    { bubbles: true, cancelable: true, code: 'KeyB', altKey: true }));
  check('not while typing in a page input (Lichess chat)', calls.bot, [true, false]);
  chat.remove();

  document.removeEventListener('keydown', ui._onKey, true);
  teardown(ui);
}

// ---------------------------------------------------------------------------
// Settings disclosure
// ---------------------------------------------------------------------------
{
  const first = makePanel();
  check('Settings starts folded away', first.q('#ag-settings-body').hidden, true);
  first.q('#ag-settings-toggle').click();
  check('clicking opens it',
    [first.q('#ag-settings-body').hidden, first.q('#ag-settings-toggle').getAttribute('aria-expanded')],
    [false, 'true']);
  document.removeEventListener('keydown', first.ui._onKey, true);
  first.ui.host.remove();

  const second = makePanel();
  check('and it stays open on the next page load', second.q('#ag-settings-body').hidden, false);
  document.removeEventListener('keydown', second.ui._onKey, true);
  teardown(second.ui);
}

// ---------------------------------------------------------------------------
// Readouts from your side
// ---------------------------------------------------------------------------
{
  const { ui, q } = makePanel();
  ui.updateScore({ pawns: -1.2, mateIn: null }, 'black');
  check('a White-relative -1.20 reads +1.20 for you when you are Black',
    [q('#ag-eval-text').textContent, q('#ag-eval-side').textContent], ['+1.20', 'for you']);
  check('and the bar leans your way',
    parseFloat(q('#ag-evalbar-fill').style.width) > 50, true);

  ui.updateScore({ pawns: null, mateIn: -3 }, 'white');
  check('a mate against you says so',
    [q('#ag-eval-text').textContent, q('#ag-eval-side').textContent, parseFloat(q('#ag-evalbar-fill').style.width)],
    ['M3', 'they mate', 0]);

  ui.updateScore({ pawns: 0.5, mateIn: null }, null);
  check('with no colour known it stays White-relative and says so',
    [q('#ag-eval-text').textContent, q('#ag-eval-side').textContent,
      q('#ag-evalbar').classList.contains('ag-neutral')],
    ['+0.50', 'White better', true]);

  check('the best-move tile is hidden until there is a move', q('#ag-best-stat').hidden, true);
  ui.updateBestMove('Nf3', 'your move');
  check('a best move shows in notation with a note',
    [q('#ag-best-stat').hidden, q('#ag-best-text').textContent, q('#ag-best-sub').textContent],
    [false, 'Nf3', 'your move']);
  ui.resetStatus();
  check('resetStatus clears it', q('#ag-best-stat').hidden, true);

  ui.setDetectedColor('black');
  const auto = q('#ag-color-seg .ag-seg-btn[data-value="auto"]');
  check('a detected colour shows on Auto without pressing Black',
    [auto.textContent, auto.getAttribute('aria-pressed'),
      q('#ag-color-seg .ag-seg-btn[data-value="black"]').getAttribute('aria-pressed')],
    ['Auto · Black', 'true', 'false']);
  ui.setDetectedColor(null);
  check('and clears back to Auto', auto.textContent, 'Auto');
  document.removeEventListener('keydown', ui._onKey, true);
  teardown(ui);
}

// ---------------------------------------------------------------------------
// Segmented controls
// ---------------------------------------------------------------------------
{
  const { ui, calls, q } = makePanel();
  const buttons = [...q('#ag-mode-seg').querySelectorAll('.ag-seg-btn')];
  const trap = buttons.find((b) => b.dataset.value === 'trap');

  trap.click();
  check('picking a style reports it once', calls.mode, ['trap']);
  check('and moves the highlight', trap.getAttribute('aria-pressed'), 'true');
  check('and shows that style\'s hint', q('#ag-mode-hint').textContent, MODES[1].hint);

  // Clicking the active option again is not a change.
  trap.click();
  check('re-picking the active style is not reported again', calls.mode, ['trap']);

  // A hint with quotes in it must survive being put in an attribute.
  check('a quoted hint is escaped into the title attribute', trap.title, MODES[1].hint);

  ui.setPlayingAs('black');
  check('setPlayingAs moves the highlight without firing the callback',
    [q('#ag-color-seg .ag-seg-btn[data-value="black"]').getAttribute('aria-pressed'), calls.colour],
    ['true', []]);
  teardown(ui);
}

// ---------------------------------------------------------------------------
// The body can scroll, which is what stopped the log being clipped away
// ---------------------------------------------------------------------------
{
  const { ui, q } = makePanel();
  const scroll = q('#ag-bot-scroll');
  check('there is a scroll container around the sections', Boolean(scroll), true);
  check('the log lives inside it, so it can always be reached',
    scroll.contains(ui.logEl), true);
  check('collapse is on the outer element, so it does not fight the scrolling',
    ui.bodyEl.contains(scroll) && ui.bodyEl !== scroll, true);
  teardown(ui);
}

// ---------------------------------------------------------------------------
// CPU usage control
// ---------------------------------------------------------------------------
{
  const { ui, calls, q } = makePanel();
  const group = q('#ag-cpu-seg');
  const buttons = [...group.querySelectorAll('.ag-seg-btn')];

  check('every mode gets a button', buttons.map((b) => b.dataset.value), ['eco', 'balanced', 'max']);
  check('the saved mode starts selected',
    buttons.find((b) => b.dataset.value === 'balanced').getAttribute('aria-pressed'), 'true');
  check('and its hint is shown', q('#ag-cpu-hint').textContent, CPU[1].hint);

  buttons.find((b) => b.dataset.value === 'eco').click();
  check('picking a mode reports it once', calls.cpu, ['eco']);
  check('the highlight moves',
    buttons.find((b) => b.dataset.value === 'eco').getAttribute('aria-pressed'), 'true');
  check('and the hint follows', q('#ag-cpu-hint').textContent, CPU[0].hint);

  // Re-picking the live mode would otherwise re-send setoption Threads and
  // quiesce a running search for no change at all.
  buttons.find((b) => b.dataset.value === 'eco').click();
  check('re-picking the active mode is not reported again', calls.cpu, ['eco']);
  teardown(ui);
}
{
  // The engine tile is how the chosen mode is confirmed as actually applied.
  const { ui, q } = makePanel();
  ui.updateEngine({ script: 'engine/stockfish-18-lite.js', threads: 1, shared: true, cores: 4 });
  check('Eco shows as a single thread',
    q('#ag-engine-text').textContent, 'stockfish-18-lite · 1 thread');
  ui.updateEngine({ script: 'engine/stockfish-18-lite.js', threads: 2, shared: true, cores: 4 });
  check('Balanced shows as two',
    q('#ag-engine-text').textContent, 'stockfish-18-lite · 2 threads');
  // A catalogue label beats a filename: with two engines selectable, the tile
  // has to answer "which one is live" in the same words the picker used.
  ui.updateEngine({ script: 'engine/sf_19_smallnet.js', label: 'Stockfish 19', threads: 2, shared: true });
  check('and a labelled build shows its name',
    q('#ag-engine-text').textContent, 'Stockfish 19 · 2 threads');
  teardown(ui);
}


// ---------------------------------------------------------------------------
// Engine picker
// ---------------------------------------------------------------------------
{
  const { ui, calls, q } = makePanel();
  const group = q('#ag-engine-seg');
  const buttons = [...group.querySelectorAll('.ag-seg-btn')];

  check('every engine gets a button', buttons.map((b) => b.dataset.value), ENGINES.map((e) => e.id));
  check('the saved engine starts selected',
    buttons.find((b) => b.dataset.value === 'sf19').getAttribute('aria-pressed'), 'true');
  check('and its hint is shown', q('#ag-engine-hint').textContent, ENGINES[0].hint);

  buttons.find((b) => b.dataset.value === 'sf18').click();
  check('picking an engine reports it once', calls.engine, ['sf18']);
  check('the highlight moves',
    buttons.find((b) => b.dataset.value === 'sf18').getAttribute('aria-pressed'), 'true');
  check('and the hint follows', q('#ag-engine-hint').textContent, ENGINES[1].hint);

  // Re-picking the live engine would tear down a working engine and build an
  // identical one — a WASM compile and a net load for no change at all.
  buttons.find((b) => b.dataset.value === 'sf18').click();
  check('re-picking the active engine is not reported again', calls.engine, ['sf18']);
  teardown(ui);
}


// ---------------------------------------------------------------------------
// Benchmark button
// ---------------------------------------------------------------------------
{
  const { ui, calls, q } = makePanel();
  const button = q('#ag-bench-btn');

  button.click();          // returns undefined; the handler runs on its own
  check('clicking starts a run', calls.bench, 1);
  // A benchmark is seconds of searching; a second click would start a competing
  // set of searches against the first run's engine.
  check('and the button locks while it runs', [button.disabled, button.textContent],
    [true, 'Benchmarking…']);
  button.click();
  check('so a second click does nothing', calls.bench, 1);

  // Two turns: one for the handler's own await, one for its finally block.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  check('it unlocks afterwards', button.disabled, false);
  check('and gets its label back', button.textContent, '⏱ Benchmark engines');
  teardown(ui);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
