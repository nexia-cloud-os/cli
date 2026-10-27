import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { nativeDev } from '../src/native-dev.js';

const managedDatabase = handler => async (req, res) => {
  if (req.method === 'GET' && req.url.endsWith('/local-database')) {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ binding: null, tunnel_url: null }));
    return;
  }
  await handler(req, res);
};
const createServer = handler => httpServer(managedDatabase(handler));

for (const mode of ['legacy', 'failed', 'persistent', 'stopped-update', 'unconfirmed-update', 'foreign-update', 'failed-stopped-update']) {
  const safeFailure = mode === 'failed';
  const conflict = mode.endsWith('-update');
  const recover = ['stopped-update', 'failed-stopped-update'].includes(mode);
  const persistent = mode === 'persistent' || conflict;
  test(conflict ? `source update conflict recovery: ${mode}` : persistent ? 'successive Backend edits retain one execution and retry ambiguous source-update responses' : safeFailure
    ? 'stopped App execution failure accepts corrected source without administrator approval'
    : 'frontend-only edits reuse a completed runtime and the next Backend edit uploads complete source', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexia-frontend-reuse-'));
    const previousConfig = process.env.NEXIA_CONFIG_HOME;
    process.env.NEXIA_CONFIG_HOME = root;
    const shutdown = new AbortController();
    const project = randomUUID(), app = randomUUID(), sandbox = randomUUID();
    const sources = [], operations = new Map();
    let polls = 0, updates = 0, updatePosts = 0;
    const appliedUpdates = new Map();
    const writerSession = { writer: { generation: 1, app_id: app, sandbox_id: sandbox } };
    const server = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const input = raw ? JSON.parse(raw) : null;
      let result;
      if (req.url.endsWith('/database-operations')) result = { operation: null };
      else if (req.url.endsWith('/connection')) result = { status: 'connected', project: { id: project },
        capabilities: { explicit_development_migrations: true, runtime_writers: persistent }, sandbox: { id: sandbox, status: 'active',
          workspace_url: 'http://workspace.localhost:8081', launch_url: `${endpoint}/launch` } };
      else if (req.url.endsWith('/writer')) result = writerSession;
      else if (req.url.endsWith('/execution')) result = { selection: { app_id: app, project_id: project,
        sandbox_id: sandbox, mode: 'development', revision: 1, stop_pending: false } };
      else if (req.url.endsWith('/v2/sources')) {
        sources.push(input.source);
        result = { revision: { id: randomUUID(), digest: input.source.digest, file_count: input.source.files.length } };
      } else if (req.method === 'POST' && req.url.endsWith('/v2/runtime-operations')) {
        const operation = { id: randomUUID(), request_id: input.request_id, source_revision_id: input.source_revision_id,
          developer_project_id: project, developer_sandbox_id: sandbox, source_updates_supported: persistent, writer_generation: 1, status: safeFailure && operations.size === 0 ? 'failed' : 'completed',
          ...(safeFailure && operations.size === 0 ? { retry_allowed: true, started_at: new Date().toISOString(),
            stopped_at: new Date().toISOString(), failure: { code: 'PREPARATION_FAILED', stage: 'serve' } } : {}) };
        operations.set(operation.id, operation);
        result = { operation };
      } else if (persistent && req.url.endsWith('/source')) {
        updatePosts++;
        const operation = operations.values().next().value;
        assert.equal(req.url.split('/').at(-2), operation.id);
        assert.ok(input.writer_session);
        if (conflict) {
          if (mode !== 'unconfirmed-update') operation.stopped_at = new Date().toISOString();
          if (mode === 'foreign-update') operation.developer_sandbox_id = randomUUID();
          if (mode === 'failed-stopped-update') {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ operation,
              update: { id: input.request_id, operation_id: operation.id, source_revision_id: input.source_revision_id,
                status: 'failed', failure: { code: 'PREPARATION_FAILED', stage: 'source', source_reason: 'runtime_stopped' } } }));
            return;
          }
          res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'Conflict' }));
          if (!recover && updatePosts === 2) shutdown.abort();
          return;
        }
        let update = appliedUpdates.get(input.request_id);
        if (!update) {
          update = { id: input.request_id, operation_id: operation.id, source_revision_id: input.source_revision_id, status: 'completed' };
          appliedUpdates.set(update.id, update);
          operation.source_revision_id = input.source_revision_id;
          updates++;
          if (updates === 1) { res.destroy(); return; }
        }
        result = { update, operation };
      } else if (req.url.includes('/v2/runtime-operations/')) {
        const operation = operations.get(req.url.split('/').at(-1));
        if (++polls === 2) await writeFile(path.join(root, 'resources/js/Page.tsx'), 'frontend-only change');
        if (polls === 5) {
          assert.equal(sources.length, 2, 'frontend source still synchronizes while execution is unchanged');
          assert.equal(operations.size, 1);
          await writeFile(path.join(root, 'src/Handler.php'), '<?php // backend change');
        }
        if (persistent && updates === 1 && polls >= 7) await writeFile(path.join(root, 'src/Handler.php'), '<?php // next Backend change');
        result = { operation };
      } else { res.writeHead(404).end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
      if (persistent && !recover ? updates === 2 : operations.size === 2) shutdown.abort();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
      shutdown.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      if (previousConfig === undefined) delete process.env.NEXIA_CONFIG_HOME; else process.env.NEXIA_CONFIG_HOME = previousConfig;
      await rm(root, { recursive: true, force: true });
    });
    for (const dir of ['.nexia', 'src', 'resources/js', 'node_modules/vite/dist/node']) await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint, token: 'test-only' }));
    await writeFile(path.join(root, '.nexia/project.json'), JSON.stringify({ endpoint, project_id: project }));
    await writeFile(path.join(root, '.nexia/app.json'), JSON.stringify({ endpoint, id: app, key: 'trial' }));
    await writeFile(path.join(root, 'composer.json'), '{}');
    await writeFile(path.join(root, 'vite.config.mjs'), 'export default {}');
    await writeFile(path.join(root, 'src/Handler.php'), '<?php // initial');
    await writeFile(path.join(root, 'resources/js/Page.tsx'), 'initial');
    await writeFile(path.join(root, 'node_modules/vite/dist/node/index.js'), `
      exports.build = async () => {
        const fs = require('node:fs');
        const watcher = new (require('node:events').EventEmitter)();
        const timer = setTimeout(() => {
          watcher.emit('event', { code: 'START' });
          fs.mkdirSync('dist/frontend/.vite', { recursive: true });
          fs.writeFileSync('dist/frontend/index.js', 'export default {}');
          fs.writeFileSync('dist/frontend/.vite/manifest.json', '{}');
          watcher.emit('event', { code: 'END' });
        }, 10);
        watcher.close = async () => clearTimeout(timer);
        return watcher;
      };
    `);
    const deadline = setTimeout(() => shutdown.abort(), 5000);
    const readyStates = [];
    try { await nativeDev(root, { port: 0, interval: 5, signal: shutdown.signal, log: () => {}, reporter: {
      summary() {}, message() {}, failure() {}, resolve() { return false; },
      task(_name, state, detail) {
        readyStates.push({ state, detail });
        if (state === 'success') assert.ok([...operations.values()].some(operation => operation.status === 'completed'));
      },
    } }); }
    finally { clearTimeout(deadline); }
    assert.ok(readyStates.some(item => item.state === 'running' && item.detail.startsWith('Frontend build ready')));
    assert.ok(readyStates.every(item => item.state !== 'success' || item.detail === 'Development ready'));
    assert.equal(sources.length, persistent && !conflict ? 4 : 3);
    assert.equal(operations.size, persistent && !recover ? 1 : 2);
    if (persistent && !conflict) { assert.equal(updates, 2); assert.ok(updatePosts >= 3); }
    if (conflict) {
      assert.equal(updates, 0);
      const saved = JSON.parse(await readFile(path.join(root, '.nexia/runtime.json'), 'utf8'));
      if (recover) {
        assert.equal(updatePosts, 1);
        assert.equal(saved.source_update, undefined);
        assert.equal([...operations.values()][1].source_revision_id, saved.revision_id);
      } else {
        assert.equal(updatePosts, 2);
        assert.ok(saved.source_update, 'unconfirmed or foreign shutdown must retain pending request');
      }
    }
    const frontend = sources[1].files.find(file => file.path === 'resources/js/Page.tsx');
    assert.equal(Buffer.from(frontend.content, 'base64').toString(), 'frontend-only change');
  });
}

