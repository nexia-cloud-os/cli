import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('db local registers a new App before its first dev run', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-db-local-registration-'));
  const app = '11111111-1111-4111-8111-111111111111';
  const project = '22222222-2222-4222-8222-222222222222';
  const calls = [];
  const server = createServer(async (req, res) => {
    calls.push([req.method, req.url]);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/connection')
      ? { status: 'connected', project: { id: project, name: 'Test project' } }
      : { app: { id: app, key: 'sample', name: 'Sample', package_name: 'example/sample', table_prefix: 'sample_' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const appRoot = path.join(root, 'app'); await mkdir(appRoot);
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint, token: 'test-token' }), { mode: 0o600 });
  await writeFile(path.join(appRoot, 'composer.json'), JSON.stringify({ name: 'example/sample' }));
  await writeFile(path.join(appRoot, 'nexia.json'), JSON.stringify({ schema_version: '2', runtime: 'laravel', app: { app_key: 'sample', app_table_prefix: 'sample_' } }));
  await assert.rejects(execute(process.execPath, [cli, 'db', 'local', '--yes'], {
    cwd: appRoot, env: { ...process.env, NEXIA_CONFIG_HOME: root, PGHOST: '192.0.2.1', PGDATABASE: 'sample', PGUSER: 'postgres', PGPASSWORD: 'test' },
  }), /loopback PGHOST/);
  assert.equal(JSON.parse(await readFile(path.join(appRoot, '.nexia', 'app.json'), 'utf8')).id, app);
  assert.ok(calls.some(([method, url]) => method === 'POST' && url.endsWith('/apps')));
  assert.ok(!calls.some(([, url]) => url.endsWith('/local-database')));
});

test('database reset uses the rollback command vocabulary and rejects reference catalog', async () => {
  const { parseCommand } = await import('../src/commands.js');
  assert.equal(parseCommand(['db', 'reset', '--yes']).name, 'db reset');
  assert.throws(() => parseCommand(['db', 'references']));
});

