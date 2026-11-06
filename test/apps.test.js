import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerApp, selectExecution, restartExecution } from '../src/apps.js';
import { saveConnection } from '../src/connection.js';

test('restart waits for shutdown and requests a revision-bound resume without claiming readiness', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-restart-'));
  const previous = process.env.NEXIA_CONFIG_HOME;
  process.env.NEXIA_CONFIG_HOME = path.join(root, 'config');
  const app = '12345678-1234-4123-8123-123456789abc', project = '22345678-1234-4123-8123-123456789abc';
  let selection = { app_id: app, project_id: project, sandbox_id: '32345678-1234-4123-8123-123456789abc', mode: 'development', revision: 1, stop_pending: false, restart_cleanup_supported: true };
  const writes = [];
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'PUT') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); writes.push(body);
      if (body.mode === 'off') selection = { ...selection, mode: 'off', revision: 2, stop_pending: true };
      else {
        assert.equal(selection.stop_pending, false);
        selection = { ...selection, mode: 'development', revision: 3 };
      }
    }
    res.end(JSON.stringify({ selection }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.NEXIA_CONFIG_HOME; else process.env.NEXIA_CONFIG_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await saveConnection({ endpoint, token: 'test-token' });
  await mkdir(path.join(root, '.nexia'));
  await writeFile(path.join(root, '.nexia/app.json'), JSON.stringify({ endpoint, id: app }));
  await writeFile(path.join(root, '.nexia/project.json'), JSON.stringify({ endpoint, project_id: project }));
  const lines = [];
  const result = await restartExecution(root, { log: line => lines.push(line), wait: async () => { selection.stop_pending = false; } });
  assert.deepEqual(writes, [{ mode: 'off', revision: 1, restart_cleanup: true }, { mode: 'development', revision: 2 }]);
  assert.equal(result.mode, 'development');
  assert.match(lines.join('\n'), /wait for Development ready/);
  selection = { ...selection, revision: 1, stop_pending: false };
  await assert.rejects(restartExecution(root, { log: () => {}, wait: async () => { selection.revision++; } }), /selection changed while waiting/);
  assert.deepEqual(writes.slice(2), [{ mode: 'off', revision: 1, restart_cleanup: true }]);
  selection = { ...selection, mode: 'development', revision: 1, stop_pending: false, restart_cleanup_supported: false };
  await restartExecution(root, { log: () => {}, wait: async () => { selection.stop_pending = false; } });
  assert.deepEqual(writes.slice(3), [{ mode: 'off', revision: 1 }, { mode: 'development', revision: 2 }]);
});

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
  await assert.rejects(selectExecution(root, 'published'), /development or off/);
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

test('startup resume uses the observed revision, accepts pending shutdown, and refuses a changed selection', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-startup-execution-'));
  const previous = process.env.NEXIA_CONFIG_HOME;
  process.env.NEXIA_CONFIG_HOME = path.join(root, 'config');
  const app = '12345678-1234-4123-8123-123456789abc';
  const project = '22345678-1234-4123-8123-123456789abc';
  let selection = { app_id: app, project_id: project, sandbox_id: '32345678-1234-4123-8123-123456789abc', mode: 'off', revision: 4, stop_pending: true };
  let writes = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'PUT') {
      let body = ''; for await (const chunk of req) body += chunk;
      assert.deepEqual(JSON.parse(body), { mode: 'development', revision: selection.revision });
      writes++;
      selection = { ...selection, revision: 5, resume_pending: true };
    }
    res.end(JSON.stringify({ selection }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.NEXIA_CONFIG_HOME; else process.env.NEXIA_CONFIG_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await saveConnection({ endpoint, token: 'fixture-token' });
  await mkdir(path.join(root, '.nexia'));
  await writeFile(path.join(root, '.nexia/app.json'), JSON.stringify({ endpoint, id: app }));
  await writeFile(path.join(root, '.nexia/project.json'), JSON.stringify({ endpoint, project_id: project }));
  const expected = { ...selection }, messages = [];
  const result = await selectExecution(root, 'development', { expected, log: message => messages.push(message) });
  assert.equal(result.resume_pending, true);
  assert.match(messages.join('\n'), /pending/);
  await assert.rejects(selectExecution(root, 'development', { expected }), /changed before startup/);
  assert.equal((await selectExecution(root, 'development', { log: () => {} })).revision, 5);
  assert.equal(writes, 2);
});

