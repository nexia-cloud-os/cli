import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverOperation, formatRecovery } from '../src/recovery.js';
import { parseCommand } from '../src/commands.js';
const id = '11111111-1111-4111-8111-111111111111', project = '22222222-2222-4222-8222-222222222222';
const config = { endpoint: 'http://localhost:4310', token: 'private', project: { id: project } };
const operation = { id, developer_project_id: project, status: 'needs_review' };
test('recover inspects only the existing operation and never resubmits execution', async t => {
  const original = globalThis.fetch, calls = [];
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    calls.push([url, init.method, init.body]);
    return new Response(JSON.stringify({ operation, recovery: { status: 'checking', reason: 'inspection_queued', next_action: 'wait' } }));
  };
  const result = await recoverOperation(config, id);
  assert.deepEqual(calls.map(call => call.slice(1)), [['GET', undefined], ['POST', '{}']]);
  assert.ok(calls[1][0].endsWith(`/runtime-operations/${id}/recover`));
  assert.match(formatRecovery(result, config.endpoint), /Inspection: checking/);
  calls.length = 0;
  await recoverOperation(config, id, { statusOnly: true });
  assert.equal(calls.length, 1);
  assert.equal(parseCommand(['recover', id, '--status']).options.status, true);
});
test('recover rejects project mismatch and replacement without explicit paired flags before mutation', async t => {
  const original = globalThis.fetch, calls = [];
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => { calls.push(init.method); return new Response(JSON.stringify({ operation: { ...operation, developer_project_id: id } })); };
  await assert.rejects(recoverOperation(config, id), /connected project/);
  assert.deepEqual(calls, ['GET']);
  await assert.rejects(recoverOperation(config, id, { preserveAndReplace: true }), /both/);
  assert.deepEqual(calls, ['GET']);
});
test('replacement explicitly preserves data and recovery output cannot grant unsafe replay or inject terminal text', async t => {
  const original = globalThis.fetch, calls = [];
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => { calls.push(init.body); return new Response(JSON.stringify({ operation })); };
  await recoverOperation(config, id, { preserveAndReplace: true, confirmPreserve: true });
  assert.deepEqual(JSON.parse(calls[1]), { action: 'preserve_and_replace', confirm_preserve: true });
  const text = formatRecovery({ operation, recovery: { status: 'blocked', reason: '\x1b[2Jsecret', next_action: 'preserve_and_replace' } }, config.endpoint);
  assert.match(text, /empty sandbox/);
  assert.doesNotMatch(text, /secret|Retry is allowed/);
  assert.doesNotMatch(formatRecovery({ operation, recovery: { status: 'retry_allowed' } }, config.endpoint), /Retry is allowed/);
});

test('CLI recover routes the explicit command through the authenticated project without exposing credentials', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const root = await mkdtemp(join(tmpdir(), 'nexia-recover-cli-')), calls = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push([req.method, req.url, body]);
    assert.equal(req.headers.authorization, 'Bearer fixture-secret');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/connection') ? { status: 'connected', project: { id: project } }
      : { operation, recovery: { status: 'checking', reason: 'inspection_queued', next_action: 'wait' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await writeFile(join(root, 'connection.json'), JSON.stringify({ endpoint, token: 'fixture-secret' }));
  const output = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'recover', id, '--json'],
    { cwd: root, env: { ...process.env, NEXIA_CONFIG_HOME: root }, timeout: 5000 });
  assert.equal(JSON.parse(output.stdout).recovery.status, 'checking');
  assert.doesNotMatch(output.stdout + output.stderr, /fixture-secret/);
  assert.deepEqual(calls.filter(call => call[0] === 'POST'), [['POST', `/developer-api/v2/runtime-operations/${id}/recover`, '{}']]);
});

test('preserved App export verifies streamed bytes and refuses overwrite or corrupt downloads', async t => {
  const { mkdtemp, readFile, writeFile, rm, stat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'nexia-preserved-export-'));
  const original = globalThis.fetch, bytes = Buffer.from('compressed-fixture');
  let corrupt = false, downloaded = 0;
  t.after(async () => { globalThis.fetch = original; await rm(root, {recursive:true, force:true}); });
  globalThis.fetch = async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer private');
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/preserved-data')) { downloaded++; return new Response(corrupt ? 'wrong' : bytes); }
    return new Response(JSON.stringify({ operation, preserved_export: { status:'ready', bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex') } }));
  };
  const file = join(root, 'app.jsonl.gz');
  const result = await recoverOperation(config, id, {exportData:file});
  assert.equal(result.download.file, file);
  assert.deepEqual(await readFile(file), bytes);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(recoverOperation(config, id, {exportData:file}), /EEXIST/);
  assert.equal(downloaded, 1);
  corrupt = true;
  const rejected = join(root, 'rejected.jsonl.gz');
  await assert.rejects(recoverOperation(config, id, {exportData:rejected}), /integrity mismatch/);
  await assert.rejects(stat(rejected), /ENOENT/);
  assert.equal(parseCommand(['recover',id,'--export-data',file]).options['export-data'], file);
});

test('export storage limit has an actionable stable reason without claiming a retry fixes it', () => {
  const output = formatRecovery({ operation, preserved_export: { status: 'failed', reason: 'export_size_limit' } }, config.endpoint);
  assert.match(output, /2 GiB uncompressed limit/);
  assert.match(output, /Repeating the same export will not resolve/);
  assert.match(output, /Original data remains preserved/);
});
