import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateManifest } from '@amuzcorp/nexia-dev-protocol';

export async function readManifest(directory) {
  const filename = path.join(path.resolve(directory), 'nexia.json');
  let value;
  try { value = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { throw new Error(`Cannot read ${filename}: ${error.message}`); }
  const result = validateManifest(value);
  if (!result.valid) {
    throw new Error(result.errors.map(({ path: key, message }) => `${key}: ${message}`).join('\n'));
  }
  return value;
}

export async function resolvePublicFile(root, entry) {
  if (entry.split(/[\\/]/).some((part) => part.startsWith('.')) || path.isAbsolute(entry)) {
    throw new Error('Hidden files and absolute paths are not public assets.');
  }
  const canonicalRoot = await realpath(root);
  const resolved = await realpath(path.resolve(root, entry));
  if (!resolved.startsWith(canonicalRoot + path.sep)) throw new Error('Asset must remain inside the public directory.');
  if (!(await lstat(resolved)).isFile()) throw new Error('Asset is not a regular file.');
  return resolved;
}

export async function validateProject(directory) {
  const manifest = await readManifest(directory);
  for (const screen of manifest.screens) {
    if (!screen.entry.startsWith('public/')) throw new Error(`${screen.id}: local preview entries must be inside public/.`);
    await resolvePublicFile(path.join(directory, 'public'), screen.entry.slice(7));
  }
  return manifest;
}

export async function initProject(directory) {
  const target = path.resolve(directory);
  // Exclusive directory creation makes any existing target a safe failure.
  await mkdir(target, { recursive: false });
  await mkdir(path.join(target, 'public'));
  const name = path.basename(target);
  const suffix = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-app';
  const manifest = {
    schema_version: '1',
    app: { id: `dev.local.${/^[a-z]/.test(suffix) ? suffix : `app-${suffix}`}`, name, version: '0.1.0' },
    screens: [{ id: 'home', route: '/', entry: 'public/index.html' }],
    permissions: { required: [] },
  };
  const files = {
    'nexia.json': JSON.stringify(manifest, null, 2) + '\n',
    'public/index.html': '<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Nexia app preview</title><style>body{font:18px system-ui;max-width:48rem;margin:10vh auto;padding:24px;line-height:1.6}small{color:#555}</style><main><small>Local preview</small><h1>Your Nexia app starts here</h1><p>Edit public/index.html and save to refresh this page.</p><p>This preview is not connected to Nexia. Data access and deployment require the remote development service.</p></main></html>\n',
    'README.md': '# Local Nexia app\n\nRun `nexia validate .`, then `nexia dev`. Edit files in `public/`.\nThis is a static local preview. It does not save data to Nexia or install an App.\nThe JSON manifest is an experimental remote-app contract, not the existing PHP App manifest.\n',
    'AGENTS.md': '# App development\n\nKeep public browser assets inside public/. Never put secrets there.\nUse the public Nexia SDK/API contracts. Local preview has no Core connection.\nDo not invent successful authentication, installation, or deployment.\n',
    '.gitignore': 'node_modules/\n.nexia/\n.env*\n',
  };
  for (const [filename, content] of Object.entries(files)) {
    await writeFile(path.join(target, filename), content, { flag: 'wx' });
  }
  return target;
}
