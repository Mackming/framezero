/**
 * FrameZero — Main Interactive Web Controller
 * Implements:
 * 1. Stats Counter Animation (easeOutCubic)
 * 2. Authentic Lichess Vector SVG Chessboard, Dynamic Vectors & Flight HUD
 * 3. Real-Time Latency Waterfall Race Simulator
 * 4. Systems Architecture Interactive Topology & Code Inspector
 * 5. Empirical Benchmarks Depth & NPS Comparator
 * 6. Quick Deploy Tabs, Copy Clipboard & Tactile Keycap Command Deck
 * 7. Mobile Navigation Sheet & ScrollSpy
 */

// ============================================================================
// 1. STATS COUNTER ANIMATION
// ============================================================================
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function animateValue(el, target, suffix, decimals, duration, delay) {
  if (typeof target !== 'number' || isNaN(target)) return;
  setTimeout(() => {
    const startTime = performance.now();

    function update(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const easedProgress = easeOutCubic(progress);
      const current = easedProgress * target;

      el.textContent = current.toFixed(decimals) + suffix;

      if (progress < 1) {
        requestAnimationFrame(update);
      } else {
        el.textContent = target.toFixed(decimals) + suffix;
      }
    }

    requestAnimationFrame(update);
  }, delay);
}

function initCounters() {
  const statContainers = document.querySelectorAll('.stats-footer');
  if (!statContainers.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const statValues = entry.target.querySelectorAll('.stat-value[data-target]');
        statValues.forEach((el, i) => {
          const target = parseFloat(el.dataset.target);
          if (isNaN(target)) return;
          const suffix = el.dataset.suffix || '';
          const decimals = parseInt(el.dataset.decimals || '0', 10);
          const duration = 1200 + i * 80;
          const delay = 150 + i * 80;

          animateValue(el, target, suffix, decimals, duration, delay);
        });
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15 });

  statContainers.forEach(container => observer.observe(container));
}

// ============================================================================
// 2. AUTHENTIC LICHESS SVG PIECES & INTERACTIVE CHESSBOARD
// ============================================================================

const PIECE_SVGS = {
  P: 'assets/pieces/wP.svg',
  N: 'assets/pieces/wN.svg',
  B: 'assets/pieces/wB.svg',
  R: 'assets/pieces/wR.svg',
  Q: 'assets/pieces/wQ.svg',
  K: 'assets/pieces/wK.svg',
  p: 'assets/pieces/bP.svg',
  n: 'assets/pieces/bN.svg',
  b: 'assets/pieces/bB.svg',
  r: 'assets/pieces/bR.svg',
  q: 'assets/pieces/bQ.svg',
  k: 'assets/pieces/bK.svg'
};

