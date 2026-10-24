import { message } from './input.js';
import { createDevReporter, serverVersionRows } from './dev-output.js';
import path from 'node:path';
import { retryDevRead } from './dev-retry.js';
import { MAX_DEV_APPS, filterDevApps } from './dev-selection.js';
import { lstat, readFile, mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readConnection, request, validateEndpoint } from './connection.js';
import { discoverApps, findWorkspace } from './workspace.js';
import { registerApp } from './apps.js';
import { sourceIsChanging } from './source-snapshot.js';
import { nativeDev } from './native-dev.js';
import { startNativePreview } from './native-preview.js';

const exists = file => lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

export async function workspaceDev(workspace, { signal, verbose = false, port = 4310, container = false, app: selector, log = console.log, onStatus = () => {}, reporter = null } = {}) {
  const ownReporter = !reporter;
  const output = reporter || createDevReporter(log);
  output.task('workspace', 'running', 'Connecting to project…');
  const config = await readConnection();
  const readStatus = () => retryDevRead(async () => {
    const current = await readConnection();
    if (current.token !== config.token || current.endpoint !== config.endpoint) throw new Error('Login changed. Restart nexia dev.');
    return request(config, 'connection');
  }, { signal, log: value => output.message('workspace', value, { verbose }) });
  let connection = await readStatus();
  if (!connection) return;
  if (config.endpoint !== workspace.endpoint || connection.status !== 'connected' || connection.project?.id !== workspace.project_id) {
    throw new Error('Log in to the project linked to this folder before starting dev.');
  }
  output.summary(serverVersionRows(connection.platform_versions), { after: 'CLI version' });
  if (!connection.capabilities?.personal_sandboxes) throw new Error('This platform must be upgraded to support project development with personal sandboxes.');
  if (!connection.sandbox || connection.sandbox.status === 'failed') {
    if (!connection.sandbox && !(await discoverApps(workspace.root)).apps.length) {
      output.task('workspace', 'pending', 'Waiting for the first App before preparing a sandbox');
      while (!signal?.aborted && !(await discoverApps(workspace.root)).apps.length) {
        await delay(1000, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
      }
      if (signal?.aborted) return;
    }
    connection = await request(config, 'sandbox', { method: 'POST', body: {} });
  }
  while (connection.sandbox?.status === 'provisioning' && !signal?.aborted) {
    output.task('workspace', 'running', `Preparing personal sandbox${connection.sandbox.preparation_step ? ` (${connection.sandbox.preparation_step})` : ''}…`);
    await delay(5000, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
    if (signal?.aborted) return;
    const selected = await readConnection();
    if (selected.token !== config.token || selected.endpoint !== config.endpoint) throw new Error('Login changed during sandbox preparation.');
    connection = await readStatus();
    if (!connection) return;
  }
  if (connection.sandbox?.status !== 'active') {
    throw Object.assign(new Error(`Personal sandbox is not active (status: ${connection.sandbox?.status || 'unknown'}).${connection.sandbox?.preparation_step ? ` Preparation stopped at: ${connection.sandbox.preparation_step}.` : ''}\nOpen this project's sandbox settings in Developers and check its status and failure details. Follow the next action shown for that sandbox status; do not reset App data.\nFor a failed preparation, run nexia dev again to resume safely, or select Retry preparation in the project's sandbox settings. Local source and data were not reset.`), { code: 'SANDBOX_NOT_ACTIVE' });
  }
  output.task('workspace', 'success', 'Personal sandbox ready');
  const workspaceOrigin = validateEndpoint(connection.sandbox.workspace_url);
  const launch = new URL(connection.sandbox.launch_url);
  if (launch.origin !== new URL(config.endpoint).origin || launch.username || launch.password) throw new Error('Invalid workspace launch address.');
  const preview = await startNativePreview(null, { workspaceOrigin, port, container, apps: new Map() });
  launch.searchParams.set('preview', preview.url);
  onStatus({ status: 'watching', workspace_url: launch.href, apps: [] });
  output.summary([
    ['Project', connection.project.name],
    ['Workspace', { link: launch.href, label: 'Open workspace' }],
    [message('Local address', '로컬 주소'), preview.url],
  ]);
  const workers = new Map(), messages = new Map(), retryAt = new Map();
  const reportApps = () => onStatus({ apps: [...workers.values()].map(worker => worker.key) });
  const report = (key, name, state, detail) => {
    const value = `${state}:${detail}`;
    if (messages.get(key) !== value) { messages.set(key, value); output.task(name, state, detail); }
  };
  const reportFailure = (key, name, error, { next, summary } = {}) => {
    const value = `error:${error.code || ''}:${error.message}`;
    if (messages.get(key) === value) return;
    messages.set(key, value);
    output.failure(name, error, { verbose, next, summary });
  };
  let nextRegistration = 0;
  try {
    while (!signal?.aborted) {
      const current = await readConnection();
      let binding;
      try { binding = await findWorkspace(workspace.root); }
      catch (error) {
        if (error.code !== 'INVALID_JSON') throw error;
        reportFailure('project-json', 'workspace', error);
        await delay(1000, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
        continue;
      }
      if (current.endpoint !== config.endpoint || current.token !== config.token || binding?.project_id !== workspace.project_id || binding.endpoint !== workspace.endpoint) {
        throw new Error('Project or login changed. Restart dev for the intended project.');
      }
      const discovered = await discoverApps(workspace.root);
      for (const error of discovered.errors) {
        reportFailure(error.directory, path.basename(error.directory), error);
      }
      const apps = filterDevApps(discovered.apps, selector);
      if (apps.length > MAX_DEV_APPS) throw new Error(`A project development connection supports at most ${MAX_DEV_APPS} local Apps. Restart dev to select Apps, or repeat --app.`);
      if (selector && apps.length === 0) report('selection', 'apps', 'pending', `Waiting for ${[selector].flat().join(', ')}`);
      for (const app of apps) if (!workers.has(app.directory) && !messages.has(`queued:${app.directory}`)) {
        messages.set(`queued:${app.directory}`, 'queued');
        output.task(app.name, 'pending', 'Queued for local and remote development');
      }
      for (const [directory, worker] of workers) {
        if (!apps.some(app => app.directory === directory && app.key === worker.key)
            && !discovered.errors.some(error => error.directory === directory && error.code === 'INVALID_JSON')) {
          worker.controller.abort(); await worker.done; workers.delete(directory);
          report(directory, path.basename(directory), 'stopped', 'Local watch removed; remote data retained');
        }
      }
      for (const app of apps) {
        if (workers.has(app.directory) || signal?.aborted || Date.now() < (retryAt.get(app.directory) ?? 0)) continue;
        // Do not capture the middle of a clone or a dependency install.
        if (await sourceIsChanging(app.directory)) {
          report(app.directory, app.name, 'pending', 'Waiting for Git to finish cloning, merging or rebasing…'); continue;
        }
        if (await exists(path.join(app.directory, 'vite.config.mjs')) && !await exists(path.join(app.directory, 'node_modules/vite/dist/node/index.js'))) {
          report(app.directory, app.name, 'warning', `Frontend dependencies missing — run npm install in ${app.name}`); continue;
        }
        if (Date.now() < nextRegistration) continue;
        // Stay below the platform's 10 registrations/minute. Runtime polling is bounded for 20 Apps.
        nextRegistration = Date.now() + 7000;
        retryAt.set(app.directory, Date.now() + Math.max(14000, apps.length * 7000));
        try {
          output.task(app.name, 'running', 'Registering App…');
          const local = path.join(app.directory, '.nexia');
          await mkdir(local, { recursive: true });
          if ((await lstat(local)).isSymbolicLink()) throw new Error('App configuration must not be a symbolic link.');
          const projectFile = path.join(local, 'project.json');
          if (!await exists(projectFile)) await writeFile(projectFile, JSON.stringify({ endpoint: config.endpoint, project_id: workspace.project_id }) + '\n', { flag: 'wx' });
          const before = await readFile(path.join(app.directory, 'nexia.json'), 'utf8');
          await registerApp(app.directory, { log: () => {} });
          if (before !== await readFile(path.join(app.directory, 'nexia.json'), 'utf8')) throw new Error('App metadata changed during registration; waiting for a stable definition.');
          output.task(app.name, 'running', 'App registered; preparing development…');
          const controller = new AbortController();
          const worker = { key: app.key, controller, done: null };
          workers.set(app.directory, worker);
          reportApps();
          worker.done = nativeDev(app.directory, { verbose, signal: controller.signal, previewHost: preview, interval: 10000,
            reporter: output, taskName: app.name, log: value => output.message(app.name, value, { verbose }),
          }).catch(error => reportFailure(app.directory, app.name, error, {
            summary: 'App execution unavailable; watching continues',
            next: 'Correct the reported issue. This App will be checked again automatically.',
          })).finally(() => {
            if (workers.get(app.directory) === worker) {
              workers.delete(app.directory);
              reportApps();
            }
          });
        } catch (error) {
          reportFailure(app.directory, app.name, error);
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
    if (ownReporter) output.close();
  }
}
