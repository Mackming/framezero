import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const safeUrl = decodeURI(req.url.split('?')[0]);
  const relativePath = safeUrl === '/' ? 'index.html' : safeUrl.replace(/^\//, '');
  const filePath = path.join(__dirname, relativePath);

  // Security: prevent directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Access denied');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Server Error');
      }
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const isStaticAsset = ['.svg', '.webp', '.png', '.jpg', '.ico', '.woff', '.woff2', '.ttf'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': isStaticAsset ? 'public, max-age=86400, immutable' : 'no-cache'
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`[FrameZero] Live local server running at http://localhost:${PORT}`);
});