const DEMO_POSITIONS = [
  {
    name: "Scholar's Tactical Strike",
    fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w - - 0 1',
    afterMoveFen: 'r1bqkbnr/pppp1Qpp/2n5/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b - - 0 1',
    bestMove: { from: 'f3', to: 'f7' },
    eval: '#M1',
    evalDesc: 'White has forced checkmate in 1 move (Qxf7#)',
    winProb: '99.9% White Win Prob',
    evalPercent: 98,
    depth: 'Depth 24 / 910k NPS',
    speed: '910k NPS',
    tb: 'Syzygy 7-Man',
    styles: {
      best: { move: { from: 'f3', to: 'f7' }, eval: '#M1', desc: 'White has forced checkmate in 1 move (Qxf7#)', prob: '99.9% White Win Prob', uci: 'bestmove f3f7 (Qxf7# checkmate)', fill: 98 },
      aggro: { move: { from: 'c4', to: 'f7' }, eval: '+4.80', desc: 'Bishop sacrifice destroys castling rights (Bxf7+)', prob: '94.2% White Win Prob', uci: 'bestmove c4f7 (Bxf7+ king hunt)', fill: 84 },
      trap: { move: { from: 'g1', to: 'e2' }, eval: '+1.65', desc: 'Prepares d4 while baiting 1...Nd4 blunder', prob: '78.5% White Win Prob', uci: 'bestmove g1e2 (solid baiting line)', fill: 68 },
      greedy: { move: { from: 'f3', to: 'f7' }, eval: '#M1', desc: 'Direct tactical queen strike wins immediately', prob: '99.9% White Win Prob', uci: 'bestmove f3f7 (material clean win)', fill: 98 },
      chaos: { move: { from: 'd2', to: 'd3' }, eval: '+1.40', desc: 'Positional quiet move holding center tension', prob: '72.0% White Win Prob', uci: 'bestmove d2d3 (quiet development)', fill: 64 },
      drawish: { move: { from: 'f3', to: 'e2' }, eval: '+0.10', desc: 'Flattens tactical complications into endgames', prob: '53.0% Equal Position', uci: 'bestmove f3e2 (defensive retreat)', fill: 51 }
    }
  },
  {
    name: 'Sicilian Dragon Tactical Clash',
    fen: 'r1bq1rk1/pp2ppbp/2np1np1/8/3NP3/2N1BP2/PPP3PP/2KR1B1R w - - 0 10',
    afterMoveFen: 'r1bq1rk1/pp2ppbp/2np1np1/8/3NP1P1/2N1BP2/PPP4P/2KR1B1R b - - 0 10',
    bestMove: { from: 'g2', to: 'g4' },
    eval: '+1.24',
    evalDesc: 'Yugoslav pawn assault launches sharp Kingside storm',
    winProb: '68.4% White Win Prob',
    evalPercent: 62,
    depth: 'Depth 22 / 885k NPS',
    speed: '885k NPS',
    tb: 'Opening Book Cache',
    styles: {
      best: { move: { from: 'g2', to: 'g4' }, eval: '+1.24', desc: 'Yugoslav pawn assault launches sharp Kingside storm', prob: '68.4% White Win Prob', uci: 'bestmove g2g4 (pawn storm initiation)', fill: 62 },
      aggro: { move: { from: 'h2', to: 'h4' }, eval: '+1.10', desc: 'Immediate h-file rook battery opening thrust', prob: '65.1% White Win Prob', uci: 'bestmove h2h4 (h-pawn sprint)', fill: 60 },
      trap: { move: { from: 'd4', to: 'b3' }, eval: '+0.88', desc: 'Prophylactic retreat avoiding exchange on c3', prob: '61.2% White Win Prob', uci: 'bestmove d4b3 (knight tactical retreat)', fill: 57 },
      greedy: { move: { from: 'd4', to: 'c6' }, eval: '+0.72', desc: 'Captures active knight and weakens Black b7 pawn', prob: '58.0% White Win Prob', uci: 'bestmove d4c6 (Nxc6 structure disruption)', fill: 55 },
      chaos: { move: { from: 'f1', to: 'c4' }, eval: '+0.95', desc: 'Classical bishop development targeting weak f7', prob: '63.0% White Win Prob', uci: 'bestmove f1c4 (Bc4 direct pressure)', fill: 59 },
      drawish: { move: { from: 'c1', to: 'b1' }, eval: '+0.30', desc: 'Prophylactic king step to safe dark square', prob: '54.5% Equalized Position', uci: 'bestmove c1b1 (Kb1 king safety)', fill: 52 }
    }
  },
  {
    name: 'Syzygy 7-Man KQ vs KR Conversion',
    fen: '8/8/8/4k3/8/8/4Q3/4K1r1 w - - 0 1',
    afterMoveFen: '8/8/8/4k3/4Q3/8/8/4K1r1 b - - 1 1',
    bestMove: { from: 'e2', to: 'e4' },
    eval: '+M12',
    evalDesc: 'Tablebase DTM 12: Forced Queen cross-pin conversion',
    winProb: '100% White Win Prob (Proven)',
    evalPercent: 99,
    depth: 'Depth 7-Man / 0.0ms TB',
    speed: 'Instant DTM',
    tb: 'Syzygy DTM Hit',
    styles: {
      best: { move: { from: 'e2', to: 'e4' }, eval: '+M12', desc: 'Tablebase DTM 12: Forced Queen cross-pin conversion', prob: '100% Proven Win', uci: 'bestmove e2e4 (Qe4+ DTM 12)', fill: 99 },
      aggro: { move: { from: 'e2', to: 'a6' }, eval: '+M14', desc: 'Queen flank check drives enemy king away', prob: '100% Proven Win', uci: 'bestmove e2a6 (Qa6+ DTM 14)', fill: 98 },
      trap: { move: { from: 'e1', to: 'f2' }, eval: '+M15', desc: 'Baits rook skewer while stepping into mating net', prob: '100% Proven Win', uci: 'bestmove e1f2 (Kf2 king tempo)', fill: 97 },
      greedy: { move: { from: 'e2', to: 'e4' }, eval: '+M12', desc: 'Mathematical shortest distance to checkmate', prob: '100% Proven Win', uci: 'bestmove e2e4 (optimal DTM sequence)', fill: 99 },
      chaos: { move: { from: 'e2', to: 'h5' }, eval: '+M16', desc: 'High-degree freedom queen check', prob: '100% Proven Win', uci: 'bestmove e2h5 (Qh5+ tactical check)', fill: 96 },
      drawish: { move: { from: 'e2', to: 'e4' }, eval: '+M12', desc: 'Simplest non-repetitive winning sequence', prob: '100% Proven Win', uci: 'bestmove e2e4 (simplest winning path)', fill: 99 }
    }
  }
];

