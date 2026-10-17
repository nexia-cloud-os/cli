import { pipeBuildLogs } from './dev-log.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

async function modified(file) {
  try { return (await stat(file)).mtimeMs; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

// Generated Apps use Vite's own incremental build; no App package script is run.
export async function startFrontendBuild(directory, { signal, verbose = false, log = console.log, onInvalidate = () => {}, onState = () => {} } = {}) {
  if (!(await modified(path.join(directory, 'vite.config.mjs')))) return null;
  const vite = path.join(directory, 'node_modules', 'vite', 'dist', 'node', 'index.js');
  if (!(await modified(vite))) throw new Error('Frontend dependencies are missing. Run npm install in this App, while nexia dev keeps watching.');
  const worker = fileURLToPath(new URL('./frontend-build-worker.js', import.meta.url));
  const child = spawn(process.execPath, [worker, vite, directory, verbose ? 'verbose' : 'warnings'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  for (const [stream, level] of [[child.stdout, 'info'], [child.stderr, 'warning']]) {
    pipeBuildLogs(stream, log, level, { verbose });
  }
  let failure, ready = false, failed = false, generation = 0, snapshot;
  child.on('message', message => {
    if (message?.phase === 'building') { ready = false; failed = false; onInvalidate(); onState('building'); }
    if (message?.phase === 'failed') { ready = false; failed = true; onInvalidate(); onState('failed', message.detail); }
    if (message?.phase === 'ready') { ready = true; failed = false; generation++; snapshot = message.snapshot; onState('ready'); }
  });
  child.once('error', error => { failure = error; });
  child.once('exit', code => { failure = new Error(`Frontend build watcher stopped (${code}). The development watcher will restart it automatically.`); });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      child.once('close', resolve);
      child.kill('SIGTERM');
    });
  };
  if (signal?.aborted) { await close(); return null; }
  return { close, ready: () => ready, failed: () => failed, generation: () => generation, snapshot: () => snapshot, check: () => { if (failure) throw failure; } };
}
