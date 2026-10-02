import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startNativePreview } from '../src/native-preview.js';

test('occupied preview port explains how to reuse or restart development', async () => {
  const first = await startNativePreview(null, { port: 0, workspaceOrigin: 'http://workspace.localhost:8081', apps: new Map() });
  try {
    await assert.rejects(startNativePreview(null, {
      port: Number(new URL(first.url).port), workspaceOrigin: 'http://workspace.localhost:8081', apps: new Map(),
    }), /already in use.*workspace link.*--port/);
  } finally { await first.close(); }
});

test('native preview exposes only compiled assets through a workspace-issued capability', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-native-preview-'));
  await mkdir(path.join(root, 'dist/frontend'), { recursive: true });
  await writeFile(path.join(root, 'dist/frontend/index.js'), 'export const App = true;');
  await writeFile(path.join(root, '.env'), 'PRIVATE');
  await mkdir(path.join(root, 'resources/lang'), { recursive: true });
  await writeFile(path.join(root, 'resources/lang/en.json'), JSON.stringify({ 'trial.title': 'Trial' }));
  await symlink(path.join(root, '.env'), path.join(root, 'dist/frontend/linked.js'));
  const workspaceOrigin = 'http://workspace.localhost:8081';
  let current = { operation_id: 'operation' };
  const server = await startNativePreview(root, { port: 0, workspaceOrigin, state: () => current });
  try {
    const get = (url, origin) => fetch(url, { headers: { Origin: origin } });
    assert.equal((await get(`${server.url}/__nexia_native`, 'null')).status, 403);
    const manifest = await get(`${server.url}/__nexia_native`, workspaceOrigin);
    assert.equal(manifest.status, 200);
    const data = await manifest.json();
    assert.equal(data.operation_id, 'operation');
    assert.deepEqual(data.translations.en, { 'trial.title': 'Trial' });
    assert.equal((await get(data.entry, workspaceOrigin)).status, 403);
    assert.equal((await get(`${server.url}/index.js`, 'null')).status, 404);
    const asset = await get(data.entry, 'null');
    assert.equal(asset.headers.get('access-control-allow-origin'), 'null');
    assert.equal(asset.headers.get('access-control-allow-credentials'), null);
    assert.match(await asset.text(), /export const App/);
    for (const name of ['linked.js', '.env', 'index.js.map', '../.env']) {
      assert.equal((await get(data.entry.replace('index.js', name), 'null')).status, 404);
    }
    current = { mode: 'off' };
    assert.equal((await get(`${server.url}/__nexia_native`, 'null')).status, 403);
    assert.equal((await get(`${server.url}/__nexia_native`, workspaceOrigin)).status, 423);
    current = null;
    assert.equal((await get(`${server.url}/__nexia_native`, workspaceOrigin)).status, 409);
    current = { operation_id: 'resumed' };
    assert.equal((await (await get(`${server.url}/__nexia_native`, workspaceOrigin)).json()).operation_id, 'resumed');
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('one project port routes multiple Apps without mixing their assets and supports hot attachment', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-project-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceOrigin = 'http://workspace.localhost:8081';
  const server = await startNativePreview(null, { port: 0, workspaceOrigin, apps: new Map() });
  t.after(() => server.close());
  const get = (url, origin = workspaceOrigin) => fetch(url, { headers: { Origin: origin } });
  assert.deepEqual((await (await get(`${server.url}/__nexia_native`)).json()).apps, []);
  const handles = [];
  for (const name of ['people', 'payroll']) {
    const directory = path.join(root, name);
    await mkdir(path.join(directory, 'dist/frontend'), { recursive: true });
    await writeFile(path.join(directory, 'dist/frontend/index.js'), `export const name = '${name}';`);
    handles.push(server.attach(directory, () => ({ app_id: name, app_key: name, operation_id: name })));
  }
  const project = await (await get(`${server.url}/__nexia_native`)).json();
  assert.equal(project.schema_version, 'project-1');
  assert.equal(project.apps.length, 2);
  const entries = [];
  for (const { app_id } of project.apps) {
    const manifest = await (await get(`${server.url}/__nexia_native?app_id=${app_id}`)).json();
    assert.equal(manifest.app_id, app_id);
    assert.equal(new URL(manifest.entry).origin, server.url);
    assert.match(await (await get(manifest.entry, 'null')).text(), new RegExp(app_id));
    entries.push(manifest.entry);
  }
  assert.notEqual(entries[0], entries[1]);
  await handles[0].close();
  assert.equal((await get(entries[0], 'null')).status, 404);
  assert.equal((await get(entries[1], 'null')).status, 200);
  assert.equal((await get(`${server.url}/__nexia_native?app_id=missing`)).status, 404);
  assert.equal((await get(`${server.url}/__nexia_native`, 'null')).status, 403);
});
