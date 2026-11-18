// A development proxy: the app from a running server, with the browser bundles of THIS checkout.
//
// The server embeds its bundles when it is compiled (src/pages.rs include_str!), so a browser test of a change
// to server/web would need a server build.  This proxy stands in front of an already built server and answers
// the bundle requests itself, from server/static on disk; everything else (pages, the API, the collaboration
// socket) goes through untouched.  Build the bundles (`npm run build`, or just the ones you changed), start the
// proxy, and point the browser or a *-ui.mjs script at it.
//
//   PORT=8104 UPSTREAM=http://127.0.0.1:18104 node scripts/cad-static-proxy.mjs
//
// The server should be started with PUBLIC_URL set to the proxy's address.  Not for production: no TLS, no
// caching, one process.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static');
const PORT = Number(process.env.PORT || 8104);
const upstream = new URL(process.env.UPSTREAM || 'http://127.0.0.1:18104');
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml' };

/** The file on disk a request for a bundle is answered from, or null when the request goes to the server. */
function local(url) {
  const p = decodeURIComponent(url.split('?')[0]);
  if (!p.startsWith('/static/') || p.startsWith('/static/pyodide/') || p.includes('..')) return null;
  if (!(path.extname(p) in TYPES) || p === '/static/theme.css') return null;
  const file = path.join(root, p.slice('/static/'.length));
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

const server = http.createServer((req, res) => {
  const file = local(req.url || '/');
  if (file && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)], 'cache-control': 'no-store' });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
    return;
  }
  const out = http.request({ host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: req.headers }, (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); });
  out.on('error', (e) => { res.writeHead(502); res.end(String(e.message)); });
  req.pipe(out);
});

// the collaboration socket: hand the upgrade to the server and join the two streams
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(Number(upstream.port), upstream.hostname, () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    socket.pipe(up); up.pipe(socket);
  });
  const end = () => { socket.destroy(); up.destroy(); };
  up.on('error', end); socket.on('error', end); up.on('close', end); socket.on('close', end);
});

server.listen(PORT, '127.0.0.1', () => console.log(`bundles from ${root}, the rest from ${upstream.origin}: http://127.0.0.1:${PORT}`));