for (const expired of [true, false]) {
  test(`native dev ${expired ? 'reuploads an expired unbound source' : 'preserves a pending request on an unrelated 410'}`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nexia-source-retention-'));
    const previousConfig = process.env.NEXIA_CONFIG_HOME;
    process.env.NEXIA_CONFIG_HOME = directory;
    const project = randomUUID(), app = randomUUID(), sandbox = randomUUID();
    const oldRevision = randomUUID(), oldRequest = randomUUID(), restoredRevision = randomUUID();
    const submissions = [];
    const tasks = [];
    let uploads = 0, connectionChecks = 0;
    const shutdown = new AbortController();
    const server = createServer(async (req, res) => {
      if (req.url.endsWith('/database-operations')) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ operation: null })); return; }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const input = raw ? JSON.parse(raw) : null;
      let payload;
      if (req.url.endsWith('/connection')) {
        if (++connectionChecks === 1 && expired) { res.writeHead(503).end('{}'); return; }
        payload = { status: 'connected', project: { id: project }, capabilities: { explicit_development_migrations: true }, sandbox: { id: sandbox, status: 'active',
          workspace_url: 'http://workspace.localhost:8081', launch_url: `${endpoint}/launch` } };
      } else if (req.url.endsWith('/execution')) {
        payload = { selection: { app_id: app, project_id: project, sandbox_id: sandbox, mode: 'development', revision: 1, stop_pending: false } };
      } else if (req.url.endsWith('/v2/sources')) {
        uploads++;
        assert.equal(submissions.length, uploads === 1 ? 0 : 1, 'sync source without replacing the original request');
        payload = { revision: { id: restoredRevision, digest: input.source.digest, file_count: input.source.files.length } };
      } else if (req.url.endsWith('/v2/runtime-operations') && req.method === 'POST') {
        submissions.push(input);
        if (input.request_id === oldRequest) {
          res.writeHead(410, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: expired ? 'source_expired' : 'endpoint_retired', message: 'Gone' }));
          return;
        }
        assert.equal(input.source_revision_id, restoredRevision);
        payload = { operation: { id: randomUUID(), request_id: input.request_id, source_revision_id: restoredRevision,
          developer_project_id: project, developer_sandbox_id: sandbox, status: 'queued' } };
      } else {
        res.writeHead(404); res.end('{}'); return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      if (previousConfig === undefined) delete process.env.NEXIA_CONFIG_HOME; else process.env.NEXIA_CONFIG_HOME = previousConfig;
      await rm(directory, { recursive: true, force: true });
    });
    await mkdir(path.join(directory, '.nexia'));
    await writeFile(path.join(directory, 'connection.json'), JSON.stringify({ endpoint, token: 'test-only' }));
    await writeFile(path.join(directory, '.nexia/project.json'), JSON.stringify({ endpoint, project_id: project }));
    await writeFile(path.join(directory, '.nexia/app.json'), JSON.stringify({ endpoint, id: app, key: 'trial' }));
    await writeFile(path.join(directory, 'composer.json'), '{}');
    await writeFile(path.join(directory, '.nexia/runtime.json'), JSON.stringify({
      endpoint, project_id: project, app_id: app, sandbox_id: sandbox,
      request_id: oldRequest, revision_id: oldRevision, digest: 'a'.repeat(64), selection_revision: 1,
    }));
    const deadline = setTimeout(() => shutdown.abort(), 3000);
    try {
      const run = nativeDev(directory, { port: 0, interval: 1, signal: shutdown.signal, reporter: {
        task(name, state, detail) { tasks.push({ name, state, detail }); if (detail.includes('Platform queue has not started') || detail.includes('Watching for changes')) shutdown.abort(); },
        message() {},
        summary() {},
        failure(name, error) { tasks.push({ name, state: 'error', detail: error.message }); shutdown.abort(); },
      } });
      await run;
      if (!expired) assert.ok(tasks.some(task => task.detail.includes('HTTP 410')));
    } finally { clearTimeout(deadline); }
    const saved = JSON.parse(await readFile(path.join(directory, '.nexia/runtime.json'), 'utf8'));
    assert.equal(uploads, expired ? 2 : 1);
    assert.equal(submissions.length, expired ? 2 : 1);
    if (expired) {
      assert.ok(tasks.some(task => task.state === 'running' && task.detail === 'Platform queue has not started runtime preparation…'));
      assert.notEqual(saved.request_id, oldRequest);
      assert.equal(saved.revision_id, restoredRevision);
      assert.ok(saved.operation_id);
    } else {
      assert.equal(saved.request_id, oldRequest);
      assert.equal(saved.revision_id, oldRevision);
    }
  });
}

