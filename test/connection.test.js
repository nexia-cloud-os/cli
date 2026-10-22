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

test('source uploads survive a slow response without extending runtime request deadlines', async t => {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', milliseconds => realTimeout(milliseconds / 1000));
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    setTimeout(() => { res.setHeader('Content-Type', 'application/json'); res.end('{"accepted":true}'); }, 60);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const config = { endpoint: `http://127.0.0.1:${server.address().port}`, token: 'test-only' };
  assert.deepEqual(await request(config, 'v2/sources', { method: 'POST', body: {} }), { accepted: true });
  await assert.rejects(request(config, 'v2/runtime-operations', { method: 'POST', body: {} }), { name: 'TimeoutError' });
});

test('a timed-out response body retains its timeout and safe request identity', async t => {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', () => realTimeout(5));
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => ({
    status: 200,
    json: () => new Promise((_, reject) => {
      const abort = () => reject(new DOMException('Aborted response body', 'AbortError'));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    }),
  }));
  // Timeout signals are unref'ed; keep the test alive while the response is pending.
  const alive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(request({ endpoint: 'http://platform.localhost:8080', token: 'test-secret' }, 'v2/sources', { method: 'POST', body: {} }), error => {
      assert.equal(error.name, 'TimeoutError');
      assert.equal(error.platformRequest, 'POST /developer-api/v2/sources');
      assert.doesNotMatch(error.message, /test-secret/);
      return true;
    });
  } finally { clearTimeout(alive); }
});

test('preparation conflicts distinguish waiting from review and reject unsafe diagnostic links', async t => {
  const id = '11111111-1111-4111-8111-111111111111';
  const project = '22222222-2222-4222-8222-222222222222';
  const operation = { id, status: 'needs_review', diagnostic_path: `/projects/${project}/development?operation=${id}#operation-${id}`,
    failure: { code: 'APPLIED_MIGRATION_SOURCE_MISMATCH', stage: 'migration_preflight' },
    recovery_check: { migrations: [{ name: '2026_10_14_payroll', reason: 'missing' }] } };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 409,
    json: async () => ({ status: 'preparation_pending', message: 'Preparation pending.', blocking_operation: operation }) }));
  const config = { endpoint: 'https://developers.example', token: 'test-secret' };
  for (const status of ['needs_review', 'queued', 'running', 'failed']) {
    operation.status = status;
    await assert.rejects(request(config, 'v2/runtime-operations'), error => {
      assert.equal(error.status, 409);
      assert.match(error.message, /missing: 2026_10_14_payroll.php/);
      assert.match(error.message, /Details: https:\/\/developers.example\/projects\//);
      assert.match(error.message, status === 'needs_review' ? /no administrator approval is required/ : /Wait for this preparation/);
      assert.doesNotMatch(error.message, /test-secret/);
      return true;
    });
  }
  operation.diagnostic_path = 'https://untrusted.example';
  await assert.rejects(request(config, 'v2/runtime-operations'), error => {
    assert.equal(error.message, 'Platform HTTP 409: Preparation pending.');
    return true;
  });
});


test('pairing respects Retry-After for creation and polling without replacing the pending token', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-pair-rate-limit-'));
  process.env.NEXIA_CONFIG_HOME = root;
  t.after(async () => { delete process.env.NEXIA_CONFIG_HOME; await rm(root, { recursive: true, force: true }); });
  const endpoint = 'https://example.test';
  const project = { id: '12345678-1234-1234-1234-123456789abc', name: 'Test' };
  const token = 'd'.repeat(64), lines = [];
  let pairs = 0, polls = 0, pairLimitedAt, pollLimitedAt;
  await setEndpoint(endpoint);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/pair')) {
      if (++pairs === 1) {
        pairLimitedAt = Date.now();
        return new Response('{}', { status: 429, headers: { 'Retry-After': '1' } });
      }
      assert.ok(Date.now() - pairLimitedAt >= 1000);
      return Response.json({ token, user_code: 'CODE', verification_url: `${endpoint}/connect`, expires_in: 600 });
    }
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    if (++polls === 1) {
      pollLimitedAt = Date.now();
      return new Response('{}', { status: 429, headers: { 'Retry-After': '1' } });
    }
    assert.ok(Date.now() - pollLimitedAt >= 1000);
    return Response.json({ status: 'connected', project });
  });
  const connected = await login(project.id, { recoveryKey: root, openBrowser: false, log: line => lines.push(line) });
  assert.equal(pairs, 2);
  assert.equal(polls, 2);
  assert.equal((await readConnection()).token, token);
  assert.equal(JSON.parse(await readFile(connected.recoveryFile, 'utf8')).pairing.token, token);
  assert.ok(!lines.join(' ').includes(token));
});

test('pairing does not replay an ambiguous POST or wait beyond its retry budget', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-pair-retry-budget-'));
  process.env.NEXIA_CONFIG_HOME = root;
  t.after(async () => { delete process.env.NEXIA_CONFIG_HOME; await rm(root, { recursive: true, force: true }); });
  const projectId = '12345678-1234-1234-1234-123456789abc';
  await saveConnection({ endpoint: 'https://example.test', token: 'existing-approved-token' });
  let status = 503, pairs = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    pairs++;
    return new Response('{}', { status, headers: { 'Retry-After': '600' } });
  });
  const options = { recoveryKey: root, openBrowser: false, log: () => {} };
  await assert.rejects(login(projectId, options), { status: 503 });
  assert.equal(pairs, 1);
  status = 429;
  await assert.rejects(login(projectId, options), { status: 429 });
  assert.equal(pairs, 2);
  assert.equal((await readConnection()).token, 'existing-approved-token');
});