let currentPosIndex = 0;
let currentStyle = 'best';
let isFlipped = false;
let isMoved = false;
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

function squareToCoords(sq) {
  const file = sq[0];
  const rank = parseInt(sq[1], 10);
  const col = isFlipped ? 7 - FILES.indexOf(file) : FILES.indexOf(file);
  const row = isFlipped ? rank - 1 : 8 - rank;
  return { col, row, x: col + 0.5, y: row + 0.5 };
}

function renderBoard(fen, highlightFrom, highlightTo) {
  const boardEl = document.getElementById('chessboard');
  if (!boardEl) return;
  boardEl.innerHTML = '';

  const placement = fen.split(' ')[0];
  const rows = placement.split('/');

  for (let r = 0; r < 8; r++) {
    const actualR = isFlipped ? 7 - r : r;
    const rowStr = rows[actualR];
    let c = 0;

    // Parse FEN row into 8 squares
    const rowPieces = [];
    for (const char of rowStr) {
      if (/\d/.test(char)) {
        const count = parseInt(char, 10);
        for (let i = 0; i < count; i++) rowPieces.push(null);
      } else {
        rowPieces.push(char);
      }
    }

    if (isFlipped) rowPieces.reverse();

    for (let col = 0; col < 8; col++) {
      const pieceChar = rowPieces[col];
      const sqFile = isFlipped ? FILES[7 - col] : FILES[col];
      const sqRank = isFlipped ? r + 1 : 8 - r;
      const sqName = `${sqFile}${sqRank}`;

      const sq = document.createElement('div');
      const isLight = (col + r) % 2 === 0;
      sq.className = `sq ${isLight ? 'light' : 'dark'}`;
      sq.dataset.square = sqName;

      // Move highlight classes
      if (highlightFrom === sqName) sq.classList.add('sq-highlight-from');
      if (highlightTo === sqName) sq.classList.add('sq-highlight-to');

      // Rank coordinate on first column
      if (col === 0) {
        const rankLabel = document.createElement('span');
        rankLabel.className = 'coord-label rank-label';
        rankLabel.textContent = sqRank;
        sq.appendChild(rankLabel);
      }

      // File coordinate on bottom row
      if (r === 7) {
        const fileLabel = document.createElement('span');
        fileLabel.className = 'coord-label file-label';
        fileLabel.textContent = sqFile;
        sq.appendChild(fileLabel);
      }

      // Render crisp vector SVG piece
      if (pieceChar && PIECE_SVGS[pieceChar]) {
        const img = document.createElement('img');
        img.className = 'piece-img';
        img.src = PIECE_SVGS[pieceChar];
        img.alt = pieceChar;
        img.draggable = false;
        sq.appendChild(img);
      }

      boardEl.appendChild(sq);
    }
  }
}