test('native dev rejects an App rebind during a connection request before uploading source', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-native-rebind-'));
  const project = randomUUID(), app = randomUUID();
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const calls = [];
  const server = createServer(async (req, res) => {
    if (req.url.endsWith('/database-operations')) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ operation: null })); return; }
    calls.push(req.url);
    // Another terminal changes the binding while the first public request is in flight.
    await writeFile(path.join(root, '.nexia/app.json'), JSON.stringify({ endpoint, id: randomUUID() }));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'connected', project: { id: project }, capabilities: { explicit_development_migrations: true }, sandbox: { status: 'active', workspace_url: 'http://workspace.localhost:8081', launch_url: `${endpoint}/launch` } }));
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
  await writeFile(path.join(root, 'nexia.json'), JSON.stringify({ schema_version: '2', runtime: 'laravel' }));
  await assert.rejects(promisify(execFile)(process.execPath, [cli, 'dev'], {
    cwd: root, env: { ...process.env, NEXIA_CONFIG_HOME: root }, timeout: 5000,
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
    if (req.url.endsWith('/database-operations')) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ operation: null })); return; }
    assert.equal(req.headers.authorization, 'Bearer disposable-token');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = raw ? JSON.parse(raw) : null;
    let payload;
    if (req.url.endsWith('/connection')) payload = { status: 'connected', project: { id: project }, capabilities: { explicit_development_migrations: true }, sandbox: { status: 'active', workspace_url: 'http://workspace.localhost:8081', launch_url: `${endpoint}/launch` } };
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
  const interrupted = new AbortController();
  await nativeDev(root, { port: 0, interval: 1, signal: interrupted.signal, log: message => {
    if (message.includes('temporarily unavailable')) interrupted.abort();
  } });
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
  const waiting = new AbortController();
  await nativeDev(root, { port: 0, interval: 1, signal: waiting.signal, log: message => {
    lifecycleMessages.push(message);
    if (message.startsWith('App execution stopping:')) waiting.abort();
  } });
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
  const offMessage = lifecycleMessages.find(message => message.includes('/development#project-apps'));
  assert.ok(offMessage, 'off state links directly to the development App list');
  assert.match(offMessage, /nexia dev/);
  assert.match(offMessage, /(?:Local App address \(copy\)|로컬 앱 주소 \(복사용\)): http:\/\/127\.0\.0\.1:[1-9]\d*/);
  assert.ok(lifecycleMessages.some(message => message.startsWith('┌─ Nexia development') && /Local address\s+http:\/\/127\.0\.0\.1:[1-9]\d*/.test(message)));
  assert.match(offMessage, /workspace|워크스페이스/);
  assert.equal(submissions.at(-1), submissions.at(-2), 'off race retains the pending idempotency key');
  [...operations.values()].at(-1).status = 'needs_review';
  // Return a terminal status on submission resume; do not silently create a fresh request.
  const last = JSON.parse(await readFile(path.join(root, '.nexia/runtime.json'), 'utf8'));
  delete last.operation_id;
  await writeFile(path.join(root, '.nexia/runtime.json'), JSON.stringify(last));
  const failedWatch = new AbortController();
  const failedDeadline = setTimeout(() => failedWatch.abort(), 5000);
  t.after(() => clearTimeout(failedDeadline));
  let failureReported = false;
  await nativeDev(root, { port: 0, interval: 1, signal: failedWatch.signal, log: message => {
    if (message.includes('Watching for changes')) { failureReported = true; failedWatch.abort(); }
  } });
  assert.equal(failureReported, true);
  assert.equal(operations.size, 3);
});

