import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startNativePreview } from '../src/native-preview.js';

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
