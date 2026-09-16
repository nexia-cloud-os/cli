import { spawn } from 'node:child_process';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const HOMEBREW_INSTALL_URL = 'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh';

export const SETUP_PLAN = [
  'If Homebrew is missing: download and run its official HTTPS installer (interactive administrator password may be required)',
  'brew update',
  'brew install or upgrade php (latest stable unversioned Homebrew formula)',
  'brew install or upgrade composer (latest stable Homebrew formula)',
  'brew info --json=v2 php composer (report selected stable versions)',
];

function run(executable, args, { capture = false, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => reject(new Error(`Cannot run ${executable}: ${error.message}`)));
    child.once('close', (code) => code === 0 ? resolve(output) : reject(new Error(`${executable} ${args.join(' ')} failed (exit ${code}). Resolve the error above, then rerun nexia setup. Completed package changes remain installed.`)));
  });
}

async function executableAt(filename) {
  try { await access(filename, constants.X_OK); return await realpath(filename); }
  catch (error) { if (['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) return null; throw error; }
}

async function onPath(name) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const executable = await executableAt(path.join(directory, name));
    if (executable) return executable;
  }
  return null;
}

async function findBrew() {
  const defaults = process.arch === 'arm64'
    ? ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']
    : ['/usr/local/bin/brew', '/opt/homebrew/bin/brew'];
  for (const filename of defaults) {
    const executable = await executableAt(filename);
    if (executable) return executable;
  }
  return onPath('brew');
}

async function bootstrapHomebrew(log) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Homebrew installation requires an interactive terminal. Run nexia setup there so the official installer can request confirmation and your macOS administrator password.');
  }
  log(`Homebrew is missing. Downloading its official installer: ${HOMEBREW_INSTALL_URL}`);
  log('The Homebrew installer will explain system changes and may ask for your macOS administrator password. Enter it directly in the terminal; Nexia does not collect it.');
  const directory = await mkdtemp(path.join(tmpdir(), 'nexia-homebrew-'));
  try {
    const response = await fetch(HOMEBREW_INSTALL_URL, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Homebrew installer download failed (HTTP ${response.status}). Retry nexia setup after checking your connection.`);
    const script = await response.text();
    if (!script.startsWith('#!/bin/bash') || script.length > 1024 * 1024) throw new Error('Unexpected Homebrew installer response. Inspect https://brew.sh before retrying.');
    const filename = path.join(directory, 'install.sh');
    await writeFile(filename, script, { flag: 'wx', mode: 0o600 });
    const env = { ...process.env };
    // Preserve the installer's own confirmation and password prompts.
    delete env.NONINTERACTIVE;
    delete env.CI;
    await run('/bin/bash', [filename], { env });
  } finally { await rm(directory, { recursive: true, force: true }); }
  const executable = await findBrew();
  if (!executable) throw new Error('Homebrew installer ended but brew was not found in its standard locations. Follow the installer recovery instructions and retry nexia setup.');
  return executable;
}

export async function setup({ dryRun = false, platform = process.platform, log = console.log } = {}) {
  if (platform !== 'darwin') throw new Error('Automatic PHP/Composer setup currently supports macOS with Homebrew only. On other systems install current stable PHP and Composer using their supported installation instructions.');
  log('Setup installs or upgrades Homebrew PHP and Composer to its current stable formulas. It may also upgrade required dependencies. Existing runtime versions can change.');
  for (const step of SETUP_PLAN) log(`  ${step}`);
  if (dryRun) { log('Preview only. No commands were run and no packages were changed.'); return; }
  const brew = await findBrew() || await bootstrapHomebrew(log);
  log(`Using Homebrew: ${brew}`);
  await run(brew, ['--version']);
  await run(brew, ['update']);
  for (const formula of ['php', 'composer']) {
    const installed = await run(brew, ['list', '--formula', '--versions'], { capture: true });
    const exists = installed.split('\n').some((line) => line.split(/\s+/)[0] === formula);
    await run(brew, [exists ? 'upgrade' : 'install', formula]);
  }
  const information = JSON.parse(await run(brew, ['info', '--json=v2', 'php', 'composer'], { capture: true }));
  for (const formula of information.formulae || []) {
    log(`${formula.name}: stable ${formula.versions.stable}; installed ${formula.installed.map((item) => item.version).join(', ') || 'none'}`);
  }
  let pathReady = true;
  const selectedDirectories = [];
  for (const name of ['php', 'composer']) {
    const prefix = (await run(brew, ['--prefix', name], { capture: true })).trim();
    const filename = path.join(prefix, 'bin', name);
    const selected = await executableAt(filename);
    if (!selected) throw new Error(`${name} was installed but its executable is missing at ${filename}. Inspect Homebrew output and rerun setup.`);
    selectedDirectories.push(path.dirname(filename));
    const active = await onPath(name);
    log(`${name} selected executable: ${filename}`);
    if (selected !== active) {
      pathReady = false;
      log(`${name} in the current PATH: ${active || 'not found'}. Your shell is not using the selected installation yet.`);
    }
  }
  if (pathReady) log('PHP and Composer are installed and selected by the current PATH.');
  else log(`PHP and Composer are installed; shell configuration is still required. Add these directories before other PHP/Composer entries in your shell PATH: ${selectedDirectories.join(', ')}. Open a new terminal afterward. See https://docs.brew.sh/Installation#post-installation-steps. Nexia did not edit your shell configuration.`);
  log('Existing non-Homebrew installations were not modified.');
  return { pathReady };
}
