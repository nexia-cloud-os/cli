import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('fixture CLI submits a replayable request and distinguishes queueing from completion', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-fixtures-'));
  const id = '11111111-1111-4111-8111-111111111111';
  const calls = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer disposable-fixture-token');
    let raw = '';
    for await (const part of req) raw += part;
    calls.push([req.method, req.url, raw && JSON.parse(raw)]);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.method === 'POST'
      ? { run: { id, status: 'queued' } }
      : req.url.startsWith('/developer-api/fixture-runs/')
        ? { run: { id, status: 'needs_review', app_key: 'sample', fixture_key: 'demo' } }
        : { apps: [{ app_key: 'sample', fixtures: ['demo'] }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, token: 'disposable-fixture-token' }), { mode: 0o600 });
  const options = { env: { ...process.env, NEXIA_CONFIG_HOME: root } };
  assert.match((await execute(process.execPath, [cli, 'fixtures', 'list'], options)).stdout, /sample · demo/);
  const result = await execute(process.execPath, [cli, 'fixtures', 'run', 'sample', 'demo', '--request-id', id, '--json'], options);
  assert.equal(JSON.parse(result.stdout).run.status, 'queued');
  assert.match(result.stderr, /retry with the same --request-id/);
  assert.deepEqual(calls[1], ['POST', '/developer-api/fixtures', { app_key: 'sample', fixture_key: 'demo', request_id: id }]);
  assert.match((await execute(process.execPath, [cli, 'fixtures', 'status', id], options)).stdout, /Execution may have committed/);
  for (const args of [['run', 'sample', 'demo', '--request-id', '../x'], ['status', '../other-project'], ['run', 'sample', 'demo', '--force']]) {
    await assert.rejects(execute(process.execPath, [cli, 'fixtures', ...args], options));
  }
  assert.equal(calls.length, 3);
});
