import path from 'node:path';
import { lstat, readFile, mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readConnection, request, validateEndpoint } from './connection.js';
import { discoverApps, findWorkspace } from './workspace.js';
import { registerApp } from './apps.js';
import { sourceIsChanging } from './source-snapshot.js';
import { nativeDev } from './native-dev.js';
import { startNativePreview } from './native-preview.js';

const exists = file => lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

export async function workspaceDev(workspace, { signal, port = 4310, container = false, app: selector, log = console.log } = {}) {
  const config = await readConnection();
  let connection = await request(config, 'connection');
  if (config.endpoint !== workspace.endpoint || connection.status !== 'connected' || connection.project?.id !== workspace.project_id) {
    throw new Error('Log in to the project linked to this folder before starting dev.');
  }
  if (!connection.capabilities?.personal_sandboxes) throw new Error('This platform must be upgraded to support project development with personal sandboxes.');
  if (!connection.sandbox) {
    if (!(await discoverApps(workspace.root)).apps.length) {
      log('Watching for the first App before preparing a personal sandbox.');
      while (!signal?.aborted && !(await discoverApps(workspace.root)).apps.length) {
        await delay(1000, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
      }
      if (signal?.aborted) return;
    }
    connection = await request(config, 'sandbox', { method: 'POST', body: {} });
  }
  while (connection.sandbox?.status === 'provisioning' && !signal?.aborted) {
    log('Preparing your personal sandbox…');
    await delay(5000, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
    if (signal?.aborted) return;
    const selected = await readConnection();
    if (selected.token !== config.token || selected.endpoint !== config.endpoint) throw new Error('Login changed during sandbox preparation.');
    connection = await request(config, 'connection');
  }
  if (connection.sandbox?.status !== 'active') throw new Error('Your sandbox needs attention. Open the developer console to renew or recover it; data was retained.');
  const workspaceOrigin = validateEndpoint(connection.sandbox.workspace_url);
  const launch = new URL(connection.sandbox.launch_url);
  if (launch.origin !== new URL(config.endpoint).origin || launch.username || launch.password) throw new Error('Invalid workspace launch address.');
  const preview = await startNativePreview(null, { workspaceOrigin, port, container, apps: new Map() });
  launch.searchParams.set('preview', preview.url);
  log(`Project: ${connection.project.name}\nNexia workspace: ${launch.href}\nWatching App folders. Create or clone Apps here; Ctrl+C stops local development without deleting data.`);
  const workers = new Map(), messages = new Map(), retryAt = new Map();
  const report = (key, message) => { if (messages.get(key) !== message) { messages.set(key, message); log(message); } };
  let nextRegistration = 0;
  try {
    while (!signal?.aborted) {
      const current = await readConnection(), binding = await findWorkspace(workspace.root);
      if (current.endpoint !== config.endpoint || current.token !== config.token || binding?.project_id !== workspace.project_id || binding.endpoint !== workspace.endpoint) {
        throw new Error('Project or login changed. Restart dev for the intended project.');
      }
      const discovered = await discoverApps(workspace.root);
      for (const error of discovered.errors) report(error.directory, `${path.basename(error.directory)}: ${error.message}`);
      const apps = discovered.apps.filter(app => !selector || app.name === selector || app.key === selector);
      if (apps.length > 20) throw new Error('A project development connection supports at most 20 local Apps. Use --app to select one.');
      if (selector && apps.length === 0) report('selection', `Waiting for App ${selector}.`);
      for (const [directory, worker] of workers) {
        if (!apps.some(app => app.directory === directory && app.key === worker.key)) {
          worker.controller.abort(); await worker.done; workers.delete(directory);
          report(directory, `${path.basename(directory)}: local watch removed; remote data retained.`);
        }
      }
      for (const app of apps) {
        if (workers.has(app.directory) || signal?.aborted || Date.now() < (retryAt.get(app.directory) ?? 0)) continue;
        // Do not capture the middle of a clone or a dependency install.
        if (await sourceIsChanging(app.directory)) {
          report(app.directory, `${app.name}: waiting for Git to finish cloning, merging or rebasing.`); continue;
        }
        if (await exists(path.join(app.directory, 'vite.config.mjs')) && !await exists(path.join(app.directory, 'node_modules/vite/dist/node/index.js'))) {
          report(app.directory, `${app.name}: waiting for frontend dependencies. Run npm install in this App.`); continue;
        }
        if (Date.now() < nextRegistration) continue;
        // Stay below the platform's 10 registrations/minute. Runtime polling is bounded for 20 Apps.
        nextRegistration = Date.now() + 7000;
        retryAt.set(app.directory, Date.now() + Math.max(14000, apps.length * 7000));
        try {
          const local = path.join(app.directory, '.nexia');
          await mkdir(local, { recursive: true });
          if ((await lstat(local)).isSymbolicLink()) throw new Error('App configuration must not be a symbolic link.');
          const projectFile = path.join(local, 'project.json');
          if (!await exists(projectFile)) await writeFile(projectFile, JSON.stringify({ endpoint: config.endpoint, project_id: workspace.project_id }) + '\n', { flag: 'wx' });
          const before = await readFile(path.join(app.directory, 'nexia.json'), 'utf8');
          await registerApp(app.directory, { log: message => report(app.directory, `${app.name}: ${message}`) });
          if (before !== await readFile(path.join(app.directory, 'nexia.json'), 'utf8')) throw new Error('App metadata changed during registration; waiting for a stable definition.');
          const controller = new AbortController();
          const worker = { key: app.key, controller, done: null };
          workers.set(app.directory, worker);
          worker.done = nativeDev(app.directory, { signal: controller.signal, previewHost: preview, interval: 10000,
            log: message => log(`${app.name}: ${message}`),
          }).catch(error => report(app.directory, `${app.name}: ${error.message} Remove and restore the folder, or restart dev after resolving it.`));
        } catch (error) {
          report(app.directory, `${app.name}: ${error.message}`);
          if (error.status === 429) nextRegistration = Date.now() + error.retryAfterMs;
          if ([401, 403].includes(error.status)) throw error;
        }
      }
      await delay(1000, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
    }
  } finally {
    for (const worker of workers.values()) worker.controller.abort();
    await Promise.allSettled([...workers.values()].map(worker => worker.done));
    await preview.close();
  }
}