for (const oldState of ['completed', 'failed', 'reviewed', 'unreviewed']) test(`new writer recovers an ambiguous ${oldState} terminal request before preparing its own generation`, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-writer-recovery-'));
  process.env.NEXIA_CONFIG_HOME = root;
  const oldStatus = ['reviewed', 'unreviewed'].includes(oldState) ? 'failed' : oldState;
  const project = randomUUID(), app = randomUUID(), sandbox = randomUUID(), revision = randomUUID(), currentRevision = randomUUID(), requestId = randomUUID();
  const abort = new AbortController(), submissions = [];
  let session, unavailableLease = oldState === 'completed';
  const server = createServer(async (req, res) => {
    if (req.url.endsWith('/database-operations')) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ operation: null })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = raw ? JSON.parse(raw) : null;
    let payload;
    if (req.url.endsWith('/connection')) payload = { status: 'connected', project: { id: project }, capabilities: { explicit_development_migrations: true, runtime_writers: true }, sandbox: { id: sandbox, status: 'active', workspace_url: 'http://workspace.localhost:8081', launch_url: `${endpoint}/launch` } };
    else if (req.url.endsWith('/v2/sources')) {
      assert.equal(submissions.length, 0, 'source synchronization stays independent of pending execution');
      payload = { revision: { id: currentRevision, digest: input.source.digest, file_count: input.source.files.length } };
    }
    else if (req.url.endsWith('/writer')) {
      session ??= input.session_id;
      assert.equal(input.session_id, session);
      if (unavailableLease) {
        unavailableLease = false;
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Deployment maintenance' })); return;
      }
      payload = { writer: { app_id: app, sandbox_id: sandbox, generation: 2 } };
    } else if (req.url.endsWith('/execution')) payload = { selection: { app_id: app, project_id: project, sandbox_id: sandbox, mode: 'development', revision: 1, stop_pending: false } };
    else {
      assert.equal(req.method, 'POST');
      assert.equal(input.writer_session, session);
      assert.equal(input.source_revision_id, input.request_id === requestId ? revision : currentRevision);
      submissions.push(input.request_id);
      payload = { operation: { id: randomUUID(), request_id: input.request_id, source_revision_id: input.source_revision_id, developer_project_id: project, developer_sandbox_id: sandbox,
        writer_generation: input.request_id === requestId ? 1 : 2, status: input.request_id === requestId ? oldStatus : 'queued',
        ...(input.request_id === requestId && ['reviewed', 'unreviewed'].includes(oldState) ? { started_at: '2026-09-29T00:00:00Z', stopped_at: '2026-09-29T00:00:01Z', retry_allowed: oldState === 'reviewed' } : {}) } };
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); delete process.env.NEXIA_CONFIG_HOME; await rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root, '.nexia'));
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint, token: 'test-only' }));
  await writeFile(path.join(root, '.nexia/project.json'), JSON.stringify({ endpoint, project_id: project }));
  await writeFile(path.join(root, '.nexia/app.json'), JSON.stringify({ endpoint, id: app, key: 'trial' }));
  await writeFile(path.join(root, '.nexia/runtime.json'), JSON.stringify({ endpoint, project_id: project, app_id: app, sandbox_id: sandbox, request_id: requestId, revision_id: revision, digest: 'a'.repeat(64), writer_generation: 1, selection_revision: 1 }));
  await writeFile(path.join(root, 'composer.json'), '{}');
  if (oldState === 'unreviewed') {
    const deadline = setTimeout(() => abort.abort(), 5000);
    t.after(() => clearTimeout(deadline));
    let failureReported = false;
    await nativeDev(root, { port: 0, interval: 1, signal: abort.signal, log: message => {
      if (message.includes('Watching for changes')) { failureReported = true; abort.abort(); }
    } });
    assert.equal(failureReported, true);
    assert.deepEqual(submissions, [requestId]);
    return;
  }
  const timeout = setTimeout(() => abort.abort(), 3000);
  try { await nativeDev(root, { port: 0, interval: 1, signal: abort.signal, log: message => { if (message.includes('preparation queued')) abort.abort(); } }); }
  finally { clearTimeout(timeout); }
  assert.equal(submissions.length, 2);
  assert.equal(submissions[0], requestId);
  assert.notEqual(submissions[1], requestId);
  assert.equal(JSON.parse(await readFile(path.join(root, '.nexia/runtime.json'), 'utf8')).writer_generation, 2);
});

