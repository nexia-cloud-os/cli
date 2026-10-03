import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
test('connect binds a folder; nested login preserves it; status and logout keep secrets off stdout', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-auth-cli-'));
  const project = { id: '12345678-1234-1234-1234-123456789abc', name: 'Test project' };
  const token = 'c'.repeat(64), calls = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push([req.method, req.url]);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/pair')) {
      assert.deepEqual(JSON.parse(raw), { project_id: project.id });
      res.end(JSON.stringify({ token, user_code: 'CODE', verification_url: `${endpoint}/projects/${project.id}/connect`, expires_in: 600 }));
    } else {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      res.end(JSON.stringify({ status: req.method === 'DELETE' ? 'revoked' : 'connected', project }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const folder = path.join(root, 'project'), nested = path.join(folder, 'notes');
  await mkdir(nested, { recursive: true });
  const run = async (args, cwd = folder) => {
    const result = await execute(process.execPath, [cli, ...args], { cwd, env: { ...process.env, NEXIA_CONFIG_HOME: path.join(root, 'config'), NEXIA_ENDPOINT: endpoint }, timeout: 5000 });
    assert.ok(!`${result.stdout}${result.stderr}`.includes(token));
    return result;
  };
  await run(['connect', project.id, '--yes', '--no-browser']);
  const binding = await readFile(path.join(folder, '.nexia/project.json'), 'utf8');
  await run(['login', '--no-browser'], nested);
  assert.equal(await readFile(path.join(folder, '.nexia/project.json'), 'utf8'), binding);
  const status = JSON.parse((await run(['status', '--json'], nested)).stdout);
  assert.equal(status.authenticated, true);
  assert.equal(status.matches_folder, true);
  await run(['logout', '--yes'], nested);
  assert.ok(calls.some(([method, url]) => method === 'DELETE' && url.endsWith('/connection')));
  assert.equal(await readFile(path.join(folder, '.nexia/project.json'), 'utf8'), binding);
  assert.equal(JSON.parse((await run(['status', '--json'])).stdout).authenticated, false);
});
