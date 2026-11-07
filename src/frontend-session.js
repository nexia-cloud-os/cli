import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readFile, readdir, realpath, rm, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const indexPattern = /^i18n\/v1\/index-([a-f0-9]{64})\.json$/;
const partPattern = /^i18n\/v1\/(en|ko|zh)\/[a-z][a-z0-9-]{0,63}-([a-f0-9]{64})\.json$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const parseJson = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));

async function flattenPlugins(values) {
  return (await Promise.all(values.map(async value => {
    const resolved = await value;
    return Array.isArray(resolved) ? flattenPlugins(resolved) : [resolved];
  }))).flat();
}

async function noNestedMount(root) {
  let points;
  if (process.platform === 'linux') {
    const text = await readFile('/proc/self/mountinfo', 'utf8');
    points = text.trim().split('\n').map(line => line.split(' ')[4]?.replace(/\\(040|011|012|134)/g, (_, code) => String.fromCharCode(parseInt(code, 8))));
  } else if (process.platform === 'darwin') {
    const { stdout, stderr } = await run('/sbin/mount', [], { timeout: 5000, maxBuffer: 1024 * 1024 });
    if (stderr) return false;
    points = stdout.trim().split('\n').map(line => /^.+ on (.+) \([^)]+\)$/.exec(line)?.[1]);
  } else return false;
  for (const point of points) {
    if (!point) return false;
    let canonical;
    try { canonical = await realpath(point); } catch { return false; }
    if (canonical === root || canonical.startsWith(root + path.sep)) return false;
  }
  return true;
}

async function sessionPath(session, relative = '') {
  const root = await lstat(session.root);
  if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== session.dev || root.ino !== session.ino
      || await realpath(session.root) !== session.root) throw new Error('Frontend session identity changed.');
  if (!relative) return session.root;
  if (path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid frontend session path.');
  let current = session.root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || info.dev !== session.dev) throw new Error('Linked or mounted frontend session path.');
  }
  return current;
}

async function safeBytes(session, name, limit) {
  const file = await sessionPath(session, name);
  const info = await lstat(file);
  if (!info.isFile() || info.size > limit) throw new Error('Invalid frontend session asset.');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new Error('Frontend session asset changed.');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== info.size || after.size !== info.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('Frontend session asset changed.');
    return bytes;
  } finally { await handle.close(); }
}

