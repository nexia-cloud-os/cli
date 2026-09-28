import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { nativeDev } from '../src/native-dev.js';

test('native dev rejects an App rebind during a connection request before uploading source', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-native-rebind-'));
  const project = randomUUID(), app = randomUUID();
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const calls = [];
  const server = createServer(async (req, res) => {
    calls.push(req.url);
    // Another terminal changes the binding while the first public request is in flight.
    await writeFile(path.join(root, '.nexia/app.json'), JSON.stringify({ endpoint, id: randomUUID() }));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'connected', project: { id: project }, sandbox: { status: 'active', workspace_url: 'http://workspace.localhost:8081', launch_url: `${endpoint}/launch` } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await mkdir(path.join(root, '.nexia'));
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint, token: 'disposable-token' }));
  await writeFile(path.join(root, '.nexia/project.json'), JSON.stringify({ endpoint, project_id: project }));
  await writeFile(path.join(root, '.nexia/app.json'), JSON.stringify({ endpoint, id: app, key: 'trial' }));
  await writeFile(path.join(root, 'composer.json'), '{}');
  await assert.rejects(promisify(execFile)(process.execPath, [cli, 'dev', root], {
    env: { ...process.env, NEXIA_CONFIG_HOME: root }, timeout: 5000,
  }), /App binding changed/);
  assert.deepEqual(calls, ['/developer-api/connection']);
  await assert.rejects(readFile(path.join(root, '.nexia/runtime.json')), { code: 'ENOENT' });
});

