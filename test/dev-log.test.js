import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startNativePreview } from '../src/native-preview.js';
import { watchRuntimeLogs } from '../src/runtime-logs.js';

test('browser diagnostics require the workspace origin, private App token and live selection', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'dist/frontend'), { recursive: true });
  await writeFile(path.join(root, 'dist/frontend/index.js'), 'export {};');
  let state = { operation_id: 'operation' };
  const logs = [], origin = 'http://workspace.localhost:8081';
  const server = await startNativePreview(root, { port: 0, workspaceOrigin: origin, state: () => state, log: line => logs.push(line) });
  t.after(() => server.close());
  const manifest = await fetch(`${server.url}/__nexia_native`, { headers: { Origin: origin } }).then(r => r.json());
  const url = new URL('__nexia_diagnostics', manifest.entry);
  const send = (body, from = origin, target = url) => fetch(target, { method: 'POST', headers: { Origin: from, 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
  assert.equal((await send([{ level: 'error', message: 'Boom\n\x1b[2Jframe' }])).status, 204);
  assert.equal(logs.length, 2);
  assert.equal(manifest.verbose_logs, false);
  assert.equal((await send([{ level: 'info', message: 'quiet by default' }])).status, 204);
  assert.equal(logs.length, 2);
  assert.ok(logs.every(line => !line.includes('\x1b[2J')));
  assert.equal((await send([], 'http://evil.example')).status, 403);
  assert.equal((await send([], origin, `${server.url}/${'0'.repeat(64)}/__nexia_diagnostics`)).status, 404);
  assert.equal((await send([{ level: 'error', message: 'x'.repeat(20000) }])).status, 413);
  assert.equal((await send([{ level: 'invalid', message: 'x' }])).status, 400);
  state = null;
  assert.equal((await send([])).status, 404);
});

test('runtime logs advance a cursor, never write, and stop polling on cancellation', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const urls = [], logs = [], controller = new AbortController();
  globalThis.fetch = async (url, options) => {
    urls.push(url);
    assert.equal(options.method, 'GET');
    const second = urls.length === 2;
    if (second) controller.abort();
    return new Response(JSON.stringify({ operation_id: 'operation', cursor: 2, truncated: false,
      entries: second ? [] : [{ id: 2, level: 'error', message: 'PHP failure' }],
    }), { headers: { 'Content-Type': 'application/json' } });
  };
  const watcher = watchRuntimeLogs({ endpoint: 'http://127.0.0.1:4310', token: 'test' }, 'operation', { log: line => logs.push(line), signal: controller.signal, interval: 1 });
  await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
  await watcher.close();
  assert.match(urls[1], /after=2&verbose=0$/);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /PHP failure/);
});


test('build logs bound newline-free output and drop a flood after one warning', async () => {
  const { PassThrough } = await import('node:stream');
  const { pipeBuildLogs } = await import('../src/dev-log.js');
  const output = [], stream = new PassThrough();
  pipeBuildLogs(stream, line => output.push(line), 'info');
  stream.write(Buffer.alloc(1024 * 1024, 120));
  assert.equal(output.length, 1);
  assert.ok(output[0].length < 8300);
  stream.write('\nrecovered\n');
  assert.match(output[1], /recovered/);
  stream.end('line\n'.repeat(1000));
  await new Promise(resolve => stream.once('end', resolve));
  assert.equal(output.length, 121);
  assert.match(output.at(-1), /Log limit reached/);
});

test('default build output collapses verbose Vite reporter warnings', async () => {
  const { PassThrough } = await import('node:stream');
  const { pipeBuildLogs } = await import('../src/dev-log.js');
  const output = [], stream = new PassThrough();
  pipeBuildLogs(stream, line => output.push(line), 'warning');
  const warning = '[plugin:vite:reporter]\n(!) /long/path/module.ts is dynamically imported by /one.ts but also statically imported by /two.ts\n';
  stream.end(warning.repeat(20));
  await new Promise(resolve => stream.once('end', resolve));
  assert.equal(output.length, 1);
  assert.match(output[0], /mixed static\/dynamic imports/);
  assert.doesNotMatch(output[0], /long\/path/);
});


test('verbose is an explicit boolean dev option', async () => {
  const { parseCommand, validateOptions } = await import('../src/commands.js');
  const result = parseCommand(['dev', '--verbose']);
  assert.equal(result.options.verbose, true);
  validateOptions('dev', result.options);
});
