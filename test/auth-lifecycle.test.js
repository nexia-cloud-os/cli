import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bindWorkspace } from '../src/workspace.js';

test('expired authentication can be inspected and cleared without deleting the project or sandbox', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-auth-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'Unauthenticated' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await bindWorkspace(root, { endpoint, project: { id: '11111111-1111-4111-8111-111111111111', name: 'Example' } });
  const binding = await readFile(path.join(root, '.nexia/project.json'), 'utf8');
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint, token: 'test-expired-token' }));
  await writeFile(path.join(root, 'AGENTS.md'), 'Developer-owned rules');
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const options = { cwd: root, env: { ...process.env, NEXIA_CONFIG_HOME: root } };
  const result = await promisify(execFile)(process.execPath, [cli, 'status', '--json'], options);
  assert.equal(JSON.parse(result.stdout).authenticated, false);
  await promisify(execFile)(process.execPath, [cli, 'logout', '--yes'], options);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'connection.json'), 'utf8')), { endpoint });
  assert.equal(await readFile(path.join(root, '.nexia/project.json'), 'utf8'), binding);
  assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), 'Developer-owned rules');
  assert.deepEqual(calls, ['GET /developer-api/connection', 'DELETE /developer-api/connection']);
});