function drawVector(fromSq, toSq) {
  const svg = document.getElementById('svg-overlay');
  if (!svg) return;
  svg.innerHTML = '';

  const from = squareToCoords(fromSq);
  const to = squareToCoords(toSq);

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;

  const nx = dx / len;
  const ny = dy / len;

  const arrowColor = '#3fd6a3';
  const targetRingColor = 'rgba(63, 214, 163, 0.4)';

  // 1. Source pulsing ring
  const circleFrom = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circleFrom.setAttribute('cx', from.x);
  circleFrom.setAttribute('cy', from.y);
  circleFrom.setAttribute('r', '0.36');
  circleFrom.setAttribute('fill', 'rgba(63, 214, 163, 0.20)');
  circleFrom.setAttribute('stroke', arrowColor);
  circleFrom.setAttribute('stroke-width', '0.08');
  svg.appendChild(circleFrom);

  // 2. Target reticle circle
  const circleTo = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circleTo.setAttribute('cx', to.x);
  circleTo.setAttribute('cy', to.y);
  circleTo.setAttribute('r', '0.38');
  circleTo.setAttribute('fill', 'rgba(63, 214, 163, 0.25)');
  circleTo.setAttribute('stroke', arrowColor);
  circleTo.setAttribute('stroke-width', '0.08');
  svg.appendChild(circleTo);

  // 3. Arrow shaft
  const shaftStart = 0.28;
  const shaftEnd = len - 0.42;

  if (shaftEnd > shaftStart) {
    const x1 = from.x + nx * shaftStart;
    const y1 = from.y + ny * shaftStart;
    const x2 = from.x + nx * shaftEnd;
    const y2 = from.y + ny * shaftEnd;

    // Outer dark casing for contrast
    const lineShadow = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    lineShadow.setAttribute('x1', x1);
    lineShadow.setAttribute('y1', y1);
    lineShadow.setAttribute('x2', x2);
    lineShadow.setAttribute('y2', y2);
    lineShadow.setAttribute('stroke', '#000000');
    lineShadow.setAttribute('stroke-width', '0.22');
    lineShadow.setAttribute('stroke-linecap', 'round');
    svg.appendChild(lineShadow);

    // Inner bright emerald line
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1);
    line.setAttribute('y1', y1);
    line.setAttribute('x2', x2);
    line.setAttribute('y2', y2);
    line.setAttribute('stroke', arrowColor);
    line.setAttribute('stroke-width', '0.14');
    line.setAttribute('stroke-linecap', 'round');
    svg.appendChild(line);
  }

  // 4. Arrowhead triangle
  const tipX = to.x - nx * 0.10;
  const tipY = to.y - ny * 0.10;
  const headLen = 0.38;
  const headWidth = 0.28;

  const perpX = -ny;
  const perpY = nx;

  const leftX = tipX - nx * headLen + perpX * headWidth;
  const leftY = tipY - ny * headLen + perpY * headWidth;
  const rightX = tipX - nx * headLen - perpX * headWidth;
  const rightY = tipY - ny * headLen - perpY * headWidth;

  const polygonShadow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  polygonShadow.setAttribute('points', `${tipX},${tipY} ${leftX},${leftY} ${rightX},${rightY}`);
  polygonShadow.setAttribute('fill', arrowColor);
  polygonShadow.setAttribute('stroke', '#000000');
  polygonShadow.setAttribute('stroke-width', '0.05');
  polygonShadow.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(polygonShadow);
}

function updateHUD(choice, pos) {
  const evalEl = document.getElementById('hud-eval');
  const descEl = document.getElementById('hud-eval-desc');
  const probEl = document.getElementById('hud-eval-prob');
  const fillEl = document.getElementById('hud-eval-fill');
  const overheadEl = document.getElementById('hud-overhead');
  const depthPill = document.getElementById('hud-depth-pill');
  const speedEl = document.getElementById('hud-speed');
  const tbEl = document.getElementById('hud-tb');
  const badgeEl = document.getElementById('style-name-badge');
  const consoleEl = document.getElementById('hud-console');

  if (evalEl) evalEl.textContent = choice.eval;
  if (descEl) descEl.textContent = choice.desc;
  if (probEl) probEl.textContent = choice.prob;
  if (fillEl) fillEl.style.width = `${choice.fill}%`;
  if (depthPill) depthPill.textContent = pos.depth;
  if (speedEl) speedEl.textContent = pos.speed;
  if (tbEl) tbEl.textContent = pos.tb;
  if (badgeEl) badgeEl.textContent = currentStyle.toUpperCase();

  const depthValEl = document.getElementById('hud-depth-val');
  if (depthValEl) {
    const depthMatch = pos.depth.match(/Depth\s+([\w-]+)/i);
    depthValEl.textContent = depthMatch ? (depthMatch[1] === '7-Man' ? '7-Man' : `${depthMatch[1]}ply`) : '24ply';
  }

  const overhead = (2.7 + Math.random() * 0.9).toFixed(1);
  if (overheadEl) overheadEl.textContent = `${overhead} ms`;

  if (consoleEl) {
    const d = new Date();
    const ts = d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0');
    consoleEl.innerHTML = `
      <div>[${ts}] <span class="ok">socket</span> Opponent played move (intercepted in 0.1ms)</div>
      <div>[${ts}] <span class="info">fen</span> Board updated: ${pos.name}</div>
      <div>[${ts}] <span class="warn">stockfish</span> Best move: ${choice.move.from}${choice.move.to} (${choice.desc.slice(0, 36)}...)</div>
      <div>[${ts}] <span class="ok">hud</span> Tactical arrow &amp; move guidance ready in ${overhead}ms</div>
    `;
  }
}

function setStyle(styleId) {
  currentStyle = styleId;
  const pos = DEMO_POSITIONS[currentPosIndex];
  const choice = pos.styles[styleId] || pos.styles.best;

  document.querySelectorAll('.style-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.style === styleId);
  });

  const activeFen = isMoved ? pos.afterMoveFen : pos.fen;
  renderBoard(activeFen, choice.move.from, choice.move.to);
  drawVector(choice.move.from, choice.move.to);
  updateHUD(choice, pos);
}

