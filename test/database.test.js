import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('database reset and reference catalog are not exposed as public commands', async () => {
  const { parseCommand } = await import('../src/commands.js');
  assert.throws(() => parseCommand(['db', 'reset', '--yes']));
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
  ]) await assert.rejects(execute(process.execPath, [cli, ...args], options), /linked to another project/);
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ['GET', '/developer-api/connection', '']));
});

test('explicit database commands reject older platforms before uploading or mutating', async () => {
  const { runDatabaseOperation } = await import('../src/database-operations.js');
  await assert.rejects(runDatabaseOperation('/unused', { connection: { capabilities: {} } }, {
    command: 'migrate', requestId: '22222222-2222-4222-8222-222222222222', log: () => {},
  }), /No database request was sent/);
});
