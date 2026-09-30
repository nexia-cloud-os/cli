import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [viteEntry, directory] = process.argv.slice(2);
const { build } = await import(pathToFileURL(viteEntry).href);
const watcher = await build({ root: directory, configFile: path.join(directory, 'vite.config.mjs'), build: { watch: {} } });
if (!watcher || typeof watcher.on !== 'function') throw new Error('Vite did not start a build watcher.');
let failed = false;
watcher.on('event', event => {
  if (event.code === 'START') { failed = false; process.send?.({ phase: 'building' }); }
  if (event.code === 'ERROR') { failed = true; process.send?.({ phase: 'building' }); }
  if (event.code === 'END' && !failed) process.send?.({ phase: 'ready' });
});
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await watcher.close();
  process.exit(0);
};
process.once('SIGTERM', close);
process.once('SIGINT', close);
process.once('disconnect', close);