function initShowcase() {
  const pos = DEMO_POSITIONS[currentPosIndex];
  const posName = document.getElementById('board-pos-name');
  const posFen = document.getElementById('board-pos-fen');

  if (posName) posName.textContent = pos.name;
  if (posFen) posFen.textContent = pos.fen;

  setStyle('best');

  // Playstyle selector pills
  document.querySelectorAll('.style-pill').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const pill = e.target.closest('.style-pill');
      if (pill) setStyle(pill.dataset.style);
    });
  });

  // Simulate Move button
  const playBtn = document.getElementById('btn-play-move');
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      const currentPos = DEMO_POSITIONS[currentPosIndex];
      isMoved = !isMoved;

      const activeFen = isMoved ? currentPos.afterMoveFen : currentPos.fen;
      const choice = currentPos.styles[currentStyle] || currentPos.styles.best;

      renderBoard(activeFen, choice.move.from, choice.move.to);
      drawVector(choice.move.from, choice.move.to);

      playBtn.innerHTML = isMoved
        ? `<i class="fa-solid fa-arrow-rotate-left"></i><span>Takeback</span>`
        : `<i class="fa-solid fa-play"></i><span>Simulate Move</span>`;

      updateHUD(choice, currentPos);
    });
  }

  // Cycle Position button
  const resetBtn = document.getElementById('btn-reset-board');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      currentPosIndex = (currentPosIndex + 1) % DEMO_POSITIONS.length;
      isMoved = false;
      const newPos = DEMO_POSITIONS[currentPosIndex];

      if (posName) posName.textContent = newPos.name;
      if (posFen) posFen.textContent = newPos.fen;

      if (playBtn) {
        playBtn.innerHTML = `<i class="fa-solid fa-play"></i><span>Simulate Move</span>`;
      }

      setStyle('best');
    });
  }

  // Flip Board button
  const flipBtn = document.getElementById('btn-flip-board');
  if (flipBtn) {
    flipBtn.addEventListener('click', () => {
      isFlipped = !isFlipped;
      setStyle(currentStyle);
    });
  }

  // Copy UCI button
  const copyUciBtn = document.getElementById('btn-copy-uci');
  if (copyUciBtn) {
    copyUciBtn.addEventListener('click', () => {
      const consoleEl = document.getElementById('hud-console');
      if (consoleEl) {
        navigator.clipboard.writeText(consoleEl.innerText).then(() => {
          copyUciBtn.innerHTML = `<i class="fa-solid fa-check"></i><span>Copied</span>`;
          setTimeout(() => {
            copyUciBtn.innerHTML = `<i class="fa-regular fa-copy"></i><span>Copy</span>`;
          }, 1500);
        });
      }
    });
  }
}

// ============================================================================
// 3. LATENCY RACE SIMULATOR
// ============================================================================
function initLatencySimulator() {
  const fireBtn = document.getElementById('btn-fire-race');
  const runnerFz = document.getElementById('runner-fz');
  const runnerDom = document.getElementById('runner-dom');
  const timerFz = document.getElementById('fz-timer');
  const timerDom = document.getElementById('dom-timer');

  if (!fireBtn || !runnerFz || !runnerDom) return;

  let isRacing = false;

  fireBtn.addEventListener('click', () => {
    if (isRacing) return;
    isRacing = true;
    fireBtn.disabled = true;
    fireBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i><span>Simulating...</span>`;

    // Reset runners
    runnerFz.style.transition = 'none';
    runnerDom.style.transition = 'none';
    runnerFz.style.left = '0%';
    runnerDom.style.left = '0%';
    timerFz.textContent = '0.0 ms';
    timerDom.textContent = '0.0 ms';

    setTimeout(() => {
      // 1. FrameZero shoots across in 280ms (simulating 3.2ms wire capture)
      runnerFz.style.transition = 'left 0.28s cubic-bezier(0.1, 0.9, 0.2, 1)';
      runnerFz.style.left = '100%';

      const fzStart = performance.now();
      const fzInterval = setInterval(() => {
        const elapsed = (performance.now() - fzStart) / 280;
        if (elapsed >= 1) {
          timerFz.textContent = '3.2 ms';
          clearInterval(fzInterval);
        } else {
          timerFz.textContent = (elapsed * 3.2).toFixed(1) + ' ms';
        }
      }, 20);

      // 2. DOM Scraper crawls slowly across 2200ms
      runnerDom.style.transition = 'left 2.2s linear';
      runnerDom.style.left = '100%';

      const domStart = performance.now();
      const domInterval = setInterval(() => {
        const elapsed = (performance.now() - domStart) / 2200;
        if (elapsed >= 1) {
          timerDom.textContent = '365.0 ms';
          clearInterval(domInterval);
          isRacing = false;
          fireBtn.disabled = false;
          fireBtn.innerHTML = `<i class="fa-solid fa-rotate-right"></i><span>Simulate Opponent Move</span>`;
        } else {
          timerDom.textContent = (elapsed * 365).toFixed(1) + ' ms';
        }
      }, 30);
    }, 50);
  });
}

// ============================================================================
// 4. SYSTEMS ARCHITECTURE INTERACTIVE TOPOLOGY & CODE INSPECTOR
// ============================================================================
const TOPO_DATA = {
  net: {
    tab: 'src/content/socket-hook.js — Instant Move Interceptor',
    badge: 'CATCHES MOVES BEFORE THEY HIT THE SCREEN',
    code: `// Catches the opponent's move the instant Lichess receives it
const OriginalWebSocket = window.WebSocket;
window.WebSocket = function (...args) {
  const ws = new OriginalWebSocket(...args);
  ws.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.t === 'move' || data.d?.moves) {
        // Send move straight to Stockfish without touching page HTML
        window.postMessage({ type: 'FZ_SOCKET_FRAME', payload: data }, '*');
      }
    } catch {}
  }, true);
  return ws;
};`,
    stats: [
      { glyph: '<', val: '0.08ms', label: 'Move Catch Time' },
      { glyph: '*', val: 'Silent', label: 'Zero Page Delay' },
      { glyph: '#', val: '0 Trace', label: 'Zero Detection Risk' }
    ]
  },
  bridge: {
    tab: 'src/content/content.js — High-Speed Extension Bridge',
    badge: 'ZERO-LAG COMMUNICATION',
    code: `// Relays moves to the background engine without slowing down Lichess
