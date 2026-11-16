import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = path.resolve(process.argv[2]);
const require = createRequire(path.join(directory, 'package.json'));
const vite = await import(pathToFileURL(require.resolve('vite')).href);
const sdk = await import(pathToFileURL(require.resolve('@nexia/sdk/vite')).href);
if (!/^7\.3\./.test(vite.version) || typeof sdk.nexiaHmrPlugins !== 'function') throw new Error('This App SDK or Vite version does not support HMR.');
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'nexia-hmr-')));
let server, approved = new Map(), pending = Promise.resolve(), active = 0, blocked = false, waiters = [], idle = [], gatewayKey;
let closed = false;
const requestContext = new AsyncLocalStorage();
let dependencyRoot;
const report = message => { if (process.connected) process.send(message, () => {}); };
const types = new Map([['.svg','image/svg+xml'],['.png','image/png'],['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.webp','image/webp'],['.woff','font/woff'],['.woff2','font/woff2'],['.json','application/json']]);
function decode(snapshot) {
  const files = new Map();
  for (const file of snapshot.files) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(file.path) || file.path.split('/').some(part => part === '..' || part.startsWith('.'))) throw new Error('Invalid snapshot path.');
    files.set(path.join(root, file.path), Buffer.from(file.content, 'base64'));
  }
  return files;
}
async function materialize(files) {
  for (const [file, bytes] of files) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes, { mode: 0o600 });
  }
}
function sourcePlugin() {
  return {
    name: 'nexia:approved-snapshot', enforce: 'pre',
    load(id) {
      const filename = id.split('?')[0];
      if (!filename.startsWith(root + path.sep) || filename.includes(`${path.sep}node_modules${path.sep}`)) return;
      const bytes = approved.get(filename);
      if (!bytes) throw new Error('Module is not in the approved snapshot.');
      if (/(?:^|[?&])(?:raw|url)(?:[=&]|$)/.test(id)) return;
      if (!/\.(?:[cm]?js|jsx|ts|tsx|css|scss|json)$/.test(filename)) return;
      return bytes.toString('utf8');
    },
    configureServer(viteServer) {
      viteServer.middlewares.use(async (req, res, next) => {
        if (req.headers['x-nexia-hmr-gateway'] !== gatewayKey) return res.writeHead(403).end();
        if (blocked) await new Promise(resolve => waiters.push(resolve));
        active++;
        let completed = false;
        const done = () => { if (completed) return; completed = true; if (--active === 0) for (const resolve of idle.splice(0)) resolve(); };
        res.once('finish', done); res.once('close', done);
        const url = new URL(req.url, 'http://localhost');
        if (!url.pathname.startsWith(viteServer.config.base)) return requestContext.run(true, next);
        const relative = decodeURIComponent(url.pathname.slice(viteServer.config.base.length));
        if (relative.startsWith('resources/') && !/^resources\/(?:js|css|scss|lang)\//.test(relative)) {
          const file = path.resolve(root, relative);
          const module = await viteServer.environments.client.moduleGraph.getModuleByUrl(`/${relative}${url.search}`)
            ?? viteServer.environments.client.moduleGraph.getModuleById(file);
          if (!file.startsWith(root + path.sep) || !approved.has(file) || !module) return res.writeHead(404).end();
        }
        if (relative.startsWith('@fs/') || relative.startsWith('@id/') || relative.startsWith('node_modules/')) {
          const file = relative.startsWith('@fs/') ? await realpath(path.resolve('/', relative.slice(4))).catch(() => null) : null;
          const module = await viteServer.environments.client.moduleGraph.getModuleByUrl(`/${relative}${url.search}`)
            ?? await viteServer.environments.client.moduleGraph.getModuleByUrl(`/${relative}`)
            ?? await viteServer.environments.client.moduleGraph.getModuleByUrl(url.pathname)
            ?? (file ? viteServer.environments.client.moduleGraph.getModuleById(file) : undefined)
            ?? (relative.startsWith('@id/') ? viteServer.environments.client.moduleGraph.getModuleById(relative.slice(4).replace(/^__x00__/, '\0')) : undefined);
          if (!module) return res.writeHead(404).end();
          if (relative.startsWith('@id/') && !/^\0nexia-app-(?:utilities\.css|services:)/.test(module.id ?? '')) return res.writeHead(404).end();
          if (relative.startsWith('node_modules/')) {
            const target = module.id && await realpath(module.id.split('?')[0]).catch(() => null);
            if (!target || !target.startsWith(dependencyRoot + path.sep)) return res.writeHead(404).end();
          }
          if (relative.startsWith('@fs/')) {
            if (!file || !file.startsWith(dependencyRoot + path.sep)) return res.writeHead(404).end();
          }
        }
        const type = types.get(path.extname(relative));
        const moduleQuery = ['import', 'raw', 'url', 'inline', 'no-inline', 'worker', 'sharedworker']
          .some(query => url.searchParams.has(query));
        if (!type || !relative.startsWith('resources/') || moduleQuery) return requestContext.run(true, next);
        const file = path.resolve(root, relative), bytes = approved.get(file);
        if (!file.startsWith(root + path.sep) || !bytes) return res.writeHead(404).end();
        res.setHeader('Content-Type', type); res.end(bytes);
      });
    },
  };
}
async function publish(snapshot) {
  const next = decode(snapshot);
  blocked = true;
  const drained = active;
  let safe = true;
  try {
    if (active) await new Promise(resolve => idle.push(resolve));
    try {
      await materialize(next);
      for (const file of approved.keys()) if (!next.has(file)) await rm(file, { force: true });
    }
    catch (error) {
      try {
        await materialize(approved);
        for (const file of next.keys()) if (!approved.has(file)) await rm(file, { force: true });
      } catch { safe = false; }
      if (!safe) { report({ type: 'error', message: 'Snapshot rollback failed; HMR stopped.' }); await close(); }
      throw error;
    }
    const changed = new Set([...approved.keys(), ...next.keys()].filter(file => !approved.get(file)?.equals(next.get(file) ?? Buffer.alloc(0))));
    const layoutChanged = [...changed].some(file => file.startsWith(path.join(root, 'resources') + path.sep)
      && (approved.has(file) !== next.has(file)));
    approved = next;
    if (server) {
      const graph = server.environments.client.moduleGraph;
      if (layoutChanged) {
        graph.invalidateAll();
        blocked = false; for (const resolve of waiters.splice(0)) resolve();
        server.environments.client.hot.send({ type: 'full-reload', path: '*' });
        return drained;
      }
      const modules = [...changed].flatMap(file => [...(graph.getModulesByFile(file) ?? [])]).filter(mod => mod.id !== null);
      const utilities = graph.getModuleById('\0nexia-app-utilities.css');
      const refreshUtilities = utilities && [...changed].some(file => file.startsWith(path.join(root, 'resources') + path.sep));
      if (refreshUtilities) graph.invalidateModule(utilities);
      for (const mod of modules) graph.invalidateModule(mod);
      blocked = false; for (const resolve of waiters.splice(0)) resolve();
      for (const mod of modules) await server.environments.client.reloadModule(mod);
      if (refreshUtilities) server.environments.client.hot.send('nexia:utilities-update', {
        path: `${server.config.base}@id/__x00__nexia-app-utilities.css`, timestamp: Date.now(),
      });
    }
  } finally { if (safe) { blocked = false; for (const resolve of waiters.splice(0)) resolve(); } }
  return drained;
}
async function start({ snapshot, peers, refreshRuntime, token, id }) {
  if (server || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid HMR start.');
  await publish(snapshot);
  dependencyRoot = await realpath(path.join(directory, 'node_modules'));
  await symlink(path.join(directory, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const baseConfig = sdk.nexiaAppConfig(pathToFileURL(path.join(directory, 'vite.config.mjs')).href, { sourceRoot: root });
  if (baseConfig.root !== root) throw new Error('App SDK does not support approved snapshot roots.');
  class GuardedEnvironment extends vite.DevEnvironment {
    async transformRequest(url) {
      if (blocked && !requestContext.getStore()) await new Promise(resolve => waiters.push(resolve));
      active++;
      try { return await super.transformRequest(url); }
      finally { if (--active === 0) for (const resolve of idle.splice(0)) resolve(); }
    }
  }
  server = await vite.createServer({ ...baseConfig, configFile: false, base: `/${token}/__nexia_vite/`, appType: 'custom',
    plugins: [sourcePlugin(), ...baseConfig.plugins, ...sdk.nexiaHmrPlugins(peers, refreshRuntime)],
    environments: { client: { dev: { preTransformRequests: false, createEnvironment(name, config, { ws }) { return new GuardedEnvironment(name, config, { hot: true, transport: ws }); } } } },
    optimizeDeps: { noDiscovery: true, exclude: sdk.nexiaHostPeers },
    server: { host: '127.0.0.1', port: 0, strictPort: false, cors: false, watch: null,
      hmr: { path: '/@vite/__nexia_hmr' }, fs: { strict: true, allow: [root, path.join(directory, 'node_modules')] },
      warmup: { clientFiles: [] } },
  });
  server.httpServer.prependListener('upgrade', (req, socket) => { if (req.headers['x-nexia-hmr-gateway'] !== gatewayKey) socket.destroy(); });
  await server.listen();
  report({ type: 'ready', id, port: server.httpServer.address().port, wsToken: server.config.webSocketToken });
}
process.on('message', message => {
  pending = pending.then(async () => {
    if (message.type === 'start') { gatewayKey = message.gatewayKey; if (!/^[a-f0-9]{64}$/.test(gatewayKey)) throw new Error('Invalid gateway credential.'); await start(message); }
    else if (message.type === 'publish') { const drained = await publish(message.snapshot); report({ type: 'published', id: message.id, drained }); }
    else if (message.type === 'close') await close();
  }).catch(error => report({ type: 'error', id: message.id, message: String(error?.message ?? error) }));
});
async function close() { if (closed) return; closed = true; await server?.close(); await rm(root, { recursive: true, force: true }); process.exit(0); }
process.on('disconnect', close);
