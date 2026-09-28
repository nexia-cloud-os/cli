import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { onPath } from './setup.js';

const toolDirectory = () => path.resolve(process.env.NEXIA_CONFIG_HOME || path.join(os.homedir(), '.config', 'nexia'), 'tools', 'devtools');

export async function installDevtools({ dryRun = false, log = console.log } = {}) {
  const directory = toolDirectory();
  log(`Install the PHP generators in ${directory}. Existing Apps and global Composer configuration are not changed.`);
  if (dryRun) return;
  const composer = await onPath('composer');
  if (!composer || !await onPath('php')) throw new Error('Install PHP 8.4+ and Composer first, then run nexia setup --devtools.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path.join(directory, 'composer.json'), JSON.stringify({ require: { 'nexia/app-devtools': '*' }, config: { 'allow-plugins': false } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const env = { ...process.env, COMPOSER_HOME: path.join(directory, 'composer-home') };
  for (const key of ['COMPOSER', 'COMPOSER_VENDOR_DIR', 'COMPOSER_BIN_DIR']) delete env[key];
  await new Promise((resolve, reject) => {
    const child = spawn(composer, ['install', '--no-interaction', '--no-scripts', '--no-plugins', '--prefer-dist'], { cwd: directory, env, shell: false, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('PHP generator installation failed. Resolve the Composer error above and rerun nexia setup --devtools.')));
  });
  await realpath(path.join(directory, 'vendor/bin/nexia-app'));
  log('PHP generators are ready. Use nexia init, nexia make:resource and nexia make:page.');
}

export async function runDevtools(args, directory) {
  const managed = await realpath(path.join(toolDirectory(), 'vendor/bin/nexia-app')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const executable = managed || await onPath('nexia-app');
  if (!executable) throw new Error('Run nexia setup --devtools to install the PHP generators, then retry this command.');
  const root = await realpath(directory).catch(error => {
    if (error.code === 'ENOENT') return path.resolve(directory);
    throw error;
  });
  const relative = path.relative(root, executable);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Use an independently installed nexia-app executable, not a script inside the App directory.');
  }
  await new Promise((resolve, reject) => {
    const child = spawn('php', [executable, ...args], { shell: false, stdio: 'inherit' });
    child.once('error', error => reject(new Error(`Cannot start PHP App generators: ${error.message}`)));
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`App generator failed (exit ${code}). Review its output; existing files were not reset.`)));
  });
}

export async function initLaravelApp(directory, options) {
  if (!options.vendor || !options.family) throw new Error('Laravel Apps require --vendor <vendor> and --family <family-key>.');
  const args = ['make:app', options.name || path.basename(directory), '--directory', directory];
  for (const key of ['vendor', 'family', 'key', 'table-prefix', 'display-name']) {
    if (options[key] !== undefined) args.push(`--${key}`, options[key]);
  }
  for (const key of options.prerequisite || []) args.push('--prerequisite', key);
  if (options.dryRun) args.push('--dry-run');
  await runDevtools(args, directory);
  return directory;
}
