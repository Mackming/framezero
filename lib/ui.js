/**
 * ui.js — the on-page control panel.
 *
 * Lives in a shadow root so Lichess's stylesheet cannot reach it and ours
 * cannot reach Lichess. The host element is `pointer-events: none` and only the
 * panel itself takes pointer events, so the invisible box around it never eats
 * a click meant for the board.
 *
 * LAYOUT, AND WHY IT IS THIS SHAPE
 * --------------------------------
 * Readouts at the top, controls below, log at the bottom. The previous version
 * interleaved them — Evaluation and Opening sat in the middle of the Engine
 * section between two sliders, and the latency readout was added underneath
 * them — which meant the numbers you want to glance at mid-game were scattered
 * among the controls you set once and leave alone.
 *
 * Explanations moved onto `title` tooltips. Every toggle used to carry its own
 * always-visible hint paragraph, six in total, and the body had
 * `max-height: 640px` with `overflow: hidden` — so once the panel grew past
 * that, the Activity log was clipped off the bottom with no scrollbar and no
 * way to reach it. The body now scrolls, and its cap is relative to the
 * viewport rather than a fixed 640px that assumed a tall window.
 *
 * Public API (content.js depends on all of it):
 *   new BotUI({ initial*, modes, on* })
 *   log(message, type)          updateEval(text, signed)
 *   updateOpening(name)         updateLatency(totalMs, overheadMs)
 *   updateEngine(info)          resetStatus()
 *   setBotActive(active)        setPlayingAs(color)
 *   setGameOver()               reflectBotStatus(active, label)
 *   setStatus(label, kind)      updateScore(score, perspective)
 *   updateBestMove(san, note)   setDetectedColor(color)
 *   setSettingsOpen(open)
 *
 * The header carries the Start/Stop button (Alt+B) and a status strip says
 * what the bot is doing. Below the readouts, "Play" holds what you touch
 * mid-game and "Settings" — folded away by default — what you set once.
 */

/**
 * Entries kept in the Activity log.
 *
 * Nothing trimmed this before, and a long session appends several nodes per
 * move forever — thousands of elements in a scrolling container, all of them
 * laid out, for scrollback nobody reads.
 */
const LOG_MAX = 200;

/** Keep at least this much of the panel on screen, so it stays grabbable. */
const KEEP_ON_SCREEN = 44;

/** Where a dragged panel remembers itself. Per-site, which is the right scope. */
const LAYOUT_KEY = 'ag-bot-ui:layout';

