import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('normal submit status displays the optional server advisory without changing its outcome', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-dashboard-warning-'));
  const config = path.join(root, 'config');
  const project = { id: '12345678-1234-1234-1234-123456789abc', name: 'Example' };
  const id = '22222222-2222-4222-8222-222222222222';
  const token = 'c'.repeat(64);
  let advisory = { scope: 'inventory_only', missing: [{ key: 'trial.summary.read', kind: 'source', path: '/api/trial/summary' }], omitted: 0 };
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/connection') ? { status: 'connected', project } : {
      submission: { id, tag: 'v1.0.0', status: 'succeeded' },
      review: { status: 'ready_for_human_review', ready_for_human_review: true, checks: [], ...(advisory && { dashboard_route_advisory: advisory }) },
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await mkdir(config);
  await writeFile(path.join(config, 'connection.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:' + server.address().port, token }), { mode: 0o600 });
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = () => promisify(execFile)(process.execPath, [cli, 'submit', 'status', id], { cwd: root, env: { ...process.env, NEXIA_CONFIG_HOME: config }, timeout: 5000 });
  const current = await run();
  assert.match(current.stdout, /trial.summary.read \(source\).*absent from the route inventory/);
  assert.match(current.stdout, /route order, parameter bindings and permissions are not verified/);
  assert.match(current.stdout, /Await administrator review/);
  assert.doesNotMatch(current.stdout + current.stderr, new RegExp(token));
  advisory = null;
  const oldCore = await run();
  assert.doesNotMatch(oldCore.stdout, /Dashboard route inventory/);
  assert.match(oldCore.stdout, /Await administrator review/);
});
