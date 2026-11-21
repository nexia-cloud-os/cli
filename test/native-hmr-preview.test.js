import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startNativePreview } from '../src/native-preview.js';

const origin = 'http://workspace.localhost:8081';
const names = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@tanstack/react-query', 'react-router-dom', 'react-i18next', '@nexia/sdk', '@nexia/sdk/host'];
const host = { peers: Object.fromEntries(names.map((name, i) => [name, `${origin}/build/sandbox-hmr/assets/${i}.js`])), refreshRuntime: `${origin}/build/sandbox-hmr/assets/refresh.js` };

test('HMR gateway admits only the selected App origin and closes upgraded sockets', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nexia-hmr-test-'));
  await mkdir(path.join(dir, 'dist/frontend'), { recursive: true });
  await writeFile(path.join(dir, 'dist/frontend/index.js'), 'export default 1;');
  let upgrade, workerSocket;
  const worker = createServer((req, res) => { assert.equal(req.headers['x-nexia-hmr-gateway'], 'worker-secret'); res.end('approved'); });
  worker.on('upgrade', (req, socket) => { upgrade = req; workerSocket = socket; socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'); });
  await new Promise(resolve => worker.listen(0, '127.0.0.1', resolve));
  let closed = false, suspended = false;
  const endpoint = { port: worker.address().port, gatewayKey: 'worker-secret', wsToken: 'vite-secret' };
  const hmr = { start: async () => endpoint, endpoint: () => endpoint, suspend: async () => { suspended = true; }, close: async () => { closed = true; } };
  const preview = await startNativePreview(dir, { workspaceOrigin: origin, port: 0, hmr,
    state: () => ({ operation_id: 'operation', app_id: 'app', app_key: 'demo', update_status: 'ready' }) });
  t.after(async () => { workerSocket?.destroy(); worker.closeAllConnections(); await new Promise(resolve => worker.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const headers = { Origin: origin };
  const manifest = await (await fetch(`${preview.url}/__nexia_native`, { headers })).json();
  const token = new URL(manifest.entry).pathname.split('/')[1];
  const start = `${preview.url}/${token}/__nexia_hmr_start`;
  assert.equal((await fetch(start, { method: 'POST', headers: { Origin: 'http://evil.test' }, body: JSON.stringify(host) })).status, 403);
  assert.equal((await fetch(start, { method: 'POST', headers, body: JSON.stringify({ ...host, peers: {} }) })).status, 409);
  const response = await fetch(start, { method: 'POST', headers, body: JSON.stringify(host) });
  assert.equal(response.status, 200);
  const { entry } = await response.json();
  assert.equal(await (await fetch(entry, { headers })).text(), 'approved');
  assert.equal((await fetch(entry, { headers: { Origin: 'http://evil.test' } })).status, 403);
  assert.equal((await fetch(entry.replace(token, '0'.repeat(64)), { headers })).status, 404);
  assert.equal((await fetch(`${preview.url}/${token}/__nexia_vite/src/private.php`, { headers })).status, 404);
  assert.equal(await (await fetch(`${preview.url}/${token}/__nexia_vite/resources/data-migrations.json?import`, { headers })).text(), 'approved');
  assert.equal(await (await fetch(`${preview.url}/${token}/__nexia_vite/resources/data/icons/people.svg?raw`, { headers })).text(), 'approved');
  assert.equal((await fetch(`${preview.url}/${token}/__nexia_vite/resources/data/private.php?import`, { headers })).status, 404);
  assert.equal((await fetch(`${preview.url}/${token}/__nexia_vite/resources/.env`, { headers })).status, 404);
  const address = new URL(preview.url);
  const socket = connect(Number(address.port), address.hostname);
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(`GET /${token}/__nexia_vite/@vite/__nexia_hmr HTTP/1.1\r\nHost: ${address.host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`);
  const first = await new Promise(resolve => socket.once('data', value => resolve(value.toString())));
  assert.match(first, /^HTTP\/1\.1 101/);
  assert.equal(upgrade.headers['x-nexia-hmr-gateway'], 'worker-secret');
  assert.match(upgrade.url, /token=vite-secret/);
  const ended = new Promise(resolve => socket.once('close', resolve));
  socket.resume(); await preview.suspendHmr(); await ended;
  assert.equal(suspended, true);
  assert.equal((await fetch(entry, { headers })).status, 404);
  await preview.close();
  assert.equal(closed, true);
});

test('a suspended App cannot admit a late HMR start', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nexia-hmr-race-'));
  await mkdir(path.join(dir, 'dist/frontend'), { recursive: true });
  await writeFile(path.join(dir, 'dist/frontend/index.js'), 'export default 1;');
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const hmr = { start: () => { started(); return new Promise(resolve => { release = resolve; }); },
    endpoint: () => ({ port: 1 }), suspend: async () => {}, close: async () => {} };
  const preview = await startNativePreview(dir, { workspaceOrigin: origin, port: 0, hmr,
    state: () => ({ operation_id: 'operation', app_id: 'app', app_key: 'demo', update_status: 'ready' }) });
  t.after(async () => { await preview.close(); await rm(dir, { recursive: true, force: true }); });
  const headers = { Origin: origin };
  const manifest = await (await fetch(`${preview.url}/__nexia_native`, { headers })).json();
  const token = new URL(manifest.entry).pathname.split('/')[1];
  const pending = fetch(`${preview.url}/${token}/__nexia_hmr_start`, { method: 'POST', headers, body: JSON.stringify(host) });
  await entered; await preview.suspendHmr(); release();
  assert.equal((await pending).status, 409);
});

test('development translations come from the approved snapshot rather than changing source files', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nexia-hmr-translations-'));
  await mkdir(path.join(dir, 'dist/frontend'), { recursive: true });
  await mkdir(path.join(dir, 'resources/lang'), { recursive: true });
  await writeFile(path.join(dir, 'dist/frontend/index.js'), 'export default 1;');
  await writeFile(path.join(dir, 'resources/lang/en.json'), JSON.stringify({ 'demo.title': 'new source' }));
  let snapshot = { files: [{ path: 'resources/lang/en.json', content: Buffer.from(JSON.stringify({ 'demo.title': 'approved old' })).toString('base64') }] };
  const hmr = { snapshot: () => snapshot, close: async () => {}, suspend: async () => {} };
  const preview = await startNativePreview(dir, { workspaceOrigin: origin, port: 0, hmr,
    state: () => ({ operation_id: 'operation', app_id: 'app', app_key: 'demo', update_status: 'ready' }) });
  t.after(async () => { await preview.close(); await rm(dir, { recursive: true, force: true }); });
  const read = async () => (await (await fetch(`${preview.url}/__nexia_native`, { headers: { Origin: origin } })).json()).translations.en['demo.title'];
  assert.equal(await read(), 'approved old');
  snapshot = { files: [{ path: 'resources/lang/en.json', content: Buffer.from(JSON.stringify({ 'demo.title': 'approved new' })).toString('base64') }] };
  assert.equal(await read(), 'approved new');
});

test('local HMR accepts only configured loopback Vite peer paths', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nexia-local-hmr-'));
  await mkdir(path.join(dir, 'dist/frontend'), { recursive: true });
  await writeFile(path.join(dir, 'dist/frontend/index.js'), 'export default 1;');
  const hmr = { start: async () => {}, close: async () => {}, suspend: async () => {} };
  const preview = await startNativePreview(dir, { workspaceOrigin: origin, localViteOrigin: 'http://localhost:18883', port: 0, hmr,
    state: () => ({ operation_id: 'operation', app_id: 'app', app_key: 'demo', update_status: 'ready' }) });
  t.after(async () => { await preview.close(); await rm(dir, { recursive: true, force: true }); });
  const headers = { Origin: origin };
  const manifest = await (await fetch(`${preview.url}/__nexia_native`, { headers })).json();
  const token = new URL(manifest.entry).pathname.split('/')[1];
  const local = { peers: Object.fromEntries(names.map((name, i) => [name, `http://localhost:18883/resources/js/app-sdk/peers/p${i}.ts`])),
    refreshRuntime: 'http://localhost:18883/resources/js/app-sdk/peers/react-refresh.js' };
  const start = body => fetch(`${preview.url}/${token}/__nexia_hmr_start`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await start({ ...local, refreshRuntime: 'http://localhost:18883/private/secret.js' })).status, 409);
  assert.equal((await start(local)).status, 200);
  assert.equal((await start({ ...local, refreshRuntime: 'http://localhost:18883/@react-refresh' })).status, 200);
  await assert.rejects(startNativePreview(dir, { workspaceOrigin: 'https://developers.example.com', localViteOrigin: 'http://localhost:18883' }), /loopback/);
});
