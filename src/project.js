import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateManifest } from '@nexia/dev-protocol';

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
    'public/index.html': '<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Nexia development app</title><style>body{font:18px system-ui;max-width:48rem;margin:10vh auto;padding:24px;line-height:1.6}small{color:#555}</style><main><small>Local preview</small><h1>Your Nexia app starts here</h1><p>Edit public/index.html and save to refresh this page.</p><p>This app runs inside your remote Nexia workspace. Run nexia deploy when it is ready for review.</p></main></html>\n',
    'README.md': '# Local Nexia app\n\nRun `nexia validate .`, then `nexia dev`. Edit files in `public/`.\nPrepare the project sandbox in the developer console, then open the workspace URL printed by nexia dev. The app appears in a real Nexia work tab. Core remains on the remote server; neither this directory nor the developer image contains Core. This static app has no tenant data authority.\nThe JSON manifest is an experimental remote-app contract, not the existing PHP App manifest.\n',
    'AGENTS.md': '# App development\n\nKeep public browser assets inside public/. Never put secrets there.\nUse public Nexia contracts and advertised capabilities only. Open the remote Nexia workspace URL from nexia dev and verify tabs, sidebar, settings, and live app refresh. Never clone, copy, mount, or distribute Nexia Core. Local apps have no tenant data authority.\nRun nexia validate and inspect browser behavior before submission. nexia deploy uploads an immutable version for review, not customer installation. Never read or copy CLI credentials.\nFor setup, SDK, CLI, Docker, AI-tool or sandbox problems, search and report at https://github.com/nexia-cloud-os/developer-support/issues. Include package versions, development mode, sanitized reproduction steps and the incident time. Never attach credentials, Core source or customer data. Prepare the report for the developer to review before submission.\n',
    'SUPPORT.md': "# Developer support\n\nFor setup, SDK, CLI, Docker, AI-tool or sandbox problems, search and report at https://github.com/nexia-cloud-os/developer-support/issues. Include package versions, development mode, sanitized reproduction steps and the incident time. Never attach credentials, Core source or customer data. Prepare the report for the developer to review before submission.\n",
    '.gitignore': 'node_modules/\n.nexia/\n.env*\n',
    'Dockerfile': 'FROM node:22-bookworm-slim\nRUN npm install --global --ignore-scripts --no-audit --no-fund @nexia/cli@0.1.0-alpha.3 && mkdir -p /workspace /home/node/.config/nexia && chown -R node:node /workspace /home/node/.config\nUSER node\nWORKDIR /workspace\nEXPOSE 4310\nENTRYPOINT ["nexia"]\nCMD ["dev", ".", "--container"]\n',
    'compose.yaml': 'services:\n  dev:\n    build: .\n    ports:\n      - "127.0.0.1:${NEXIA_PORT:-4310}:${NEXIA_PORT:-4310}"\n    command: ["dev", ".", "--container", "--port", "${NEXIA_PORT:-4310}"]\n    volumes:\n      - .:/workspace\n      - nexia-config:/home/node/.config/nexia\n    extra_hosts:\n      - "developers.nexia.test:host-gateway"\n    init: true\nvolumes:\n  nexia-config:\n',
    '.dockerignore': '**\n!Dockerfile\n',

  };
  for (const [filename, content] of Object.entries(files)) {
    await writeFile(path.join(target, filename), content, { flag: 'wx' });
  }
  return target;
}