test('db migrations preserve App binding, current source, completion and recovery identity', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-db-operation-'));
  const app = '11111111-1111-4111-8111-111111111111', project = '33333333-3333-4333-8333-333333333333', requestId = '22222222-2222-4222-8222-222222222222';
  const calls = [];
  const sandbox = '44444444-4444-4444-8444-444444444444', revision = '55555555-5555-4555-8555-555555555555';
  let operation = null;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const input = body && JSON.parse(body);
    calls.push([req.method, req.url, input]);
    let payload;
    if (req.url.endsWith('/connection')) payload = { status: 'connected', project: { id: project },
      sandbox: { id: sandbox, status: 'active' }, capabilities: { explicit_development_migrations: true } };
    else if (req.url.endsWith('/v2/sources')) payload = { revision: { id: revision, digest: input.source.digest, file_count: input.source.files.length } };
    else if (req.method === 'GET' && req.url.includes('/runtime-operations/')) {
      operation = { ...operation, status: 'completed' }; payload = { operation };
    } else if (req.method === 'GET') payload = { operation };
    else {
      operation = { id: requestId, request_id: requestId, database_command: 'migrate', status: 'queued',
        developer_project_id: project, developer_sandbox_id: sandbox, source_revision_id: input.source_revision_id };
      payload = { operation };
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const appRoot = path.join(root, 'app'); await mkdir(path.join(appRoot, '.nexia'), { recursive: true });
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, token: 'db-operation-token' }), { mode: 0o600 });
  await writeFile(path.join(appRoot, '.nexia', 'project.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, project_id: project }));
  await writeFile(path.join(appRoot, '.nexia', 'app.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, id: app, key: 'sample' }));
  await writeFile(path.join(appRoot, 'nexia.json'), JSON.stringify({ schema_version: '2', runtime: 'laravel', app: { app_key: 'sample' } }));
  await writeFile(path.join(appRoot, 'composer.json'), '{}');
  await mkdir(path.join(appRoot, 'database/migrations'), { recursive: true });
  await writeFile(path.join(appRoot, 'database/migrations/pending.php'), '<?php // pending change');
  const options = { cwd: appRoot, env: { ...process.env, NEXIA_CONFIG_HOME: root } };
  await assert.rejects(execute(process.execPath, [cli, 'db', 'migrate'], options));
  assert.equal(calls.some(call => call[0] !== 'GET'), false);
  calls.length = 0;
  await execute(process.execPath, [cli, 'db', 'migrate', '--yes', '--request-id', requestId], options);
  const uploaded = calls.find(call => call[1].endsWith('/v2/sources'))[2].source;
  assert.equal(Buffer.from(uploaded.files.find(file => file.path === 'database/migrations/pending.php').content, 'base64').toString(), '<?php // pending change');
  const submitted = calls.find(call => call[0] === 'POST' && call[1].endsWith('/database-operations'));
  assert.deepEqual(submitted[2], { command: 'migrate', request_id: requestId, writer_session: requestId, source_revision_id: revision });
  assert.ok(calls.some(call => call[1].includes('/runtime-operations/')));
  assert.ok(!calls.some(call => call[1].endsWith('/writer')), 'server preserves the active watcher lease');
  await writeFile(path.join(appRoot, 'database/migrations/pending.php'), '<?php // later edit');
  calls.length = 0;
  await execute(process.execPath, [cli, 'db', 'migrate', '--yes', '--request-id', requestId], options);
  assert.ok(calls.every(call => call[0] === 'GET'), 'recover accepted request without uploading later edits or resubmitting');

});

test('db lifecycle rejects a locally linked project that differs from the approved connection', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-db-project-binding-'));
  const app = '11111111-1111-4111-8111-111111111111';
  const localProject = app;
  const connectedProject = '22222222-2222-4222-8222-222222222222';
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    calls.push([req.method, req.url, body && JSON.parse(body)]);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'connected', project: { id: connectedProject } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const appRoot = path.join(root, 'app'); await mkdir(path.join(appRoot, '.nexia'), { recursive: true });
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, token: 'db-operation-token' }), { mode: 0o600 });
  await writeFile(path.join(appRoot, '.nexia', 'project.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, project_id: localProject }));
  await writeFile(path.join(appRoot, '.nexia', 'app.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, id: app, key: 'sample' }));
  await writeFile(path.join(appRoot, 'nexia.json'), JSON.stringify({ schema_version: '2', runtime: 'laravel', app: { app_key: 'sample' } }));
  const options = { cwd: appRoot, env: { ...process.env, NEXIA_CONFIG_HOME: root } };
  for (const args of [
    ['db', 'status'], ['db', 'migrate', '--yes'], ['db', 'seed', 'sample', '--yes'],
  ]) await assert.rejects(execute(process.execPath, [cli, ...args], options), error => { assert.match(error.stdout, /linked to another project/); return true; });
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ['GET', '/developer-api/connection', '']));
});

test('explicit database commands reject older platforms before uploading or mutating', async () => {
  const { runDatabaseOperation } = await import('../src/database-operations.js');
  await assert.rejects(runDatabaseOperation('/unused', { connection: { capabilities: {} } }, {
    command: 'migrate', requestId: '22222222-2222-4222-8222-222222222222', log: () => {},
  }), /No database request was sent/);
});

