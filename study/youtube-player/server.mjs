// Minimal static server with HTTP Range support (the progressive fallback and
// the browser's own media stack both issue Range requests). No dependencies.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const PORT = Number(process.env.PORT ?? 8080);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
  '.webm': 'video/webm',
  '.vtt': 'text/vtt; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  let file = join(ROOT, path.endsWith('/') ? path + 'index.html' : path);
  if (!file.startsWith(ROOT)) return void res.writeHead(403).end();

  let stat;
  try {
    stat = statSync(file);
  } catch {
    return void res.writeHead(404).end('not found');
  }
  const headers = {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*', // lets a second local port act as a separate media origin
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    const end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    if (start > end || end >= stat.size) {
      return void res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    return void createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`player study → http://127.0.0.1:${PORT}/`));
