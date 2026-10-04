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

test('db migrations preserve App binding, request identity and writer release', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-db-operation-'));
  const app = '11111111-1111-4111-8111-111111111111', project = '33333333-3333-4333-8333-333333333333', requestId = '22222222-2222-4222-8222-222222222222';
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    calls.push([req.method, req.url, body && JSON.parse(body)]);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/connection') ? { status: 'connected', project: { id: project } }
      : req.method === 'GET' ? { operation: null }
        : req.url.endsWith('/writer') ? { writer: { released: true } }
          : { operation: { id: requestId, database_command: 'migrate', status: 'queued' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const appRoot = path.join(root, 'app'); await mkdir(path.join(appRoot, '.nexia'), { recursive: true });
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, token: 'db-operation-token' }), { mode: 0o600 });
  await writeFile(path.join(appRoot, '.nexia', 'project.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, project_id: project }));
  await writeFile(path.join(appRoot, '.nexia', 'app.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, id: app, key: 'sample' }));
  await writeFile(path.join(appRoot, 'nexia.json'), JSON.stringify({ schema_version: '2', runtime: 'laravel', app: { app_key: 'sample' } }));
  const options = { cwd: appRoot, env: { ...process.env, NEXIA_CONFIG_HOME: root } };
  await assert.rejects(execute(process.execPath, [cli, 'db', 'migrate'], options));
  assert.equal(calls.some(call => call[0] !== 'GET'), false);
  calls.length = 0;
  await execute(process.execPath, [cli, 'db', 'migrate', '--yes', '--request-id', requestId], options);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], ['GET', '/developer-api/connection', '']);
  assert.equal(calls[1][0], 'POST'); assert.equal(calls[1][1], `/developer-api/v2/apps/${app}/database-operations`);
  assert.deepEqual(Object.keys(calls[1][2]).sort(), ['command', 'request_id', 'writer_session']);
  assert.equal(calls[1][2].command, 'migrate');
  assert.equal(calls[1][2].writer_session, requestId);
  assert.deepEqual(calls[2], ['PUT', `/developer-api/v2/apps/${app}/writer`, { session_id: requestId, release: true }]);
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
