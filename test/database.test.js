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

test('db references reads the Core contract without a DB login or mutation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-db-cli-'));
  const calls = [];
  let response = { references: [{ schema: 'public', table: 'users', column: 'id' }], grants_data_access: false };
  const server = createServer((req, res) => {
    calls.push([req.method, req.url]);
    assert.equal(req.headers.authorization, 'Bearer disposable-db-catalog-token');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(response));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, token: 'disposable-db-catalog-token' }), { mode: 0o600 });
  const options = { env: { ...process.env, NEXIA_CONFIG_HOME: root } };
  const human = await execute(process.execPath, [cli, 'db', 'references'], options);
  assert.match(human.stdout, /public\.users\.id/);
  assert.match(human.stdout, /do not grant access/);
  assert.deepEqual(JSON.parse((await execute(process.execPath, [cli, 'db', 'references', '--json'], options)).stdout), response);
  await assert.rejects(execute(process.execPath, [cli, 'db', 'references', '--force'], options));
  await assert.rejects(execute(process.execPath, [cli, 'db', 'references', 'another-tenant'], options));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['GET', '/developer-api/v2/database/references']);
  response = { references: [{ schema: 'public', table: 'users\u001b[2J', column: 'id' }], grants_data_access: false };
  await assert.rejects(execute(process.execPath, [cli, 'db', 'references'], options));
});

test('db lifecycle requests are App-bound and reset requires an explicit confirmation', async t => {
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
          : { operation: { id: requestId, database_command: 'reset', status: 'queued' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const appRoot = path.join(root, 'app'); await mkdir(path.join(appRoot, '.nexia'), { recursive: true });
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, token: 'db-operation-token' }), { mode: 0o600 });
  await writeFile(path.join(appRoot, '.nexia', 'project.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, project_id: project }));
  await writeFile(path.join(appRoot, '.nexia', 'app.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, id: app, key: 'sample' }));
  const options = { env: { ...process.env, NEXIA_CONFIG_HOME: root } };
  await assert.rejects(execute(process.execPath, [cli, 'db', 'reset', appRoot], options));
  await execute(process.execPath, [cli, 'db', 'reset', '--yes', appRoot, '--request-id', requestId], options);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], ['GET', '/developer-api/connection', '']);
  assert.equal(calls[1][0], 'POST'); assert.equal(calls[1][1], `/developer-api/v2/apps/${app}/database-operations`);
  assert.deepEqual(Object.keys(calls[1][2]).sort(), ['command', 'request_id', 'writer_session']);
  assert.equal(calls[1][2].command, 'reset');
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
  const options = { env: { ...process.env, NEXIA_CONFIG_HOME: root } };
  for (const args of [
    ['db', 'status', appRoot], ['db', 'migrate', appRoot], ['db', 'reset', '--yes', appRoot], ['db', 'seed', 'sample', appRoot],
  ]) await assert.rejects(execute(process.execPath, [cli, ...args], options), /linked to another project/);
  assert.deepEqual(calls, Array.from({ length: 4 }, () => ['GET', '/developer-api/connection', '']));
});
