import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveConnection } from '../src/connection.js';
import { bindWorkspace } from '../src/workspace.js';
import { workspaceDev } from '../src/workspace-dev.js';

test('project dev registers a hot-added App on the same port and leaves other Apps running', { timeout: 20000 }, async t => {
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
    try {
      assert.equal(req.headers.authorization, 'Bearer fixture');
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      let result;
      if (req.url === '/developer-api/connection') result = { status: 'connected', project, capabilities: { personal_sandboxes: true },
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
  const shutdown = new AbortController();
  let url;
  const messages = [];
  const running = workspaceDev(workspace, { signal: shutdown.signal, port: 0, log: message => {
    messages.push(message);
    if (message.startsWith('Project:')) url = new URL(message.split('\n')[1].replace('Nexia workspace: ', '')).searchParams.get('preview');
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
      if (current?.apps.length === count) return current;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(messages.join('\n'));
  };
  const first = await waitForApps(1);
  await addApp('payroll');
  const second = await waitForApps(2);
  assert.equal(second.apps[0].app_id, first.apps[0].app_id);
  assert.equal(registrations.size, 2);
  assert.equal(operations.size, 2);
  shutdown.abort(); await running;
});
