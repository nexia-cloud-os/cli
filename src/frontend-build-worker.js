import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdir, cp, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const [viteEntry, directory, output] = process.argv.slice(2);
const { build } = await import(pathToFileURL(viteEntry).href);
// Rollup watches existing imports, but a newly generated glob match may not
// invalidate its importer. Recreate the graph when the resources layout changes.
async function resourceLayout() {
  try { return JSON.stringify((await readdir(path.join(directory, 'resources'), { recursive: true })).sort()); }
  catch (error) { if (error.code === 'ENOENT') return '[]'; throw error; }
}
let watcher, layout, timer;
let closing = false;
const snapshots = new Set();
async function start() {
  process.send?.({ phase: 'building' });
  layout = await resourceLayout();
  // Mounted pages may still lazy-load a content-hashed chunk from the previous
  // build while the developer preserves a draft. Do not delete those chunks.
  const current = await build({ logLevel: output === 'verbose' ? 'info' : 'warn', root: directory, configFile: path.join(directory, 'vite.config.mjs'), build: { watch: {}, emptyOutDir: false } });
  if (!current || typeof current.on !== 'function') throw new Error('Vite did not start a build watcher.');
  if (closing) { await current.close(); return; }
  watcher = current;
  let failed = false, cycle = 0;
  current.on('event', async event => {
    if (closing || watcher !== current) return;
    if (event.code === 'START') { failed = false; cycle++; process.send?.({ phase: 'building' }); }
    if (event.code === 'ERROR') { console.error(event.error?.stack || event.error?.message || 'Frontend build failed.'); failed = true; cycle++; process.send?.({ phase: 'failed' }); }
    if (event.code === 'END' && !failed) {
      try {
        const completedCycle = cycle;
        const unchanged = layout === await resourceLayout();
        if (!closing && watcher === current && cycle === completedCycle && !failed && unchanged) {
          const generation = randomUUID();
          const destination = path.join(directory, 'dist', 'frontend-generations', generation);
          snapshots.add(destination);
          await mkdir(path.dirname(destination), { recursive: true });
          await cp(path.join(directory, 'dist', 'frontend'), destination, { recursive: true, errorOnExist: true, force: false });
          if (!closing && watcher === current && cycle === completedCycle && !failed && layout === await resourceLayout()) {
            process.send?.({ phase: 'ready', snapshot: generation });
          }
        }
      } catch (error) { console.error(error); await close(); }
    }
  });
}
async function checkLayout() {
  if (closing) return;
  try {
    if (await resourceLayout() !== layout) {
      process.send?.({ phase: 'building' });
      const previous = watcher;
      watcher = null;
      await previous.close();
      if (!closing) await start();
    }
    if (!closing) timer = setTimeout(checkLayout, 250);
  } catch (error) { console.error(error); await close(); }
}
const close = async () => {
  if (closing) return;
  closing = true;
  clearTimeout(timer);
  await watcher?.close();
  await Promise.all([...snapshots].map(directory => rm(directory, { recursive: true, force: true })));
  process.exit(0);
};
process.once('SIGTERM', close);
process.once('SIGINT', close);
process.once('disconnect', close);
await start();
if (!closing) timer = setTimeout(checkLayout, 250);