export async function validateSessionAssets(session, sdk, bundleFiles) {
  const host = parseJson(await safeBytes(session, 'nexia-host.json', 16384));
  const marker = host?.translation_partitions;
  const indexMatch = typeof marker?.index === 'string' && indexPattern.exec(marker.index);
  if (host?.version !== 1 || marker?.version !== 1 || !indexMatch || !/^[a-z][a-z0-9-]*$/.test(host.app_key ?? '')) throw new Error('Invalid translation session metadata.');
  const indexBytes = await safeBytes(session, marker.index, 16384);
  if (sha256(indexBytes) !== indexMatch[1]) throw new Error('Translation index digest mismatch.');
  const index = parseJson(indexBytes);
  if (index?.version !== 1 || index.app_key !== host.app_key || JSON.stringify(index.locales) !== '["en","ko","zh"]'
      || !index.parts || Array.isArray(index.parts) || typeof index.parts !== 'object'
      || !index.scopes || Array.isArray(index.scopes) || typeof index.scopes !== 'object') throw new Error('Invalid translation index.');
  const partIds = Object.keys(index.parts), scopeIds = Object.keys(index.scopes);
  if (!partIds.length || partIds.length > 64 || partIds.some(id => !/^[a-z][a-z0-9-]{0,63}$/.test(id))
      || !scopeIds.length || scopeIds.length > 128 || scopeIds.some(id => !/^(?:route|widget|form|profile):[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(id))) throw new Error('Invalid translation scope.');
  const used = new Set();
  for (const references of [index.registration, ...Object.values(index.scopes)]) {
    if (!Array.isArray(references) || references.length > 32 || new Set(references).size !== references.length
        || references.some(id => typeof id !== 'string' || !Object.hasOwn(index.parts, id))) throw new Error('Invalid translation part references.');
    references.forEach(id => used.add(id));
  }
  if (partIds.some(id => !used.has(id))) throw new Error('Unreferenced translation part.');
  const names = new Set([marker.index]);
  const bytesByLocale = { en: 0, ko: 0, zh: 0 };
  const valuesByLocale = { en: new Map(), ko: new Map(), zh: new Map() };
  const prefixes = [`${host.app_key}.`, ...['groups', 'keys', 'resources', 'role_presets'].map(type => `permissions.${type}.${host.app_key}.`)];
  for (const part of Object.values(index.parts)) {
    if (!part || Array.isArray(part) || typeof part !== 'object' || Object.keys(part).sort().join(',') !== 'en,ko,zh') throw new Error('Invalid translation part.');
    for (const locale of ['en', 'ko', 'zh']) {
      const name = part[locale];
      const match = typeof name === 'string' && partPattern.exec(name);
      if (!match || match[1] !== locale || names.has(name)) throw new Error('Invalid translation part path.');
      const bytes = await safeBytes(session, name, 1024 * 1024);
      if (sha256(bytes) !== match[2]) throw new Error('Translation part digest mismatch.');
      const content = parseJson(bytes);
      if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('Invalid translation part content.');
      for (const [key, value] of Object.entries(content)) {
        if (!prefixes.some(prefix => key.startsWith(prefix)) || typeof value !== 'string' || !key.isWellFormed() || !value.isWellFormed()
            || (valuesByLocale[locale].has(key) && valuesByLocale[locale].get(key) !== value)) throw new Error('Invalid translation part content.');
        valuesByLocale[locale].set(key, value);
      }
      bytesByLocale[locale] += bytes.length;
      if (bytesByLocale[locale] > 1024 * 1024) throw new Error('Translation parts exceed locale limit.');
      names.add(name);
    }
  }
  const generated = sdk.generatedFiles();
  if (!Array.isArray(generated) || new Set(generated).size !== generated.length
      || generated.length !== names.size || generated.some(name => !names.has(name))) throw new Error('Translation SDK output does not match its index.');
  const reserved = bundleFiles.filter(name => name.startsWith('i18n/v1/'));
  if (reserved.length !== names.size || reserved.some(name => !names.has(name))) throw new Error('Translation session output collision.');
  return [...names];
}

export function translationSessionPlugins(waitForSnapshot, onSession = () => {}, environment = {}) {
  let session, sdk, publicDirectory, bundleFiles = [];
  const negotiate = {
    name: 'nexia:translation-session', enforce: 'pre',
    config: { order: 'pre', async handler(config) {
      const plugins = await flattenPlugins(config.plugins ?? []);
      const candidates = plugins.filter(plugin => plugin?.name === 'nexia:app-services' && plugin.api?.nexiaTranslationSession?.version === 1);
      if (!candidates.length) return;
      if (candidates.length !== 1) throw new Error('Multiple translation session providers.');
      sdk = candidates[0].api.nexiaTranslationSession;
      if (typeof sdk.acceptSession !== 'function' || typeof sdk.generatedFiles !== 'function') throw new Error('Invalid translation session provider.');
      // Older producers cannot identify files from a failed build; keep their full-catalog path.
      if (typeof sdk.candidateFiles !== 'function') return;
      if (!['linux', 'darwin'].includes(environment.platform ?? process.platform)) return;
      const parent = await realpath(tmpdir());
      const root = await mkdtemp(path.join(parent, 'nexia-frontend-'));
      const created = await lstat(root);
      const removeEmpty = async () => {
        const current = await lstat(root);
        if (current.isDirectory() && !current.isSymbolicLink() && current.dev === created.dev && current.ino === created.ino) await rmdir(root);
      };
      try {
        if (!(await (environment.checkMount ?? noNestedMount)(root))) { await removeEmpty(); return; }
      } catch {
        // Retain the private directory if either the check or its safe removal is unavailable.
        try { await removeEmpty(); } catch {}
        return;
      }
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== created.dev || info.ino !== created.ino || (info.mode & 0o077) !== 0
          || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('Frontend session is not private.');
      session = { root, dev: info.dev, ino: info.ino };
      onSession(session);
      await sdk.acceptSession({ outDir: root, waitForSnapshot });
    } },
    configResolved(config) {
      if (!session) return;
      if (path.resolve(config.root, config.build.outDir) !== session.root) throw new Error('Translation session outDir was not accepted.');
      publicDirectory = config.publicDir;
    },
    buildStart: { order: 'pre', sequential: true, async handler() { if (session) await waitForSnapshot(); } },
  };
  const guard = {
    name: 'nexia:translation-session-guard', enforce: 'post',
    outputOptions: { order: 'post', handler(options) {
      if (session && (options.file || path.resolve(options.dir ?? '') !== session.root)) throw new Error('Translation session output escaped its directory.');
    } },
    writeBundle: { order: 'post', handler(_options, bundle) { if (session) bundleFiles = Object.keys(bundle); } },
  };
  return {
    plugins: [negotiate, guard],
    getSession: () => session,
    failedAssets() {
      if (!session) return [];
      const files = sdk.candidateFiles();
      if (!Array.isArray(files) || files.length > 193 || new Set(files).size !== files.length
          || files.some(name => typeof name !== 'string' || !(indexPattern.test(name) || partPattern.test(name)))) throw new Error('Invalid failed translation asset list.');
      return files;
    },
    async currentAssets() {
      if (!session) return undefined;
      if (publicDirectory) {
        try { await lstat(path.join(publicDirectory, 'i18n/v1')); throw new Error('Public assets use the reserved translation directory.'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return validateSessionAssets(session, sdk, bundleFiles);
    },
  };
}

export async function removeSessionAssets(session, names, { allowMissing = false } = {}) {
  if (!session || !names.length || !(await noNestedMount(session.root))) return false;
  await sessionPath(session);
  const present = [];
  for (const name of names) {
    const match = indexPattern.exec(name) || partPattern.exec(name);
    if (!match) throw new Error('Invalid translation session cleanup path.');
    const expected = match.at(-1);
    let bytes;
    try { bytes = await safeBytes(session, name, 1024 * 1024); }
    catch (error) {
      if (error.code !== 'ENOENT' || !allowMissing) throw error;
      await sessionPath(session);
      continue;
    }
    if (sha256(bytes) !== expected) throw new Error('Translation session asset changed before cleanup.');
    present.push(name);
  }
  for (const name of present) await unlink(await sessionPath(session, name));
  await sessionPath(session);
  return true;
}

export async function validateSessionTree(session) {
  if (!session || !(await noNestedMount(session.root))) throw new Error('Frontend session mount could not be verified.');
  async function check(directory) {
    for (const entry of await readdir(directory)) {
      const file = path.join(directory, entry), info = await lstat(file);
      if (info.isSymbolicLink() || info.dev !== session.dev) throw new Error('Unsafe frontend session contents.');
      if (info.isDirectory()) await check(file);
    }
  }
  await sessionPath(session);
  await check(session.root);
}

export async function removeSession(session) {
  if (!session) return false;
  await validateSessionTree(session);
  await rm(session.root, { recursive: true });
  return true;
}
