import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { readConnection, request } from './connection.js';

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
  let metadata = composer.extra?.nexia?.app;
  if (manifest?.schema_version === '2') {
    if (manifest.runtime !== 'laravel') throw new Error('Package nexia.json version 2 requires runtime laravel.');
    if (Object.hasOwn(composer.extra?.nexia ?? {}, 'app')) throw new Error('Declare App metadata only in nexia.json; remove extra.nexia.app.');
    metadata = manifest.app;
  } else if (manifest && manifest.schema_version !== '1') {
    throw new Error('Unsupported nexia.json schema_version.');
  }
  if (!composer.name || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Declare a Composer package name and App metadata in native nexia.json or legacy extra.nexia.app.');
  }
  const browser = manifest?.schema_version === '1' ? { browser_app_id: manifest.app?.id } : {};
  if (manifest?.schema_version === '1' && typeof browser.browser_app_id !== 'string') throw new Error('nexia.json must declare app.id before its browser identity can be bound.');
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
    throw new Error('This directory is linked to another project or endpoint. Run nexia link to confirm the current target first.');
  }
  const identity = await optionalJson(path.join(local, 'app.json'));
  if (identity && (identity.endpoint !== config.endpoint || identity.key !== metadata.app_key)) {
    throw new Error('This directory already has a different App identity. Its existing binding was preserved.');
  }
  const result = await request(config, 'apps', { method: 'POST', body: { package_name: composer.name, metadata, ...browser } });
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
  if (!selection || selection.app_id !== scope.app_id || selection.project_id !== scope.project_id
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(selection.sandbox_id ?? '')
      || ![null, 'development', 'off'].includes(selection.mode)
      || !Number.isSafeInteger(selection.revision) || selection.revision < 0 || typeof selection.stop_pending !== 'boolean') {
    throw new Error('Platform returned a conflicting execution selection.');
  }
  return selection;
}

export async function selectExecution(directory, mode, { log = console.log } = {}) {
  if (!['development', 'off'].includes(mode)) throw new Error('Use nexia app runtime development|off [directory].');
  const config = await readConnection();
  const readBinding = async () => {
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
    return { project_id: project.project_id, app_id: app.id };
  };
  const scope = await readBinding();
  const current = await readExecutionSelection(config, scope);
  const latest = await readConnection(), binding = await readBinding();
  if (latest.endpoint !== config.endpoint || latest.token !== config.token || binding.project_id !== scope.project_id || binding.app_id !== scope.app_id) throw new Error('App binding or CLI connection changed. No execution choice was submitted.');
  const { selection } = await request(config, `v2/apps/${scope.app_id}/execution`, { method: 'PUT', body: { mode, revision: current.revision } });
  if (selection?.app_id !== scope.app_id || selection.project_id !== scope.project_id || selection.sandbox_id !== current.sandbox_id
      || selection.mode !== mode || selection.revision !== current.revision + (current.mode === mode ? 0 : 1)
      || typeof selection.stop_pending !== 'boolean') throw new Error('Execution choice acknowledgement was not confirmed. Check status before retrying.');
  log(`Development execution: ${selection.mode}${selection.stop_pending ? ' (operator shutdown pending)' : ''}. Source and data retained. No published App was installed.`);
  return selection;
}
