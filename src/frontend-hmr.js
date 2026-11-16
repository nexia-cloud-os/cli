import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The stable snapshot is supplied only after native-dev confirms the backend revision.
export function createFrontendHmr(directory, { forkWorker = fork, terminationMs = 5000 } = {}) {
  let child, approved, manifestSnapshot, started, serial = Promise.resolve(), closed = false, terminationUnconfirmed = false;
  const gatewayKey = randomBytes(32).toString('hex');
  let endpoint, binding;
  const waiters = new Map();
  const spawnFailures = new WeakSet();
  function failWaiters(error) { for (const waiter of waiters.values()) { clearTimeout(waiter.timer); waiter.reject(error); } waiters.clear(); }
  function enqueue(work) { const next = serial.then(work); serial = next.catch(() => {}); return next; }
  async function stopWorker(running) {
    if (!running) return;
    if (child === running) { endpoint = null; started = false; }
    if (spawnFailures.has(running)) return;
    if (running.exitCode !== null || running.signalCode !== null) return;
    await new Promise((resolve, reject) => {
      const term = setTimeout(() => running.kill('SIGTERM'), terminationMs);
      const kill = setTimeout(() => running.kill('SIGKILL'), terminationMs * 2);
      const deadline = setTimeout(() => { terminationUnconfirmed = true; reject(new Error('HMR worker termination was not confirmed. Restart development.')); }, terminationMs * 3);
      running.once('exit', () => { clearTimeout(term); clearTimeout(kill); clearTimeout(deadline); resolve(); });
      if (running.connected) running.send({ type: 'close' }, error => { if (error && running.exitCode === null) running.kill('SIGTERM'); });
      else running.kill('SIGTERM');
    });
  }
  function request(message, expected) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { waiters.delete(id); reject(new Error('HMR worker did not respond.')); }, 30_000);
      waiters.set(id, { expected, resolve, reject, timer });
      try { child.send({ ...message, id }, error => { if (error && waiters.has(id)) { clearTimeout(timer); waiters.delete(id); reject(error); } }); }
      catch (error) { clearTimeout(timer); waiters.delete(id); reject(error); }
    });
  }
  return {
    stage(snapshot) { manifestSnapshot = snapshot; },
    snapshot: () => manifestSnapshot,
    approve(snapshot) {
      return enqueue(async () => {
        if (terminationUnconfirmed) throw new Error('HMR worker termination was not confirmed. Restart development.');
        if (approved?.digest === snapshot.digest) return;
        if (child) {
          const running = child;
          try { await request({ type: 'publish', snapshot }, 'published'); }
          catch (error) { approved = undefined; await stopWorker(running); throw error; }
        }
        approved = snapshot;
      });
    },
    start(token, peers, refreshRuntime) {
      return enqueue(async () => {
        if (terminationUnconfirmed) throw new Error('HMR worker termination was not confirmed. Restart development.');
        if (closed || !approved) throw new Error('HMR is waiting for an approved source snapshot.');
        const requested = JSON.stringify([token, peers, refreshRuntime]);
        if (started) { if (binding !== requested) throw new Error('HMR host binding changed.'); return endpoint; }
        const config = await readFile(path.join(directory, 'vite.config.mjs'), 'utf8');
        if (!/^\s*import\s*\{\s*nexiaAppConfig\s*\}\s*from\s*['"]@nexia\/sdk\/vite['"];?\s*export\s+default\s+nexiaAppConfig\(import\.meta\.url\);?\s*$/.test(config)) throw new Error('Custom Vite configurations use compiled development.');
        child = forkWorker(fileURLToPath(new URL('./frontend-hmr-worker.js', import.meta.url)), [directory], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        const running = child;
        running.on('error', error => {
          if (child !== running) return;
          if (!running.pid) spawnFailures.add(running);
          child = null; started = false; endpoint = null;
          failWaiters(error);
        });
        running.on('message', message => {
          if (child !== running) return;
          const waiter = waiters.get(message.id);
          if (!waiter || (message.type !== waiter.expected && message.type !== 'error')) return;
          clearTimeout(waiter.timer); waiters.delete(message.id);
          if (message.type === 'error') waiter.reject(new Error(message.message)); else waiter.resolve(message);
        });
        running.once('exit', () => { if (child !== running) return; child = null; started = false; endpoint = null; failWaiters(new Error('HMR worker stopped.')); });
        try {
          const ready = await request({ type: 'start', snapshot: approved, peers, refreshRuntime, token, gatewayKey }, 'ready');
          endpoint = { port: ready.port, wsToken: ready.wsToken, gatewayKey }; binding = requested; started = true; return endpoint;
        } catch (error) { await stopWorker(running); throw error; }
      });
    },
    endpoint: () => endpoint,
    suspend() {
      return enqueue(async () => { approved = undefined; manifestSnapshot = undefined; await stopWorker(child); });
    },
    close() {
      closed = true;
      return enqueue(async () => {
        await stopWorker(child);
      });
    },
  };
}
