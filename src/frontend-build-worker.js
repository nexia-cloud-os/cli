import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdir, cp, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { removeSession, removeSessionAssets, translationSessionPlugins, validateSessionAssets, validateSessionTree } from './frontend-session.js';

const [viteEntry, directory, output] = process.argv.slice(2);
const { build } = await import(pathToFileURL(viteEntry).href);
// Rollup watches existing imports, but a newly generated glob match may not
// invalidate its importer. Recreate the graph when the resources layout changes.
async function resourceLayout() {
  try { return JSON.stringify((await readdir(path.join(directory, 'resources'), { recursive: true })).sort()); }
  catch (error) { if (error.code === 'ENOENT') return '[]'; throw error; }
}
let watcher, watcherSession, layout, timer;
let closing = false;
const snapshots = new Set();
const ownedSnapshots = new Set();
const sessions = new Set();
const retainedSessions = new Set();
const pendingCopies = new Set();
const pendingStarts = new Set();
const pendingRetirements = new Set();
async function start() {
  const operation = startWatcher();
  pendingStarts.add(operation);
  try { await operation; } finally { pendingStarts.delete(operation); }
}
async function startWatcher() {
  process.send?.({ phase: 'building' });
  layout = await resourceLayout();
  // Mounted pages may still lazy-load a content-hashed chunk from the previous
  // build while the developer preserves a draft. Do not delete those chunks.
  let pendingSnapshot = Promise.resolve(), previousAssets = [], failedCandidates = [], cleaning, cleanupBlocked = false;
  const session = translationSessionPlugins(async () => {
    if (cleaning) return cleaning;
    cleaning = (async () => {
      await pendingSnapshot;
      if (cleanupBlocked) throw new Error('Translation session ownership is uncertain; restart the watcher.');
      if (previousAssets.length) {
        try {
          if (!(await removeSessionAssets(session.getSession(), previousAssets))) throw new Error('Translation session cleanup could not be verified.');
        } catch (error) {
          cleanupBlocked = true; retainedSessions.add(session.getSession()); throw error;
        }
        previousAssets = [];
      }
      if (failedCandidates.length) {
        try {
          if (!(await removeSessionAssets(session.getSession(), failedCandidates, { allowMissing: true }))) throw new Error('Failed translation session cleanup could not be verified.');
        } catch (error) {
          cleanupBlocked = true; retainedSessions.add(session.getSession()); throw error;
        }
        failedCandidates = [];
      }
    })();
    try { await cleaning; } finally { cleaning = undefined; }
  }, created => sessions.add(created));
  const current = await build({ logLevel: output === 'verbose' ? 'info' : 'warn', root: directory, configFile: path.join(directory, 'vite.config.mjs'), plugins: session.plugins, build: { watch: {}, emptyOutDir: false } });
  if (!current || typeof current.on !== 'function') throw new Error('Vite did not start a build watcher.');
  if (closing) { await current.close(); return; }
  watcher = current;
  watcherSession = session.getSession();
  let failed = false, cycle = 0;
  current.on('event', async event => {
    if (closing || watcher !== current) return;
    if (event.code === 'START') { failed = false; cycle++; process.send?.({ phase: 'building' }); }
    if (event.code === 'ERROR') {
      if (session.getSession()) {
        try { failedCandidates = [...new Set([...failedCandidates, ...session.failedAssets()])]; }
        catch (error) { console.error(error); cleanupBlocked = true; retainedSessions.add(session.getSession()); failed = true; process.send?.({ phase: 'failed', detail: 'Invalid failed translation asset list.' }); return; }
      }
      const detail = String(event.error?.stack || event.error?.message || 'Frontend build failed.').slice(0, 8192);
      console.error(detail); failed = true; cycle++; process.send?.({ phase: 'failed', detail: detail.split(/\r?\n/, 1)[0].slice(0, 240) });
    }
    if (event.code === 'END' && !failed) {
      const completedCycle = cycle;
      pendingSnapshot = (async () => {
        const activeSession = session.getSession();
        let assets;
        try { assets = activeSession ? await session.currentAssets() : undefined; }
        catch (error) { cleanupBlocked = true; retainedSessions.add(activeSession); throw error; }
        // Even a superseded copy belongs to this session and must be retired
        // before the next build writes its assets.
        if (activeSession) previousAssets = assets;
        const unchanged = layout === await resourceLayout();
        if (!closing && watcher === current && cycle === completedCycle && !failed && unchanged) {
          const generation = randomUUID();
          let destination = path.join(directory, 'dist', 'frontend-generations', generation);
          if (activeSession) {
            const root = await realpath(directory);
            for (const name of ['dist', 'dist/frontend-generations']) {
              const target = path.join(root, name);
              try { await mkdir(target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
              const info = await lstat(target);
              if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe frontend generation directory.');
            }
            destination = path.join(root, 'dist', 'frontend-generations', generation);
            await mkdir(destination, { mode: 0o700 });
            const info = await lstat(destination);
            if (!info.isDirectory() || info.isSymbolicLink() || await realpath(destination) !== destination) throw new Error('Unsafe frontend generation directory.');
            ownedSnapshots.add({ root: destination, dev: info.dev, ino: info.ino });
          } else {
            snapshots.add(destination);
            await mkdir(path.dirname(destination), { recursive: true });
          }
          const source = activeSession?.root ?? path.join(directory, 'dist', 'frontend');
          const reserved = path.join(source, 'i18n/v1');
          if (activeSession) await validateSessionTree(activeSession);
          const options = { recursive: true, errorOnExist: true, force: false,
            ...(assets ? { filter: file => file !== reserved && file.startsWith(reserved + path.sep)
              ? assets.some(name => path.join(source, name) === file || path.join(source, name).startsWith(file + path.sep)) : true } : {}) };
          if (activeSession) {
            for (const name of await readdir(source)) await cp(path.join(source, name), path.join(destination, name), options);
          } else await cp(source, destination, options);
          if (activeSession) {
            const root = await realpath(destination);
            const info = await lstat(root);
            const copied = { root, dev: info.dev, ino: info.ino };
            await validateSessionTree(copied);
            await validateSessionAssets(copied, { generatedFiles: () => assets }, assets);
          }
          if (!closing && watcher === current && cycle === completedCycle && !failed && layout === await resourceLayout()) {
            process.send?.({ phase: 'ready', snapshot: generation });
          }
        }
      })().catch(async error => {
        console.error(error);
        if (session.getSession()) {
          retainedSessions.add(session.getSession());
          if (!closing && watcher === current && cycle === completedCycle) {
            failed = true; process.send?.({ phase: 'failed', detail: String(error.message).slice(0, 240) });
          }
        }
        else await close();
      });
      if (session.getSession()) {
        const copy = pendingSnapshot;
        pendingCopies.add(copy);
        void copy.finally(() => pendingCopies.delete(copy));
      }
    }
  });
}
async function checkLayout() {
  if (closing) return;
  let sessionTransition = false;
  try {
    if (await resourceLayout() !== layout) {
      process.send?.({ phase: 'building' });
      const previous = watcher;
      const previousSession = watcherSession;
      sessionTransition = Boolean(previousSession);
      const retirement = (async () => {
        try {
          await previous.close();
          if (previousSession) {
            await Promise.all([...pendingCopies]);
            if (!retainedSessions.has(previousSession)) {
              try { if (await removeSession(previousSession)) sessions.delete(previousSession); }
              catch { retainedSessions.add(previousSession); console.error('Frontend session could not be safely removed; it was retained.'); }
            }
          }
        } catch (error) {
          if (previousSession) retainedSessions.add(previousSession);
          throw error;
        }
      })();
      if (previousSession) pendingRetirements.add(retirement);
      watcher = null;
      watcherSession = undefined;
      try { await retirement; } finally { pendingRetirements.delete(retirement); }
      if (!closing) await start();
    }
    if (!closing) timer = setTimeout(checkLayout, 250);
  } catch (error) {
    console.error(error);
    if (sessionTransition) process.send?.({ phase: 'failed', detail: 'Frontend watcher could not be safely replaced; its files were retained.' });
    else await close();
  }
}
const close = async () => {
  if (closing) return;
  closing = true;
  clearTimeout(timer);
  await watcher?.close();
  if (sessions.size && (pendingStarts.size || pendingRetirements.size)) {
    console.error('Frontend startup was still active; its files were retained.');
    process.exit(0);
  }
  await Promise.all([...pendingCopies]);
  await Promise.all([...snapshots].map(directory => rm(directory, { recursive: true, force: true })));
  for (const snapshot of ownedSnapshots) {
    try { await removeSession(snapshot); } catch { console.error('Frontend snapshot could not be safely removed; it was retained.'); }
  }
  for (const session of sessions) {
    if (retainedSessions.has(session)) { console.error('Frontend session was retained because its safety could not be verified.'); continue; }
    try { await removeSession(session); } catch { console.error('Frontend session could not be safely removed; it was retained.'); }
  }
  process.exit(0);
};
process.once('SIGTERM', close);
process.once('SIGINT', close);
process.once('disconnect', close);
await start();
if (!closing) timer = setTimeout(checkLayout, 250);
