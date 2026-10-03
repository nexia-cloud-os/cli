import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const syncModule = new URL('../src/sync.js', import.meta.url).href;
const syncArgs = root => ['--input-type=module', '-e', `const { syncSource } = await import(${JSON.stringify(syncModule)}); await syncSource(process.argv[1]);`, root];
test('sync uses the bound project and sends private source without credentials', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-sync-'));
  const id = '11111111-1111-4111-8111-111111111111';
  const calls = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer disposable-token');
    let raw = ''; for await (const bytes of req) raw += bytes;
    calls.push([req.url, raw && JSON.parse(raw)]);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.method === 'POST' ? { revision: { id, digest: JSON.parse(raw).source.digest, file_count: 1 } }
      : { status: 'connected', project: { id }, sandbox: { status: 'active' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await mkdir(path.join(root, '.nexia'));
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint, token: 'disposable-token' }));
  await writeFile(path.join(root, '.nexia', 'project.json'), JSON.stringify({ endpoint, project_id: id }));
  await writeFile(path.join(root, '.nexia', 'app.json'), JSON.stringify({ endpoint, id }));
  await writeFile(path.join(root, 'composer.json'), '{}');
  await writeFile(path.join(root, '.env'), 'secret-must-not-leave');
  const options = { env: { ...process.env, NEXIA_CONFIG_HOME: root } };
  assert.match((await execute(process.execPath, syncArgs(root), options)).stdout, /does not activate/);
  assert.equal(calls[1][0], '/developer-api/v2/sources');
  assert.deepEqual(calls[1][1].source.files.map(file => file.path), ['composer.json']);
  assert.doesNotMatch(JSON.stringify(calls[1][1]), /disposable-token|secret-must-not-leave/);
  await writeFile(path.join(root, '.nexia', 'project.json'), JSON.stringify({ endpoint, project_id: 'another' }));
  await assert.rejects(execute(process.execPath, syncArgs(root), options), /linked to another project/);
  assert.equal(calls.length, 3);
});