test('native dev resumes an ambiguous request and serializes changed source after preparation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-native-dev-'));
  const previousConfig = process.env.NEXIA_CONFIG_HOME;
  process.env.NEXIA_CONFIG_HOME = root;
  const project = randomUUID(), app = randomUUID(), sandbox = randomUUID();
  const operations = new Map(), revisions = new Map(), submissions = [];
  let mode = 'development', selectionRevision = 1, raceOff = false, offPolls = 0;
  let loseResponse = true, sequence = 0, polls = 0;
  let throttledAt = null, retriedAt = null, unavailableReads = 0;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer disposable-token');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = raw ? JSON.parse(raw) : null;
    let payload;
    if (req.url.endsWith('/connection')) payload = { status: 'connected', project: { id: project }, sandbox: { status: 'active', workspace_url: 'http://workspace.localhost:8081', launch_url: `${endpoint}/launch` } };
    else if (req.url.endsWith('/execution')) {
      payload = { selection: { app_id: app, project_id: project, sandbox_id: sandbox, mode, revision: selectionRevision, stop_pending: false } };
      if (mode === 'off' && ++offPolls === 3) { mode = 'development'; selectionRevision++; }
    } else if (req.url.endsWith('/v2/sources')) {
      assert.notEqual(mode, 'off');
      assert.doesNotMatch(raw, /secret-must-not-leave/);
      const revision = { id: randomUUID(), digest: input.source.digest, file_count: input.source.files.length };
      revisions.set(revision.id, revision);
      payload = { revision };
    } else if (req.method === 'POST') {
      if (!loseResponse && throttledAt === null) {
        throttledAt = Date.now();
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
        res.end(JSON.stringify({ message: 'Too Many Attempts.' }));
        return;
      }
      if (throttledAt !== null && retriedAt === null) retriedAt = Date.now();
      submissions.push(input.request_id);
      if (raceOff) {
        raceOff = false; mode = 'off'; selectionRevision++;
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Development execution is off' }));
        return;
      }
      if (!operations.has(input.request_id)) operations.set(input.request_id, { id: randomUUID(), request_id: input.request_id, source_revision_id: input.source_revision_id, developer_project_id: project, status: 'queued' });
      payload = { operation: operations.get(input.request_id) };
      if (loseResponse) { loseResponse = false; req.socket.destroy(); return; }
    } else {
      const operation = [...operations.values()].find(op => req.url.endsWith(op.id));
      assert.ok(operation);
      if (unavailableReads++ === 0) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Restarting' })); return;
      }
      polls++;
      operation.status = 'completed';
      payload = { operation };
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (previousConfig === undefined) delete process.env.NEXIA_CONFIG_HOME; else process.env.NEXIA_CONFIG_HOME = previousConfig;
    await rm(root, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await mkdir(path.join(root, '.nexia'));
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint, token: 'disposable-token' }));
  await writeFile(path.join(root, '.nexia/project.json'), JSON.stringify({ endpoint, project_id: project }));
  await writeFile(path.join(root, '.nexia/app.json'), JSON.stringify({ endpoint, id: app, key: 'trial' }));
  await writeFile(path.join(root, 'composer.json'), '{}');
  await writeFile(path.join(root, '.env'), 'secret-must-not-leave');
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'dev', root], { env: process.env }), /fetch failed/);
  const pending = JSON.parse(await readFile(path.join(root, '.nexia/runtime.json'), 'utf8'));
  assert.equal(pending.request_id, submissions[0]);
  assert.equal(pending.operation_id, undefined);
  // File changes while the prior request is uncertain must not replace its request key.
  await writeFile(path.join(root, 'composer.json'), '{"description":"changed"}');
  const shutdown = new AbortController();
  const deadline = setTimeout(() => shutdown.abort(), 5000);
  try {
    await nativeDev(root, { port: 0, interval: 1, signal: shutdown.signal, log: message => {
      if (message.includes('preparation completed')) { sequence++; if (sequence === 2) shutdown.abort(); }
    } });
  } finally { clearTimeout(deadline); }
  assert.equal(sequence, 2);
  assert.ok(retriedAt - throttledAt >= 1000, '429 respects Retry-After before reusing the pending request');
  assert.equal(submissions[0], submissions[1]);
  assert.equal(operations.size, 2);
  assert.equal(revisions.size, 2);
  assert.equal(polls, 2);
  assert.equal(unavailableReads, 3, "temporary status failure is retried without another preparation");
  assert.doesNotMatch(await readFile(path.join(root, '.nexia/runtime.json'), 'utf8'), /disposable-token|secret-must-not-leave/);
  const stopped = [...operations.values()].at(-1);
  stopped.stop_requested_at = new Date().toISOString();
  const lifecycleMessages = [];
  await assert.rejects(nativeDev(root, { port: 0, interval: 1, log: message => lifecycleMessages.push(message) }), /shutdown is still pending/);
  assert.ok(lifecycleMessages.some(message => message.startsWith('App execution stopping:')));
  assert.ok(lifecycleMessages.every(message => !message.includes('preparation completed')));
  assert.equal(operations.size, 2);
  stopped.stopped_at = new Date().toISOString();
  const restarted = new AbortController();
  raceOff = true;
  await nativeDev(root, { port: 0, interval: 1, signal: restarted.signal, log: message => {
    lifecycleMessages.push(message);
    if (message.includes('preparation queued')) restarted.abort();
  } });
  assert.ok(lifecycleMessages.some(message => message.startsWith('App execution stopped:')));
  assert.ok(lifecycleMessages.every(message => !message.includes('preparation completed')));
  assert.equal(operations.size, 3);
  assert.equal(offPolls, 3);
  assert.equal(submissions.at(-1), submissions.at(-2), 'off race retains the pending idempotency key');
  [...operations.values()].at(-1).status = 'needs_review';
  // Return a terminal status on submission resume; do not silently create a fresh request.
  const last = JSON.parse(await readFile(path.join(root, '.nexia/runtime.json'), 'utf8'));
  delete last.operation_id;
  await writeFile(path.join(root, '.nexia/runtime.json'), JSON.stringify(last));
  await assert.rejects(nativeDev(root, { port: 0, interval: 1, log: () => {} }), /requires operator review/);
  assert.equal(operations.size, 3);
});
