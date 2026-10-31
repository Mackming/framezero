/**
 * End-to-end: rendered Lichess board -> extractFen -> chess.js -> Stockfish.
 *
 * The engine is driven through its Web Worker branch (the same branch Chrome
 * takes) inside a vm sandbox, so this exercises the real pipeline without Chrome.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { Chess } from '../lib/chess.js';
import { extractFen } from '../lib/fen-sources.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SQUARE = 64, BOARD = SQUARE * 8;
const ROLES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

// --- 1. render a position as chessground would ------------------------------
const PLACEMENT = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR';
const pieces = [];
PLACEMENT.split('/').forEach((row, rowFromTop) => {
  let file = 0;
  for (const ch of row) {
    if (/\d/.test(ch)) { file += Number(ch); continue; }
    pieces.push(`<piece class="${ch === ch.toUpperCase() ? 'white' : 'black'} ${ROLES[ch.toLowerCase()]}" ` +
      `style="transform: translate(${file * SQUARE}px, ${rowFromTop * SQUARE}px);"></piece>`);
    file++;
  }
});
const dom = new JSDOM(`<!doctype html><body><div class="cg-wrap orientation-white">
  <cg-container><cg-board>${pieces.join('')}</cg-board></cg-container></div></body>`);
dom.window.Element.prototype.getBoundingClientRect = function () {
  if (this.tagName.toLowerCase() === 'cg-board') return { left: 0, top: 0, width: BOARD, height: BOARD, right: BOARD, bottom: BOARD };
  const m = /translate\(\s*(-?[\d.]+)px[ ,]+(-?[\d.]+)px/.exec(this.getAttribute('style') ?? '');
  if (!m) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  return { left: +m[1], top: +m[2], width: SQUARE, height: SQUARE, right: +m[1] + SQUARE, bottom: +m[2] + SQUARE };
};

// --- 2. extract and load into the board -------------------------------------
const hit = extractFen(dom.window.document);
console.log('extracted   :', hit.fen, `(source: ${hit.source})`);

const board = new Chess();
board.load(hit.fen);
const fen = board.fen();                       // == getCurrentFEN()
console.log('getCurrentFEN:', fen);
if (fen.split(' ')[0] !== PLACEMENT) { console.error('FAIL placement round trip'); process.exit(1); }

// --- 3. feed it to Stockfish through the worker code path -------------------
const out = [];
const handlers = { onmessage: null };
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  TextDecoder, TextEncoder, URL, URLSearchParams, performance, crypto,
  WebAssembly, Response, Headers, Request, Date, Math, JSON, Promise, Error,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  location: { origin: ORIGIN, pathname: '/engine/stockfish-18-lite-single.js', href: `${ORIGIN}/engine/stockfish-18-lite-single.js`, hash: '', protocol: 'chrome-extension:' },
  onmessage: null,
  postMessage: (line) => out.push(String(line)),
  close: () => {},
  fetch: async () => new Response(fs.readFileSync(path.join(ROOT, 'engine/stockfish-18-lite-single.wasm')), { headers: { 'content-type': 'application/wasm' } })
};
sandbox.self = sandbox; sandbox.globalThis = sandbox;
Object.defineProperty(sandbox, 'onmessage', { get: () => handlers.onmessage, set: (fn) => { handlers.onmessage = fn; }, configurable: true, enumerable: true });
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'engine/stockfish-18-lite-single.js'), 'utf8'), sandbox);

const send = (cmd) => handlers.onmessage({ data: cmd });
let cursor = 0, stage = 'boot';
send('uci');
const pump = setInterval(() => {
  while (cursor < out.length) {
    const line = out[cursor++];
    if (stage === 'boot' && line.startsWith('uciok')) { stage = 'ready'; send('isready'); }
    else if (stage === 'ready' && line.startsWith('readyok')) {
      stage = 'search'; send('stop'); send(`position fen ${fen}`); send('go depth 10');
    } else if (line.startsWith('bestmove')) {
      clearInterval(pump);
      const move = line.split(/\s+/)[1];
      console.log('engine       :', line.trim());
      const legal = board.moves({ verbose: true }).some((m) => m.from + m.to === move.slice(0, 4));
      console.log(legal ? 'PASS  engine move is legal in the extracted position' : 'FAIL  illegal move');
      process.exit(legal ? 0 : 1);
    }
  }
}, 20);
setTimeout(() => { console.error('TIMEOUT at ' + stage); process.exit(1); }, 90_000);