/** Interpolating a string into an attribute needs this. */
const attr = (value) => String(value ?? '').replace(
  /[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
);

export class BotUI {
  constructor(options) {
    this.options = options ?? {};
    this.createDOM();
    this.attachEvents();
    this.restoreLayout();
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  createDOM() {
    this.host = document.createElement('div');
    this.host.id = 'ag-bot-host';
    Object.assign(this.host.style, {
      position: 'fixed',
      top: '20px',
      right: '20px',
      zIndex: '100000',
      width: '318px',
      pointerEvents: 'none'
    });

    const shadow = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; }

      #ag-bot-ui {
        --accent: #3fd6a3;
        --accent-dim: rgba(63, 214, 163, 0.15);
        --danger: #ff5c72;
        --danger-dim: rgba(255, 92, 114, 0.15);
        --warn: #ffb454;
        --info: #6fb8ff;
        --text: #e9ebf0;
        --text-dim: #8a8f9c;
        --panel: rgba(19, 20, 24, 0.94);
        --panel-raised: rgba(255, 255, 255, 0.045);
        --border: rgba(255, 255, 255, 0.09);

        background: var(--panel);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        border: 1px solid var(--border);
        border-radius: 14px;
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45), 0 1px 0 rgba(255, 255, 255, 0.04) inset;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        pointer-events: auto;
      }
      /* Text selection while dragging looks like a bug even though it is not. */
      #ag-bot-ui.ag-dragging, #ag-bot-ui.ag-dragging * { user-select: none; cursor: grabbing !important; }

      /* --- header --------------------------------------------------- */
      #ag-bot-header {
        padding: 11px 12px 11px 14px;
        background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0));
        cursor: grab;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        border-bottom: 1px solid var(--border);
        user-select: none;
        touch-action: none;
      }
      #ag-bot-title {
        font-weight: 600;
        font-size: 13px;
        letter-spacing: 0.2px;
        display: flex;
        align-items: center;
        gap: 7px;
        white-space: nowrap;
      }
      #ag-bot-title .ag-dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: var(--danger);
        box-shadow: 0 0 6px 1px var(--danger);
        flex: none;
        transition: background .2s, box-shadow .2s;
      }
      #ag-bot-title .ag-dot.on {
        background: var(--accent);
        box-shadow: 0 0 6px 1px var(--accent-dim);
      }

      #ag-header-right { display: flex; align-items: center; gap: 6px; }

      /* --- power button ---------------------------------------------------
         The one control you touch every game, so it is the biggest thing in
         the header rather than one switch among seven. A real checkbox sits
         inside the label, so keyboard, screen readers and the existing
         change handler all keep working unchanged. */
      #ag-power {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 5px 12px 5px 10px;
        border-radius: 20px;
        font-size: 11.5px; font-weight: 700; letter-spacing: 0.3px;
        cursor: pointer;
        background: var(--accent); color: #07140f;
        transition: background .15s, color .15s, box-shadow .15s;
        white-space: nowrap;
      }
      #ag-power:hover { box-shadow: 0 0 0 3px var(--accent-dim); }
      #ag-power.on { background: rgba(255,92,114,0.16); color: var(--danger); }
      #ag-power.on:hover { box-shadow: 0 0 0 3px var(--danger-dim); }
      #ag-power input { position: absolute; opacity: 0; width: 0; height: 0; }
      #ag-power:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
      #ag-power kbd {
        font: inherit; font-size: 9px; font-weight: 600; opacity: 0.6;
        border: 1px solid currentColor; border-radius: 4px; padding: 0 3px;
      }

      /* --- status strip ---------------------------------------------------
         Says what the bot is doing right now, not just whether it is on. */
      #ag-status-strip {
        display: flex; align-items: center; gap: 8px;
        padding: 7px 14px;
        border-bottom: 1px solid var(--border);
        font-size: 11.5px;
      }
      #ag-bot-status-text {
        font-weight: 700;
        letter-spacing: 0.3px;
        color: var(--danger);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
      }
      #ag-bot-status-text::before {
        content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%;
        background: currentColor; margin-right: 7px; vertical-align: 1px;
      }
      #ag-bot-status-text.ag-status-on { color: var(--accent); }
      #ag-bot-status-text.ag-status-busy { color: var(--info); }
      #ag-bot-status-text.ag-status-busy::before { animation: ag-pulse 1s ease-in-out infinite; }
      #ag-bot-status-text.ag-status-wait { color: var(--text-dim); }
      #ag-bot-status-text.ag-status-warn,
      #ag-bot-status-text.ag-status-over { color: var(--warn); }
      #ag-bot-status-text.ag-status-error { color: var(--danger); }
      @keyframes ag-pulse { 50% { opacity: 0.25; } }

      /* --- eval bar ------------------------------------------------------- */
      .ag-eval-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
      #ag-eval-side { font-size: 11px; color: var(--text-dim); font-weight: 600; white-space: nowrap; }
      #ag-evalbar {
        height: 6px; border-radius: 3px; margin-top: 6px; overflow: hidden;
        background: rgba(255, 92, 114, 0.35);
      }
      #ag-evalbar-fill {
        height: 100%; width: 50%;
        background: var(--accent);
        transition: width .3s ease;
      }
      #ag-evalbar.ag-neutral { background: #2b2d33; }
      #ag-evalbar.ag-neutral #ag-evalbar-fill { background: #e9ebf0; }
      .ag-stat-sub { font-size: 10px; color: var(--text-dim); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #ag-best-text { font-size: 17px; color: var(--text); }

      /* --- settings disclosure ------------------------------------------- */
      #ag-settings-toggle {
        display: flex; justify-content: space-between; align-items: center;
        width: 100%; padding: 0; border: 0; background: none; cursor: pointer;
        font-family: inherit; color: var(--text-dim);
      }
      #ag-settings-toggle:hover .ag-section-title { color: var(--text); }
      #ag-settings-toggle svg { transition: transform .2s; }
      #ag-settings-toggle[aria-expanded="false"] svg { transform: rotate(-90deg); }
      #ag-settings-body { display: flex; flex-direction: column; gap: 10px; }
      #ag-settings-body[hidden] { display: none; }

      #ag-collapse-btn {
        width: 20px; height: 20px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 6px;
        color: var(--text-dim);
        cursor: pointer;
        border: none;
        background: transparent;
        transition: background .15s, color .15s;
      }
      #ag-collapse-btn:hover { background: rgba(255,255,255,0.08); color: var(--text); }
      #ag-collapse-btn svg { transition: transform .2s; }
      #ag-collapse-btn.ag-collapsed svg { transform: rotate(-90deg); }

      /* --- body ---------------------------------------------------------
         Two nested elements on purpose: the outer one animates the collapse
         with max-height, the inner one scrolls. One element cannot do both,
         because a max-height transition needs overflow hidden. */
      #ag-bot-body {
        overflow: hidden;
        transition: max-height .22s ease, opacity .18s ease;
        max-height: 1200px;
      }
      #ag-bot-body.ag-collapsed { max-height: 0; opacity: 0; }

      #ag-bot-scroll {
        display: flex;
        flex-direction: column;
        /* Relative to the window, so the panel can never be taller than the
           screen it sits on — which is how the log used to end up clipped
           away with no scrollbar to reach it. */
        max-height: calc(100vh - 140px);
        overflow-y: auto;
        overscroll-behavior: contain;
      }

      .ag-section {
        padding: 12px 14px;
        border-bottom: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .ag-section:last-child { border-bottom: none; }

      .ag-section-title {
        font-size: 9.5px;
        font-weight: 700;
        letter-spacing: 0.9px;
        text-transform: uppercase;
        color: var(--text-dim);
      }

      .ag-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
      .ag-label { font-size: 12px; color: var(--text); display: flex; align-items: center; gap: 5px; }
      /* A dotted underline is the conventional "there is a tooltip here" mark,
         which is what lets six hint paragraphs come out of the layout. */
      .ag-label[title] {
        text-decoration: underline dotted rgba(255,255,255,0.22);
        text-underline-offset: 3px;
        cursor: help;
      }
      .ag-hint { font-size: 10.5px; color: var(--text-dim); line-height: 1.45; }
      .ag-value { font-size: 12px; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }

      .ag-field { display: flex; flex-direction: column; gap: 3px; }
      .ag-field.ag-disabled { opacity: 0.42; }

      /* --- status tiles -------------------------------------------------- */
      #ag-stats {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--border);
      }
      .ag-stat {
        background: var(--panel-raised);
        border: 1px solid var(--border);
        border-radius: 9px;
        padding: 7px 10px;
        min-width: 0;
      }
      .ag-stat.ag-wide { grid-column: span 2; }
      .ag-stat[hidden] { display: none; }
      .ag-stat-k {
        font-size: 8.5px;
        font-weight: 700;
        letter-spacing: 0.8px;
        text-transform: uppercase;
        color: var(--text-dim);
      }
      .ag-stat-v {
        font-size: 13px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        margin-top: 3px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--text);
      }
      #ag-eval-text { font-size: 19px; color: var(--info); }
      #ag-opening-text { color: var(--accent); font-size: 12px; }

      /* --- toggle switch ---------------------------------------------- */
      .ag-switch { position: relative; display: inline-block; width: 38px; height: 22px; flex: none; }
      .ag-switch input { opacity: 0; width: 0; height: 0; }
      .ag-slider-toggle {
        position: absolute;
        cursor: pointer;
        top: 0; left: 0; right: 0; bottom: 0;
        background-color: rgba(255, 255, 255, 0.16);
        transition: background-color .2s;
        border-radius: 22px;
      }
      .ag-slider-toggle:before {
        position: absolute;
        content: "";
        height: 16px; width: 16px;
        left: 3px; top: 3px;
        background-color: #fff;
        transition: transform .2s;
        border-radius: 50%;
        box-shadow: 0 1px 3px rgba(0,0,0,0.4);
      }
      input:checked + .ag-slider-toggle { background-color: var(--accent); }
      input:checked + .ag-slider-toggle:before { transform: translateX(16px); }
      input:disabled + .ag-slider-toggle { opacity: 0.4; cursor: not-allowed; }
      .ag-switch input:focus-visible + .ag-slider-toggle { outline: 2px solid var(--accent); outline-offset: 2px; }

      /* --- segmented control -------------------------------------------- */
      /* Every option visible and one click away — a dropdown hides the
         choices behind an extra click, which is the wrong trade for a
         control you change mid-game. */
      .ag-seg {
        display: flex;
        gap: 3px;
        background: var(--panel-raised);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 3px;
      }
      .ag-seg-wrap { display: flex; flex-direction: column; gap: 5px; }
      .ag-seg.ag-seg-grid { display: grid; grid-template-columns: repeat(3, 1fr); }
      .ag-seg-btn {
        flex: 1 1 0;
        min-width: 0;
        padding: 5px 6px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: var(--text-dim);
        font-family: inherit;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        transition: background 120ms ease, color 120ms ease;
      }
      .ag-seg-btn:hover { background: rgba(255, 255, 255, 0.06); color: var(--text); }
      .ag-seg-btn[aria-pressed="true"] {
        background: var(--accent-dim);
        color: var(--accent);
        box-shadow: inset 0 0 0 1px rgba(63, 214, 163, 0.35);
      }
      .ag-seg-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }

      /* --- buttons ------------------------------------------------------ */
      .ag-btn {
        width: 100%;
        padding: 7px 0;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: var(--panel-raised);
        color: var(--text);
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: background .15s, border-color .15s, transform .1s;
      }
      .ag-btn:hover { background: rgba(255,255,255,0.09); border-color: rgba(255,255,255,0.18); }
      .ag-btn:active { transform: scale(0.98); }
      .ag-btn:disabled { opacity: 0.55; cursor: default; transform: none; }

      /* --- sliders ------------------------------------------------------ */
      input[type=range] {
        -webkit-appearance: none;
        appearance: none;
        width: 100%;
        height: 4px;
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.14);
        margin: 4px 0 0;
      }
      input[type=range]::-webkit-slider-thumb {
        -webkit-appearance: none;
        height: 14px; width: 14px;
        border-radius: 50%;
        background: var(--accent);
        cursor: pointer;
        margin-top: -5px;
        box-shadow: 0 1px 4px rgba(0,0,0,0.5);
      }
      input[type=range]::-moz-range-thumb {
        height: 14px; width: 14px;
        border-radius: 50%;
        background: var(--accent);
        cursor: pointer;
        border: none;
      }
      input[type=range]::-moz-range-track { height: 4px; border-radius: 2px; background: rgba(255, 255, 255, 0.14); }
      input[type=range]:disabled { cursor: not-allowed; }
      input[type=range]:disabled::-webkit-slider-thumb { background: var(--text-dim); cursor: not-allowed; }
      input[type=range]:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }

      /* --- log panel ------------------------------------------------------ */
      #ag-log-header { display: flex; justify-content: space-between; align-items: center; }
      #ag-clear-log-btn {
        border: none;
        background: transparent;
        color: var(--text-dim);
        font-size: 10px;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 4px;
      }
      #ag-clear-log-btn:hover { color: var(--text); background: rgba(255,255,255,0.08); }

      #ag-bot-logs {
        background: rgba(0, 0, 0, 0.35);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 8px 9px;
        height: 132px;
        overflow-y: auto;
        overscroll-behavior: contain;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 10.5px;
        line-height: 1.6;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      #ag-bot-logs:empty::before { content: 'No activity yet.'; color: var(--text-dim); font-style: italic; }
      .ag-log-entry { word-break: break-word; display: flex; gap: 5px; }
      .ag-log-entry .ag-log-time { color: var(--text-dim); flex: none; }
      .ag-log-entry .ag-log-icon { flex: none; }
      .ag-log-error   { color: var(--danger); }
      .ag-log-warn    { color: var(--warn); }
      .ag-log-info    { color: var(--text); }
      .ag-log-success { color: var(--accent); }

      #ag-bot-logs::-webkit-scrollbar, #ag-bot-scroll::-webkit-scrollbar { width: 6px; }
      #ag-bot-logs::-webkit-scrollbar-track, #ag-bot-scroll::-webkit-scrollbar-track { background: transparent; }
      #ag-bot-logs::-webkit-scrollbar-thumb, #ag-bot-scroll::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.18);
        border-radius: 3px;
      }

      @media (prefers-reduced-motion: reduce) {
        #ag-bot-body, #ag-collapse-btn svg, .ag-slider-toggle, .ag-slider-toggle:before,
        #ag-evalbar-fill, #ag-settings-toggle svg { transition: none; }
        #ag-bot-status-text.ag-status-busy::before { animation: none; }
      }
    `;

    const o = this.options;
    const moveTime = o.initialMoveTimeMs ?? 1500;
    const delay = o.initialDelay ?? 1200;

    this.container = document.createElement('div');
    this.container.id = 'ag-bot-ui';
    this.container.innerHTML = `
      <div id="ag-bot-header">
        <div id="ag-bot-title">
          <span class="ag-dot" id="ag-status-dot"></span>
          FrameZero
        </div>
        <div id="ag-header-right">
          <label id="ag-power" title="Start or stop the bot (Alt+B)">
            <input type="checkbox" id="ag-toggle-bot" aria-label="Bot active" aria-keyshortcuts="Alt+B">
            <span id="ag-power-label">Start</span><kbd>Alt+B</kbd>
          </label>
          <button id="ag-collapse-btn" type="button" title="Collapse" aria-label="Collapse panel" aria-expanded="true">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M1.5 3.5L5 7L8.5 3.5" stroke="currentColor" stroke-width="1.5"
                stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>

      <div id="ag-status-strip">
        <span id="ag-bot-status-text" role="status">OFF</span>
      </div>

      <div id="ag-bot-body">
        <div id="ag-bot-scroll">

          <div id="ag-stats">
            <div class="ag-stat ag-wide" id="ag-eval-stat">
              <div class="ag-stat-k">Evaluation</div>
              <div class="ag-eval-row">
                <div class="ag-stat-v" id="ag-eval-text">N/A</div>
                <span id="ag-eval-side"></span>
              </div>
              <div id="ag-evalbar" class="ag-neutral" aria-hidden="true"><div id="ag-evalbar-fill"></div></div>
            </div>
            <div class="ag-stat" id="ag-best-stat" hidden>
              <div class="ag-stat-k">Best move</div>
              <div class="ag-stat-v" id="ag-best-text"></div>
              <div class="ag-stat-sub" id="ag-best-sub"></div>
            </div>
            <div class="ag-stat" id="ag-latency-stat" hidden
              title="From the opponent's move arriving on the socket to ours landing on the board. The overhead is the part before the engine was even asked.">
              <div class="ag-stat-k">Reply time</div>
              <div class="ag-stat-v" id="ag-latency-text"></div>
              <div class="ag-stat-sub" id="ag-latency-sub"></div>
            </div>
            <div class="ag-stat ag-wide" id="ag-opening-stat" hidden>
              <div class="ag-stat-k">Opening</div>
              <div class="ag-stat-v" id="ag-opening-text"></div>
            </div>
          </div>

          <!-- What you look at or change mid-game. -->
          <div class="ag-section">
            <div class="ag-section-title">Play</div>

            <div class="ag-row">
              <span class="ag-label" title="Off = the move is only highlighted on the board and you play it yourself.">Auto-Play</span>
              <label class="ag-switch">
                <input type="checkbox" id="ag-toggle-autoplay" ${o.initialAutoPlay ? 'checked' : ''} aria-label="Auto-play moves">
                <span class="ag-slider-toggle"></span>
              </label>
            </div>

            <div class="ag-row">
              <span class="ag-label" title="Plays the moment the engine answers. Move Delay (in Settings) is ignored while this is on.">Instant (bullet)</span>
              <label class="ag-switch">
                <input type="checkbox" id="ag-toggle-instant" ${o.initialInstant ? 'checked' : ''} aria-label="Instant bullet mode">
                <span class="ag-slider-toggle"></span>
              </label>
            </div>

            <div class="ag-seg-wrap">
              <span class="ag-label" title="Set White or Black to stop Auto-Play moving for the other side. Auto follows what Lichess says, and shows which side it detected.">Playing As</span>
              <div class="ag-seg" id="ag-color-seg" role="group" aria-label="Playing as">
                ${[['auto', 'Auto'], ['white', 'White'], ['black', 'Black']].map(([value, label]) => `
                  <button type="button" class="ag-seg-btn" data-value="${value}"
                    aria-pressed="${o.initialPlayingAs === value}">${label}</button>
                `).join('')}
              </div>
            </div>

            <div class="ag-seg-wrap">
              <span class="ag-label" title="Anything but Best move asks the engine for several candidate lines, which costs real search depth.">Style</span>
              <div class="ag-seg ag-seg-grid" id="ag-mode-seg" role="group" aria-label="Playing style">
                ${(o.modes ?? []).map((mode) => `
                  <button type="button" class="ag-seg-btn" data-value="${attr(mode.id)}" title="${attr(mode.hint)}"
                    aria-pressed="${o.initialMode === mode.id}">${attr(mode.label)}</button>
                `).join('')}
              </div>
            </div>
            <div class="ag-hint" id="ag-mode-hint"></div>

            <div class="ag-field">
              <div class="ag-row">
                <span class="ag-label" title="How long the engine calculates per move. Lower for bullet, higher for stronger play.">Think Time</span>
                <span class="ag-value" id="ag-movetime-val">${moveTime}ms</span>
              </div>
              <input type="range" id="ag-movetime-slider" min="100" max="10000" step="100"
                value="${moveTime}" aria-label="Think time in milliseconds">
            </div>

            <button id="ag-sync-btn" type="button" class="ag-btn">⟳ Sync Position</button>
          </div>

          <!-- Set once and leave alone, so folded away by default. -->
          <div class="ag-section">
            <button id="ag-settings-toggle" type="button" aria-expanded="false" aria-controls="ag-settings-body">
              <span class="ag-section-title">Settings</span>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <path d="M1.5 3.5L5 7L8.5 3.5" stroke="currentColor" stroke-width="1.5"
                  stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>

            <div id="ag-settings-body" hidden>
              <!-- Which build actually came up, and on how many threads. -->
              <div class="ag-stat" id="ag-engine-stat" hidden>
                <div class="ag-stat-k">Running</div>
                <div class="ag-stat-v" id="ag-engine-text"></div>
              </div>
              <div class="ag-seg-wrap">
                <span class="ag-label" title="Which Stockfish build to run. A build that cannot start on this machine falls back automatically.">Engine</span>
                <div class="ag-seg" id="ag-engine-seg" role="group" aria-label="Engine build">
                  ${(o.engines ?? []).map((engine) => `
                    <button type="button" class="ag-seg-btn" data-value="${attr(engine.id)}" title="${attr(engine.hint)}"
                      aria-pressed="${o.initialEngine === engine.id}">${attr(engine.label)}</button>
                  `).join('')}
                </div>
              </div>
              <div class="ag-hint" id="ag-engine-hint"></div>
              <button id="ag-bench-btn" type="button" class="ag-btn">⏱ Benchmark engines</button>

              <div class="ag-seg-wrap">
                <span class="ag-label" title="How much of the processor the engine may use. Higher is stronger; lower keeps the fans quiet.">CPU Usage</span>
                <div class="ag-seg" id="ag-cpu-seg" role="group" aria-label="CPU usage">
                  ${(o.cpuModes ?? []).map((mode) => `
                    <button type="button" class="ag-seg-btn" data-value="${attr(mode.id)}" title="${attr(mode.hint)}"
                      aria-pressed="${o.initialCpuMode === mode.id}">${attr(mode.label)}</button>
                  `).join('')}
                </div>
              </div>
              <div class="ag-hint" id="ag-cpu-hint"></div>

              <div class="ag-field" id="ag-delay-field">
                <div class="ag-row">
                  <span class="ag-label" title="A deliberate pause before playing, on top of Think Time. Ignored while Instant is on.">Move Delay</span>
                  <span class="ag-value" id="ag-delay-val">${delay}ms</span>
                </div>
                <input type="range" id="ag-delay-slider" min="0" max="5000" step="100"
                  value="${delay}" aria-label="Move delay in milliseconds">
              </div>

              <div class="ag-row">
                <span class="ag-label" title="Draws the suggested move as an arrow on the board.">Highlight Arrows</span>
                <label class="ag-switch">
                  <input type="checkbox" id="ag-toggle-arrows" ${o.initialArrows ? 'checked' : ''} aria-label="Highlight arrows">
                  <span class="ag-slider-toggle"></span>
                </label>
              </div>
            </div>
          </div>

          <div class="ag-section">
            <div id="ag-log-header">
              <div class="ag-section-title">Activity</div>
              <button id="ag-clear-log-btn" type="button">Clear</button>
            </div>
            <div id="ag-bot-logs" role="log" aria-live="polite"></div>
          </div>

        </div>
      </div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(this.container);
    document.body.appendChild(this.host);

    const pick = (id) => this.container.querySelector(id);
    this.logEl = pick('#ag-bot-logs');
    this.statusTextEl = pick('#ag-bot-status-text');
    this.statusDotEl = pick('#ag-status-dot');
    this.evalTextEl = pick('#ag-eval-text');
    this.toggleBotEl = pick('#ag-toggle-bot');
    this.bodyEl = pick('#ag-bot-body');
    this.collapseBtnEl = pick('#ag-collapse-btn');
    this.delayFieldEl = pick('#ag-delay-field');
    this.delaySliderEl = pick('#ag-delay-slider');
    this.instantEl = pick('#ag-toggle-instant');
    this.powerEl = pick('#ag-power');
    this.powerLabelEl = pick('#ag-power-label');
    this.settingsToggleEl = pick('#ag-settings-toggle');
    this.settingsBodyEl = pick('#ag-settings-body');
  }

  // -------------------------------------------------------------------------
  // Position and collapse
  // -------------------------------------------------------------------------

  /**
   * Move the panel, keeping it reachable.
   *
   * The old drag had no clamping at all, so it was entirely possible to drag
   * the panel off the top or side of the window and have no way to get it back
   * short of reloading the page. The header is what you grab, so the rule is
   * that a strip of the panel always stays on screen.
   */
  moveTo(left, top) {
    const rect = this.container.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - KEEP_ON_SCREEN);
    this.host.style.left = `${Math.round(Math.min(Math.max(0, left), maxLeft))}px`;
    this.host.style.top = `${Math.round(Math.min(Math.max(0, top), maxTop))}px`;
    this.host.style.right = 'auto';
  }

  saveLayout() {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({
        left: parseInt(this.host.style.left, 10),
        top: parseInt(this.host.style.top, 10),
        collapsed: this.bodyEl.classList.contains('ag-collapsed'),
        settingsOpen: !this.settingsBodyEl.hidden
      }));
    } catch { /* private mode, or storage disabled — the panel just forgets */ }
  }

  /** Put the panel back where it was left, collapse state included. */
  restoreLayout() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null');
    } catch { /* corrupt value; fall through to the default position */ }
    if (!saved) return;

    if (Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      // Re-clamped rather than trusted: the window may well be smaller than it
      // was when this was saved, which would otherwise restore the panel to
      // somewhere off screen.
      this.moveTo(saved.left, saved.top);
    }
    if (saved.collapsed) this.setCollapsed(true);
    if (saved.settingsOpen) this.setSettingsOpen(true);
  }

  /** Fold the set-once Settings section away, or open it. */
  setSettingsOpen(open) {
    this.settingsBodyEl.hidden = !open;
    this.settingsToggleEl.setAttribute('aria-expanded', String(open));
  }

  setCollapsed(collapsed) {
    this.bodyEl.classList.toggle('ag-collapsed', collapsed);
    this.collapseBtnEl.classList.toggle('ag-collapsed', collapsed);
    this.collapseBtnEl.title = collapsed ? 'Expand' : 'Collapse';
    this.collapseBtnEl.setAttribute('aria-label', collapsed ? 'Expand panel' : 'Collapse panel');
    this.collapseBtnEl.setAttribute('aria-expanded', String(!collapsed));
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  attachEvents() {
    this.attachDrag();

    this.collapseBtnEl.addEventListener('click', () => {
      this.setCollapsed(!this.bodyEl.classList.contains('ag-collapsed'));
      this.saveLayout();
    });

    this.toggleBotEl.addEventListener('change', (e) => {
      this.reflectBotStatus(e.target.checked);
      this.options.onToggleBot?.(e.target.checked);
    });

    this.settingsToggleEl.addEventListener('click', () => {
      this.setSettingsOpen(this.settingsBodyEl.hidden);
      this.saveLayout();
    });

    // Alt+B starts or stops the bot from anywhere on the page — the one action
    // worth a shortcut, since it is the first thing you do in every game. Not
    // while typing (Lichess chat), and never with Ctrl/Meta, so it cannot
    // shadow a browser or OS shortcut.
    this._onKey = (event) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.code !== 'KeyB' || event.repeat) return;
      const target = event.composedPath?.()[0] ?? event.target;
      if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '') &&
          target !== this.toggleBotEl) return;
      event.preventDefault();
      this.toggleBotEl.click();
    };
    document.addEventListener('keydown', this._onKey, true);

    this.container.querySelector('#ag-toggle-autoplay').addEventListener('change', (e) => {
      this.options.onAutoPlayChange?.(e.target.checked);
    });

    this.instantEl.addEventListener('change', (e) => {
      this.reflectInstant(e.target.checked);
      this.options.onInstantChange?.(e.target.checked);
    });
    // Move Delay (in Settings) greys out while Instant (in Play) owns it, and
    // both tooltips say so — Instant is the mid-game switch, the delay length
    // is the set-once part.
    this.reflectInstant(this.instantEl.checked);

    this.selectColor = this.wireSegmented('#ag-color-seg', (value) => {
      this.options.onPlayingAsChange?.(value);
    });

    const modeHint = this.container.querySelector('#ag-mode-hint');
    // Each style's one-line description travels with the style itself, so the
    // hint under the buttons stays right without this file having to know what
    // any of the modes actually do.
    const showModeHint = (id) => {
      modeHint.textContent = (this.options.modes ?? []).find((m) => m.id === id)?.hint ?? '';
    };
    showModeHint(this.options.initialMode);
    this.selectMode = this.wireSegmented('#ag-mode-seg', (value) => {
      showModeHint(value);
      this.options.onModeChange?.(value);
    });

    const engineHint = this.container.querySelector('#ag-engine-hint');
    const showEngineHint = (id) => {
      engineHint.textContent = (this.options.engines ?? []).find((e) => e.id === id)?.hint ?? '';
    };
    showEngineHint(this.options.initialEngine);
    this.selectEngine = this.wireSegmented('#ag-engine-seg', (value) => {
      showEngineHint(value);
      this.options.onEngineChange?.(value);
    });

    const cpuHint = this.container.querySelector('#ag-cpu-hint');
    const showCpuHint = (id) => {
      cpuHint.textContent = (this.options.cpuModes ?? []).find((m) => m.id === id)?.hint ?? '';
    };
    showCpuHint(this.options.initialCpuMode);
    this.selectCpuMode = this.wireSegmented('#ag-cpu-seg', (value) => {
      showCpuHint(value);
      this.options.onCpuModeChange?.(value);
    });

    this.wireSlider('#ag-movetime-slider', '#ag-movetime-val', (v) => this.options.onMoveTimeChange?.(v));
    this.wireSlider('#ag-delay-slider', '#ag-delay-val', (v) => this.options.onDelayChange?.(v));

    this.container.querySelector('#ag-toggle-arrows').addEventListener('change', (e) => {
      this.options.onHighlightChange?.(e.target.checked);
    });

    this.container.querySelector('#ag-clear-log-btn').addEventListener('click', () => {
      this.logEl.replaceChildren();
    });

    // Same shape as the Sync button: disabled and relabelled while it runs,
    // because a benchmark takes seconds and a second click would start a
    // competing set of searches against the first one's engine.
    const benchBtn = this.container.querySelector('#ag-bench-btn');
    benchBtn.addEventListener('click', async () => {
      if (!this.options.onBenchmarkClick || benchBtn.disabled) return;
      benchBtn.disabled = true;
      const label = benchBtn.textContent;
      benchBtn.textContent = 'Benchmarking…';
      try {
        await this.options.onBenchmarkClick();
      } finally {
        benchBtn.textContent = label;
        benchBtn.disabled = false;
      }
    });

    const syncBtn = this.container.querySelector('#ag-sync-btn');
    syncBtn.addEventListener('click', async () => {
      if (!this.options.onSyncClick || syncBtn.disabled) return;
      syncBtn.disabled = true;
      const label = syncBtn.textContent;
      syncBtn.textContent = 'Syncing…';
      try {
        await this.options.onSyncClick();
      } finally {
        syncBtn.textContent = label;
        syncBtn.disabled = false;
      }
    });

    // A window that shrinks below the panel's saved position would otherwise
    // leave it stranded off screen.
    this._onResize = () => {
      if (!this.host.style.left) return;
      this.moveTo(parseInt(this.host.style.left, 10), parseInt(this.host.style.top, 10));
    };
    window.addEventListener('resize', this._onResize);
  }

  /**
   * Pointer-based drag.
   *
   * Pointer capture rather than document-level mousemove: the old version
   * assigned `document.onmousemove` / `document.onmouseup` directly, which
   * clobbers any other handler on the page, is clobbered *by* any other
   * handler, and leaves the drag stuck on if the pointer leaves the window
   * mid-gesture. Capture routes every move to this element until release, and
   * `pointercancel` covers the cases where the gesture is taken away.
   */
  attachDrag() {
    const header = this.container.querySelector('#ag-bot-header');
    let grabX = 0;
    let grabY = 0;
    let dragging = false;

    header.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('#ag-collapse-btn, #ag-power')) return;
      const rect = this.container.getBoundingClientRect();
      grabX = event.clientX - rect.left;
      grabY = event.clientY - rect.top;
      dragging = true;
      this.container.classList.add('ag-dragging');
      header.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    header.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      this.moveTo(event.clientX - grabX, event.clientY - grabY);
    });

    const end = (event) => {
      if (!dragging) return;
      dragging = false;
      this.container.classList.remove('ag-dragging');
      try { header.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      this.saveLayout();
    };
    header.addEventListener('pointerup', end);
    header.addEventListener('pointercancel', end);
  }

  /**
   * Wire one slider.
   *
   * The label follows the thumb on `input`, but the callback only fires on
   * `change` — when the drag is *committed*. Firing on `input` meant one
   * callback per pixel of travel, and each of those wrote to chrome.storage
   * and appended a line to the Activity log: dragging Think Time across its
   * range produced around a hundred storage writes and a hundred log entries,
   * burying everything else in the panel.
   */
  wireSlider(sliderId, valueId, onCommit) {
    const slider = this.container.querySelector(sliderId);
    const label = this.container.querySelector(valueId);
    slider.addEventListener('input', () => { label.textContent = `${slider.value}ms`; });
    slider.addEventListener('change', () => onCommit(parseInt(slider.value, 10)));
    return slider;
  }

  /**
   * Wire one segmented group. `aria-pressed` is both the accessible state and
   * the thing the stylesheet selects on, so setting it is all that is needed
   * to move the highlight — there is no separate "selected" class to keep in
   * sync and get wrong.
   */
  wireSegmented(groupId, onPick) {
    const group = this.container.querySelector(groupId);
    const select = (value) => {
      for (const button of group.querySelectorAll('.ag-seg-btn')) {
        button.setAttribute('aria-pressed', String(button.dataset.value === value));
      }
    };
    group.addEventListener('click', (event) => {
      const button = event.target.closest('.ag-seg-btn');
      if (!button || !group.contains(button)) return;
      // Re-picking what is already active would re-fire the callback (and its
      // log line) for no change at all.
      if (button.getAttribute('aria-pressed') === 'true') return;
      select(button.dataset.value);
      onPick(button.dataset.value);
    });
    return select;
  }

  /** Move Delay is meaningless while Instant is on, so it says so. */
  reflectInstant(instantOn) {
    this.delaySliderEl.disabled = instantOn;
    this.delayFieldEl.classList.toggle('ag-disabled', instantOn);
    this.delayFieldEl.title = instantOn ? 'Ignored while Instant is on' : '';
  }

  // -------------------------------------------------------------------------
  // Readouts
  // -------------------------------------------------------------------------

  /** Shared visual state for on/off, used by both user toggling and programmatic sets. */
  reflectBotStatus(active, label = active ? 'ON' : 'OFF') {
    this.setStatus(label, active ? 'on' : 'off');
    this.statusDotEl.classList.toggle('on', active);
    this.powerEl.classList.toggle('on', active);
    this.powerLabelEl.textContent = active ? 'Stop' : 'Start';
  }

  /**
   * Say what the bot is doing right now.
   *
   * @param {string} label  e.g. "Thinking…", "Opponent's move"
   * @param {'on'|'off'|'busy'|'wait'|'warn'|'error'|'over'} kind  colour/animation
   */
  setStatus(label, kind = 'on') {
    this.statusTextEl.textContent = label;
    for (const k of ['on', 'busy', 'wait', 'warn', 'error', 'over']) {
      this.statusTextEl.classList.toggle(`ag-status-${k}`, k === kind);
    }
  }

  log(message, type = 'info') {
    const icon = { success: '✓', warn: '!', error: '✕', info: '·' }[type] ?? '·';
    const entry = document.createElement('div');
    entry.className = `ag-log-entry ag-log-${type}`;

    const time = document.createElement('span');
    time.className = 'ag-log-time';
    time.textContent = new Date().toLocaleTimeString([], {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const mark = document.createElement('span');
    mark.className = 'ag-log-icon';
    mark.textContent = icon;

    entry.append(time, mark, document.createTextNode(message));

    // Only follow the tail if the reader is already at it — yanking the scroll
    // position out from under someone reading back is its own bug.
    const atBottom = this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight < 24;
    this.logEl.appendChild(entry);
    while (this.logEl.childElementCount > LOG_MAX) this.logEl.firstElementChild.remove();
    if (atBottom) this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /** @param {string} evaluation display text. @param {number} signed pawns (or mate count), +ve = White ahead. */
  updateEval(evaluation, signed = 0) {
    this.evalTextEl.textContent = evaluation;
    this.evalTextEl.style.color = signed > 0.15 ? 'var(--accent)'
      : signed < -0.15 ? 'var(--danger)'
      : 'var(--info)';
  }

  /**
   * Show an engine score from *your* side, with a bar.
   *
   * Scores arrive White-positive (the chess convention), which made "-1.20"
   * mean "good for you" every time you played Black. With a known colour the
   * number, its colour and the bar are all flipped to your side; without one
   * (analysis boards) it stays White-relative and says so.
   *
   * @param {{pawns: number|null, mateIn: number|null}} score  White-positive
   * @param {'white'|'black'|null} perspective  your colour, if known
   */
  updateScore({ pawns = null, mateIn = null } = {}, perspective = null) {
    const flip = perspective === 'black' ? -1 : 1;
    const p = pawns === null ? null : pawns * flip;
    const m = mateIn === null ? null : mateIn * flip;
    const mine = Boolean(perspective);

    let text;
    let side;
    if (m !== null) {
      text = `M${Math.abs(m)}`;
      side = mine ? (m > 0 ? 'you mate' : 'they mate') : `${m > 0 ? 'White' : 'Black'} mates`;
    } else if (p !== null) {
      text = `${p > 0 ? '+' : ''}${p.toFixed(2)}`;
      side = Math.abs(p) < 0.15 ? 'level'
        : mine ? (p > 0 ? 'for you' : 'for them')
        : `${p > 0 ? 'White' : 'Black'} better`;
    } else {
      text = 'N/A';
      side = '';
    }

    const signed = m !== null ? Math.sign(m) * 99 : p ?? 0;
    this.updateEval(text, signed);
    this.container.querySelector('#ag-eval-side').textContent = side;

    // tanh keeps small edges visible and big ones from pinning the bar at
    // once: +1 is ~62%, +3 ~82%, a mate is all the way.
    const pct = m !== null ? (m > 0 ? 100 : 0) : 50 + 50 * Math.tanh((p ?? 0) / 4);
    const bar = this.container.querySelector('#ag-evalbar');
    bar.classList.toggle('ag-neutral', !mine);
    this.container.querySelector('#ag-evalbar-fill').style.width = `${pct.toFixed(1)}%`;
  }

  /**
   * The suggested move in readable notation.
   * @param {string|null} san  e.g. "Nf3", or null to hide the tile
   * @param {string} [note]  e.g. "your move", "book: Italian Game"
   */
  updateBestMove(san, note = '') {
    const tile = this.container.querySelector('#ag-best-stat');
    tile.hidden = !san;
    if (!san) return;
    this.container.querySelector('#ag-best-text').textContent = san;
    this.container.querySelector('#ag-best-sub').textContent = note;
  }

  /**
   * Show which colour Auto detected, on the Auto button itself.
   *
   * Detection used to press the White/Black button, which looked exactly like a
   * choice you had made. Now Auto stays selected and reads "Auto · Black".
   */
  setDetectedColor(color) {
    const auto = this.container.querySelector('#ag-color-seg .ag-seg-btn[data-value="auto"]');
    if (!auto) return;
    auto.textContent = color ? `Auto · ${color[0].toUpperCase()}${color.slice(1)}` : 'Auto';
  }

  /** Show the known opening name, or hide the tile once out of book. */
  updateOpening(name) {
    const tile = this.container.querySelector('#ag-opening-stat');
    tile.hidden = !name;
    if (name) this.container.querySelector('#ag-opening-text').textContent = name;
  }

  /**
   * Report how long the last reply actually took.
   *
   * `totalMs` runs from the moment the opponent's move arrived on the socket to
   * the moment ours was confirmed on the board, so it includes the engine's
   * think time. `overheadMs` — everything before the engine was even asked — is
   * the number that says whether the fast path is working.
   */
  updateLatency(totalMs, overheadMs = null) {
    const tile = this.container.querySelector('#ag-latency-stat');
    const text = this.container.querySelector('#ag-latency-text');
    if (!tile || !text) return;

    tile.hidden = false;
    text.textContent = `${totalMs}ms`;
    this.container.querySelector('#ag-latency-sub').textContent =
      overheadMs === null ? '' : `${overheadMs}ms overhead`;

    // Overhead is the part this extension is responsible for, so it is what
    // gets the colour: single digits mean the socket tap is doing its job,
    // three digits mean something fell back to reading the DOM.
    const grade = overheadMs ?? 0;
    text.style.color = grade < 40 ? 'var(--accent)' : grade < 150 ? 'var(--warn)' : 'var(--danger)';
  }

  /**
   * Which engine build actually came up, and on how many threads.
   *
   * This was previously only a log line, which scrolls away — unhelpful for the
   * one fact worth checking after a reload, since whether threading is live is
   * the difference between a strong bot and a much weaker one.
   *
   * @param {{script?: string, threads?: number, shared?: boolean}|null} info
   */
  updateEngine(info) {
    const tile = this.container.querySelector('#ag-engine-stat');
    const text = this.container.querySelector('#ag-engine-text');
    if (!tile || !text) return;

    if (!info?.script) { tile.hidden = true; return; }

    const threads = Number(info.threads) || 1;
    tile.hidden = false;
    // The build matters now that there is more than one to choose from: "2
    // threads" alone cannot tell you whether the engine you picked is the one
    // that actually came up.
    const name = info.label ?? info.script.replace(/^engine\//, '').replace(/\.js$/, '');
    text.textContent = `${name} · ${threads} thread${threads === 1 ? '' : 's'}`;
    text.style.color = threads > 1 ? 'var(--accent)' : 'var(--warn)';
    tile.title = threads > 1
      ? `${info.script} — multithreaded`
      : `${info.script} — single-threaded. Shared memory was unavailable, so the threaded build could not start.`;
  }

  /**
   * Clear the per-game readouts.
   *
   * Without this the last game's latency and opening sat there indefinitely,
   * including after the bot was switched off, describing a game that had
   * already finished.
   */
  resetStatus() {
    this.updateScore({}, null);
    this.updateBestMove(null);
    this.updateOpening(null);
    this.container.querySelector('#ag-latency-stat').hidden = true;
  }

  /** Reflect bot on/off state without re-firing onToggleBot (e.g. a failed start). */
  setBotActive(active) {
    this.toggleBotEl.checked = active;
    this.reflectBotStatus(active);
  }

  /** Reflect "Playing As" once known, without re-firing onPlayingAsChange. */
  setPlayingAs(color) {
    this.selectColor?.(color);
  }

  setGameOver() {
    this.toggleBotEl.checked = false;
    this.reflectBotStatus(false, 'GAME OVER');
    this.setStatus('GAME OVER', 'over');
  }
}
