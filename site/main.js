/**
 * FrameZero — Landing Page Logic
 * Exact count-up easing, mobile navigation sheet, and deep-dive drawer.
 */

// --- 1. Stats Counter Animation (easeOutCubic, exact timings) ----------------
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

// --- 2. Mobile Menu Controller (<=720px) ------------------------------------
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
    document.body.classList.add('menu-open');
  }

  function closeMenu() {
    burgerBtn.classList.remove('open');
    burgerBtn.setAttribute('aria-expanded', 'false');
    overlay.classList.remove('active');
    sheet.classList.remove('active');
    document.body.classList.remove('menu-open');
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

  sheet.querySelectorAll('a, button').forEach(item => {
    item.addEventListener('click', closeMenu);
  });
}

// --- 3. Technical Deep-Dive Drawer ------------------------------------------
const DRAWER_DATA = {
  architecture: {
    title: 'Systems Architecture',
    body: `
      <div class="drawer-card">
        <h4>01 / MAIN-World WebSocket Sniffer</h4>
        <p>Injected at <code>document_start</code> before Lichess scripts initialize. Wraps native <code>WebSocket</code> to sniff round frames in capture phase without mutating data or sending frames.</p>
        <div class="drawer-code">Latency overhead: &lt; 0.1 ms (direct frame capture)</div>
      </div>
      <div class="drawer-card">
        <h4>02 / Persistent Offscreen Host</h4>
        <p>Chrome MV3 service workers terminate every 30 seconds. FrameZero hosts Stockfish inside a persistent Offscreen document, preserving a 512 MB transposition table across matches.</p>
      </div>
      <div class="drawer-card">
        <h4>03 / Chrome DevTools Protocol (CDP)</h4>
        <p>Dispatches native pointer events through <code>chrome.debugger</code>. Injected at the browser compositor level with <code>isTrusted: true</code>, bypassing synthetic DOM input blockers.</p>
      </div>
      <div class="drawer-card">
        <h4>04 / Syzygy 7-Piece Tablebases</h4>
        <p>Inside 7 pieces, chess is mathematically solved. FrameZero skips heuristic search and queries Syzygy tablebases for provably optimal conversion using Distance to Mate (DTM).</p>
      </div>
    `
  },
  benchmarks: {
    title: 'Engine Benchmarks',
    body: `
      <p>Measured across 5 tactical benchmark positions on a 2-thread WebAssembly budget:</p>
      <div class="drawer-card">
        <h4>Stockfish 19 (1MB Net) vs Stockfish 18 Lite (5MB Net)</h4>
        <p><strong>100 ms:</strong> SF19: 13.0 ply (788k nps) &bull; SF18: 13.2 ply (1076k nps)</p>
        <p><strong>500 ms:</strong> SF19: 16.6 ply (883k nps) &bull; SF18: 17.2 ply (1088k nps)</p>
        <p><strong>2000 ms:</strong> SF19: <strong>21.0 ply</strong> (878k nps) &bull; SF18: 19.8 ply (949k nps)</p>
        <p><strong>5000 ms:</strong> SF19: <strong>24.6 ply</strong> (877k nps) &bull; SF18: 21.6 ply (1056k nps)</p>
        <div class="drawer-code">Result: SF19 reaches +3.0 plies deeper at 5s</div>
      </div>
      <div class="drawer-card">
        <h4>Why the 1.1MB Net Outperforms the 94MB Net</h4>
        <p>The 1.1MB size-optimized net fits entirely inside modern L3 CPU cache. The 94MB net experiences massive cache-miss thrashing in WebAssembly's 128-bit SIMD environment, losing 50% nodes/sec.</p>
      </div>
    `
  },
  install: {
    title: 'Installation & Quickstart',
    body: `
      <div class="drawer-card">
        <h4>Step 1: Clone the Repository</h4>
        <div class="drawer-code">git clone https://github.com/Mackming/framezero.git</div>
      </div>
      <div class="drawer-card">
        <h4>Step 2: Load in Chrome</h4>
        <p>Open <code>chrome://extensions</code>, toggle <strong>Developer mode</strong> in the top right, and click <strong>Load unpacked</strong>.</p>
        <p>Select the root <code>framezero</code> folder.</p>
      </div>
      <div class="drawer-card">
        <h4>Step 3: Play on Lichess</h4>
        <p>Navigate to <a href="https://lichess.org/analysis" target="_blank" style="color:#3fd6a3">lichess.org/analysis</a> or any live game. The FrameZero HUD will mount automatically in the top-right corner. Press <strong>Alt + B</strong> to toggle.</p>
      </div>
    `
  }
};

function initDrawer() {
  const backdrop = document.getElementById('drawer-backdrop');
  const panel = document.getElementById('drawer-panel');
  const closeBtn = document.getElementById('drawer-close');
  const titleEl = document.getElementById('drawer-title');
  const bodyEl = document.getElementById('drawer-body');

  if (!backdrop || !panel || !closeBtn) return;

  function openDrawer(key) {
    const data = DRAWER_DATA[key];
    if (!data) return;

    titleEl.textContent = data.title;
    bodyEl.innerHTML = data.body;

    backdrop.classList.add('active');
    panel.classList.add('active');
  }

  function closeDrawer() {
    backdrop.classList.remove('active');
    panel.classList.remove('active');
  }

  document.querySelectorAll('[data-drawer]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openDrawer(btn.dataset.drawer);
    });
  });

  closeBtn.addEventListener('click', closeDrawer);
  backdrop.addEventListener('click', closeDrawer);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });
}

// --- 4. Initialize on DOM Ready ---------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initCounters();
  initMobileMenu();
  initDrawer();
});
