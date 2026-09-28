import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);

test('native deploy uses public source and build APIs, never static bundle fallback', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-deploy-'));
  const project = randomUUID(), app = randomUUID(), revision = randomUUID(), build = randomUUID();
  let buildStatus = 'queued';
  let submitted, digest, enabled = true, mismatch = false;
  const calls = [];
  const server = createServer(async (req, res) => {
    calls.push(req.url);
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = raw ? JSON.parse(raw) : null;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/developer-api/connection') res.end(JSON.stringify({ status: 'connected', project: { id: project, name: 'Trial project' }, sandbox: { status: 'active' }, capabilities: { native_artifact_builds: enabled } }));
    else if (req.url === '/developer-api/v2/sources') {
      assert.equal(input.app_id, app); digest = input.source.digest;
      res.end(JSON.stringify({ revision: { id: revision, digest, file_count: 1 } }));
    } else if (req.url === '/developer-api/v2/artifact-builds') {
      submitted = input;
      res.end(JSON.stringify({ build: { id: build, developer_project_id: project, version: input.version,
        source_revision_id: mismatch ? randomUUID() : revision, source_digest: digest, status: buildStatus } }));
    } else if (req.url === `/developer-api/v2/artifact-builds/${build}/cancel`) {
      assert.equal(req.method, 'POST');
      res.end(JSON.stringify({ build: { id: mismatch ? randomUUID() : build, version: '1.2.0', status: 'cancelled' } }));
    } else if (req.url === `/developer-api/v2/artifact-builds/${build}`) {
      res.end(JSON.stringify({ build: { id: build, version: '1.2.0', status: 'built' }, review: { status: 'checks_incomplete', ready_for_human_review: false, checks: [{ key: 'artifact_integrity', status: 'passed' }, { key: 'agent_analysis', status: 'pending' }] } }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await mkdir(path.join(root, '.nexia'));
  await writeFile(path.join(root, 'connection.json'), JSON.stringify({ endpoint, token: 'synthetic' }));
  await writeFile(path.join(root, '.nexia/project.json'), JSON.stringify({ endpoint, project_id: project }));
  await writeFile(path.join(root, '.nexia/app.json'), JSON.stringify({ endpoint, id: app }));
  await writeFile(path.join(root, 'composer.json'), '{}');
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = args => execute(process.execPath, [cli, 'deploy', root, ...args], { env: { ...process.env, NEXIA_CONFIG_HOME: root } });
  await assert.rejects(run([]), /Choose the immutable App version/);
  assert.equal(calls.length, 0);
  const result = await run(['--version', '1.2.0']);
  assert.match(result.stdout, /Status: queued/);
  assert.equal(submitted.source_revision_id, revision); assert.equal(submitted.version, '1.2.0');
  assert.match(submitted.request_id, /^[a-f0-9-]{36}$/);
  for (const status of ['approved', 'rejected', 'published']) {
    buildStatus = status;
    assert.match((await run(['--version', '1.2.0'])).stdout, new RegExp(`Status: ${status}`));
  }
  buildStatus = 'queued';
  const inspected = await execute(process.execPath, [cli, 'submissions', 'status', build], { env: { ...process.env, NEXIA_CONFIG_HOME: root } });
  assert.match(inspected.stdout, /Build: built/);
  assert.match(inspected.stdout, /Review: checks_incomplete/);
  assert.match(inspected.stdout, /agent_analysis: pending/);
  const cancel = () => execute(process.execPath, [cli, 'submissions', 'cancel', build], { env: { ...process.env, NEXIA_CONFIG_HOME: root } });
  assert.match((await cancel()).stdout, /stays reserved/);
  mismatch = true;
  await assert.rejects(cancel(), /different submission/);
  mismatch = false;
  enabled = false;
  await assert.rejects(run(['--version', '1.2.1']), /not accepting Native artifact builds/);
  enabled = true; mismatch = true;
  await assert.rejects(run(['--version', '1.2.1']), /acknowledgement did not match/);
  await rm(path.join(root, '.nexia/app.json'));
  await assert.rejects(run(['--version', '1.2.1']));
  assert.equal(calls.includes('/developer-api/deployments'), false);
});
