#!/usr/bin/env node
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createNexiaClient } from '@nexia/dev-client';
import { initProject, validateProject } from './project.js';
import { startPreview } from './preview.js';
import { serveMcp } from './mcp.js';
import { setup } from './setup.js';
import { initLaravelApp, runDevtools, installDevtools } from './devtools.js';
import { validateInRuntime } from './runtime-validate.js';
import { readConnection, setEndpoint, login, request, saveConnection, validateEndpoint } from './connection.js';
import { repository, submitTag } from './repository.js';
import { registerApp, selectExecution } from './apps.js';
import { syncSource } from './sync.js';
import { workspaceDev } from './workspace-dev.js';
import { nativeDev } from './native-dev.js';
import { bindWorkspace, findWorkspace, resolveAppDirectory } from './workspace.js';
import { access, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';

async function linkProject(directory) {
  const workspace = await findWorkspace(directory);
  if (workspace?.root === directory) throw new Error('This is a project workspace. Use nexia link-project <project-id>; App link must run inside an App.');
  const config = await readConnection();
  const result = await request(config, 'connection');
  if (result.status !== 'connected') throw new Error('Approve CLI login first.');
  await mkdir(path.join(directory, '.nexia'), { recursive: true });
  await writeFile(path.join(directory, '.nexia', 'project.json'), JSON.stringify({ endpoint: config.endpoint, project_id: result.project.id }) + '\n');
  console.log(`Linked to ${result.project.name} (${result.project.id}) at ${config.endpoint}`);
}

async function databaseBinding(directory, selector) {
  const root = await resolveAppDirectory(directory, selector), config = await readConnection();
  const local = path.join(root, '.nexia');
  const [project, app] = await Promise.all(['project.json', 'app.json'].map(async name => {
    const file = path.join(local, name), stat = await access(file).then(() => null, () => { throw new Error('Register and link this App before requesting database work.'); });
    return JSON.parse(await readFile(file, 'utf8'));
  }));
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
  if (!uuid(project.project_id) || !uuid(app.id)
      || validateEndpoint(project.endpoint) !== validateEndpoint(config.endpoint)
      || validateEndpoint(app.endpoint) !== validateEndpoint(config.endpoint)) throw new Error('App binding is invalid.');
  const connection = await request(config, 'connection');
  if (connection.status !== 'connected' || connection.project?.id !== project.project_id) {
    throw new Error('This directory is linked to another project or the connection is no longer approved. Run nexia link to confirm the current target first.');
  }
  return { config, app_id: app.id };
}

const signatureSourceOptions = ['source-key', 'source-version', 'subject-resource-key', 'source-resource-key', 'cardinality', 'min-items', 'max-items', 'stable-sort-key', 'lookup-mode', 'subject-anchor', 'source-ref-anchor', 'field-key', 'field-type', 'field-classification', 'field-formatter', 'label-key', 'description-key', 'field-label-key'];

const help = `Nexia developer tools

  nexia create-project <directory> [--name <name>] [--endpoint URL] [--no-browser]
                                   Create and connect a project after browser approval
  nexia login <project-id> [--no-browser]
                                   Connect through browser approval
  nexia link-project <project-id> [--no-browser]
                                   Connect this local project folder through browser approval
  nexia link [directory]            Bind an existing app to the connected project
  nexia status                     Show the connected project
  nexia logout                     Revoke this CLI connection
  nexia app register [directory]   Register PHP/React App identity from nexia.json
  nexia sync [directory]           Save a private PHP/React source snapshot
  nexia apps list [--json]         List registered Apps linked to the project
  nexia app runtime development|off [directory]
                                   Select development execution without deleting data
  nexia resources list [--json]    Inspect public resource contracts in the sandbox
  nexia db references [--json]     List Core keys allowed as App foreign-key targets
  nexia db status [directory] [--app <folder-or-key>]
  nexia db migrate [directory] [--request-id UUID] [--app <folder-or-key>]
  nexia db reset --yes [directory] [--request-id UUID] [--app <folder-or-key>]
  nexia db seed <fixture> [directory] [--request-id UUID] [--app <folder-or-key>]
                                   Run one App-scoped sandbox database operation
  nexia fixtures list [--json]     List installed App development fixtures
  nexia fixtures run <app> <key> [--request-id UUID] [--json]
                                   Request a sandbox fixture job
  nexia fixtures status <run-id> [--json]
                                   Check its recorded result
  nexia repository connect|status [directory] [--app <folder-or-key>]
  nexia submit [directory] --tag v1.2.0 [--request-id <uuid>] [--app <folder-or-key>]
                                   Submit an immutable App version
  nexia submissions status <submission-id> [--json]
  nexia submissions cancel|retry <submission-id> [--json]
                                   Inspect PHP/React build processing
  nexia setup --devtools [--dry-run] Install PHP generators for this CLI
  nexia setup [--dry-run]           Install/upgrade PHP and Composer (macOS)
  nexia init <dir> [--vendor <vendor>] [--family <key>]
                                   Create a PHP/React App; missing identity options are prompted interactively
  nexia init <dir> --template browser
                                   Create a legacy static browser App explicitly
  nexia make:resource <name> [dir] --label-ko <label> [--with-filament]
                                   Add a resource using the App namespace
  nexia make:page <name> [dir] --label-ko <label> [--without-record] [--without-navigation]
                                   Add a business page without a model or migration
  nexia make:signature-data-source <name> [dir] --subject-resource-key <key> --source-resource-key <key>
                                   Preview an explicit signature source; --write creates it
  nexia validate [directory] [--runtime-image sha256:...]  Check source or isolated Runtime/Catalog
  nexia dev [directory] [--port N]   Open in the remote Nexia workspace
  nexia doctor --endpoint URL       Inspect Core development capabilities
  nexia mcp [directory]             Read-only local MCP server on stdio

Default platform: https://developers.nexia.to
Alternate/local platforms: nexia config endpoint <URL> (clears the saved connection).
doctor accepts --allow-insecure-loopback for a local HTTP Core endpoint.
Project dev discovers Apps in immediate child folders. App commands accept --app <folder-or-key>. Deployments remain pending until review.
`;

try {
  const [command, ...rawArgs] = process.argv.slice(2);
  const args = rawArgs.flatMap(arg => /^--[^=]+=/.test(arg) ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg]);
  const positions = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--container') options.container = true;
    else if (arg === '--no-browser') options.noBrowser = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--allow-insecure-loopback') options.allowInsecureLoopback = true;
    else if (arg === '--prerequisite') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error('--prerequisite needs an App key.');
      (options.prerequisite ??= []).push(args[++i]);
    }
    else if (arg === '--force' || arg === '--yes' || arg === '--with-filament' || arg === '--without-navigation' || arg === '--without-record' || arg === '--write' || arg === '--devtools') options[arg.slice(2)] = true;
    else if (['--runtime-image', '--app', '--tag', '--version', '--request-id', '--port', '--endpoint', '--template', '--vendor', '--family', '--name', '--key', '--table-prefix', '--display-name', '--label-ko', '--label-ko-plural', '--label-zh', '--label-zh-plural', '--record-owner', '--navigation-group', '--navigation-subgroup', '--icon', '--sort'].includes(arg) || signatureSourceOptions.some(key => arg === `--${key}`)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} needs a value.`);
      options[arg.slice(2)] = args[++i];
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else positions.push(arg);
  }
  if (['config', 'internal'].includes(command) && positions[0] === 'endpoint' && positions.length === 2 && Object.keys(options).length === 0) {
    console.log(`Platform endpoint: ${await setEndpoint(positions[1])}\nPrevious CLI connection cleared. Run nexia login <project-id>.`);
    process.exit(0);
  }
  if (command === 'app' && positions[0] === 'register') {
    if (positions.length > 2 || Object.keys(options).some(key => key !== 'app')) throw new Error('Use nexia app register [directory] [--app <folder-or-key>].');
    await registerApp(await resolveAppDirectory(positions[1] || '.', options.app));
    process.exit(0);
  }
  if (command === 'app' && positions[0] === 'runtime') {
    if (positions.length < 2 || positions.length > 3 || Object.keys(options).some(key => key !== 'app')) throw new Error('Use nexia app runtime development|off [directory] [--app <folder-or-key>].');
    await selectExecution(await resolveAppDirectory(positions[2] || '.', options.app), positions[1]);
    process.exit(0);
  }
  if (command === 'apps' && positions[0] === 'list') {
    if (positions.length !== 1 || Object.keys(options).some(key => key !== 'json')) throw new Error('Use nexia apps list [--json].');
    const result = await request(await readConnection(), 'apps');
    console.log(options.json ? JSON.stringify(result) : result.apps.map(app => `${app.key} · ${app.name} · ${app.id}`).join('\n') || 'No registered Apps are linked to this project.');
    process.exit(0);
  }
  if (command === 'db') {
    const [action, first, second] = positions;
    if (action === 'references') {
      if (positions.length !== 1 || Object.keys(options).some(key => key !== 'json')) throw new Error('Use nexia db references [--json].');
      const result = await request(await readConnection(), 'v2/database/references');
      if (!Array.isArray(result.references) || result.grants_data_access !== false
          || result.references.some(item => !item || ['schema', 'table', 'column'].some(key => !/^[a-z_][a-z0-9_]{0,62}$/.test(item[key] ?? '')))) throw new Error('Invalid Core database reference catalog.');
      console.log(options.json ? JSON.stringify(result) : result.references.map(item => `${item.schema}.${item.table}.${item.column}`).join('\n') || 'No Core foreign-key targets are published.');
      if (!options.json) console.log('Reference declarations do not grant access to Core records.');
    } else {
      const seed = action === 'seed', allowed = ['json', 'app', 'request-id', ...(action === 'reset' ? ['yes'] : [])];
      if (!['status', 'migrate', 'seed', 'reset'].includes(action) || Object.keys(options).some(key => !allowed.includes(key))
          || (seed ? !first || positions.length > 3 : positions.length > 2) || (action === 'reset' && options.yes !== true)) throw new Error('Use nexia db status|migrate [directory], nexia db reset --yes [directory], or nexia db seed <fixture> [directory].');
      const directory = seed ? second || '.' : first || '.', binding = await databaseBinding(directory, options.app);
      if (action === 'status') {
        const result = await request(binding.config, `v2/apps/${binding.app_id}/database-operations`);
        console.log(options.json ? JSON.stringify(result) : result.operation ? `${result.operation.database_command}: ${result.operation.status} (${result.operation.id})` : 'No App database operation has been requested.');
      } else {
        const id = options['request-id'] || randomUUID();
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error('--request-id must be a UUID.');
        console.error(`Database request: ${id}. Stop nexia dev first if it owns this App writer lease; retry a lost response with the same --request-id.`);
        // Reuse the idempotency key for this short-lived lease. A lost-response
        // retry can then release the same writer generation without a new claim.
        const result = await request(binding.config, `v2/apps/${binding.app_id}/database-operations`, { method: 'POST', body: { command: action, ...(seed ? { fixture_key: first } : {}), request_id: id, writer_session: id } });
        const released = await request(binding.config, `v2/apps/${binding.app_id}/writer`, { method: 'PUT', body: { session_id: id, release: true } });
        if (released.writer?.released !== true) throw new Error('The accepted database request did not release its writer lease. Retry with the same --request-id.');
        console.log(options.json ? JSON.stringify(result) : `${result.operation.database_command}: ${result.operation.status} (${result.operation.id})\nCheck: nexia db status ${JSON.stringify(directory)}`);
      }
    }
    process.exit(0);
  }
  if (command === 'fixtures') {
    const [action, appOrRun, key] = positions;
    const allowed = action === 'run' ? ['json', 'request-id'] : ['json'];
    if (Object.keys(options).some(option => !allowed.includes(option))) throw new Error('Unsupported fixture option.');
    if (action === 'list' && positions.length === 1) {
      const result = await request(await readConnection(), 'fixtures');
      console.log(options.json ? JSON.stringify(result) : result.apps.flatMap(app => app.fixtures.map(key => `${app.app_key} · ${key}`)).join('\n') || 'No installed App exposes development fixtures.');
    } else if (action === 'run' && positions.length === 3) {
      if (!/^[a-z][a-z0-9-]{0,62}$/.test(appOrRun) || !key.trim() || key.length > 160) throw new Error('Use an App key and a declared fixture key.');
      const id = options['request-id'] || randomUUID();
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error('--request-id must be a UUID.');
      console.error(`Fixture request: ${id}. If the response is lost, retry with the same --request-id.`);
      const result = await request(await readConnection(), 'fixtures', { method: 'POST', body: { app_key: appOrRun, fixture_key: key, request_id: id } });
      console.log(options.json ? JSON.stringify(result) : `${result.run.status}: ${result.run.id}\nCheck: nexia fixtures status ${result.run.id}`);
    } else if (action === 'status' && positions.length === 2 && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(appOrRun)) {
      const result = await request(await readConnection(), `fixture-runs/${appOrRun}`);
      console.log(options.json ? JSON.stringify(result) : `${result.run.status}: ${result.run.app_key} · ${result.run.fixture_key}${result.run.status === 'needs_review' ? '\nExecution may have committed. Ask the platform administrator to inspect it before creating another request.' : ''}`);
    } else throw new Error('Use nexia fixtures list, run <app> <key>, or status <run-id>.');
    process.exit(0);
  }
  if (command === 'deploy') throw new Error('nexia deploy is retired. Connect a GitHub repository, then use nexia submit --tag v1.2.0. No submission was made.');
  if (command === 'repository') {
    const [action, directory = '.'] = positions;
    if (!['connect', 'status'].includes(action) || positions.length > 2 || Object.keys(options).some(key => key !== 'app')) throw new Error('Use nexia repository connect|status [directory] [--app <folder-or-key>].');
    await repository(await resolveAppDirectory(directory, options.app), action);
    process.exit(0);
  }
  if (command === 'submissions' && ['status', 'cancel', 'retry'].includes(positions[0])) {
    if (positions.length !== 2 || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(positions[1]) || Object.keys(options).some(key => key !== 'json')) throw new Error('Use nexia submissions status|cancel|retry <submission-id> [--json].');
    const action = positions[0] === 'status' ? '' : positions[0];
    const result = await request(await readConnection(), `v2/submissions/${positions[1]}${action ? `/${action}` : ''}`, action ? { method: 'POST', body: {} } : undefined);
    if (result.submission?.id !== positions[1]) throw new Error('Platform returned a different submission.');
    console.log(options.json ? JSON.stringify(result) : `${result.submission.tag}: ${result.submission.status}\n${result.submission.failure ?? ''}\n${result.submission.retryable ? 'Retry available: nexia submissions retry ' + result.submission.id : 'Code changes require a new version tag.'}`);
    process.exit(0);
  }
  if (command === 'resources' && positions[0] === 'list') {
    if (positions.length !== 1 || Object.keys(options).some(key => key !== 'json')) throw new Error('Use nexia resources list [--json].');
    const result = await request(await readConnection(), 'resources');
    console.log(options.json ? JSON.stringify(result) : `${result.resources.map(resource => `${resource.key} · ${resource.version} · ${resource.status}`).join('\n') || 'No public resource contracts are available.'}\nContract metadata only; this does not grant data access. Use --json for fields, declared permissions, actions and public events.`);
    process.exit(0);
  }
  // Keep old scripts readable while exposing one canonical make:* vocabulary.
  const generator = command?.startsWith('make:') ? command.slice(5) : command === 'make' ? positions.shift() : null;
  if (['resource', 'page', 'signature-data-source'].includes(generator)) {
    const allowed = {
      page: ['label-ko', 'navigation-group', 'sort', 'without-record', 'without-navigation', 'dryRun'],
      resource: ['label-ko', 'label-ko-plural', 'label-zh', 'label-zh-plural', 'record-owner', 'navigation-group', 'navigation-subgroup', 'icon', 'sort', 'force', 'with-filament', 'without-navigation', 'dryRun'],
      'signature-data-source': [...signatureSourceOptions, 'write', 'force'],
    }[generator];
    const required = generator === 'signature-data-source' ? '--subject-resource-key <key> --source-resource-key <key>' : '--label-ko <label>';
    if (!positions[0] || positions.length > 2 || Object.keys(options).some(key => !allowed.includes(key) && key !== 'app')) throw new Error(`Use nexia make:${generator} <name> [directory] ${required}.`);
    const directory = await resolveAppDirectory(positions[1] || '.', options.app);
    const args = [`make:${generator}`, directory, positions[0]];
    for (const [key, value] of Object.entries(options)) {
      if (key === 'app') continue;
      args.push(`--${key === 'dryRun' ? 'dry-run' : key}`);
      if (value !== true) args.push(value);
    }
    await runDevtools(args, directory);
    process.exit(0);
  }
  if (positions.length > 1) throw new Error('Supply at most one project directory.');
  const allowed = command === 'create-project' ? ['name', 'endpoint', 'noBrowser'] : command === 'init' ? ['template', 'vendor', 'family', 'name', 'key', 'table-prefix', 'display-name', 'prerequisite', 'dryRun'] : ['login', 'link-project'].includes(command) ? ['noBrowser'] : command === 'setup' ? ['dryRun', 'devtools'] : command === 'doctor' ? ['endpoint', 'allowInsecureLoopback'] : command === 'dev' ? ['port', 'container', 'app'] : command === 'submit' ? ['tag', 'request-id', 'app'] : command === 'validate' ? ['app', 'runtime-image'] : command === 'sync' ? ['app'] : [];
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new Error(`Option ${key} is not supported by ${command}.`);
  const directory = ['submit', 'sync', 'validate'].includes(command)
    ? await resolveAppDirectory(positions[0] || '.', options.app) : path.resolve(positions[0] || '.');
  if (!command || ['help', '--help', '-h'].includes(command)) console.log(help);
  else if (command === 'create-project') {
    if (!positions[0]) throw new Error('Use nexia create-project <new-directory>.');
    const projectName = options.name || path.basename(directory);
    if (!projectName.trim() || projectName.length > 100) throw new Error('Project name must contain 1 to 100 characters.');
    if (await findWorkspace(path.dirname(directory))) throw new Error('Do not create a project inside another project.');
    if (options.endpoint) validateEndpoint(options.endpoint);
    await mkdir(directory).catch(async error => {
      if (error.code !== 'EEXIST' || (await readdir(directory)).length) throw new Error('Use a new or empty project folder. Existing files were preserved.');
    });
    if (options.endpoint) await setEndpoint(options.endpoint);
    const connected = await login(undefined, { projectName, recoveryKey: directory, ...(options.noBrowser ? { openBrowser: false } : {}) });
    await bindWorkspace(directory, { endpoint: connected.endpoint, project: connected.project });
    if (connected.recoveryFile) await rm(connected.recoveryFile);
    console.log(`Project created: ${connected.project.name}\nNext: cd ${JSON.stringify(directory)}, then create or clone your Apps.`);
  }
  else if (command === 'login') await login(positions[0], options.noBrowser ? { openBrowser: false } : undefined);
  else if (command === 'link-project') {
    if (await access(path.join(process.cwd(), 'nexia.json')).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; })) throw new Error('Run link-project from the parent project directory, outside an App.');
    const existing = await findWorkspace(process.cwd());
    if (existing && (existing.root !== process.cwd() || existing.project_id !== positions[0])) throw new Error('Use a separate folder for another project.');
    await login(positions[0], options.noBrowser ? { openBrowser: false } : undefined);
    const config = await readConnection();
    const connection = await request(config, 'connection');
    if (connection.status !== 'connected' || connection.project?.id !== positions[0]) throw new Error('Project approval does not match.');
    await bindWorkspace(process.cwd(), { endpoint: config.endpoint, project: connection.project });
    console.log(`Project connected: ${connection.project.name}\nCreate or clone Apps directly inside this folder.`);
  }
  else if (command === 'link') await linkProject(directory);
  else if (command === 'sync') await syncSource(directory);
  else if (command === 'submit') await submitTag(directory, options.tag, options['request-id']);
  else if (command === 'status') console.log(JSON.stringify(await request(await readConnection(), 'connection'), null, 2));
  else if (command === 'logout') { const config = await readConnection(); await request(config, 'connection', { method: 'DELETE' }); await saveConnection({ endpoint: config.endpoint }); console.log('CLI connection revoked.'); }
  else if (command === 'setup') {
    if (positions.length) throw new Error('Use nexia setup or nexia setup --dry-run without a directory.');
    await (options.devtools ? installDevtools : setup)({ dryRun: options.dryRun });
  } else if (command === 'init') {
    if (!positions[0]) throw new Error('Choose a new directory: nexia init my-app');
    const template = options.template || 'laravel';
    if (!['browser', 'laravel'].includes(template)) throw new Error('Template must be browser or laravel.');
    if (template === 'browser' && Object.keys(options).some(key => key !== 'template')) throw new Error('App identity options require --template laravel.');
    const parentWorkspace = await findWorkspace(path.dirname(directory));
    if (parentWorkspace && parentWorkspace.root !== path.dirname(directory)) throw new Error('Create Apps directly inside the project folder.');
    const target = template === 'laravel' ? await initLaravelApp(directory, options) : await initProject(directory);
    if (options.dryRun) process.exit(0);
    console.log(`Created ${target}\nNext: ${template === 'laravel' ? (parentWorkspace ? 'install App dependencies, then run nexia dev from the project; registration is automatic' : 'review nexia.json, select a project with nexia link, then register with nexia app register') : `nexia dev ${JSON.stringify(target)}`}`);
  } else if (command === 'validate') {
    if (options['runtime-image']) {
      await validateInRuntime(directory, options['runtime-image']);
      process.exit(0);
    }
    const exists = async name => access(path.join(directory, name)).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (await exists('composer.json')) {
      await runDevtools(['validate', directory], directory);
      if (!await exists('nexia.json')) process.exit(0);
      // The public PHP validator owns native metadata; only preview v1 has static entries.
      const manifest = JSON.parse(await readFile(path.join(directory, 'nexia.json'), 'utf8'));
      if (manifest?.schema_version === '2') process.exit(0);
    }
    const manifest = await validateProject(directory);
    console.log(`${manifest.app.name}: local manifest and preview entries are valid. Remote compatibility has not been checked.`);
  } else if (command === 'dev') {
    const projectWorkspace = await findWorkspace(directory);
    if (projectWorkspace) {
      const shutdown = new AbortController();
      const stop = () => shutdown.abort();
      const port = options.port === undefined ? 4310 : Number(options.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try { await workspaceDev(projectWorkspace, { signal: shutdown.signal, port, container: options.container === true, app: options.app }); }
      finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
      process.exit(0);
    }
    if (options.app) throw new Error('--app requires a linked project folder.');
    const native = await access(path.join(directory, 'composer.json')).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (native) {
      const shutdown = new AbortController();
      const stop = () => shutdown.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      const port = options.port === undefined ? 4310 : Number(options.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
      try { await nativeDev(directory, { signal: shutdown.signal, port, container: options.container === true }); }
      finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
      process.exit(0);
    }
    const port = options.port === undefined ? 4310 : Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
    const config = await readConnection();
    const connection = await request(config, 'connection');
    if (connection.status !== 'connected' || connection.sandbox?.status !== 'active') {
      throw new Error('A ready project sandbox is required. Open your project in the developer console and prepare its workspace first.');
    }
    const binding = JSON.parse(await readFile(path.join(directory, '.nexia', 'project.json'), 'utf8').catch(() => { throw new Error('Link this app first: nexia link'); }));
    if (binding.project_id !== connection.project.id || binding.endpoint !== config.endpoint) throw new Error('This app belongs to a different project. Run nexia link to select the connected project.');
    const workspace = new URL(validateEndpoint(connection.sandbox.workspace_url));
    const platform = new URL(config.endpoint);
    const launch = new URL(connection.sandbox.launch_url);
    if (launch.origin !== platform.origin || launch.username || launch.password || workspace.username || workspace.password || !['http:', 'https:'].includes(workspace.protocol)) {
      throw new Error('The platform returned an invalid workspace connection.');
    }
    const preview = await startPreview(directory, port, { container: options.container === true, workspaceOrigin: workspace.origin });
    launch.searchParams.set('preview', preview.url);
    console.log(`Nexia workspace: ${launch.href}\nOpen this address to add your app to the remote workspace.\n${preview.reload ? 'Save public files to refresh the app tab.' : 'Automatic refresh unavailable; refresh the app tab after saving.'}\nCore runs on the platform; this machine serves only your app.\nPress Ctrl+C to stop.`);
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; await preview.close(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } else if (command === 'doctor') {
    if (positions.length || !options.endpoint) throw new Error('Use nexia doctor --endpoint https://your-nexia-host');
    const discovery = await createNexiaClient({ endpoint: options.endpoint, allowInsecureLoopback: options.allowInsecureLoopback }).discover();
    console.log(JSON.stringify(discovery, null, 2));
    console.log('Discovery succeeded. This does not authenticate you or create a remote project.');
  } else if (command === 'mcp') await serveMcp(directory);
  else if (['projects'].includes(command)) {
    throw new Error(`${command} is unavailable: create and manage projects in the developer web console, then run nexia login <project-id>. No remote action was performed.`);
  } else throw new Error(`Unknown command: ${command}\nRun nexia help for available commands.`);
} catch (error) {
  console.error(`Nexia: ${error.code === 'EEXIST' ? 'The target directory already exists. Choose a new directory; existing files were not overwritten.' : error.message}`);
  console.error('Developer support: https://github.com/nexia-cloud-os/developer-support/issues/new/choose (remove credentials and private data before reporting).');
  process.exitCode = 1;
}
