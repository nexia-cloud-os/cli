import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('resource discovery uses the existing authenticated API and distinguishes metadata from access', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-resources-'));
  let calls = 0;
  const payload = { resources: [{ key: 'sample.records', version: '1.0.0', status: 'active', declared_permissions: [], events: [], actions: [] }], grants_data_access: false };
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/developer-api/resources');
    assert.equal(req.headers.authorization, 'Bearer disposable-test-token');
    calls++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, token: 'disposable-test-token' }), { mode: 0o600 });
  const options = { env: { ...process.env, NEXIA_CONFIG_HOME: root } };
  const json = await run(process.execPath, [cli, 'resources', 'list', '--json'], options);
  assert.deepEqual(JSON.parse(json.stdout), payload);
  const text = await run(process.execPath, [cli, 'resources', 'list'], options);
  assert.match(text.stdout, /sample.records/);
  assert.match(text.stdout, /does not grant data access/);
  assert.doesNotMatch(text.stdout, /disposable-test-token/);
  await assert.rejects(run(process.execPath, [cli, 'resources', 'list', '--port', '1234'], options), /Use nexia resources list/);
  assert.equal(calls, 2);
});