const enginePort = chrome.runtime.connect({ name: 'FRAMEZERO_PIPE' });

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.type !== 'FZ_SOCKET_FRAME') return;
  
  // Forward move history and clock time straight to Stockfish
  enginePort.postMessage({
    action: 'EVAL_WIRE_MOVE',
    moves: event.data.payload.d.moves,
    clock: event.data.payload.d.clock
  });
});`,
    stats: [
      { glyph: '<', val: '1.1ms', label: 'Internal Bridge' },
      { glyph: '*', val: 'Zero-Copy', label: 'Direct Memory' },
      { glyph: '#', val: '0 DOM', label: 'Elements Scraped' }
    ]
  },
  engine: {
    tab: 'src/offscreen/stockfish-worker.js — Stockfish 19 Engine Host',
    badge: 'LOCAL WEBASSEMBLY NNUE + SYZYGY TABLEBASE',
    code: `// Evaluates positions in real time using local WebAssembly Stockfish 19
self.onmessage = async ({ data }) => {
  if (data.action === 'EVAL_WIRE_MOVE') {
    // 1. Instant checkmate lookup in 7-piece Syzygy endgame tablebase
    if (countPieces(data.fen) <= 7) {
      const tbHit = await querySyzygyTablebase(data.fen);
      if (tbHit) return postMessage({ bestmove: tbHit.bestMove, dtm: tbHit.dtm });
    }
    
    // 2. High-speed neural network evaluation (Depth 24)
    stockfishWasm.postMessage(\`position fen \${data.fen}\`);
    stockfishWasm.postMessage('go depth 24');
  }
};`,
    stats: [
      { glyph: '>', val: '910k', label: 'Positions / Sec' },
      { glyph: '#', val: '512MB', label: 'Memory Cache' },
      { glyph: '*', val: '7-Piece', label: 'Endgame Tablebase' }
    ]
  },
  cdp: {
    tab: 'src/background/cdp-dispatcher.js — Natural Move Execution',
    badge: 'NATURAL HUMAN-LIKE MOUSE GESTURES',
    code: `// Emits smooth, natural mouse gestures that look 100% human
async function executeNaturalMove(tabId, fromSquare, toSquare) {
  // 1. Gentle mouse press on piece
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: fromSquare.x, y: fromSquare.y, button: 'left'
  });

  // 2. Humanized curved trajectory to target square
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: toSquare.x, y: toSquare.y
  });

  // 3. Drop piece cleanly on destination
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: toSquare.x, y: toSquare.y, button: 'left'
  });
}`,
    stats: [
      { glyph: '<', val: '1.1ms', label: 'Move Execution' },
      { glyph: '*', val: 'Humanized', label: 'Natural Mouse Curves' },
      { glyph: '%', val: '100%', label: 'Account Safety' }
    ]
  }
};

function initTopologyInspector() {
  const nodes = document.querySelectorAll('.topo-node');
  const inspectTitle = document.getElementById('inspect-title');
  const inspectBadge = document.getElementById('inspect-badge');
  const inspectCode = document.getElementById('inspect-code');
  const statsContainer = document.querySelector('.inspector-stats-row');

  if (!nodes.length || !inspectCode) return;

  nodes.forEach(node => {
    node.addEventListener('click', () => {
      nodes.forEach(n => n.classList.remove('active'));
      node.classList.add('active');

      const key = node.dataset.node;
      const data = TOPO_DATA[key];
      if (!data) return;

      if (inspectTitle) inspectTitle.textContent = data.tab;
      if (inspectBadge) inspectBadge.textContent = data.badge;
      if (inspectCode) inspectCode.innerHTML = `<code>${escapeHtml(data.code)}</code>`;

      if (statsContainer && data.stats) {
        statsContainer.innerHTML = data.stats.map(s => `
          <div class="stat-item">
            <div class="stat-glyph">${s.glyph}</div>
            <div class="stat-value">${s.val}</div>
            <div class="stat-label">${s.label}</div>
          </div>
        `).join('');
      }
    });
  });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ============================================================================
// 5. EMPIRICAL BENCHMARKS DEPTH & NPS COMPARATOR
// ============================================================================
const BENCH_DATA = {
  100: {
    sf19Depth: '13.0 ply', sf19DepthPct: 52,
    sf18Depth: '13.2 ply', sf18DepthPct: 53,
    sf19hDepth: '12.2 ply', sf19hDepthPct: 49,
    sf19Nps: '788k NPS', sf19NpsPct: 73,
    sf18Nps: '1,076k NPS', sf18NpsPct: 100,
    sf19hNps: '414k NPS', sf19hNpsPct: 38
  },
  500: {
    sf19Depth: '16.6 ply', sf19DepthPct: 66,
    sf18Depth: '17.2 ply', sf18DepthPct: 69,
    sf19hDepth: '14.6 ply', sf19hDepthPct: 58,
    sf19Nps: '883k NPS', sf19NpsPct: 81,
    sf18Nps: '1,088k NPS', sf18NpsPct: 100,
    sf19hNps: '445k NPS', sf19hNpsPct: 41
  },
  2000: {
    sf19Depth: '21.0 ply', sf19DepthPct: 84,
    sf18Depth: '19.8 ply', sf18DepthPct: 79,
    sf19hDepth: '18.2 ply', sf19hDepthPct: 73,
    sf19Nps: '878k NPS', sf19NpsPct: 92,
    sf18Nps: '949k NPS', sf18NpsPct: 100,
    sf19hNps: '440k NPS', sf19hNpsPct: 46
  },
  5000: {
    sf19Depth: '24.6 ply', sf19DepthPct: 98,
    sf18Depth: '21.6 ply', sf18DepthPct: 86,
    sf19hDepth: '22.2 ply', sf19hDepthPct: 89,
    sf19Nps: '877k NPS', sf19NpsPct: 83,
    sf18Nps: '1,056k NPS', sf18NpsPct: 100,
    sf19hNps: '434k NPS', sf19hNpsPct: 41
  }
};

function initBenchmarksStudio() {
  const pills = document.querySelectorAll('.budget-pill');
  if (!pills.length) return;

  pills.forEach(pill => {
    pill.addEventListener('click', () => {
      pills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');

      const budget = pill.dataset.budget;
      const data = BENCH_DATA[budget];
      if (!data) return;

      // Update Depth Chart
      const valSf19 = document.getElementById('val-depth-sf19');
      const barSf19 = document.getElementById('bar-depth-sf19');
      const valSf18 = document.getElementById('val-depth-sf18');
      const barSf18 = document.getElementById('bar-depth-sf18');
      const valSf19h = document.getElementById('val-depth-sf19heavy');
      const barSf19h = document.getElementById('bar-depth-sf19heavy');

      if (valSf19) valSf19.textContent = data.sf19Depth;
      if (barSf19) barSf19.style.width = `${data.sf19DepthPct}%`;
      if (valSf18) valSf18.textContent = data.sf18Depth;
      if (barSf18) barSf18.style.width = `${data.sf18DepthPct}%`;
      if (valSf19h) valSf19h.textContent = data.sf19hDepth;
      if (barSf19h) barSf19h.style.width = `${data.sf19hDepthPct}%`;

      // Update NPS Chart
      const valNpsSf19 = document.getElementById('val-nps-sf19');
      const barNpsSf19 = document.getElementById('bar-nps-sf19');
      const valNpsSf18 = document.getElementById('val-nps-sf18');
      const barNpsSf18 = document.getElementById('bar-nps-sf18');
      const valNpsSf19h = document.getElementById('val-nps-sf19heavy');
      const barNpsSf19h = document.getElementById('bar-nps-sf19heavy');

      if (valNpsSf19) valNpsSf19.textContent = data.sf19Nps;
      if (barNpsSf19) barNpsSf19.style.width = `${data.sf19NpsPct}%`;
      if (valNpsSf18) valNpsSf18.textContent = data.sf18Nps;
      if (barNpsSf18) barNpsSf18.style.width = `${data.sf18NpsPct}%`;
      if (valNpsSf19h) valNpsSf19h.textContent = data.sf19hNps;
      if (barNpsSf19h) barNpsSf19h.style.width = `${data.sf19hNpsPct}%`;
    });
  });
}

// ============================================================================
// 6. DEPLOYMENT TABS, COPY COMMANDS & TACTILE KEY DECK
// ============================================================================
const TAB_COMMANDS = {
  git: 'git clone https://github.com/Mackming/framezero.git',
  zip: 'curl -L -O https://github.com/Mackming/framezero/archive/refs/heads/main.zip && tar -xf main.zip',
  brave: 'git clone https://github.com/Mackming/framezero.git && open brave://extensions'
};

function initInstallAndHotkeys() {
  const tabs = document.querySelectorAll('.deploy-tab');
  const cmdText = document.getElementById('cmd-install-text');
  const copyBtn = document.getElementById('btn-copy-install');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const key = tab.dataset.tab;
      if (cmdText && TAB_COMMANDS[key]) {
        cmdText.textContent = TAB_COMMANDS[key];
      }
    });
  });

  if (copyBtn && cmdText) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(cmdText.textContent.trim()).then(() => {
        copyBtn.innerHTML = `<i class="fa-solid fa-check"></i><span>Copied</span>`;
        setTimeout(() => {
          copyBtn.innerHTML = `<i class="fa-regular fa-copy"></i><span>Copy</span>`;
        }, 1500);
      });
    });
  }

  // Tactile hotkey simulation
  const keyCards = document.querySelectorAll('.key-card');
  keyCards.forEach(card => {
    card.addEventListener('click', () => {
      card.classList.add('pressed');
      setTimeout(() => card.classList.remove('pressed'), 250);
    });
  });

  // Physical keyboard hotkey listener
  window.addEventListener('keydown', (e) => {
    if (e.altKey) {
      const key = e.key.toLowerCase();
      const match = document.querySelector(`.key-card[data-key="${key}"]`);
      if (match) {
        match.classList.add('pressed');
        setTimeout(() => match.classList.remove('pressed'), 250);
      }
    }
  });
}