test('project DB commands run all Apps sequentially and retain per-App failures and request identities', async t => {
  const { randomUUID } = await import('node:crypto');
  const { bindWorkspace } = await import('../src/workspace.js');
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-db-targets-'));
  const project = randomUUID(), sandbox = randomUUID();
  const apps = new Map([['a-broken', randomUUID()], ['people', randomUUID()]]);
  const sources = new Map(), submitted = [];
  let endpoint;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = raw ? JSON.parse(raw) : null;
    let result;
    if (req.url.endsWith('/connection')) {
      result = { status: 'connected', project: { id: project }, sandbox: { id: sandbox, status: 'active' },
        capabilities: { explicit_development_migrations: true, development_database_commands: 2 } };
    } else if (req.url.endsWith('/v2/sources')) {
      const revision = { id: randomUUID(), digest: input.source.digest, file_count: input.source.files.length };
      sources.set(revision.id, input.app_id);
      result = { revision };
    } else if (req.method === 'POST') {
      const appId = req.url.split('/')[4];
      assert.equal(sources.get(input.source_revision_id), appId, 'each command uses only its selected App source');
      submitted.push({ appId, requestId: input.request_id, command: input.command, options: input.options });
      result = { operation: { id: randomUUID(), request_id: input.request_id, source_revision_id: input.source_revision_id,
        database_command: input.command, database_options: input.options, ...(input.command === 'status' ? { database_result: { command: 'status', migrations: [{ name: '001_first', batch: 1, status: 'ran' }] } } : {}), developer_project_id: project, developer_sandbox_id: sandbox,
        status: appId === apps.get('a-broken') ? 'failed' : 'completed',
        ...(appId === apps.get('a-broken') ? { failure: { code: 'PREPARATION_FAILED', stage: 'migrate' } } : {}) } };
    } else result = { operation: null };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await bindWorkspace(root, { endpoint, project: { id: project, name: 'DB targets' } });
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint, token: 'fixture-only' }));
  for (const [key, id] of apps) {
    const directory = path.join(root, key);
    await mkdir(path.join(directory, '.nexia'), { recursive: true });
    await writeFile(path.join(directory, '.nexia/project.json'), JSON.stringify({ endpoint, project_id: project }));
    await writeFile(path.join(directory, '.nexia/app.json'), JSON.stringify({ endpoint, id, key }));
    await writeFile(path.join(directory, 'composer.json'), JSON.stringify({ name: `example/${key}` }));
    await writeFile(path.join(directory, 'nexia.json'), JSON.stringify({ schema_version: '2', runtime: 'laravel', app: { app_key: key } }));
  }
  const options = { cwd: root, env: { ...process.env, NEXIA_CONFIG_HOME: root } };
  await assert.rejects(execute(process.execPath, [cli, 'db', 'migrate', '--yes', '--json'], options), error => {
    const result = JSON.parse(error.stdout);
    assert.equal(error.code, 1);
    assert.equal(result.failed, 1);
    assert.deepEqual(result.results.map(item => [item.app, item.status]), [['a-broken', 'failed'], ['people', 'success']]);
    assert.match(error.stderr, /Database migrate targets/);
    return true;
  });
  assert.deepEqual(submitted.map(item => item.appId), [...apps.values()]);
  assert.equal(new Set(submitted.map(item => item.requestId)).size, 2);
  submitted.length = 0;
  await execute(process.execPath, [cli, 'db', 'migrate', '--app=people', '--yes'], options);
  assert.deepEqual(submitted.map(item => item.appId), [apps.get('people')]);
  submitted.length = 0;
  await execute(process.execPath, [cli, 'db', 'migrate', '--yes'], { ...options, cwd: path.join(root, 'people') });
  assert.deepEqual(submitted.map(item => item.appId), [apps.get('people')]);
  submitted.length = 0;
  await assert.rejects(execute(process.execPath, [cli, 'db', 'migrate', '--yes', '--request-id', randomUUID()], options), /exactly one App/);
  assert.equal(submitted.length, 0);
  for (const [command, flags, wire, dbOptions] of [
    ['reset', [], 'rollback_all', {}], ['fresh', ['--seed'], 'fresh', { seed: true }],
    ['rollback', ['--step=2'], 'rollback', { step: 2 }], ['seed', ['--class=Trial\\DatabaseSeeder'], 'seeder', { class: 'Trial\\DatabaseSeeder' }],
  ]) {
    await execute(process.execPath, [cli, 'db', command, '--app=people', '--yes', '--json', ...flags], options);
    assert.equal(submitted.at(-1).command, wire);
    assert.deepEqual(submitted.at(-1).options, dbOptions);
  }
  const status = await execute(process.execPath, [cli, 'db', 'status', '--app=people', '--json'], options);
  assert.equal(JSON.parse(status.stdout).database_result.migrations[0].batch, 1);

});

