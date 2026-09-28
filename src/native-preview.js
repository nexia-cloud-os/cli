import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, stat, lstat } from 'node:fs/promises';
import path from 'node:path';
import { resolvePublicFile } from './project.js';
import { validateEndpoint } from './connection.js';

const types = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2' };

// Serves only the developer's compiled frontend. Never executes a build or project script.
export async function startNativePreview(directory, { workspaceOrigin, state, port = 4310, container = false, apps = null }) {
  workspaceOrigin = validateEndpoint(workspaceOrigin);
  const token = randomBytes(32).toString('hex');
  const registrations = apps ?? new Map([[token, { directory, state }]]);
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, origin);
    const manifest = url.pathname === '/__nexia_native';
    const allowedOrigin = manifest ? workspaceOrigin : 'null';
    if (req.headers.origin !== allowedOrigin) { res.writeHead(403).end(); return; }
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method'] === 'GET' && !req.headers['access-control-request-headers']) {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Private-Network': 'true' }).end(); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
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
    const root = path.join(path.resolve(directory), 'dist', 'frontend');
    const current = manifest ? app.state() : null;
    if (manifest && current?.mode === 'off') { res.writeHead(423).end(); return; }
    try {
      for (const directory of [path.resolve(root, '../..'), path.dirname(root), root]) {
        if ((await lstat(directory)).isSymbolicLink()) throw new Error('Linked frontend directories are not public.');
      }
      if (manifest) {
        if (!current) { res.writeHead(409).end(); return; }
        const file = await resolvePublicFile(root, 'index.js');
        const info = await stat(file);
        const langRoot = path.join(path.resolve(directory), 'resources', 'lang');
        const translations = {};
        for (const locale of ['en', 'ko', 'zh']) {
          try {
            if ((await lstat(path.dirname(langRoot))).isSymbolicLink()) throw new Error('Linked resources are not public.');
            const langFile = await resolvePublicFile(langRoot, `${locale}.json`);
            if ((await stat(langFile)).size > 1024 * 1024) throw new Error('Translation catalog is too large.');
            translations[locale] = JSON.parse(await readFile(langFile, 'utf8'));
          } catch (error) { if (error.code === 'ENOENT') translations[locale] = {}; else throw error; }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ schema_version: 'native-1', ...current,
          translations, entry: `${origin}/${assetToken}/index.js`, frontend_revision: `${info.size}:${info.mtimeMs}:${info.ctimeMs}` }));
        return;
      }
      const prefix = `/${assetToken}/`;
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
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, container ? '0.0.0.0' : '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return {
    attach(directory, state) {
      const key = randomBytes(32).toString('hex');
      registrations.set(key, { directory, state });
      return { url: `http://127.0.0.1:${server.address().port}`, close: async () => { registrations.delete(key); } };
    },
    url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
