import { receiveBrowserLogs } from './dev-log.js';
import { createServer, request as httpRequest } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat, lstat } from 'node:fs/promises';
import path from 'node:path';
import { resolvePublicFile } from './project.js';
import { validateEndpoint } from './connection.js';

const types = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const hmrPeers = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@tanstack/react-query', 'react-router-dom', 'react-i18next', '@nexia/sdk', '@nexia/sdk/host'];
function validHmrPath(raw) {
  let value; try { value = decodeURIComponent(raw); } catch { return false; }
  if (/[%\\\x00-\x20]/.test(value) || value.split('/').some(part => part === '.' || part === '..' || (part.startsWith('.') && part !== '.pnpm'))) return false;
  if (/\.(?:php|env|map|sqlite|db|pem|key)$/i.test(value)) return false;
  if (value.startsWith('resources/')) return /\.(?:[cm]?js|jsx|ts|tsx|css|scss|json|svg|png|jpe?g|webp|woff2?)$/i.test(value);
  return /^(?:@vite\/client$|@react-refresh$|@id\/|@fs\/|node_modules\/)/.test(value);
}

// Serves only the developer's compiled frontend. Never executes a build or project script.
export async function startNativePreview(directory, { workspaceOrigin, state, hmr = null, port = 4310, container = false, apps = null, log = console.log, verbose = false, localViteOrigin = null }) {
  workspaceOrigin = validateEndpoint(workspaceOrigin);
  if (localViteOrigin !== null) {
    const local = new URL(workspaceOrigin);
    const vite = new URL(validateEndpoint(localViteOrigin));
    if (local.protocol !== 'http:' || !(local.hostname === 'localhost' || local.hostname.endsWith('.localhost') || local.hostname === '127.0.0.1')
        || vite.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(vite.hostname)) throw new Error('Local HMR requires loopback origins.');
    localViteOrigin = vite.origin;
  }
  const token = randomBytes(32).toString('hex');
  const registrations = apps ?? new Map([[token, { directory, state, hmr, log, verbose }]]);
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, origin);
    const manifest = url.pathname === '/__nexia_native';
    const allowedOrigin = workspaceOrigin;
    if (req.headers.origin !== allowedOrigin) { res.writeHead(403).end(); return; }
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS' && ['GET', 'POST'].includes(req.headers['access-control-request-method']) && !req.headers['access-control-request-headers']) {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Private-Network': 'true' }).end(); return;
    }
    if (req.method === 'POST' && /^\/[a-f0-9]{64}\/__nexia_diagnostics$/.test(url.pathname)) {
      const app = registrations.get(url.pathname.split('/')[1]);
      if (!app?.state() || app.state().mode === 'off') { res.writeHead(404).end(); return; }
      try { await receiveBrowserLogs(req, res, app); } catch { if (!res.headersSent) res.writeHead(400).end(); }
      return;
    }
    if (req.method === 'POST' && /^\/[a-f0-9]{64}\/__nexia_hmr_start$/.test(url.pathname)) {
      const key = url.pathname.split('/')[1], app = registrations.get(key);
      if (!app?.hmr || !app.state()?.operation_id || app.state()?.update_status !== 'ready') { res.writeHead(409).end(); return; }
      const epoch = app.epoch ?? 0;
      try {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 16384) throw new Error('Invalid request.'); }
        const { peers, refreshRuntime } = JSON.parse(body);
        const allowed = value => { const target = new URL(value); return !target.username && !target.password && !target.search && !target.hash
          && ((target.origin === workspaceOrigin && /^\/build\/sandbox-hmr\/assets\/[A-Za-z0-9_.-]+\.js$/.test(target.pathname))
            || (localViteOrigin && target.origin === localViteOrigin && (target.pathname === '/@react-refresh'
              || /^\/resources\/js\/app-sdk\/peers\/[A-Za-z0-9_-]+\.(?:ts|js)$/.test(target.pathname)))); };
        if (!peers || typeof peers !== 'object' || Array.isArray(peers) || Object.keys(peers).length !== hmrPeers.length
          || !hmrPeers.every(name => Object.hasOwn(peers, name) && allowed(peers[name])) || !allowed(refreshRuntime)) throw new Error('Invalid host assets.');
        await app.hmr.start(key, peers, refreshRuntime);
        if (registrations.get(key) !== app || (app.epoch ?? 0) !== epoch || !app.state()?.operation_id || app.state()?.update_status !== 'ready') { await app.hmr.suspend(); res.writeHead(409).end(); return; }
        app.suspended = false;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ entry: `${origin}/${key}/__nexia_vite/resources/js/index.ts` }));
      } catch { res.writeHead(409).end(); }
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    const vitePath = url.pathname.match(/^\/([a-f0-9]{64})\/__nexia_vite\/(.*)$/);
    if (vitePath) {
      const app = registrations.get(vitePath[1]), endpoint = app?.hmr?.endpoint();
      if (!endpoint || app.suspended || !app.state()?.operation_id || !validHmrPath(vitePath[2])) { res.writeHead(404).end(); return; }
      const upstream = httpRequest({ host: '127.0.0.1', port: endpoint.port, method: req.method, path: req.url,
        headers: { host: `127.0.0.1:${endpoint.port}`, 'x-nexia-hmr-gateway': endpoint.gatewayKey } }, response => {
        res.writeHead(response.statusCode, { ...response.headers, 'Access-Control-Allow-Origin': allowedOrigin, 'Cache-Control': 'no-store' }); response.pipe(res);
      });
      res.once('close', () => upstream.destroy());
      upstream.once('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); upstream.end(); return;
    }
    if (manifest && apps && !url.searchParams.has('app_id')) {
      const ready = [...registrations.values()].map(app => app.state()).filter(app => app?.app_id && app.mode !== 'off');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ schema_version: 'project-1', apps: ready.map(app => ({ app_id: app.app_id, app_key: app.app_key })) }));
      return;
    }
    const selected = manifest
      ? [...registrations.entries()].find(([, app]) => !apps || app.state()?.app_id === url.searchParams.get('app_id'))
      : [...registrations.entries()].find(([key]) => url.pathname.startsWith(`/${key}/`));
    if (!selected) { res.writeHead(404).end(); return; }
    const [assetToken, app] = selected;
    const directory = app.directory;
    const current = manifest ? app.state() : null;
    const manifestSnapshot = manifest ? app.hmr?.snapshot?.() : null;
    const assetPath = manifest ? current?.frontend_generation : url.pathname.slice(assetToken.length + 2).split('/')[0];
    const generation = typeof assetPath === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(assetPath) ? assetPath : null;
    const root = path.join(path.resolve(directory), 'dist', generation ? `frontend-generations/${generation}` : 'frontend');
    if (manifest && current?.mode === 'off') { res.writeHead(423).end(); return; }
    if (manifest && ['preparing', 'build_failed', 'runtime_failed'].includes(current?.mode)) {
      const pending = current.mode === 'preparing' && req.headers.accept === 'application/vnd.nexia.native-status+json';
      res.writeHead(pending ? 202 : 409, { 'Content-Type': 'application/json', 'Retry-After': '2' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({
        schema_version: 'native-status-1', status: current.mode, app_id: current.app_id, app_key: current.app_key,
      }));
      return;
    }
    try {
      for (const directory of [path.resolve(app.directory), path.join(path.resolve(app.directory), 'dist'), path.dirname(root), root]) {
        if ((await lstat(directory)).isSymbolicLink()) throw new Error('Linked frontend directories are not public.');
      }
      if (manifest) {
        if (!current) { res.writeHead(409).end(); return; }
        const file = await resolvePublicFile(root, 'index.js');
        const info = await stat(file);
        const langRoot = path.join(path.resolve(directory), 'resources', 'lang');
        const translations = {};
        const snapshot = manifestSnapshot;
        if (app.hmr?.snapshot && !snapshot) { res.writeHead(409).end(); return; }
        for (const locale of ['en', 'ko', 'zh']) {
          try {
            if (snapshot) {
              const file = snapshot.files.find(item => item.path === `resources/lang/${locale}.json`);
              const bytes = file ? Buffer.from(file.content, 'base64') : Buffer.from('{}');
              if (bytes.length > 1024 * 1024) throw new Error('Translation catalog is too large.');
              translations[locale] = JSON.parse(bytes.toString('utf8'));
              continue;
            }
            if ((await lstat(path.dirname(langRoot))).isSymbolicLink()) throw new Error('Linked resources are not public.');
            const langFile = await resolvePublicFile(langRoot, `${locale}.json`);
            if ((await stat(langFile)).size > 1024 * 1024) throw new Error('Translation catalog is too large.');
            translations[locale] = JSON.parse(await readFile(langFile, 'utf8'));
          } catch (error) { if (error.code === 'ENOENT') translations[locale] = {}; else throw error; }
        }
        const body = JSON.stringify({ schema_version: 'native-1', verbose_logs: app.verbose === true, ...current,
          translations, entry: `${origin}/${assetToken}/${generation ? generation + '/' : ''}index.js`, frontend_revision: generation ?? `${info.size}:${info.mtimeMs}:${info.ctimeMs}` });
        const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
        res.setHeader('Cache-Control', 'private, no-cache');
        res.setHeader('ETag', etag);
        if (req.headers['if-none-match'] === etag) { res.writeHead(304).end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      const prefix = `/${assetToken}/${generation ? generation + '/' : ''}`;
      if (!req.url.startsWith(prefix)) { res.writeHead(404).end(); return; }
      const entry = decodeURIComponent(new URL(req.url, origin).pathname.slice(prefix.length));
      const type = types[path.extname(entry)];
      if (!type) { res.writeHead(404).end(); return; }
      const file = await resolvePublicFile(root, entry);
      if ((await stat(file)).size > 8 * 1024 * 1024) { res.writeHead(413).end(); return; }
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': type });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { res.writeHead(404).end(); }
  });
  server.on('upgrade', (req, socket, head) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.host !== new URL(origin).host || req.headers.origin !== workspaceOrigin) return socket.destroy();
    const url = new URL(req.url, origin), match = url.pathname.match(/^\/([a-f0-9]{64})\/__nexia_vite\/@vite\/__nexia_hmr$/);
    const app = match && registrations.get(match[1]), endpoint = app?.hmr?.endpoint();
    if (!endpoint || app.suspended || !app.state()?.operation_id || url.search || req.headers['sec-websocket-protocol'] !== 'vite-hmr') return socket.destroy();
    url.searchParams.set('token', endpoint.wsToken);
    const upstream = httpRequest({ host: '127.0.0.1', port: endpoint.port, path: `${url.pathname}${url.search}`, headers: {
      ...req.headers, host: `127.0.0.1:${endpoint.port}`, 'x-nexia-hmr-gateway': endpoint.gatewayKey,
    } });
    upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      if (socket.destroyed || registrations.get(match[1]) !== app || app.suspended || app.hmr.endpoint() !== endpoint || !app.state()?.operation_id) { upstreamSocket.destroy(); socket.destroy(); return; }
      app.sockets ??= new Set(); app.sockets.add(socket); app.sockets.add(upstreamSocket);
      socket.once('close', () => { app.sockets.delete(socket); upstreamSocket.destroy(); });
      upstreamSocket.once('close', () => { app.sockets.delete(upstreamSocket); socket.destroy(); });
      socket.once('error', () => { socket.destroy(); upstreamSocket.destroy(); });
      upstreamSocket.once('error', () => { socket.destroy(); upstreamSocket.destroy(); });
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${response.rawHeaders.reduce((lines, value, i, all) => i % 2 ? lines : `${lines}${value}: ${all[i + 1]}\r\n`, '')}\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead); if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    socket.once('close', () => upstream.destroy());
    upstream.on('response', () => socket.destroy());
    upstream.on('error', () => socket.destroy()); upstream.end();
  });
  async function suspendHmr(key) {
    const app = registrations.get(key);
    if (app) { app.suspended = true; app.epoch = (app.epoch ?? 0) + 1; }
    for (const socket of app?.sockets ?? []) socket.destroy();
    await app?.hmr?.suspend();
  }
  await new Promise((resolve, reject) => {
    const onError = error => reject(error.code === 'EADDRINUSE'
      ? new Error(`Port ${port} is already in use. If nexia dev is already running, open its workspace link.
Inspect this project: nexia ps
Stop its local development: nexia stop --port ${port}
For older CLI sessions, press Ctrl+C in the terminal running nexia dev, then run nexia dev again.
If you cannot find that terminal, inspect the listening process (macOS/Linux):
  lsof -nP -iTCP:${port} -sTCP:LISTEN
Check COMMAND and PID. Only if it is the process you intend to stop, replace PID below with its number:
  kill -TERM PID
Then run nexia dev again. To keep the existing process, retry with --port <unused-port>.`)
      : error);
    server.once('error', onError);
    server.listen(port, container ? '0.0.0.0' : '127.0.0.1', () => { server.removeListener('error', onError); resolve(); });
  });
  return {
    attach(directory, state, log = console.log, verbose = false, hmr = null) {
      const key = randomBytes(32).toString('hex');
      registrations.set(key, { directory, state, hmr, log, verbose });
      return { url: `http://127.0.0.1:${server.address().port}`, suspendHmr: () => suspendHmr(key), close: async () => { const app = registrations.get(key); if (app) { app.suspended = true; app.epoch = (app.epoch ?? 0) + 1; } for (const socket of app?.sockets ?? []) socket.destroy(); await hmr?.close(); registrations.delete(key); } };
    },
    url: `http://127.0.0.1:${server.address().port}`, suspendHmr: () => suspendHmr(token), close: async () => {
      for (const app of registrations.values()) { app.suspended = true; app.epoch = (app.epoch ?? 0) + 1; for (const socket of app.sockets ?? []) socket.destroy(); }
      await Promise.all([...registrations.values()].map(app => app.hmr?.close()));
      await new Promise(resolve => server.close(resolve));
    } };
}