for (const [outcome, started] of [['completed', true], ['failed', true], ['failed', false], ['needs_review', true]]) {
  test(`native dev waits for acknowledged shutdown and preserves ${outcome} recovery rules (started: ${started})`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexia-native-shutdown-'));
    const previousConfig = process.env.NEXIA_CONFIG_HOME;
    process.env.NEXIA_CONFIG_HOME = root;
    const project = randomUUID(), app = randomUUID(), sandbox = randomUUID();
    const operations = [];
    let pending = false, polls = 0, completed = 0, readPreview;
    const server = createServer(async (req, res) => {
      if (req.url.endsWith('/database-operations')) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ operation: null })); return; }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const input = raw ? JSON.parse(raw) : null;
      let payload;
      if (req.url.endsWith('/connection')) payload = { status: 'connected', project: { id: project }, capabilities: { explicit_development_migrations: true },
        sandbox: { id: sandbox, status: 'active', workspace_url: 'http://workspace.localhost:8081', launch_url: `${endpoint}/launch` } };
      else if (req.url.endsWith('/execution')) payload = { selection: { app_id: app, project_id: project,
        sandbox_id: sandbox, mode: 'development', revision: 1, stop_pending: pending } };
      else if (req.url.endsWith('/v2/sources')) {
        payload = { revision: { id: randomUUID(), digest: input.source.digest, file_count: input.source.files.length } };
      } else if (req.method === 'POST') {
        assert.equal(pending, false, 'no new operation before shutdown acknowledgment');
        const operation = { id: randomUUID(), request_id: input.request_id, source_revision_id: input.source_revision_id,
          developer_project_id: project, developer_sandbox_id: sandbox, status: 'queued' };
        operations.push(operation); payload = { operation };
      } else {
        const operation = operations.find(item => req.url.endsWith(item.id));
        assert.ok(operation);
        polls++;
        operation.status = outcome;
        operation.started_at = started ? '2026-10-02T02:52:00Z' : null;
        if (outcome === 'failed' && started) operation.failure = {
          code: 'SDK_VERSION_MISMATCH', stage: 'dependencies', required_sdk: '^0.8.6 || ^0.9.0', installed_sdk: 'v0.8.4',
        };
        if (operations.length === 1 && (polls >= 2 || outcome !== 'completed')) {
          operation.stop_requested_at = '2026-10-02T02:52:06Z'; pending = true;
          if (polls === 3) assert.deepEqual(readPreview(), { mode: 'preparing', app_id: app, app_key: 'trial' }, 'stopping publishes status without execution authority');
          if (polls >= 4) { operation.stopped_at = '2026-10-02T02:52:16Z'; pending = false; }
        }
        payload = { operation };
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      if (previousConfig === undefined) delete process.env.NEXIA_CONFIG_HOME; else process.env.NEXIA_CONFIG_HOME = previousConfig;
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(path.join(root, '.nexia'));
    await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint, token: 'disposable-token' }));
    await writeFile(path.join(root, '.nexia/project.json'), JSON.stringify({ endpoint, project_id: project }));
    await writeFile(path.join(root, '.nexia/app.json'), JSON.stringify({ endpoint, id: app, key: 'trial' }));
    await writeFile(path.join(root, 'composer.json'), '{}');
    const shutdown = new AbortController();
    const deadline = setTimeout(() => shutdown.abort(), 5000);
    try {
      const run = nativeDev(root, { interval: 1, signal: shutdown.signal,
        previewHost: { attach(_directory, state) { readPreview = state; return { url: 'http://127.0.0.1:4310', close: async () => {} }; } },
        log(message) { if (message.includes('Watching for changes') && outcome !== 'completed') shutdown.abort(); if (message.includes('preparation completed') && ++completed === 2) shutdown.abort(); } });
      if (outcome === 'completed') {
        await run;
        assert.equal(completed, 2);
        assert.equal(operations.length, 2);
        assert.ok(operations[0].stopped_at);
        assert.notEqual(operations[0].request_id, operations[1].request_id);
      } else {
        await run;
        assert.equal(operations.length, 1, 'uncertain failures never retry automatically');
      }
    } finally { clearTimeout(deadline); }
  });
}