test('project restart requests each watched development App and preserves stopped, unwatched and changed selections', async t => {
  const { bindWorkspace } = await import('../src/workspace.js');
  const { startDevSession } = await import('../src/dev-sessions.js');
  const { restartProjectExecutions } = await import('../src/apps.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-project-restart-'));
  const previous = process.env.NEXIA_CONFIG_HOME;
  process.env.NEXIA_CONFIG_HOME = path.join(root, 'config');
  const project = '22345678-1234-4123-8123-123456789abc';
  const sandbox = '32345678-1234-4123-8123-123456789abc';
  const names = ['a-first', 'b-second', 'c-off', 'd-unwatched', 'e-changed'];
  const selections = new Map(), operations = new Map(), writes = [], reads = new Map();
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/developer-api/connection') return res.end(JSON.stringify({ status: 'connected', project: { id: project } }));
    if (req.url === '/developer-api/apps') return res.end(JSON.stringify({ apps: [...selections].map(([id, selection]) => ({ id, key: selection.key })) }));
    const operationId = req.url.match(/\/v2\/runtime-operations\/([^/]+)$/)?.[1];
    if (operationId) return res.end(JSON.stringify({ operation: operations.get(operationId) }));
    const id = req.url.match(/\/v2\/apps\/([^/]+)\/execution$/)?.[1];
    const selection = selections.get(id);
    if (!selection) { res.writeHead(404).end('{}'); return; }
    if (req.method === 'PUT') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); writes.push({ id, ...body });
      if (body.revision !== selection.revision) { res.writeHead(409).end('{}'); return; }
      selection.mode = body.mode; selection.revision++; selection.stop_pending = false;
    } else {
      reads.set(id, (reads.get(id) || 0) + 1);
      if (id.endsWith('0005') && reads.get(id) === 2) { selection.mode = 'off'; selection.revision++; }
    }
    res.end(JSON.stringify({ selection }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let session;
  t.after(async () => {
    await session?.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.NEXIA_CONFIG_HOME; else process.env.NEXIA_CONFIG_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await saveConnection({ endpoint, token: 'test-token' });
  const workspace = await bindWorkspace(root, { endpoint, project: { id: project, name: 'Test' } });
  for (const [index, name] of names.entries()) {
    const id = `12345678-1234-4123-8123-${String(index + 1).padStart(12, '0')}`;
    const directory = path.join(root, name);
    await mkdir(path.join(directory, '.nexia'), { recursive: true });
    await writeFile(path.join(directory, 'composer.json'), JSON.stringify({ name: `example/${name}` }));
    await writeFile(path.join(directory, 'nexia.json'), JSON.stringify({ schema_version: '2', runtime: 'laravel', app: { app_key: name } }));
    await writeFile(path.join(directory, '.nexia/app.json'), JSON.stringify({ endpoint, id, key: name }));
    await writeFile(path.join(directory, '.nexia/project.json'), JSON.stringify({ endpoint, project_id: project }));
    const operationId = `42345678-1234-4123-8123-${String(index + 1).padStart(12, '0')}`;
    await writeFile(path.join(directory, '.nexia/runtime.json'), JSON.stringify({ endpoint, project_id: project, app_id: id, sandbox_id: sandbox, operation_id: operationId }));
    operations.set(operationId, { id: operationId, developer_project_id: project, developer_sandbox_id: sandbox, status: 'completed', stopped_at: null, stop_requested_at: null });
    selections.set(id, { key: name, app_id: id, project_id: project, sandbox_id: sandbox, mode: name === 'c-off' ? 'off' : 'development', revision: 1, stop_pending: false, restart_cleanup_supported: true });
  }
  const remoteId = '12345678-1234-4123-8123-000000000006';
  selections.set(remoteId, { key: 'f-remote', app_id: remoteId, project_id: project, sandbox_id: sandbox, mode: 'development', revision: 1, stop_pending: false });
  const unboundId = '12345678-1234-4123-8123-000000000007';
  const unbound = path.join(root, 'g-unbound');
  await mkdir(unbound);
  await writeFile(path.join(unbound, 'composer.json'), JSON.stringify({ name: 'example/g-unbound' }));
  await writeFile(path.join(unbound, 'nexia.json'), JSON.stringify({ schema_version: '2', runtime: 'laravel', app: { app_key: 'g-unbound' } }));
  selections.set(unboundId, { key: 'g-unbound', app_id: unboundId, project_id: project, sandbox_id: sandbox, mode: 'development', revision: 1, stop_pending: false });
  session = await startDevSession(root, { port: 4310, projectId: project, stop: () => {} });
  session.update({ status: 'watching', apps: ['a-first', 'b-second', 'c-off', 'e-changed'] });
  const logs = [];
  await assert.rejects(restartProjectExecutions(workspace, { log: line => logs.push(line) }), /d-unwatched, e-changed, g-unbound, f-remote/);
  assert.deepEqual(writes.map(({ id, mode }) => [names[Number(id.slice(-4)) - 1], mode]), [
    ['a-first', 'off'], ['a-first', 'development'], ['b-second', 'off'], ['b-second', 'development'],
  ]);
  assert.match(logs.join('\n'), /Restart requested: 2; skipped: 1; not confirmed: 4/);
  assert.match(logs.join('\n'), /No active local nexia dev watcher/);

  writes.length = 0; reads.clear();
  for (const selection of selections.values()) {
    selection.revision = 1;
    selection.mode = selection.key === 'c-off' ? 'off' : 'development';
  }
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, [cli, 'dev', 'restart', '--no-interactive'], {
    cwd: root, env: { ...process.env, CI: '1' }, timeout: 10000,
  }), error => error.code === 1 && /Restart requested: 2; skipped: 1; not confirmed: 4/.test(error.stderr));
  assert.deepEqual(writes.map(({ id, mode }) => [names[Number(id.slice(-4)) - 1], mode]), [
    ['a-first', 'off'], ['a-first', 'development'], ['b-second', 'off'], ['b-second', 'development'],
  ]);
});
