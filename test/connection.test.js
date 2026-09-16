import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, writeFile, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readConnection, saveConnection, setEndpoint, validateEndpoint, request, login } from '../src/connection.js';
import { initProject } from '../src/project.js';
import { bundleProject } from '../src/deploy.js';

test('endpoint changes clear credentials and private config is outside the project', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-connection-'));
  process.env.NEXIA_CONFIG_HOME = root;
  t.after(async () => { delete process.env.NEXIA_CONFIG_HOME; await rm(root, { recursive: true, force: true }); });
  await saveConnection({ endpoint: 'https://example.test', token: 'secret' });
  assert.equal((await stat(path.join(root, 'connection.json'))).mode & 0o777, 0o600);
  await setEndpoint('http://developers.nexia.test:8080');
  assert.equal((await readConnection()).token, undefined);
  for (const value of ['http://public.example', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?token=x']) assert.throws(() => validateEndpoint(value));
});

test('browser pairing stores a token only after matching project approval, never prints it', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-pair-'));
  process.env.NEXIA_CONFIG_HOME = root;
  const projectId = '12345678-1234-1234-1234-123456789abc';
  const token = 'a'.repeat(64);
  let poll = 0;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/developer-api/pair') res.end(JSON.stringify({ token, user_code: 'ABCDEF123456', verification_url: `http://127.0.0.1:${server.address().port}/projects/${projectId}/connect`, expires_in: 600 }));
    else { assert.equal(req.headers.authorization, `Bearer ${token}`); res.end(JSON.stringify({ status: ++poll > 1 ? 'connected' : 'pending', project: { id: projectId, name: 'Test' } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); delete process.env.NEXIA_CONFIG_HOME; await rm(root, { recursive: true, force: true }); });
  await setEndpoint(`http://127.0.0.1:${server.address().port}`);
  const lines = [];
  await login(projectId, { log: line => lines.push(line), pollMs: 1 });
  assert.equal((await readConnection()).project.id, projectId);
  assert.ok(!lines.join('\n').includes(token));
  assert.equal(poll, 2);
  await assert.rejects(() => request({ endpoint: 'https://example.test' }, 'connection'), /Connect a project first/);
});

test('deployment includes public assets only and rejects symlinks or server code', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'app');
  await initProject(directory);
  await writeFile(path.join(directory, '.env'), 'SECRET=private');
  await writeFile(path.join(directory, 'public', '.env'), 'SECRET=private');
  const bundle = await bundleProject(directory);
  assert.deepEqual(Object.keys(bundle.files), ['public/index.html']);
  await writeFile(path.join(directory, 'public', 'server.php'), '<?php');
  await assert.rejects(() => bundleProject(directory), /Unsupported public asset/);
  await rm(path.join(directory, 'public', 'server.php'));
  await symlink(path.join(directory, '.env'), path.join(directory, 'public', 'leak.html'));
  await assert.rejects(() => bundleProject(directory), /symbolic links/);
  assert.match(await readFile(path.join(directory, 'compose.yaml'), 'utf8'), /127\.0\.0\.1:\$\{NEXIA_PORT:-4310\}/);
});
