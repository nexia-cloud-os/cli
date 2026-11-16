import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFrontendHmr } from '../src/frontend-hmr.js';

class Worker extends EventEmitter {
  connected = true;
  exitCode = null;
  signalCode = null;
  constructor({ failStart = false, failPublish = false, spawnError = false, pipeError = false } = {}) { super(); this.failStart = failStart; this.failPublish = failPublish; this.spawnError = spawnError; this.pipeError = pipeError; }
  send(message, callback) {
    if (message.type === 'close') return setTimeout(() => { this.exitCode = 0; this.emit('exit', 0); }, 20);
    if (message.type === 'start' && this.spawnError) return queueMicrotask(() => this.emit('error', new Error('spawn failed')));
    if (message.type === 'start' && this.pipeError) return queueMicrotask(() => callback(new Error('IPC closed')));
    queueMicrotask(() => this.emit('message', (message.type === 'start' && this.failStart) || (message.type === 'publish' && this.failPublish)
      ? { type: 'error', id: message.id, message: 'fixture failure' }
      : { type: message.type === 'start' ? 'ready' : 'published', id: message.id, port: 1234, wsToken: 'private' }));
  }
  kill() { this.exitCode = 1; this.emit('exit', 1); }
}
async function fixture(t, createWorker, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'nexia-hmr-worker-test-'));
  await writeFile(path.join(dir, 'vite.config.mjs'), "import { nexiaAppConfig } from '@nexia/sdk/vite';\nexport default nexiaAppConfig(import.meta.url);\n");
  const hmr = createFrontendHmr(dir, { forkWorker: createWorker, ...options });
  t.after(async () => { await hmr.close(); await rm(dir, { recursive: true, force: true }); });
  await hmr.approve({ digest: 'a', files: [] });
  return hmr;
}
const start = hmr => hmr.start('a'.repeat(64), {}, 'https://host/refresh.js');

test('a failed start waits for its own worker exit before another starts', async t => {
  const workers = [];
  const hmr = await fixture(t, () => { const worker = new Worker({ failStart: workers.length === 0 }); workers.push(worker); return worker; });
  await assert.rejects(start(hmr), /fixture failure/);
  assert.equal(workers[0].exitCode, 0);
  assert.equal((await start(hmr)).port, 1234);
  assert.equal(workers.length, 2);
});

test('failed snapshot publication closes its worker and prevents stale restart', async t => {
  const workers = [];
  const hmr = await fixture(t, () => { const worker = new Worker({ failPublish: workers.length === 0 }); workers.push(worker); return worker; });
  await start(hmr);
  await assert.rejects(hmr.approve({ digest: 'b', files: [] }), /fixture failure/);
  assert.equal(hmr.endpoint(), null);
  assert.equal(workers[0].exitCode, 0);
  await assert.rejects(start(hmr), /approved source snapshot/);
  await hmr.approve({ digest: 'b', files: [] });
  assert.equal((await start(hmr)).port, 1234);
});

test('spawn failure rejects without waiting for an exit that never arrives', async t => {
  const workers = [];
  const hmr = await fixture(t, () => { const worker = new Worker({ spawnError: workers.length === 0 }); workers.push(worker); return worker; });
  await assert.rejects(start(hmr), /spawn failed/);
  assert.equal((await start(hmr)).port, 1234);
});

test('a closed IPC channel rejects and cleans up the task worker', async t => {
  const worker = new Worker({ pipeError: true });
  const hmr = await fixture(t, () => worker);
  await assert.rejects(start(hmr), /IPC closed/);
  assert.equal(worker.exitCode, 0);
});

test('a stuck task-owned worker is killed before a replacement starts', async t => {
  const signals = [];
  class StuckWorker extends Worker {
    send(message) { if (message.type !== 'close') super.send(message); }
    kill(signal) { signals.push(signal); if (signal === 'SIGKILL') super.kill(); }
  }
  const hmr = await fixture(t, () => new StuckWorker({ failStart: true }), { terminationMs: 10 });
  await assert.rejects(start(hmr), /fixture failure/);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('suspending an inactive runtime closes HMR and requires a newly approved snapshot', async t => {
  const workers = [];
  const hmr = await fixture(t, () => { const worker = new Worker(); workers.push(worker); return worker; });
  await start(hmr); await hmr.suspend();
  assert.equal(hmr.endpoint(), null);
  assert.equal(workers[0].exitCode, 0);
  await assert.rejects(start(hmr), /approved source snapshot/);
  await hmr.approve({ digest: 'b', files: [] });
  assert.equal((await start(hmr)).port, 1234);
});