test('database waiting survives throttling and failed shutdown without replaying accepted work', async t => {
  const { runDatabaseOperation } = await import('../src/database-operations.js');
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-db-wait-'));
  const previous = process.env.NEXIA_CONFIG_HOME;
  process.env.NEXIA_CONFIG_HOME = root;
  t.after(async () => { if (previous === undefined) delete process.env.NEXIA_CONFIG_HOME; else process.env.NEXIA_CONFIG_HOME = previous; await rm(root, { recursive: true, force: true }); });
  const id = '11111111-1111-4111-8111-111111111111', requestId = '22222222-2222-4222-8222-222222222222';
  const config = { endpoint: 'http://127.0.0.1:43210', token: 'local-test' };
  const connection = { status: 'connected', sandbox: { id, status: 'active' }, project: { id }, capabilities: { explicit_development_migrations: true, development_database_commands: 2 } };
  await mkdir(path.join(root, '.nexia'));
  await writeFile(path.join(root, 'connection.json'), JSON.stringify(config));
  await writeFile(path.join(root, '.nexia/project.json'), JSON.stringify({ endpoint: config.endpoint, project_id: id }));
  await writeFile(path.join(root, '.nexia/app.json'), JSON.stringify({ endpoint: config.endpoint, id }));
  await writeFile(path.join(root, 'composer.json'), '{}');
  const operation = { id, request_id: requestId, source_revision_id: id, developer_project_id: id, developer_sandbox_id: id,
    database_command: 'migrate', database_options: {}, status: 'running', started_at: '2026-10-18T00:00:00Z',
    failure: { code: 'PREPARATION_FAILED', stage: 'migrate' }, recovery_check: { retry_safe: false },
    diagnostic_path: `/projects/${id}/development?operation=${id}#operation-${id}` };
  let posts = 0, polls = 0, blockingPolls = 0, limited = false;
  const logs = [], requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const send = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Retry-After': '1' } });
    if (url.endsWith('/connection')) return send(connection);
    if (url.endsWith('/v2/sources')) return send({ revision: { id, digest: JSON.parse(options.body).source.digest, file_count: 1 } });
    if (options.method === 'POST') {
      requests.push(JSON.parse(options.body));
      if (++posts === 1) return send({ status: 'preparation_pending', blocking_operation: { ...operation, status: 'failed' } }, 409);
      if (posts === 2) return send({ message: 'Too Many Attempts' }, 429);
      return send({ operation });
    }
    if (url.includes('/runtime-operations/')) {
      if (!limited) { limited = true; return send({}, 429); }
      const count = posts < 3 ? ++blockingPolls : ++polls;
      return send({ operation: { ...operation, status: 'failed', ...(count > 1 ? { stopped_at: '2026-10-18T00:00:01Z', retry_allowed: true } : {}) } });
    }
    return send({ operation: null });
  });
  await assert.rejects(runDatabaseOperation(root, { config, app: { id }, project: { project_id: id }, connection }, {
    command: 'migrate', requestId, log: line => logs.push(line),
  }), /Fix the reported source error/);
  assert.equal(posts, 3, 'only rejected submissions retry; accepted failed work never replays');
  assert.equal(polls, 2, 'wait for shutdown even when retry_safe is false');
  assert.equal(blockingPolls, 2, 'poll the blocking execution instead of repeating rejected POST requests');
  assert.ok(requests.every(request => request.request_id === requestId && request.source_revision_id === id));
  assert.match(logs.join('\n'), /normally clears shortly/);
  assert.match(logs.join('\n'), /request limit reached/);
});
