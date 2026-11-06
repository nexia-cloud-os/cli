import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readConnection, request } from './connection.js';
import { discoverApps } from './workspace.js';
import { listDevSessions } from './dev-sessions.js';

async function optionalJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Register package metadata only. Never executes Composer, PHP or project scripts. */
export async function registerApp(directory, { log = console.log } = {}) {
  if ((await lstat(path.join(directory, 'composer.json'))).isSymbolicLink()) throw new Error('composer.json must not be a symbolic link.');
  const composer = JSON.parse(await readFile(path.join(directory, 'composer.json'), 'utf8'));
  const manifestPath = path.join(directory, 'nexia.json');
  let manifest;
  try {
    const stat = await lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576) throw new Error('nexia.json must be a regular file of at most 1 MiB.');
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('nexia.json must contain an object.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (manifest?.schema_version !== '2') throw new Error('Package registration requires nexia.json version 2.');
  if (manifest.runtime !== 'laravel') throw new Error('Package nexia.json version 2 requires runtime laravel.');
  if (Object.keys(composer.extra?.nexia ?? {}).length) throw new Error('Declare App metadata only in nexia.json; extra.nexia is unsupported.');
  const metadata = manifest.app;
  if (!composer.name || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Declare a Composer package name and App metadata in nexia.json.');
  }
  const config = await readConnection();
  const connection = await request(config, 'connection');
  if (connection.status !== 'connected') throw new Error('Approve CLI login first.');
  const local = path.join(directory, '.nexia');
  await mkdir(local, { recursive: true });
  if ((await lstat(local)).isSymbolicLink()) throw new Error('.nexia must not be a symbolic link.');
  for (const file of ['project.json', 'app.json']) {
    try { if ((await lstat(path.join(local, file))).isSymbolicLink()) throw new Error(`${file} must not be a symbolic link.`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const project = await optionalJson(path.join(local, 'project.json'));
  if (project && (project.endpoint !== config.endpoint || project.project_id !== connection.project.id)) {
    throw new Error('This directory is linked to another project or endpoint. Run nexia login to confirm the current target first.');
  }
  const identity = await optionalJson(path.join(local, 'app.json'));
  if (identity && (identity.endpoint !== config.endpoint || identity.key !== metadata.app_key)) {
    throw new Error('This directory already has a different App identity. Its existing binding was preserved.');
  }
  const result = await request(config, 'apps', { method: 'POST', body: { package_name: composer.name, metadata } });
  const app = result.app;
  if (!app || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(app.id || '')
      || app.key !== metadata.app_key || app.package_name !== composer.name || app.table_prefix !== metadata.app_table_prefix
      || (identity && identity.id !== app.id)) throw new Error('Platform returned a conflicting App identity. Local identity was not changed.');
  await writeFile(path.join(local, 'app.json'), JSON.stringify({ endpoint: config.endpoint, id: app.id, key: app.key }) + '\n');
  await writeFile(path.join(local, 'project.json'), JSON.stringify({ endpoint: config.endpoint, project_id: connection.project.id }) + '\n');
  log(`Registered: ${app.name} (${app.key})\nApp ID: ${app.id}\nProject: ${connection.project.name}\nIdentity registered. Run nexia dev to request sandbox execution. This does not publish or install the App.`);
  return result;
}

export async function readExecutionSelection(config, scope) {
  const { selection } = await request(config, `v2/apps/${scope.app_id}/execution`);
  return validateExecutionSelection(selection, scope);
}

export function validateExecutionSelection(selection, scope) {
  if (!selection || selection.app_id !== scope.app_id || selection.project_id !== scope.project_id
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(selection.sandbox_id ?? '')
      || ![null, 'development', 'off'].includes(selection.mode)
      || !Number.isSafeInteger(selection.revision) || selection.revision < 0 || typeof selection.stop_pending !== 'boolean') {
    throw new Error('Platform returned a conflicting execution selection.');
  }
  return selection;
}

async function readExecutionBinding(directory, config) {
  const folder = path.join(directory, '.nexia');
  const stat = await lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Use a real linked App directory.');
  const values = [];
  for (const name of ['project.json', 'app.json']) {
    const file = path.join(folder, name), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('Invalid App binding.');
    values.push(JSON.parse(await readFile(file, 'utf8')));
  }
  const [project, app] = values;
  const validId = id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
  if (project.endpoint !== config.endpoint || app.endpoint !== config.endpoint || !validId(project.project_id) || !validId(app.id)) throw new Error('App bindings do not match the platform.');
  return { project_id: project.project_id, app_id: app.id, app_key: app.key };
}

export async function selectExecution(directory, mode, { log = console.log, expected, restartCleanup = false } = {}) {
  if (!['development', 'off'].includes(mode)) throw new Error('Development execution mode must be development or off.');
  const config = await readConnection();
  const scope = await readExecutionBinding(directory, config);
  const current = await readExecutionSelection(config, scope);
  if (expected && (current.revision !== expected.revision || current.sandbox_id !== expected.sandbox_id
    || current.app_id !== expected.app_id || current.project_id !== expected.project_id
    || current.mode !== expected.mode || current.stop_pending !== expected.stop_pending
    || Boolean(current.resume_pending) !== Boolean(expected.resume_pending))) {
    throw new Error('Execution selection changed before startup. No automatic resume was submitted.');
  }
  const latest = await readConnection(), binding = await readExecutionBinding(directory, latest);
  if (latest.endpoint !== config.endpoint || latest.token !== config.token || binding.project_id !== scope.project_id || binding.app_id !== scope.app_id || binding.app_key !== scope.app_key) throw new Error('App binding or CLI connection changed. No execution choice was submitted.');
  const { selection } = await request(config, `v2/apps/${scope.app_id}/execution`, { method: 'PUT', body: { mode, revision: current.revision,
    ...(restartCleanup && mode === 'off' && current.restart_cleanup_supported === true ? { restart_cleanup: true } : {}) } });
  const pendingResume = mode === 'development' && selection?.mode === 'off' && selection.resume_pending === true && selection.stop_pending === true;
  if (selection?.app_id !== scope.app_id || selection.project_id !== scope.project_id || selection.sandbox_id !== current.sandbox_id
      || (!pendingResume && selection.mode !== mode) || (!Number.isSafeInteger(selection.revision) || selection.revision < current.revision || selection.revision > current.revision + 1)
      || typeof selection.stop_pending !== 'boolean') throw new Error('Execution choice acknowledgement was not confirmed. Check status before retrying.');
  log(pendingResume ? 'Development switch pending. Waiting for shutdown confirmation; keep nexia dev running.'
    : `Development execution: ${selection.mode}${selection.stop_pending ? ' (operator shutdown pending)' : ''}. Source and data retained. No published App was installed.`);
  return selection;
}

export async function restartExecution(directory, { log = console.log, wait = delay, expected } = {}) {
  const stopped = await selectExecution(directory, 'off', { log, expected, restartCleanup: true });
  const config = await readConnection();
  const scope = { app_id: stopped.app_id, project_id: stopped.project_id };
  let current = stopped;
  const deadline = Date.now() + 120_000;
  while (current.stop_pending) {
    if (Date.now() >= deadline) throw new Error('Shutdown is still pending. Check the App in Developers before resuming; source and data are retained.');
    await wait(1000);
    const latest = await readConnection();
    if (latest.endpoint !== config.endpoint || latest.token !== config.token) throw new Error('CLI connection changed while waiting for shutdown. Check the App in Developers.');
    current = await readExecutionSelection(config, scope);
    if (current.sandbox_id !== stopped.sandbox_id || current.revision !== stopped.revision || current.mode !== 'off' || current.resume_pending) {
      throw new Error('Development selection changed while waiting for shutdown. Check the App in Developers; no resume was requested.');
    }
  }
  const selection = await selectExecution(directory, 'development', { log, expected: current });
  log('Restart requested. Keep nexia dev running, or start it for this App; wait for Development ready. Source and data are retained.');
  return selection;
}

// Project restart only targets linked local Apps already selected for development.
export async function restartProjectExecutions(workspace, { log = console.log } = {}) {
  const config = await readConnection();
  const connection = await request(config, 'connection');
  if (config.endpoint !== workspace.endpoint || connection.status !== 'connected'
      || connection.project?.id !== workspace.project_id) throw new Error('Log in to the project linked to this folder before restarting Apps.');
  const { apps, errors } = await discoverApps(workspace.root);
  if (errors.length) throw new Error(errors.map(error => `${error.directory}: ${error.message}`).join('\n'));
  const remote = (await request(config, 'apps')).apps;
  if (!Array.isArray(remote) || remote.some(app => !/^[a-z][a-z0-9-]{0,62}$/.test(app.key ?? '')
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(app.id ?? ''))
      || new Set(remote.map(app => app.key)).size !== remote.length
      || new Set(remote.map(app => app.id)).size !== remote.length) throw new Error('Invalid project App list.');
  if (!apps.length && !remote.length) throw new Error('No Apps found in this project.');
  let requested = 0, skipped = 0;
  const failures = [];
  for (const app of apps) {
    log(`\n${app.name}:`);
    try {
      const latest = await readConnection();
      if (latest.endpoint !== config.endpoint || latest.token !== config.token) throw new Error('CLI connection changed. Stop and check the project before retrying.');
      let scope;
      try { scope = await readExecutionBinding(app.directory, config); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const registered = remote.find(item => item.key === app.key);
        if (registered) {
          const selected = await readExecutionSelection(config, { app_id: registered.id, project_id: workspace.project_id });
          if (selected.mode === 'development') throw new Error('Local App binding is missing; reconnect its source and watcher.');
        }
        skipped++; log('Not registered locally; skipped.'); continue;
      }
      if (scope.project_id !== workspace.project_id || scope.app_key !== app.key
          || !remote.some(item => item.key === app.key && item.id === scope.app_id)) throw new Error('App binding does not match this project and App.');
      const selection = await readExecutionSelection(config, scope);
      if (selection.mode !== 'development') {
        skipped++; log('Development execution is not selected; skipped.'); continue;
      }
      if (selection.stop_pending || selection.resume_pending) throw new Error('Execution transition is already pending.');
      const sessions = await listDevSessions(workspace.root);
      if (!sessions.some(session => session.status === 'watching' && session.project_id === workspace.project_id && session.apps.includes(app.key))) {
        throw new Error('No active local nexia dev watcher for this App; start it before retrying.');
      }
      const statePath = path.join(app.directory, '.nexia', 'runtime.json');
      const stat = await lstat(statePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!stat) throw new Error('No local execution state; check this App before retrying.');
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('Invalid runtime state.');
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      if (state.endpoint !== config.endpoint || state.project_id !== scope.project_id || state.app_id !== scope.app_id
          || state.sandbox_id !== selection.sandbox_id || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(state.operation_id ?? '')) {
        throw new Error('Runtime state does not match this App and sandbox.');
      }
      const { operation } = await request(config, `v2/runtime-operations/${state.operation_id}`);
      if (operation?.id !== state.operation_id || operation.developer_project_id !== scope.project_id
          || operation.developer_sandbox_id !== selection.sandbox_id) throw new Error('Runtime operation does not match this App and sandbox.');
      if (state.source_update || operation.stop_requested_at) throw new Error('A source update or runtime stop is pending.');
      if (operation.status !== 'completed' || operation.stopped_at) {
        skipped++; log('No running runtime recorded; skipped.'); continue;
      }
      await restartExecution(app.directory, { log, expected: selection });
      requested++;
    } catch (error) {
      failures.push(app.name);
      log(`Restart not confirmed: ${error.message} Check this App in Developers before retrying.`);
    }
  }
  for (const app of remote.filter(item => !apps.some(local => local.key === item.key))) {
    try {
      const selection = await readExecutionSelection(config, { app_id: app.id, project_id: workspace.project_id });
      if (selection.mode !== 'development') { skipped++; log(`${app.key}: Development execution is not selected; skipped.`); continue; }
      throw new Error('App is not present in this project folder; connect its local source and watcher before retrying.');
    } catch (error) {
      failures.push(app.key);
      log(`${app.key}: Restart not confirmed: ${error.message}`);
    }
  }
  log(`\nRestart requested: ${requested}; skipped: ${skipped}; not confirmed: ${failures.length}. Keep nexia dev running and check Development ready for each App. For incomplete Apps, check state and retry that App individually.`);
  if (failures.length) throw new Error(`Restart not confirmed for: ${failures.join(', ')}.`);
}
