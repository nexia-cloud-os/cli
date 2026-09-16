import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { resolvePublicFile, validateProject } from './project.js';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };

export async function startPreview(directory, port = 4310) {
  const manifest = await validateProject(directory);
  const root = path.join(path.resolve(directory), 'public');
  const streams = new Set();
  const server = createServer(async (req, res) => {
    // Reject DNS rebinding and cross-origin reads. The listener is loopback only.
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    if (req.headers.host !== `127.0.0.1:${address.port}` || (req.headers.origin && req.headers.origin !== origin)) {
      res.writeHead(403).end('Open the exact preview URL printed in your terminal.'); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, origin).pathname); }
    catch { res.writeHead(400).end('Invalid URL'); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (pathname === '/__nexia_reload') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      if (req.method === 'HEAD') { res.end(); return; }
      res.write(': local-preview\n\n'); streams.add(res);
      req.on('close', () => streams.delete(res)); return;
    }
    try {
      const screen = manifest.screens.find((item) => item.route === pathname);
      const entry = screen ? screen.entry.slice(7) : pathname.replace(/^\//, '');
      const file = await resolvePublicFile(root, entry);
      let content = await readFile(file);
      const extension = path.extname(file);
      if (extension === '.html') {
        content = Buffer.from(content.toString('utf8') + '<script>new EventSource("/__nexia_reload").onmessage=()=>location.reload()</script>');
      }
      res.writeHead(200, { 'Content-Type': types[extension] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch { res.writeHead(404).end('Asset not found. Keep browser files inside public/.'); }
  });
  let watcher;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  try {
    watcher = watch(root, { recursive: true }, () => {
      for (const stream of streams) stream.write('data: reload\n\n');
    });
    watcher.on('error', () => { for (const stream of streams) stream.end(); streams.clear(); watcher.close(); });
  } catch { /* Preview still works when file watching is unavailable. */ }
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    reload: Boolean(watcher),
    close: async () => {
      watcher?.close();
      for (const stream of streams) stream.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
