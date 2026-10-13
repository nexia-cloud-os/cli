import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { InputError } from './commands.js';
import { message } from './input.js';

export const MAX_DEV_APPS = 20;
export const filterDevApps = (apps, selectors) => selectors === undefined ? apps
  : apps.filter(app => Array.isArray(selectors) ? selectors.includes(app.key)
    : app.name === selectors || app.key === selectors);

export async function selectDevApps(apps, selectors, input) {
  if (selectors !== undefined) {
    const keys = new Set();
    for (const selector of [selectors].flat().flatMap(value => value.split(',').map(part => part.trim()))) {
      const matches = filterDevApps(apps, selector);
      if (matches.length !== 1) throw new InputError(`Unknown or ambiguous App: ${selector}. Available: ${apps.map(app => app.name).join(', ')}`);
      keys.add(matches[0].key);
    }
    if (!keys.size || keys.size > MAX_DEV_APPS) throw new InputError(`Select 1–${MAX_DEV_APPS} Apps with repeated --app.`);
    return [...keys];
  }
  if (apps.length > 1 && input.interactive) {
    return (await input.multiChoice(message('Choose Apps to develop', '개발할 앱을 선택하세요'),
      apps.map(app => ({ value: app.key, label: app.name })), { max: MAX_DEV_APPS })) ?? undefined;
  }
  if (apps.length > MAX_DEV_APPS) throw new InputError(`A project development connection supports at most ${MAX_DEV_APPS} local Apps. Repeat --app to select Apps, or run nexia dev in an interactive terminal.`);
  return undefined;
}

async function configPath(workspace) {
  const directory = path.join(workspace.root, '.nexia');
  if (!(await lstat(directory)).isDirectory()) throw new Error('Project configuration must be a real directory.');
  const file = path.join(directory, 'dev.json');
  const stat = await lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (stat && (!stat.isFile() || stat.size > 16384)) throw new Error('Development configuration must be a regular file under 16 KiB.');
  return file;
}

async function readDevConfig(workspace) {
  const file = await configPath(workspace);
  let config;
  try { config = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (!(error instanceof SyntaxError)) throw error;
    throw new InputError('Invalid development configuration. Run nexia dev config to replace it.');
  }
  if (config?.schema_version !== 1 || config.project_id !== workspace.project_id || config.endpoint !== workspace.endpoint
    || !(config.apps === null || Array.isArray(config.apps) && config.apps.length > 0 && config.apps.length <= MAX_DEV_APPS
      && config.apps.every(key => typeof key === 'string' && key.length > 0) && new Set(config.apps).size === config.apps.length)) {
    throw new InputError('Development configuration does not match this project. Run nexia dev config to replace it.');
  }
  return config.apps;
}

function validateSavedApps(apps, keys) {
  if (keys === null) {
    if (apps.length > MAX_DEV_APPS) throw new InputError('All Apps exceeds the 20-App limit. Run nexia dev config.');
    return undefined;
  }
  if (!Array.isArray(keys) || !keys.length || keys.length > MAX_DEV_APPS) throw new InputError('Select 1–20 Apps.');
  const missing = keys.filter(key => apps.filter(app => app.key === key).length !== 1);
  if (missing.length) throw new InputError(`Configured Apps are missing or ambiguous: ${missing.join(', ')}. Run nexia dev config or use --app.`);
  return keys;
}

export async function configureDevApps(workspace, apps, selectors, input, log = console.error) {
  const file = await configPath(workspace);
  let previous;
  try { previous = await readDevConfig(workspace); }
  catch (error) { if (!(error instanceof InputError)) throw error; log(error.message); }
  let selected;
  if (selectors !== undefined) {
    selected = await selectDevApps(apps, selectors, input);
    await input.confirm(`Save default development Apps: ${selected.join(', ')}`);
  } else {
    if (!input.interactive) throw new InputError('Use nexia dev config --app <names> --no-interactive --yes.');
    if (!apps.length) throw new InputError('No Apps found. Create an App before configuring development.');
    const initial = previous === null && apps.length <= MAX_DEV_APPS ? null : (previous || []).filter(key => apps.some(app => app.key === key));
    selected = await input.multiChoice(message('Config Apps — save defaults', 'Config Apps — 기본 앱 설정'),
      apps.map(app => ({ value: app.key, label: app.name })), { max: MAX_DEV_APPS, initial, saving: true });
  }
  validateSavedApps(apps, selected);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ schema_version: 1, project_id: workspace.project_id, endpoint: workspace.endpoint, apps: selected }) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  log(message('Saved Apps. Select Config Apps in nexia dev; edit with nexia dev config.', '앱 설정을 저장했습니다. nexia dev에서 Config 설정을 선택하세요. 변경: nexia dev config.'));
  return selected ?? undefined;
}

export async function configuredDevApps(workspace, apps, selectors, input) {
  if (selectors !== undefined) return selectDevApps(apps, selectors, input);
  if (input.interactive) {
    let saved, configError = '';
    try {
      saved = await readDevConfig(workspace);
      if (saved !== undefined) validateSavedApps(apps, saved);
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      configError = error.message;
    }
    const configKeys = configError ? [] : saved === null ? apps.map(app => app.key) : saved || [];
    return (await input.multiChoice(message('Choose Apps to develop', '개발할 앱을 선택하세요'),
      apps.map(app => ({ value: app.key, label: app.name })), {
        max: MAX_DEV_APPS, configure: true, configKeys, configAll: saved === null, configError,
      })) ?? undefined;
  }
  return selectDevApps(apps, undefined, input);
}