test('stopped execution recovers source and ambiguous preparation timeouts without restarting or duplicating work', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-native-timeout-'));
  const previousConfig = process.env.NEXIA_CONFIG_HOME;
  process.env.NEXIA_CONFIG_HOME = root;
  t.after(async () => {
    if (previousConfig === undefined) delete process.env.NEXIA_CONFIG_HOME; else process.env.NEXIA_CONFIG_HOME = previousConfig;
    await rm(root, { recursive: true, force: true });
  });
  const endpoint = 'http://platform.localhost:8080';
  const project = randomUUID(), app = randomUUID(), sandbox = randomUUID();
  const oldRevision = randomUUID(), revision = randomUUID(), requestId = randomUUID(), oldOperation = randomUUID();
  await mkdir(path.join(root, '.nexia'));
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint, token: 'test-secret' }));
  await writeFile(path.join(root, '.nexia/project.json'), JSON.stringify({ endpoint, project_id: project }));
  await writeFile(path.join(root, '.nexia/app.json'), JSON.stringify({ endpoint, id: app, key: 'trial' }));
  await writeFile(path.join(root, '.nexia/runtime.json'), JSON.stringify({ endpoint, project_id: project, app_id: app, sandbox_id: sandbox,
    request_id: requestId, revision_id: oldRevision, operation_id: oldOperation, digest: 'a'.repeat(64), writer_generation: 1 }));
  await writeFile(path.join(root, 'composer.json'), '{}');
  let sourceCalls = 0, operation, writerSession;
  const submissions = [], messages = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const route = new URL(url).pathname;
    const input = options.body ? JSON.parse(options.body) : null;
    let payload;
    if (route.endsWith('/local-database')) payload = { binding: null, tunnel_url: null };
    else if (route.endsWith('/connection')) payload = { status: 'connected', project: { id: project }, capabilities: { explicit_development_migrations: true, runtime_writers: true },
      sandbox: { id: sandbox, status: 'active', workspace_url: 'http://workspace.localhost:8081', launch_url: `${endpoint}/launch` } };
    else if (route.endsWith('/database-operations')) payload = { operation: null };
    else if (route.endsWith('/writer')) {
      writerSession ??= input.session_id;
      assert.equal(input.session_id, writerSession);
      payload = { writer: { app_id: app, sandbox_id: sandbox, generation: 2 } };
    } else if (route.endsWith('/execution')) payload = { selection: { app_id: app, project_id: project, sandbox_id: sandbox, mode: 'development', revision: 1, stop_pending: false } };
    else if (route.endsWith(oldOperation)) payload = { operation: { id: oldOperation, request_id: requestId, source_revision_id: oldRevision,
      developer_project_id: project, developer_sandbox_id: sandbox, writer_generation: 1, status: 'completed', stopped_at: '2026-10-12T01:02:45Z' } };
    else if (route.endsWith('/v2/sources')) {
      if (++sourceCalls === 1) throw new DOMException('Timed out', 'TimeoutError');
      payload = { revision: { id: revision, digest: input.source.digest, file_count: input.source.files.length } };
    } else {
      assert.equal(route, '/developer-api/v2/runtime-operations');
      assert.equal(options.method, 'POST');
      submissions.push(input);
      operation ??= { id: randomUUID(), request_id: input.request_id, source_revision_id: input.source_revision_id,
        developer_project_id: project, developer_sandbox_id: sandbox, writer_generation: 2, status: 'queued' };
      if (submissions.length === 1) {
        await writeFile(path.join(root, 'composer.json'), '{"description":"changed during uncertain preparation"}');
        throw new DOMException('Response lost after acceptance', 'TimeoutError');
      }
      payload = { operation };
    }
    return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
  });
  const shutdown = new AbortController();
  const deadline = setTimeout(() => shutdown.abort(), 5000);
  try {
    await nativeDev(root, { port: 0, interval: 1, signal: shutdown.signal, log: message => {
      messages.push(message);
      if (message.includes('preparation queued')) shutdown.abort();
    } });
  } finally { clearTimeout(deadline); }
  assert.equal(sourceCalls, 3, 'edits synchronize while the ambiguous preparation retains its request');
  assert.equal(submissions.length, 2);
  assert.deepEqual(submissions[0], submissions[1], 'ambiguous acceptance reuses the entire preparation request');
  assert.equal(JSON.parse(await readFile(path.join(root, '.nexia/runtime.json'), 'utf8')).operation_id, operation.id);
  assert.ok(messages.some(message => message.includes('POST /developer-api/v2/sources: timeout')));
  assert.ok(messages.some(message => message.includes('POST /developer-api/v2/runtime-operations: timeout')));
  assert.doesNotMatch(messages.join('\n'), /test-secret/);
});

for (const outcome of ['pending', 'denied', 'unavailable']) {
  test(`startup auto-resume: ${outcome}, without repeated execution writes`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexia-auto-resume-'));
    const previous = process.env.NEXIA_CONFIG_HOME;
    process.env.NEXIA_CONFIG_HOME = root;
    const project = randomUUID(), app = randomUUID(), sandbox = randomUUID();
    let writes = 0, readsAfterResume = 0;
    let selection = { app_id: app, project_id: project, sandbox_id: sandbox, mode: 'off', revision: 1, stop_pending: false };
    const shutdown = new AbortController(), messages = [];
    const server = createServer(async (req, res) => {
      if (req.url.endsWith('/database-operations')) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ operation: null })); return; }
      res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('/connection')) {
        res.end(JSON.stringify({ status: 'connected', project: { id: project }, capabilities: { explicit_development_migrations: true }, sandbox: { id: sandbox, status: 'active', workspace_url: 'http://workspace.localhost:8081', launch_url: `${endpoint}/launch` } }));
      } else if (req.url.endsWith('/execution')) {
        if (req.method === 'PUT') {
          writes++;
          let body = ''; for await (const chunk of req) body += chunk;
          assert.deepEqual(JSON.parse(body), { mode: 'development', revision: 1 });
          if (outcome !== 'pending') {
            res.writeHead(outcome === 'denied' ? 403 : 503);
            res.end(JSON.stringify({ message: 'fixture resume failure' }));
            return;
          }
          selection = { ...selection, revision: 2, stop_pending: true, resume_pending: true };
        } else if (writes) {
          readsAfterResume++;
          // A later Console decision cancels the pending resume. The watcher must respect it.
          selection = { ...selection, revision: 3, stop_pending: false, resume_pending: false };
          if (readsAfterResume === 3) shutdown.abort();
        }
        res.end(JSON.stringify({ selection }));
      } else if (req.url.endsWith('/v2/sources')) {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const input = JSON.parse(raw);
        res.end(JSON.stringify({ revision: { id: randomUUID(), digest: input.source.digest, file_count: input.source.files.length } }));
      } else { res.writeHead(404).end('{}'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      if (previous === undefined) delete process.env.NEXIA_CONFIG_HOME; else process.env.NEXIA_CONFIG_HOME = previous;
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(path.join(root, '.nexia'));
    await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint, token: 'fixture-only' }));
    await writeFile(path.join(root, '.nexia/project.json'), JSON.stringify({ endpoint, project_id: project }));
    await writeFile(path.join(root, '.nexia/app.json'), JSON.stringify({ endpoint, id: app, key: 'fixture' }));
    await writeFile(path.join(root, 'composer.json'), '{}');
    const timeout = setTimeout(() => shutdown.abort(), 3000);
    try {
      const run = nativeDev(root, { port: 0, interval: 1, signal: shutdown.signal, log: value => messages.push(value) });
      if (outcome === 'pending') {
        await run;
        assert.equal(readsAfterResume, 3);
        assert.ok(messages.some(value => /switch pending|전환 대기/.test(value)));
      } else {
        await run;
        assert.ok(messages.some(value => value.includes('fixture resume failure') && value.includes('Watching for changes')));
      }
    } finally { clearTimeout(timeout); }
    assert.equal(writes, 1);
    assert.doesNotMatch(messages.join('\n'), /fixture-only/);
  });
}

