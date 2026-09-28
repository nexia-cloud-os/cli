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
  assert.equal(validateEndpoint('http://sbx-example.localhost:8081'), 'http://sbx-example.localhost:8081');
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
  let opened;
  await login(projectId, { log: line => lines.push(line), pollMs: 1, openBrowser: async url => {
    opened = url;
    throw new Error('Browser opener unavailable');
  } });
  assert.match(opened, /\/projects\/12345678-1234-1234-1234-123456789abc\/connect$/);
  assert.ok(lines.some(line => line.includes(opened)), 'The approval URL remains available after browser opening fails.');
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

test('project creation resumes the same approval after a lost response and renews only an unapproved expiry', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-create-recovery-'));
  process.env.NEXIA_CONFIG_HOME = root;
  const project = { id: '12345678-1234-1234-1234-123456789abc', name: 'Shared project' };
  let pairs = 0, phase = 'lost';
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/pair')) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      assert.deepEqual(JSON.parse(raw), { project_name: project.name });
      pairs++;
      res.end(JSON.stringify({ token: 'b'.repeat(64), user_code: 'CODE', verification_url: `${endpoint}/connect-project`, expires_in: 600 }));
    } else if (phase === 'lost') { res.writeHead(503); res.end('{}'); }
    else if (phase === 'expired') { res.writeHead(410); res.end(JSON.stringify({ status: 'pairing_expired' })); }
    else if (phase === 'revoked') { res.writeHead(401); res.end('{}'); }
    else res.end(JSON.stringify({ status: 'connected', project }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); delete process.env.NEXIA_CONFIG_HOME; await rm(root, { recursive: true, force: true }); });
  await setEndpoint(endpoint);
  const options = { projectName: project.name, recoveryKey: '/local/project', openBrowser: null, log: () => {} };
  await assert.rejects(login(undefined, options), /503/);
  phase = 'approved';
  const connected = await login(undefined, options);
  assert.equal(connected.project.id, project.id);
  assert.equal(pairs, 1, 'an approved request is recovered, never duplicated');
  assert.equal((await stat(connected.recoveryFile)).mode & 0o777, 0o600);
  phase = 'revoked';
  await assert.rejects(login(undefined, options), /401/);
  await stat(connected.recoveryFile);
  phase = 'expired';
  await assert.rejects(login(undefined, options), /410/);
  await assert.rejects(stat(connected.recoveryFile), { code: 'ENOENT' });
  phase = 'approved';
  await login(undefined, options);
  assert.equal(pairs, 2);
});
