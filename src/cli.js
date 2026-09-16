#!/usr/bin/env node
import path from 'node:path';
import { createNexiaClient } from '@amuzcorp/nexia-dev-client';
import { initProject, validateProject } from './project.js';
import { startPreview } from './preview.js';
import { serveMcp } from './mcp.js';
import { setup } from './setup.js';
import { readConnection, setEndpoint, login, request, saveConnection } from './connection.js';
import { deploy } from './deploy.js';
import { mkdir, writeFile } from 'node:fs/promises';

async function linkProject(directory) {
  const config = await readConnection();
  const result = await request(config, 'connection');
  if (result.status !== 'connected') throw new Error('Approve CLI login first.');
  await mkdir(path.join(directory, '.nexia'), { recursive: true });
  await writeFile(path.join(directory, '.nexia', 'project.json'), JSON.stringify({ endpoint: config.endpoint, project_id: result.project.id }) + '\n');
  console.log(`Linked to ${result.project.name} (${result.project.id}) at ${config.endpoint}`);
}

const help = `Nexia developer tools

  nexia login <project-id>          Connect through browser approval
  nexia link [directory]            Bind an existing app to the connected project
  nexia status                     Show the connected project
  nexia logout                     Revoke this CLI connection
  nexia deploy [directory]          Submit an immutable version for review
  nexia setup [--dry-run]           Install/upgrade PHP and Composer (macOS)
  nexia init <new-directory>        Create an app without overwriting files
  nexia validate [directory]        Check nexia.json and public entries
  nexia dev [directory] [--port N]   Preview locally; refresh when files change
  nexia doctor --endpoint URL       Inspect Core development capabilities
  nexia mcp [directory]             Read-only local MCP server on stdio

doctor accepts --allow-insecure-loopback for a local HTTP Core endpoint.
Create projects in the developer platform. Deployments remain pending until review.
`;

try {
  const [command, ...args] = process.argv.slice(2);
  const positions = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--container') options.container = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--allow-insecure-loopback') options.allowInsecureLoopback = true;
    else if (['--port', '--endpoint'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} needs a value.`);
      options[arg.slice(2)] = args[++i];
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else positions.push(arg);
  }
  if (command === 'internal' && positions[0] === 'endpoint' && positions.length === 2) {
    console.log(`Platform endpoint: ${await setEndpoint(positions[1])}\nPrevious CLI connection cleared. Run nexia login <project-id>.`);
    process.exit(0);
  }
  if (positions.length > 1) throw new Error('Supply at most one project directory.');
  const allowed = command === 'setup' ? ['dryRun'] : command === 'doctor' ? ['endpoint', 'allowInsecureLoopback'] : command === 'dev' ? ['port', 'container'] : [];
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new Error(`Option ${key} is not supported by ${command}.`);
  const directory = path.resolve(positions[0] || '.');
  if (!command || ['help', '--help', '-h'].includes(command)) console.log(help);
  else if (command === 'login') await login(positions[0]);
  else if (command === 'link') await linkProject(directory);
  else if (command === 'deploy') await deploy(directory);
  else if (command === 'status') console.log(JSON.stringify(await request(await readConnection(), 'connection'), null, 2));
  else if (command === 'logout') { const config = await readConnection(); await request(config, 'connection', { method: 'DELETE' }); await saveConnection({ endpoint: config.endpoint }); console.log('CLI connection revoked.'); }
  else if (command === 'setup') {
    if (positions.length) throw new Error('Use nexia setup or nexia setup --dry-run without a directory.');
    await setup({ dryRun: options.dryRun });
  } else if (command === 'init') {
    if (!positions[0]) throw new Error('Choose a new directory: nexia init my-app');
    const target = await initProject(directory);
    console.log(`Created ${target}\nNext: nexia dev ${JSON.stringify(target)}`);
    if ((await readConnection()).token) await linkProject(target);
  } else if (command === 'validate') {
    const manifest = await validateProject(directory);
    console.log(`${manifest.app.name}: local manifest and preview entries are valid. Remote compatibility has not been checked.`);
  } else if (command === 'dev') {
    const port = options.port === undefined ? 4310 : Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
    const preview = await startPreview(directory, port, { container: options.container === true });
    console.log(`Local preview: ${preview.url}\n${preview.reload ? 'Save public files to refresh.' : 'Automatic refresh unavailable; refresh the browser after saving.'}\nBrowser preview is local. Use nexia deploy to submit for review. No tenant data access is granted.\nPress Ctrl+C to stop.`);
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
  process.exitCode = 1;
}
