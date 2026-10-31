/**
 * FrameZero — Main Web Controller
 * Handles stats count-up, interactive chessboard simulation,
 * SVG vector overlay, live HUD telemetry, and mobile navigation.
 */

// --- 1. Stats Counter Animation (easeOutCubic) -------------------------------
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function animateValue(el, target, suffix, decimals, duration, delay) {
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
  const statValues = document.querySelectorAll('.stat-value');

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        statValues.forEach((el, i) => {
          const target = parseFloat(el.dataset.target);
          const suffix = el.dataset.suffix || '';
          const decimals = parseInt(el.dataset.decimals || '0', 10);
          const duration = 1500 + i * 80;
          const delay = 480 + i * 90;

          animateValue(el, target, suffix, decimals, duration, delay);
        });
        observer.disconnect();
      }
    });
  }, { threshold: 0.25 });

  const footer = document.querySelector('.stats-footer');
  if (footer) observer.observe(footer);
}

// --- 2. Interactive Chessboard & SVG Overlay ---------------------------------
const PIECES = {
  K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟'
};

const DEMO_POSITIONS = [
  {
    name: 'Scholar Tactical Strike',
    fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w - - 0 1',
    bestMove: { from: 'f3', to: 'f7' },
    eval: '#M1',
    evalPercent: 98,
    depth: '24 ply · 910k',
    styles: {
      best: { move: { from: 'f3', to: 'f7' }, eval: '#M1', reason: 'Direct checkmate (Qxf7#)' },
      aggro: { move: { from: 'c4', to: 'f7' }, eval: '+4.80', reason: 'Sacrifice check on f7' },
      trap: { move: { from: 'g1', to: 'e2' }, eval: '+1.65', reason: 'Baits 1...Nd4 blunder' },
      greedy: { move: { from: 'f3', to: 'f7' }, eval: '#M1', reason: 'Free queen strike' },
      chaos: { move: { from: 'd2', to: 'd3' }, eval: '+1.40', reason: 'Quiet solid development' },
      drawish: { move: { from: 'f3', to: 'e2' }, eval: '+0.10', reason: 'Trades queen, flattens eval' }
    }
  },
  {
    name: 'Sicilian Dragon Tactical Clash',
    fen: 'r1bq1rk1/pp2ppbp/2np1np1/8/3NP3/2N1BP2/PPP3PP/2KR1B1R w - - 0 10',
    bestMove: { from: 'g2', to: 'g4' },
    eval: '+1.24',
    evalPercent: 62,
    depth: '22 ply · 885k',
    styles: {
      best: { move: { from: 'g2', to: 'g4' }, eval: '+1.24', reason: 'Yugoslav pawn storm' },
      aggro: { move: { from: 'h2', to: 'h4' }, eval: '+0.95', reason: 'Sharp Kingside thrust' },
      trap: { move: { from: 'd4', to: 'b3' }, eval: '+0.88', reason: 'Baits exchange on c3' },
      greedy: { move: { from: 'd4', to: 'c6' }, eval: '+0.72', reason: 'Captures knight, disrupts pawns' },
      chaos: { move: { from: 'f1', to: 'e2' }, eval: '+0.60', reason: 'Flexible bishop placement' },
      drawish: { move: { from: 'c1', to: 'b1' }, eval: '+0.30', reason: 'Prophylactic king step' }
    }
  }
];

let currentPosIndex = 0;
let currentStyle = 'best';
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

function squareToCoords(sq) {
  const file = sq[0];
  const rank = parseInt(sq[1], 10);
  const col = FILES.indexOf(file);
  const row = 8 - rank;
  return { col, row, x: col + 0.5, y: row + 0.5 };
}

function renderBoard(fen) {
  const boardEl = document.getElementById('chessboard');
  if (!boardEl) return;
  boardEl.innerHTML = '';

  const placement = fen.split(' ')[0];
  const rows = placement.split('/');

  for (let r = 0; r < 8; r++) {
    const rowStr = rows[r];
    let c = 0;
    for (const char of rowStr) {
      if (/\d/.test(char)) {
        const count = parseInt(char, 10);
        for (let i = 0; i < count; i++) {
          createSquare(boardEl, c, r, null);
          c++;
        }
      } else {
        createSquare(boardEl, c, r, char);
        c++;
      }
    }
  }
}

