import path from 'node:path';
import { lstat, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { validateEndpoint } from './connection.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

async function json(file) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error(`Use a regular JSON file: ${file}`);
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Legacy per-App bindings intentionally do not define a project workspace.
export async function findWorkspace(directory) {
  for (let root = path.resolve(directory);;) {
    const local = path.join(root, '.nexia');
    const stat = await lstat(local).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (stat?.isSymbolicLink()) throw new Error('Project configuration must not be a symbolic link.');
    const binding = stat ? await json(path.join(local, 'project.json')) : null;
    if (binding?.kind === 'project') {
      if (binding.schema_version !== 1 || !uuid(binding.project_id)) throw new Error('Unsupported or invalid project workspace configuration.');
      validateEndpoint(binding.endpoint);
      return { ...binding, root };
    }
    const parent = path.dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}

export async function bindWorkspace(directory, { endpoint, project }) {
  const root = path.resolve(directory);
  endpoint = validateEndpoint(endpoint);
  if (!uuid(project?.id)) throw new Error('Platform returned an invalid project.');
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Use a real project directory.');
  if (await json(path.join(root, 'nexia.json'))) throw new Error('Run link-project from the parent project directory, outside an App.');
  const parent = await findWorkspace(path.dirname(root));
  if (parent) throw new Error(`Do not nest projects. Existing project: ${parent.root}`);
  const local = path.join(root, '.nexia');
  await mkdir(local, { recursive: true });
  if ((await lstat(local)).isSymbolicLink()) throw new Error('Project configuration must not be a symbolic link.');
  const file = path.join(local, 'project.json');
  const previous = await json(file);
  if (previous && (previous.endpoint !== endpoint || previous.project_id !== project.id)) throw new Error('This folder is already connected to another project. Use a separate project folder.');
  await writeFile(file, JSON.stringify({ schema_version: 1, kind: 'project', endpoint, project_id: project.id }) + '\n');
  const ignore = path.join(root, '.gitignore');
  try { await writeFile(ignore, '.nexia/\n', { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const template = await readFile(new URL('./templates/project-agents.md', import.meta.url), 'utf8');
  const values = { projectName: JSON.stringify(project.name ?? ''), projectId: project.id, endpoint };
  const instructions = template.replace(/{{ (projectName|projectId|endpoint) }}/g, (_, key) => values[key]);
  try { await writeFile(path.join(root, 'AGENTS.md'), instructions, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return findWorkspace(root);
}

// Only immediate children; never traverse cloned dependencies or linked directories.
export async function discoverApps(root) {
  const apps = [], errors = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || ['node_modules', 'vendor', 'dist'].includes(entry.name)) continue;
    const directory = path.join(root, entry.name);
    try {
      const manifest = await json(path.join(directory, 'nexia.json'));
      if (!manifest) continue;
      if (manifest.schema_version !== '2' || manifest.runtime !== 'laravel') throw new Error('Project dev supports native PHP/React Apps; run legacy browser Apps separately.');
      const composer = await json(path.join(directory, 'composer.json'));
      if (!composer?.name || !/^[a-z][a-z0-9-]{0,62}$/.test(manifest.app?.app_key ?? '')) throw new Error('App metadata is incomplete.');
      apps.push({ directory, name: entry.name, key: manifest.app.app_key, manifest });
    } catch (error) { errors.push({ directory, message: error.message }); }
  }
  const duplicates = new Set(apps.filter(app => apps.some(other => other !== app && other.key === app.key)).map(app => app.key));
  return {
    apps: apps.filter(app => !duplicates.has(app.key)).sort((a, b) => a.name.localeCompare(b.name)),
    errors: [...errors, ...apps.filter(app => duplicates.has(app.key)).map(app => ({ directory: app.directory, message: `Duplicate App key ${app.key}; neither copy will run.` }))],
  };
}

export async function resolveAppDirectory(directory, selector) {
  const absolute = path.resolve(directory);
  const workspace = await findWorkspace(absolute);
  if (!workspace) {
    if (selector) throw new Error('--app requires a linked project directory.');
    return absolute;
  }
  const { apps, errors } = await discoverApps(workspace.root);
  const matches = apps.filter(app => selector ? app.name === selector || app.key === selector
    : absolute === app.directory || absolute.startsWith(app.directory + path.sep));
  if (matches.length !== 1) throw new Error(`Select an App with --app <folder-or-key>, or run inside its directory.${errors.length ? ` ${errors.map(error => error.message).join(' ')}` : ''}`);
  return matches[0].directory;
}
