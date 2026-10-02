import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdir } from 'node:fs/promises';

const [viteEntry, directory] = process.argv.slice(2);
const { build } = await import(pathToFileURL(viteEntry).href);
// Rollup watches existing imports, but a newly generated glob match may not
// invalidate its importer. Recreate the graph when the resources layout changes.
async function resourceLayout() {
  try { return JSON.stringify((await readdir(path.join(directory, 'resources'), { recursive: true })).sort()); }
  catch (error) { if (error.code === 'ENOENT') return '[]'; throw error; }
}
let watcher, layout, timer;
let closing = false;
async function start() {
  process.send?.({ phase: 'building' });
  layout = await resourceLayout();
  const current = await build({ root: directory, configFile: path.join(directory, 'vite.config.mjs'), build: { watch: {} } });
  if (!current || typeof current.on !== 'function') throw new Error('Vite did not start a build watcher.');
  if (closing) { await current.close(); return; }
  watcher = current;
  let failed = false, cycle = 0;
  current.on('event', async event => {
    if (closing || watcher !== current) return;
    if (event.code === 'START') { failed = false; cycle++; process.send?.({ phase: 'building' }); }
    if (event.code === 'ERROR') { failed = true; cycle++; process.send?.({ phase: 'building' }); }
    if (event.code === 'END' && !failed) {
      try {
        const completedCycle = cycle;
        const unchanged = layout === await resourceLayout();
        if (!closing && watcher === current && cycle === completedCycle && !failed && unchanged) process.send?.({ phase: 'ready' });
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
  process.exit(0);
};
process.once('SIGTERM', close);
process.once('SIGINT', close);
process.once('disconnect', close);
await start();
if (!closing) timer = setTimeout(checkLayout, 250);
