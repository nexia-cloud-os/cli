import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

async function modified(file) {
  try { return (await stat(file)).mtimeMs; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

// Generated Apps use Vite's own incremental build; no App package script is run.
export async function startFrontendBuild(directory, { signal, onInvalidate = () => {} } = {}) {
  if (!(await modified(path.join(directory, 'vite.config.mjs')))) return null;
  const vite = path.join(directory, 'node_modules', 'vite', 'dist', 'node', 'index.js');
  if (!(await modified(vite))) throw new Error('Frontend dependencies are missing. Run npm install in this App, then retry nexia dev.');
  const manifest = path.join(directory, 'dist', 'frontend', '.vite', 'manifest.json');
  const entry = path.join(directory, 'dist', 'frontend', 'index.js');
  const worker = fileURLToPath(new URL('./frontend-build-worker.js', import.meta.url));
  const child = spawn(process.execPath, [worker, vite, directory], { cwd: directory, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  let failure, ready = false, generation = 0;
  child.on('message', message => {
    if (message?.phase === 'building') { ready = false; onInvalidate(); }
    if (message?.phase === 'ready') { ready = true; generation++; }
  });
  child.once('error', error => { failure = error; });
  child.once('exit', code => { failure = new Error(`Frontend build watcher stopped (${code}). Restart nexia dev after fixing the build.`); });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      child.once('close', resolve);
      child.kill('SIGTERM');
    });
  };
  try {
    const started = Date.now();
    while (!signal?.aborted) {
      const current = await modified(manifest);
      if (ready && current && (await modified(entry))) break;
      if (failure) throw failure;
      if (Date.now() - started > 120_000) throw new Error('Frontend build did not finish within two minutes. Check the Vite output.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (signal?.aborted) await close();
    else if (failure) throw failure;
    return signal?.aborted ? null : { close, ready: () => ready, generation: () => generation, check: () => { if (failure) throw failure; } };
  } catch (error) { await close(); throw error; }
}
