import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateManifest } from '@nexia/dev-protocol';

/** Static delivery must never silently discard an App's PHP implementation. */
export async function assertStaticProject(directory) {
  try { await lstat(path.join(directory, 'composer.json')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('This directory contains a PHP package. the static path cannot run or submit its server code. Keep composer.json; use Native nexia dev and nexia submit --tag v1.0.0 --version <version> on a configured platform.');
}

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
  // Check the root too: canonicalizing a linked public/ directory would silently
  // redefine the allowed boundary to an unrelated directory.
  let current = path.resolve(root);
  for (const part of ['', ...entry.split(/[\\/]/)]) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Public assets must not use symbolic links.');
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
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
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
    'public/index.html': '<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Nexia development app</title><style>body{font:18px system-ui;max-width:48rem;margin:10vh auto;padding:24px;line-height:1.6}small{color:#555}</style><main><small>Local preview</small><h1>Your Nexia app starts here</h1><p>Edit public/index.html and save to refresh this page.</p><p>This app runs inside your remote Nexia workspace. Run nexia submit --tag v1.0.0 when it is ready for review.</p></main></html>\n',
    'README.md': `# Nexia App development

Choose local or Docker development for this same App directory. Neither requires
platform repository checkouts. Prepare the project sandbox in Developers first.
This starter currently supports browser assets and static review submissions;
Native Laravel execution and SDK data access are not enabled by this template.

## Local

Install Node.js 22+ and the public CLI, then connect this directory:

\`\`\`sh
npm install -g @nexia/cli@${version}
nexia login <project-id>
nexia link
nexia dev
\`\`\`

Approve login in your browser. Keep dev running; in another terminal use
\`nexia validate\`, \`nexia resources list --json\` or \`nexia submit --tag v1.0.0\`.
Open the printed workspace address, connect the preview and edit public/.

## Docker

Docker Engine/Desktop with Compose is sufficient; host Node.js is optional.
On macOS/Linux set the file owner once in every terminal using Compose:

\`\`\`sh
export NEXIA_UID="$(id -u)" NEXIA_GID="$(id -g)"
docker compose build
docker compose run --rm dev login <project-id>
docker compose run --rm dev link
docker compose up
\`\`\`

On Windows PowerShell omit the export line; Docker uses its default container UID.
Approve login in the host browser. Keep Compose running; in another terminal use
\`docker compose run --rm dev validate\`, \`docker compose run --rm dev resources list --json\`
or \`docker compose run --rm dev deploy\`. Docker polls public/ for saved changes.

## Switching modes and stopping

Both modes use the same files, App identity and project binding. Each mode has
its own private CLI login: log in and run link in the selected mode. Do not copy
credentials between modes. Stop the previous preview before starting the other,
or choose another port (local: --port; Docker: NEXIA_PORT environment variable).
Ctrl+C stops the preview and preserves App files and sandbox data. Do not use
\`docker compose down --volumes\` unless you intend to remove the Docker CLI login.

If the operator supplies another platform URL, run \`nexia config endpoint <URL>\`
or \`docker compose run --rm dev config endpoint <URL>\` before login. Local
operator endpoints developers.localhost and developers.nexia.test map to the host
from Docker. Use the same browser-visible endpoint in both modes.

Keep browser files in public/ and secrets/server files outside it. Before
submission validate the App and verify tab switching and save/reload in Nexia.
Deploy submits an immutable version for administrator review; it is not installation.
`,
    'AGENTS.md': '# App development\n\nWork only on this App using the installed public CLI/SDK; platform repositories are administrator-owned. Choose local nexia commands or docker compose run --rm dev commands as documented in README.md. Keep the preview running in one terminal and use another for commands. Do not copy CLI credentials when switching modes.\nKeep public browser assets inside public/. Never put secrets there.\nUse public Nexia contracts and advertised capabilities only. Open the remote Nexia workspace URL from nexia dev and verify tabs, sidebar, settings, and live app refresh. Never clone, copy, mount, or distribute Nexia Core. Local apps have no tenant data authority.\nRun nexia validate and inspect browser behavior before submission. Run nexia repository connect, then nexia submit --tag v1.0.0 to submit committed GitHub source for review. Never read or copy CLI credentials.\nFor setup, SDK, CLI, Docker, AI-tool or sandbox problems, search and report at https://github.com/nexia-cloud-os/developer-support/issues. Include package versions, development mode, sanitized reproduction steps and the incident time. Never attach credentials, Core source or customer data. Prepare the report for the developer to review before submission.\n',
    'SUPPORT.md': "# Developer support\n\nFor setup, SDK, CLI, Docker, AI-tool or sandbox problems, search and report at https://github.com/nexia-cloud-os/developer-support/issues. Include package versions, development mode, sanitized reproduction steps and the incident time. Never attach credentials, Core source or customer data. Prepare the report for the developer to review before submission.\n",
    '.gitignore': 'node_modules/\n.nexia/\n.env*\n',
    'Dockerfile': `FROM node:22-bookworm-slim
ARG NEXIA_CLI_VERSION=${version}
RUN npm install --global --ignore-scripts --no-audit --no-fund "@nexia/cli@\${NEXIA_CLI_VERSION}" && mkdir -p /workspace /nexia-config && chmod 1777 /nexia-config && chown node:node /workspace
USER node
WORKDIR /workspace
EXPOSE 4310
ENTRYPOINT ["nexia"]
CMD ["dev", ".", "--container"]
`,
    'compose.yaml': `services:
  dev:
    build:
      context: .
      args:
        NEXIA_CLI_VERSION: "\${NEXIA_CLI_VERSION:-${version}}"
    user: "\${NEXIA_UID:-1000}:\${NEXIA_GID:-1000}"
    environment:
      NEXIA_CONFIG_HOME: "/nexia-config/\${NEXIA_UID:-1000}"
      npm_config_cache: /tmp/npm
    ports:
      - "127.0.0.1:\${NEXIA_PORT:-4310}:\${NEXIA_PORT:-4310}"
    command: ["dev", ".", "--container", "--port", "\${NEXIA_PORT:-4310}"]
    volumes:
      - .:/workspace
      - nexia-config:/nexia-config
    extra_hosts:
      - "developers.localhost:host-gateway"
      - "developers.nexia.test:host-gateway"
    init: true
volumes:
  nexia-config:
`,
    '.dockerignore': '**\n!Dockerfile\n',

  };
  for (const [filename, content] of Object.entries(files)) {
    await writeFile(path.join(target, filename), content, { flag: 'wx' });
  }
  return target;
}