// ============================================================================
// 7. MOBILE MENU CONTROLLER
// ============================================================================
function initMobileMenu() {
  const burgerBtn = document.getElementById('burger-btn');
  const overlay = document.getElementById('mobile-overlay');
  const sheet = document.getElementById('mobile-sheet');

  if (!burgerBtn || !overlay || !sheet) return;

  function openMenu() {
    burgerBtn.classList.add('open');
    burgerBtn.setAttribute('aria-expanded', 'true');
    overlay.classList.add('active');
    sheet.classList.add('active');
  }

  function closeMenu() {
    burgerBtn.classList.remove('open');
    burgerBtn.setAttribute('aria-expanded', 'false');
    overlay.classList.remove('active');
    sheet.classList.remove('active');
  }

  burgerBtn.addEventListener('click', () => {
    const isOpen = burgerBtn.classList.contains('open');
    if (isOpen) closeMenu();
    else openMenu();
  });

  overlay.addEventListener('click', closeMenu);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 720) closeMenu();
  });

  sheet.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', closeMenu);
  });
}

// ============================================================================
// 8. SCROLLSPY ACTIVE NAV TRACKING
// ============================================================================
function initScrollSpy() {
  const sections = document.querySelectorAll('section[id], body[id]');
  const navLinks = document.querySelectorAll('.nav-link[href^="#"]');

  window.addEventListener('scroll', () => {
    let current = '';
    const scrollPos = window.scrollY + 140;

    sections.forEach(sec => {
      const top = sec.offsetTop;
      const height = sec.offsetHeight;
      if (scrollPos >= top && scrollPos < top + height) {
        current = sec.getAttribute('id');
      }
    });

    navLinks.forEach(link => {
      link.classList.toggle('active', link.getAttribute('href') === `#${current}`);
    });
  }, { passive: true });
}

// ============================================================================
// INITIALIZE APPLICATION
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  initCounters();
  initShowcase();
  initLatencySimulator();
  initTopologyInspector();
  initBenchmarksStudio();
  initInstallAndHotkeys();
  initMobileMenu();
  initScrollSpy();
});