test('first dev waits for explicit migration and file saves never submit database commands', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-manual-migration-'));
  const previousConfig = process.env.NEXIA_CONFIG_HOME;
  process.env.NEXIA_CONFIG_HOME = root;
  const project = randomUUID(), app = randomUUID(), sandbox = randomUUID(), first = randomUUID();
  const shutdown = new AbortController();
  const operations = new Map();
  let database = null, submissions = 0, uploads = 0, waitingPolls = 0, edited = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = raw ? JSON.parse(raw) : null;
    let payload;
    if (req.url.endsWith('/connection')) payload = { status: 'connected', project: { id: project },
      capabilities: { explicit_development_migrations: true }, sandbox: { id: sandbox, status: 'active',
        workspace_url: 'http://workspace.localhost:8081', launch_url: `${endpoint}/launch` } };
    else if (req.url.endsWith('/execution')) payload = { selection: { app_id: app, project_id: project,
      sandbox_id: sandbox, mode: 'development', revision: waitingPolls >= 2 ? 2 : 1, stop_pending: false } };
    else if (req.url.endsWith('/database-operations')) {
      assert.equal(req.method, 'GET', 'watcher must not authorize database writes');
      if (waitingPolls && ++waitingPolls === 2) {
        database = { id: randomUUID(), database_command: 'status', developer_project_id: project,
          developer_sandbox_id: sandbox, status: 'completed', created_at: '2026-10-14T05:00:00Z' };
      }
      if (waitingPolls === 4) database = { id: randomUUID(), database_command: 'migrate',
        developer_project_id: project, developer_sandbox_id: sandbox, status: 'completed', created_at: '2026-10-14T05:00:00Z' };
      payload = { operation: database };
    } else if (req.url.endsWith('/v2/sources')) {
      uploads++;
      payload = { revision: { id: randomUUID(), digest: input.source.digest, file_count: input.source.files.length } };
    } else if (req.url.endsWith('/v2/runtime-operations')) {
      if (submissions > 0) assert.equal(database?.database_command, 'migrate', 'status reads and selection changes must not retry migration-required preparation');
      submissions++;
      assert.equal(input.database_command, undefined);
      const operation = { id: submissions === 1 ? first : randomUUID(), request_id: input.request_id,
        source_revision_id: input.source_revision_id, developer_project_id: project, developer_sandbox_id: sandbox,
        created_at: '2026-10-14T05:00:00Z', status: submissions === 1 ? 'failed' : 'completed',
        ...(submissions === 1 ? { stopped_at: '2026-10-14T05:00:01Z', retry_allowed: true,
          failure: { code: 'DATABASE_MIGRATION_REQUIRED', stage: 'migration_preflight' } } : {}) };
      operations.set(operation.id, operation); payload = { operation };
    } else {
      const operation = [...operations.values()].find(op => req.url.endsWith(op.id));
      assert.ok(operation);
      if (operation.id === first && !waitingPolls) waitingPolls = 1;
      if (operation.id !== first && !edited) {
        edited = true;
        await writeFile(path.join(root, 'database/migrations/draft.php'), '<?php // unfinished migration edit');
      }
      payload = { operation };
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (previousConfig === undefined) delete process.env.NEXIA_CONFIG_HOME; else process.env.NEXIA_CONFIG_HOME = previousConfig;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, '.nexia'));
  await mkdir(path.join(root, 'database/migrations'), { recursive: true });
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint, token: 'test-only' }));
  await writeFile(path.join(root, '.nexia/project.json'), JSON.stringify({ endpoint, project_id: project }));
  await writeFile(path.join(root, '.nexia/app.json'), JSON.stringify({ endpoint, id: app, key: 'trial' }));
  await writeFile(path.join(root, 'composer.json'), '{}');
  const messages = [];
  const deadline = setTimeout(() => shutdown.abort(), 5000);
  try {
    await nativeDev(root, { port: 0, interval: 1, signal: shutdown.signal, log: message => {
      messages.push(message);
      if (submissions === 3 && message.includes('preparation completed')) shutdown.abort();
    } });
  } finally { clearTimeout(deadline); }
  assert.equal(submissions, 3, 'initial wait, explicit migration recovery, then source-only edit');
  assert.equal(uploads, 2, 'completed migration reuses the already uploaded source');
  assert.ok(messages.some(message => message.includes('nexia db migrate')));
});