function createSquare(parent, col, row, pieceChar) {
  const sq = document.createElement('div');
  const isLight = (col + row) % 2 === 0;
  sq.className = `sq ${isLight ? 'light' : 'dark'}`;
  sq.dataset.square = `${FILES[col]}${8 - row}`;

  if (pieceChar) {
    const isWhite = pieceChar === pieceChar.toUpperCase();
    const span = document.createElement('span');
    span.className = `piece ${isWhite ? 'white' : 'black'}`;
    span.textContent = PIECES[pieceChar] || '';
    sq.appendChild(span);
  }

  parent.appendChild(sq);
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

  const sourceColor = '#3fd6a3';
  const targetColor = '#f87171';
  const arrowColor = '#3fd6a3';

  // 1. Source circle
  const circleFrom = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circleFrom.setAttribute('cx', from.x);
  circleFrom.setAttribute('cy', from.y);
  circleFrom.setAttribute('r', '0.36');
  circleFrom.setAttribute('fill', 'none');
  circleFrom.setAttribute('stroke', sourceColor);
  circleFrom.setAttribute('stroke-width', '0.08');
  svg.appendChild(circleFrom);

  // 2. Target circle
  const circleTo = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circleTo.setAttribute('cx', to.x);
  circleTo.setAttribute('cy', to.y);
  circleTo.setAttribute('r', '0.36');
  circleTo.setAttribute('fill', 'none');
  circleTo.setAttribute('stroke', targetColor);
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

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1);
    line.setAttribute('y1', y1);
    line.setAttribute('x2', x2);
    line.setAttribute('y2', y2);
    line.setAttribute('stroke', arrowColor);
    line.setAttribute('stroke-width', '0.09');
    line.setAttribute('stroke-linecap', 'round');
    svg.appendChild(line);
  }

  // 4. Arrowhead triangle
  const tipX = to.x - nx * 0.22;
  const tipY = to.y - ny * 0.22;
  const headLen = 0.30;
  const headWidth = 0.22;

  const perpX = -ny;
  const perpY = nx;

  const leftX = tipX - nx * headLen + perpX * headWidth;
  const leftY = tipY - ny * headLen + perpY * headWidth;
  const rightX = tipX - nx * headLen - perpX * headWidth;
  const rightY = tipY - ny * headLen - perpY * headWidth;

  const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  polygon.setAttribute('points', `${tipX},${tipY} ${leftX},${leftY} ${rightX},${rightY}`);
  polygon.setAttribute('fill', arrowColor);
  svg.appendChild(polygon);
}

function updateHUD(move, evalScore, evalPercent, reason) {
  const evalEl = document.getElementById('hud-eval');
  const fillEl = document.getElementById('hud-eval-fill');
  const overheadEl = document.getElementById('hud-overhead');
  const consoleEl = document.getElementById('hud-console');

  if (evalEl) evalEl.textContent = evalScore;
  if (fillEl) fillEl.style.width = `${evalPercent}%`;

  const overhead = (2.8 + Math.random() * 1.4).toFixed(1);
  if (overheadEl) overheadEl.textContent = `${overhead} ms`;

  if (consoleEl) {
    const timeStr = new Date().toTimeString().split(' ')[0];
    consoleEl.innerHTML = `
      <div>[${timeStr}] <span class="ok">socket</span> frame intercepted (0.1ms)</div>
      <div>[${timeStr}] bestmove <span class="info">${move.from}${move.to}</span> &bull; ${reason || 'SF19 top pick'}</div>
      <div>[${timeStr}] <span class="ok">CDP</span> native drag executed (${overhead}ms total)</div>
    `;
  }
}

function setStyle(styleId) {
  currentStyle = styleId;
  const pos = DEMO_POSITIONS[currentPosIndex];
  const choice = pos.styles[styleId] || pos.styles.best;

  document.querySelectorAll('.style-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.style === styleId);
  });

  drawVector(choice.move.from, choice.move.to);
  updateHUD(choice.move, choice.eval, pos.evalPercent, choice.reason);
}

function initShowcase() {
  const pos = DEMO_POSITIONS[currentPosIndex];
  renderBoard(pos.fen);
  setStyle('best');

  document.querySelectorAll('.style-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      setStyle(e.target.dataset.style);
    });
  });

  const playBtn = document.getElementById('btn-play-move');
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      const overheadEl = document.getElementById('hud-overhead');
      if (overheadEl) {
        overheadEl.style.color = '#ffffff';
        setTimeout(() => {
          overheadEl.style.color = 'var(--accent)';
          setStyle(currentStyle);
        }, 200);
      }
    });
  }

  const resetBtn = document.getElementById('btn-reset-board');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      currentPosIndex = (currentPosIndex + 1) % DEMO_POSITIONS.length;
      const newPos = DEMO_POSITIONS[currentPosIndex];
      renderBoard(newPos.fen);
      const depthEl = document.getElementById('hud-depth');
      if (depthEl) depthEl.textContent = newPos.depth;
      setStyle('best');
    });
  }
}

// --- 3. Mobile Menu Controller -----------------------------------------------
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

// --- 4. Active Nav Tracking on Scroll ----------------------------------------
function initScrollSpy() {
  const sections = document.querySelectorAll('section[id], body[id]');
  const navLinks = document.querySelectorAll('.nav-link[href^="#"]');

  window.addEventListener('scroll', () => {
    let current = '';
    const scrollPos = window.scrollY + 120;

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

// --- Initialize All ----------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initCounters();
  initShowcase();
  initMobileMenu();
  initScrollSpy();
});
