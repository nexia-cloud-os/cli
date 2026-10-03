import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);

test('tag submission uses only remote source and retired deploy never sends a request', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-submit-'));
  const project = randomUUID(), app = randomUUID(), id = randomUUID(), requestId = randomUUID();
  const calls = [];
  let submitted;
  const submission = { id, developer_project_id: project, tag: 'v1.2.0', version: '1.2.0', commit_sha: 'a'.repeat(40), status: 'waiting', retryable: false };
  const server = createServer(async (req, res) => {
    calls.push(req.url);
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = raw ? JSON.parse(raw) : null;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/developer-api/connection') res.end(JSON.stringify({ status: 'connected', project: { id: project }, sandbox: null }));
    else if (req.url === `/developer-api/v2/apps/${app}/repository`) res.end(JSON.stringify({ repository: { full_name: 'example/app', status: 'connected' } }));
    else if (req.url === '/developer-api/v2/submissions') { submitted = input; res.end(JSON.stringify({ submission })); }
    else if (req.url === `/developer-api/v2/submissions/${id}`) res.end(JSON.stringify({ submission }));
    else if (req.url === `/developer-api/v2/submissions/${id}/cancel`) res.end(JSON.stringify({ submission: { ...submission, status: 'cancelled' } }));
    else if (req.url === `/developer-api/v2/submissions/${id}/retry`) { res.statusCode = 409; res.end('{}'); }
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await mkdir(path.join(root, '.nexia'));
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint, token: 'synthetic' }));
  await writeFile(path.join(root, '.nexia/project.json'), JSON.stringify({ endpoint, project_id: project }));
  await writeFile(path.join(root, '.nexia/app.json'), JSON.stringify({ endpoint, id: app }));
  await writeFile(path.join(root, 'composer.json'), 'uncommitted invalid source must never be uploaded');
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  await writeFile(path.join(root, 'nexia.json'), JSON.stringify({ schema_version: '2', runtime: 'laravel', app: { app_key: 'sample' } }));
  const run = args => execute(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, NEXIA_CONFIG_HOME: root } });
  await assert.rejects(run(['deploy', root]), /no longer a command/);
  assert.equal(calls.length, 0);
  await assert.rejects(run(['submit', '--yes', '--tag', 'latest']), /version|v1.0.0/);
  assert.equal(calls.length, 0);
  assert.match((await run(['submit', '--yes', '--tag', 'v1.2.0', '--request-id', requestId])).stderr, /v1.2.0: waiting/);
  assert.deepEqual(submitted, { app_id: app, tag: 'v1.2.0', request_id: requestId });
  assert.match((await run(['submit', 'status', id])).stdout, /waiting/);
  assert.match((await run(['submit', 'cancel', id, '--yes'])).stdout, /cancelled/);
  await assert.rejects(run(['submit', 'retry', id, '--yes']), /409/);
  assert.equal(calls.some(route => /sources|artifact-builds|deployments/.test(route)), false);
});