for (const interruption of [503, 429, 409, 'source-busy']) test(`completed preview survives ${interruption} without another runtime submission`, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-preview-continuity-'));
  const previousConfig = process.env.NEXIA_CONFIG_HOME;
  process.env.NEXIA_CONFIG_HOME = root;
  const shutdown = new AbortController();
  const project = randomUUID(), app = randomUUID(), sandbox = randomUUID();
  let operation, readPreview, interrupted = false, recovered = false, submissions = 0, preparationReads = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = raw ? JSON.parse(raw) : null;
    let result;
    if (req.url.endsWith('/connection')) result = { status: 'connected', project: { id: project },
      capabilities: { explicit_development_migrations: true }, sandbox: { id: sandbox, status: 'active',
        workspace_url: 'http://workspace.localhost:8081', launch_url: `${endpoint}/launch` } };
    else if (req.url.endsWith('/database-operations')) {
      if (operation && readPreview()?.operation_id === operation.id) {
        if (!interrupted) {
          interrupted = true;
          if (interruption === 'source-busy') await writeFile(path.join(root, '.git/index.lock'), '');
          else { res.writeHead(interruption, { 'Content-Type': 'application/json', 'Retry-After': '1' }).end(JSON.stringify(interruption === 409 ? { status: 'preparation_pending', blocking_operation: { id: operation.id, status: 'running', diagnostic_path: `/projects/${project}/development?operation=${operation.id}#operation-${operation.id}` } } : {})); return; }
        } else {
          assert.equal(readPreview().operation_id, operation.id);
          recovered = true;
          if (interruption === 'source-busy') await rm(path.join(root, '.git/index.lock'));
          if (interruption === 'source-busy') shutdown.abort();
        }
      }
      result = { operation: null };
    } else if (req.url.endsWith('/execution')) result = { selection: { app_id: app, project_id: project,
      sandbox_id: sandbox, mode: 'development', revision: 1, stop_pending: false } };
    else if (req.url.endsWith('/v2/sources')) result = { revision: { id: randomUUID(), digest: input.source.digest, file_count: input.source.files.length } };
    else if (req.method === 'POST' && req.url.endsWith('/v2/runtime-operations')) {
      submissions++;
      operation = { id: randomUUID(), request_id: input.request_id, source_revision_id: input.source_revision_id,
        developer_project_id: project, developer_sandbox_id: sandbox, status: 'queued' };
      result = { operation };
    } else if (req.url.includes('/v2/runtime-operations/')) {
      operation.status = ++preparationReads === 1 ? 'running' : 'completed';
      result = { operation };
    }
    else { res.writeHead(404).end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    shutdown.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (previousConfig === undefined) delete process.env.NEXIA_CONFIG_HOME; else process.env.NEXIA_CONFIG_HOME = previousConfig;
    await rm(root, { recursive: true, force: true });
  });
  for (const dir of ['.nexia', '.git']) await mkdir(path.join(root, dir));
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint, token: 'test-only' }));
  await writeFile(path.join(root, '.nexia/project.json'), JSON.stringify({ endpoint, project_id: project }));
  await writeFile(path.join(root, '.nexia/app.json'), JSON.stringify({ endpoint, id: app, key: 'trial' }));
  await writeFile(path.join(root, 'composer.json'), '{}');
  const statuses = [], notices = [];
  const deadline = setTimeout(() => shutdown.abort(), 10000);
  try {
    await nativeDev(root, { ...(interruption === 'source-busy' ? {} : { reporter: {
      summary() {}, message(_name, value) { notices.push(value); }, resolve() { return false; },
      task(_name, state, detail) {
        statuses.push({ state, detail });
        if (state === 'success' && recovered) shutdown.abort();
      },
    } }), interval: 5, signal: shutdown.signal, log: message => {
      if (interruption === 'source-busy' && message.includes('Waiting for Git')) {
        assert.equal(readPreview().operation_id, operation.id);
        recovered = true;
        shutdown.abort();
      }
    },
      previewHost: { attach(_directory, state) { readPreview = state; return { url: 'http://127.0.0.1:4310', close: async () => {} }; } },
    });
  } finally { clearTimeout(deadline); }
  assert.equal(interrupted, true);
  assert.equal(recovered, true);
  assert.equal(submissions, 1);
  if (interruption !== 'source-busy') {
    assert.equal(statuses.filter(item => item.state === 'success').length, 2);
    assert.ok(!statuses.some(item => item.state === 'pending'), 'runtime queueing must not return an active preparation to WAITING');
    const ready = statuses.findIndex(item => item.state === 'success');
    assert.ok(statuses.slice(ready).every(item => ['success', 'stopped'].includes(item.state)), 'poll interruptions must not regress readiness');
    assert.ok(notices.some(value => /retrying|Waiting/.test(value)));
    if (interruption === 429) assert.ok(notices.some(value => value.includes(`/developer-api/v2/apps/${app}/database-operations`)));
  }
});
