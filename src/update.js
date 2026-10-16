import path from 'node:path';
import os from 'node:os';
import { readFile, writeFile, mkdir, realpath, lstat } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { onPath } from './setup.js';
import { message } from './input.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const day = 24 * 60 * 60 * 1000;
const manual = 'npm install -g @nexia/cli@alpha';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/;
function parts(version) {
  if (typeof version !== 'string' || version.length > 200) return null;
  const match = version.match(versionPattern);
  if (!match || match[4]?.split('.').some(item => /^\d+$/.test(item) && item.length > 1 && item[0] === '0')) return null;
  return [...match.slice(1, 4).map(BigInt), match[4]?.split('.')];
}
export function isNewer(candidate, current) {
  const a = parts(candidate), b = parts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  if (!a[3] || !b[3]) return !a[3] && Boolean(b[3]);
  for (let i = 0; i < Math.max(a[3].length, b[3].length); i++) {
    const x = a[3][i], y = b[3][i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return y === undefined;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y);
    return xn !== yn ? !xn : x > y;
  }
  return false;
}

export async function latestVersion(fetcher = fetch) {
  const options = () => ({ redirect: 'error', signal: AbortSignal.timeout(2000) });
  const response = await fetcher('https://registry.npmjs.org/@nexia%2fcli/alpha', options());
  if (!response.ok) throw new Error(`npm registry: HTTP ${response.status}`);
  const data = await response.json();
  if (data.name !== '@nexia/cli' || !parts(data.version)) throw new Error('Invalid CLI version from npm registry.');
  const exact = await fetcher(`https://registry.npmjs.org/@nexia%2fcli/${encodeURIComponent(data.version)}`, options());
  if (!exact.ok) throw new Error(`npm registry: ${data.version} is not installable yet (HTTP ${exact.status})`);
  const published = await exact.json();
  if (published.name !== '@nexia/cli' || published.version !== data.version) throw new Error('Invalid CLI release from npm registry.');
  return data.version;
}

export async function installCli(version, { root = packageRoot, platform = process.platform, findNpm = () => onPath('npm'), run = promisify(execFile), start = spawn } = {}) {
  if (!parts(version)) throw new Error('Invalid CLI update version.');
  // shortcut: Windows uses manual npm updates until a native npm launcher is supported.
  if (platform === 'win32') throw new Error(`Run ${manual} in your terminal.`);
  const npm = await findNpm();
  if (!npm) throw new Error(`npm was not found. Run ${manual} after installing npm.`);
  const { stdout } = await run(npm, ['root', '--global'], { cwd: os.homedir(), timeout: 5000, maxBuffer: 8192 });
  const globalPackage = path.join(stdout.trim(), '@nexia', 'cli');
  if ((await lstat(globalPackage).catch(() => null))?.isSymbolicLink()) throw new Error('This CLI is npm-linked source. Update the source checkout instead.');
  const target = await realpath(globalPackage).catch(() => null);
  if (target !== await realpath(root)) throw new Error(`This CLI is not the active npm global installation. Use its original package manager or run ${manual}.`);
  await new Promise((resolve, reject) => {
    const child = start(npm, ['install', '--global', `@nexia/cli@${version}`, '--registry=https://registry.npmjs.org/'], { cwd: os.homedir(), shell: false, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`CLI update failed (${signal || code}). Check npm output, then retry ${manual}.`)));
  });
  const installed = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'));
  if (installed.version !== version) throw new Error(`Could not verify CLI update. Run nexia --version and check your npm installation.`);
}

export async function updateCli(input, options = {}, {
  automatic = false, fresh = false, current, getLatest = latestVersion, installVersion = installCli,
  cacheFile = path.join(process.env.NEXIA_CONFIG_HOME || path.join(os.homedir(), '.config', 'nexia'), 'update.json'),
  now = Date.now(), env = process.env, log = console.error, onChecked = () => {},
  installedGlobally = path.normalize(packageRoot).replace(/[\\/]$/, '').endsWith(path.join('node_modules', '@nexia', 'cli')),
} = {}) {
  if (automatic && (!input.interactive || env.CI || options.json || options['no-interactive'] || options['dry-run'] || options.yes || !installedGlobally)) return false;
  current ??= JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  let cache = {};
  if (automatic) {
    try { cache = JSON.parse(await readFile(cacheFile, 'utf8')) || {}; } catch {}
  }
  const recent = value => Number.isFinite(value) && value <= now && now - value < day;
  const recentCheck = automatic && recent(cache.checkedAt);
  let latest = recentCheck && parts(cache.latest) ? cache.latest : null;
  let checkFailed = recentCheck && !latest;
  if (fresh) { latest = null; checkFailed = false; }
  if (!latest && !(recentCheck && !fresh)) {
    try { latest = await getLatest(); }
    catch (error) {
      checkFailed = true;
      if (!automatic) throw new Error(`Could not check CLI updates: ${error.message}. Retry nexia update or run ${manual}.`);
    }
    cache = { ...cache, checkedAt: now, latest, failed: checkFailed };
    if (automatic) await saveCache();
  }
  onChecked({ current, latest, updateAvailable: Boolean(latest && isNewer(latest, current)), checkFailed });
  if (!latest || !isNewer(latest, current)) {
    if (!automatic) log(message(`No newer alpha release (installed: ${current}).`, `새 alpha 버전이 없습니다 (설치 버전: ${current}).`));
    return false;
  }
  if (automatic && cache.skippedVersion === latest) return false;
  const summary = message(`Nexia update: ${current} → ${latest}`, `Nexia 새 버전: ${current} → ${latest}`);
  if (automatic) {
    const action = await input.choice('cli-update', summary, [
      { value: 'update', label: message('Update', '업데이트') },
      { value: 'skip', label: message('Skip', '건너뛰기') },
      { value: 'skip-version', label: message('Skip Until Next Version', '다음 버전까지 건너뛰기') },
    ], 'skip');
    if (action === 'skip-version') { cache.skippedVersion = latest; await saveCache(); }
    if (action !== 'update') return false;
  }
  log(`${summary}\nnpm install -g @nexia/cli@${latest}`);
  if (options['dry-run']) return false;
  input.close();
  await installVersion(latest);
  log(message(`Updated to ${latest}. Run your command again.`, `${latest} 버전으로 업데이트했습니다. 명령을 다시 실행하세요.`));
  return true;

  async function saveCache() {
    try {
      await mkdir(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
      await writeFile(cacheFile, JSON.stringify(cache), { mode: 0o600 });
    } catch { /* Update checks must not prevent the original command when the cache is unwritable. */ }
  }
}
