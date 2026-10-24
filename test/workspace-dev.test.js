import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveConnection } from '../src/connection.js';
import { bindWorkspace } from '../src/workspace.js';
import { workspaceDev } from '../src/workspace-dev.js';
import { startDevSession, listDevSessions } from '../src/dev-sessions.js';

for (const selected of [false, true]) test(`project dev ${selected ? 'only watches selected Apps' : 'registers hot-added Apps'} on the same port`, { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-project-dev-'));
  const previous = process.env.NEXIA_CONFIG_HOME;
  process.env.NEXIA_CONFIG_HOME = path.join(root, '.config');
  t.after(async () => {
    if (previous === undefined) delete process.env.NEXIA_CONFIG_HOME; else process.env.NEXIA_CONFIG_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  const project = { id: randomUUID(), name: 'Shared project' }, sandboxId = randomUUID();
  const registrations = new Map(), sources = new Map(), operations = new Map();
  let endpoint;
  const server = createServer(async (req, res) => {
    if (req.url.endsWith('/database-operations')) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ operation: null })); return; }
    try {
      assert.equal(req.headers.authorization, 'Bearer fixture');
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      let result;
      if (req.url === '/developer-api/connection') result = { status: 'connected', project, capabilities: { explicit_development_migrations: true, personal_sandboxes: true },
        sandbox: { id: sandboxId, status: 'active', workspace_url: 'http://sandbox.localhost:8081', launch_url: `${endpoint}/projects/${project.id}/workspace` } };
      else if (req.url === '/developer-api/apps') {
        const key = body.metadata.app_key;
        const app = registrations.get(key) ?? { id: randomUUID(), key, name: key, package_name: body.package_name, table_prefix: body.metadata.app_table_prefix };
        registrations.set(key, app); result = { app };
      } else if (/\/execution$/.test(req.url)) result = { selection: { app_id: req.url.split('/')[4], project_id: project.id, sandbox_id: sandboxId, mode: null, revision: 0, stop_pending: false } };
      else if (req.url === '/developer-api/v2/sources') {
        const revision = { id: randomUUID(), digest: body.source.digest, file_count: body.source.files.length };
        sources.set(revision.id, body.app_id); result = { revision };
      } else if (req.url === '/developer-api/v2/runtime-operations' && req.method === 'POST') {
        const operation = { id: randomUUID(), request_id: body.request_id, source_revision_id: body.source_revision_id,
          developer_project_id: project.id, developer_sandbox_id: sandboxId, status: 'completed' };
        operations.set(operation.id, operation); result = { operation };
      } else result = { operation: operations.get(req.url.split('/').at(-1)) };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (error) { res.writeHead(500).end(JSON.stringify({ message: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => server.close(resolve)));
  await saveConnection({ endpoint, token: 'fixture', project });
  const workspace = await bindWorkspace(root, { endpoint, project });
  const addApp = async name => {
    const directory = path.join(root, name);
    await mkdir(path.join(directory, 'dist/frontend'), { recursive: true });
    await writeFile(path.join(directory, 'composer.json'), JSON.stringify({ name: `example/${name}` }));
    await writeFile(path.join(directory, 'dist/frontend/index.js'), `export const name = '${name}';`);
    await writeFile(path.join(directory, 'nexia.json'), JSON.stringify({ schema_version: '2', runtime: 'laravel', app: { app_key: name, app_table_prefix: name } }));
  };
  await addApp('people');
  if (selected) await addApp('ignored');
  const shutdown = new AbortController();
  const session = await startDevSession(root, { port: 4310, projectId: project.id, stop: () => shutdown.abort() });
  t.after(() => session.close());
  const sessionApps = async () => (await listDevSessions(root))[0].apps;
  let url;
  const messages = [];
  const running = workspaceDev(workspace, { signal: shutdown.signal, port: 0, onStatus: value => session.update(value), ...(selected ? { app: ['people', 'payroll'] } : {}), log: message => {
    messages.push(message);
    const match = message.match(/Local address\s+(http:\/\/[^\s]+)/);
    if (match) url = match[1];
  } });
  t.after(async () => { shutdown.abort(); await running; });
  const manifest = async () => {
    if (!url) return null;
    return (await fetch(`${url}/__nexia_native`, { headers: { Origin: 'http://sandbox.localhost:8081' } })).json();
  };
  const waitForApps = async count => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const current = await manifest();
      if (current?.apps.length === count) {
        const ready = await Promise.all(current.apps.map(async app => {
          const response = await fetch(`${url}/__nexia_native?app_id=${app.app_id}`, { headers: { Origin: 'http://sandbox.localhost:8081' } });
          return response.ok && typeof (await response.json()).operation_id === 'string';
        }));
        if (ready.every(Boolean)) return current;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(messages.join('\n'));
  };
  const first = await waitForApps(1);
  assert.deepEqual(await sessionApps(), ['people']);
  assert.ok(!messages.some(value => /DONE.*App registration confirmed/.test(value)), 'registration alone is not development readiness');
  assert.ok(messages.some(message => message.includes(`Local address  ${url}`)), 'print the actual listening address separately, including dynamically assigned ports');
  const metadata = path.join(root, 'people/composer.json'), before = await readFile(metadata, 'utf8');
  await writeFile(metadata, '{ broken');
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.ok(messages.some(message => message.includes('Invalid JSON in')));
  assert.ok(!messages.some(message => message.includes('Local watch removed')));
  assert.deepEqual(await sessionApps(), ['people']);
  await writeFile(metadata, before);
  const projectFile = path.join(root, '.nexia/project.json'), projectBefore = await readFile(projectFile, 'utf8');
  await writeFile(projectFile, '{ broken');
  await new Promise(resolve => setTimeout(resolve, 1500));
  await writeFile(projectFile, projectBefore);
  await addApp('payroll');
  const second = await waitForApps(2);
  assert.equal(second.apps[0].app_id, first.apps[0].app_id);
  assert.equal(registrations.size, 2);
  assert.equal(registrations.has('ignored'), false);
  assert.equal(operations.size, 2);
  assert.deepEqual(await sessionApps(), ['people', 'payroll']);
  await rm(path.join(root, 'people'), { recursive: true });
  await waitForApps(1);
  assert.deepEqual(await sessionApps(), ['payroll']);
  shutdown.abort(); await running;
  assert.deepEqual(await sessionApps(), []);
});

test('failed sandbox retries once and preserves the failure guidance if preparation still fails', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-inactive-sandbox-'));
  const previous = process.env.NEXIA_CONFIG_HOME;
  process.env.NEXIA_CONFIG_HOME = root;
  const project = randomUUID();
  let retries = 0;
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/developer-api/sandbox') retries++;
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      status: 'connected', project: { id: project }, capabilities: { personal_sandboxes: true }, sandbox: { status: 'failed' },
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.NEXIA_CONFIG_HOME; else process.env.NEXIA_CONFIG_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint, token: 'test-only' }));
  await assert.rejects(workspaceDev({ root, endpoint, project_id: project }, {
    reporter: { task() {}, summary() {} },
  }), error => {
    assert.equal(error.code, 'SANDBOX_NOT_ACTIVE');
    assert.match(error.message, /status: failed/);
    assert.equal(retries, 1);
    assert.match(error.message, /run nexia dev again to resume safely/);
    assert.doesNotMatch(error.message, /renew or recover/);
    return true;
  });
});


test('failed sandbox resumes through the existing prepare endpoint before local development starts', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-resume-sandbox-'));
  const previous = process.env.NEXIA_CONFIG_HOME;
  process.env.NEXIA_CONFIG_HOME = root;
  const project = randomUUID(), abort = new AbortController();
  let endpoint, retries = 0, ready = false;
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/developer-api/sandbox') retries++;
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      status: 'connected', project: { id: project, name: 'Retry' }, capabilities: { personal_sandboxes: true },
      sandbox: { status: retries ? 'active' : 'failed', workspace_url: 'http://sandbox.localhost:8081', launch_url: `${endpoint}/projects/${project}/workspace` },
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.NEXIA_CONFIG_HOME; else process.env.NEXIA_CONFIG_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  endpoint = `http://127.0.0.1:${server.address().port}`;
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint, token: 'test-only' }));
  await workspaceDev({ root, endpoint, project_id: project }, {
    signal: abort.signal, port: 0,
    reporter: { task(_id, state) { if (state === 'success') { ready = true; abort.abort(); } }, summary() {} },
  });
  assert.equal(retries, 1);
  assert.equal(ready, true);
});
