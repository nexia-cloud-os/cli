import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerApp, selectExecution } from '../src/apps.js';
import { saveConnection } from '../src/connection.js';

test('execution selection uses server revision and refuses stale or rebound choices', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-execution-'));
  const previousConfig = process.env.NEXIA_CONFIG_HOME;
  process.env.NEXIA_CONFIG_HOME = path.join(root, 'config');
  const app = '12345678-1234-4123-8123-123456789abc';
  const project = '22345678-1234-4123-8123-123456789abc';
  const selection = { app_id: app, project_id: project, sandbox_id: '32345678-1234-4123-8123-123456789abc', mode: 'development', revision: 1, stop_pending: false };
  let stale = false, rebind = false, writes = 0;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, `/developer-api/v2/apps/${app}/execution`);
    assert.equal(req.headers.authorization, 'Bearer test-token');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'PUT') {
      writes++;
      let raw = ''; for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      if (stale) selection.revision++;
      if (input.revision !== selection.revision) {
        res.statusCode = 409; res.end(JSON.stringify({ message: 'Selection changed' })); return;
      }
      if (input.mode !== selection.mode) selection.revision++;
      selection.mode = input.mode;
      selection.stop_pending = input.mode === 'off';
    } else if (rebind) {
      await writeFile(path.join(root, '.nexia/app.json'), JSON.stringify({ endpoint, id: project }));
    }
    res.end(JSON.stringify({ selection }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (previousConfig === undefined) delete process.env.NEXIA_CONFIG_HOME; else process.env.NEXIA_CONFIG_HOME = previousConfig;
    await rm(root, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await saveConnection({ endpoint, token: 'test-token' });
  await mkdir(path.join(root, '.nexia'));
  await writeFile(path.join(root, '.nexia/app.json'), JSON.stringify({ endpoint, id: app }));
  await writeFile(path.join(root, '.nexia/project.json'), JSON.stringify({ endpoint, project_id: project }));
  const lines = [];
  assert.equal((await selectExecution(root, 'off', { log: line => lines.push(line) })).revision, 2);
  assert.match(lines[0], /shutdown pending/);
  assert.equal((await selectExecution(root, 'off', { log: () => {} })).revision, 2);
  stale = true;
  await assert.rejects(selectExecution(root, 'development'), { status: 409 });
  assert.equal(selection.mode, 'off');
  rebind = true;
  await assert.rejects(selectExecution(root, 'development'), /binding or CLI connection changed/);
  assert.equal(writes, 3);
  await assert.rejects(selectExecution(root, 'published'), /development\|off/);
});

test('native registration sends metadata only and preserves identity across retries', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-app-registration-'));
  process.env.NEXIA_CONFIG_HOME = path.join(root, 'config');
  const id = '12345678-1234-4123-8123-123456789abc';
  const metadata = { app_key: 'test-app', app_name: 'Test', app_table_prefix: 'test_app' };
  await writeFile(path.join(root, 'composer.json'), JSON.stringify({ name: 'example/test', scripts: { 'post-install-cmd': 'must-never-run' }, config: { 'private-setting': 'do-not-send' } }));
  const native = { schema_version: '2', runtime: 'laravel', app: metadata };
  await writeFile(path.join(root, 'nexia.json'), JSON.stringify(native));
  await writeFile(path.join(root, '.env'), 'SECRET=do-not-send');
  let registrations = 0;
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/developer-api/connection') {
      res.end(JSON.stringify({ status: 'connected', project: { id, name: 'Local project' } }));
      return;
    }
    assert.equal(req.url, '/developer-api/apps');
    assert.equal(req.method, 'POST');
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), { package_name: 'example/test', metadata });
    registrations++;
    res.end(JSON.stringify({ app: { id, key: 'test-app', name: 'Test', package_name: 'example/test', table_prefix: 'test_app' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    delete process.env.NEXIA_CONFIG_HOME;
    await rm(root, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await saveConnection({ endpoint, token: 'test-token' });
  const lines = [];
  await registerApp(root, { log: line => lines.push(line) });
  await registerApp(root, { log: line => lines.push(line) });
  assert.equal(registrations, 2);
  await writeFile(path.join(root, 'nexia.json'), JSON.stringify({ schema_version: '1', app: { id: 'com.example.test' } }));
  await assert.rejects(registerApp(root), /requires nexia.json version 2/);
  await writeFile(path.join(root, 'nexia.json'), JSON.stringify(native));
  assert.deepEqual(JSON.parse(await readFile(path.join(root, '.nexia/app.json'), 'utf8')), { endpoint, id, key: 'test-app' });
  assert.doesNotMatch(lines.join('\n'), /test-token|do-not-send/);
  await writeFile(path.join(root, 'nexia.json'), JSON.stringify({ ...native, app: { ...metadata, app_key: 'changed' } }));
  await assert.rejects(() => registerApp(root), /different App identity/);
  assert.equal(registrations, 2);
  assert.equal(JSON.parse(await readFile(path.join(root, '.nexia/app.json'), 'utf8')).key, 'test-app');

  await writeFile(path.join(root, 'nexia.json'), JSON.stringify(native));
  await writeFile(path.join(root, 'composer.json'), JSON.stringify({ name: 'example/test', extra: { nexia: { app: metadata } } }));
  await assert.rejects(registerApp(root), /extra.nexia is unsupported/);
  assert.equal(registrations, 2);
  await writeFile(path.join(root, 'composer.json'), JSON.stringify({ name: 'example/test' }));
  await registerApp(root, { log: line => lines.push(line) });
  assert.equal(registrations, 3);
  const binding = await readFile(path.join(root, '.nexia/app.json'), 'utf8');
  const requestsBeforeInvalid = requests;
  for (const invalid of [
    { ...native, runtime: 'browser' }, { ...native, schema_version: '3' },
    { ...native, schema_version: 2 }, { ...native, app: null }, [], '{invalid', ' '.repeat(1048577),
  ]) {
    await writeFile(path.join(root, 'nexia.json'), typeof invalid === 'string' ? invalid : JSON.stringify(invalid));
    await assert.rejects(registerApp(root));
    assert.equal(registrations, 3);
    assert.equal(requests, requestsBeforeInvalid);
    assert.equal(await readFile(path.join(root, '.nexia/app.json'), 'utf8'), binding);
  }
  await rm(path.join(root, 'nexia.json'));
  await symlink(path.join(root, '.env'), path.join(root, 'nexia.json'));
  await assert.rejects(registerApp(root), /regular file/);
  assert.equal(requests, requestsBeforeInvalid);
  await rm(path.join(root, 'nexia.json'));
  await rename(path.join(root, 'composer.json'), path.join(root, 'composer-retained.json'));
  await symlink(path.join(root, '.env'), path.join(root, 'composer.json'));
  await assert.rejects(() => registerApp(root), /composer.json must not be a symbolic link/);
  assert.equal(registrations, 3);
});
