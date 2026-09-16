#!/usr/bin/env node
import path from 'node:path';
import { createNexiaClient } from '@amuzcorp/nexia-dev-client';
import { initProject, validateProject } from './project.js';
import { startPreview } from './preview.js';
import { serveMcp } from './mcp.js';
import { setup } from './setup.js';

const help = `Nexia developer tools — local preview foundation

  nexia setup [--dry-run]           Install/upgrade PHP and Composer (macOS)
  nexia init <new-directory>        Create an app without overwriting files
  nexia validate [directory]        Check nexia.json and public entries
  nexia dev [directory] [--port N]   Preview locally; refresh when files change
  nexia doctor --endpoint URL       Inspect Core development capabilities
  nexia mcp [directory]             Read-only local MCP server on stdio

doctor accepts --allow-insecure-loopback for a local HTTP Core endpoint.
login, projects, and deploy require services not yet available.
`;

try {
  const [command, ...args] = process.argv.slice(2);
  const positions = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--allow-insecure-loopback') options.allowInsecureLoopback = true;
    else if (['--port', '--endpoint'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} needs a value.`);
      options[arg.slice(2)] = args[++i];
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else positions.push(arg);
  }
  if (positions.length > 1) throw new Error('Supply at most one project directory.');
  const allowed = command === 'setup' ? ['dryRun'] : command === 'doctor' ? ['endpoint', 'allowInsecureLoopback'] : command === 'dev' ? ['port'] : [];
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new Error(`Option ${key} is not supported by ${command}.`);
  const directory = path.resolve(positions[0] || '.');
  if (!command || ['help', '--help', '-h'].includes(command)) console.log(help);
  else if (command === 'setup') {
    if (positions.length) throw new Error('Use nexia setup or nexia setup --dry-run without a directory.');
    await setup({ dryRun: options.dryRun });
  } else if (command === 'init') {
    if (!positions[0]) throw new Error('Choose a new directory: nexia init my-app');
    const target = await initProject(directory);
    console.log(`Created ${target}\nNext: nexia dev ${JSON.stringify(target)}\nThis app is a local preview; it is not installed in Nexia.`);
  } else if (command === 'validate') {
    const manifest = await validateProject(directory);
    console.log(`${manifest.app.name}: local manifest and preview entries are valid. Remote compatibility has not been checked.`);
  } else if (command === 'dev') {
    const port = options.port === undefined ? 4310 : Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
    const preview = await startPreview(directory, port);
    console.log(`Local preview: ${preview.url}\n${preview.reload ? 'Save public files to refresh.' : 'Automatic refresh unavailable; refresh the browser after saving.'}\nNot connected to Nexia. Remote data, authentication, and deployment are unavailable.\nPress Ctrl+C to stop.`);
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; await preview.close(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } else if (command === 'doctor') {
    if (positions.length || !options.endpoint) throw new Error('Use nexia doctor --endpoint https://your-nexia-host');
    const discovery = await createNexiaClient({ endpoint: options.endpoint, allowInsecureLoopback: options.allowInsecureLoopback }).discover();
    console.log(JSON.stringify(discovery, null, 2));
    console.log('Discovery succeeded. This does not authenticate you or create a remote project.');
  } else if (command === 'mcp') await serveMcp(directory);
  else if (['login', 'projects', 'deploy'].includes(command)) {
    throw new Error(`${command} is unavailable: Core must first provide developer authentication, project management, and remote development services. Use nexia doctor --endpoint URL to inspect capability availability. No remote action was performed.`);
  } else throw new Error(`Unknown command: ${command}\nRun nexia help for available commands.`);
} catch (error) {
  console.error(`Nexia: ${error.code === 'EEXIST' ? 'The target directory already exists. Choose a new directory; existing files were not overwritten.' : error.message}`);
  process.exitCode = 1;
}
