import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { Readable, Writable } from 'node:stream';
import { initProject } from '../src/project.js';
import { startPreview } from '../src/preview.js';
import { serveMcp } from '../src/mcp.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
function invoke(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'nexia-integration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('CLI creates and validates an app, rejects overwrite, and reports unavailable deploy', async (t) => {
  const root = await temporary(t);
  const directory = path.join(root, 'sample');
  assert.equal((await invoke(['init', directory])).code, 0);
  assert.equal((await invoke(['validate', directory])).code, 0);
  assert.equal((await invoke(['init', directory])).code, 1);
  const deploy = await invoke(['deploy']);
  assert.equal(deploy.code, 1);
  assert.match(deploy.stderr, /No remote action was performed/);
  if (process.platform === 'darwin') {
    const setup = await invoke(['setup', '--dry-run']);
    assert.equal(setup.code, 0);
    assert.match(setup.stdout, /No commands were run/);
  }
});

test('preview serves public HTML and rejects private paths, bad hosts, origins and writes', async (t) => {
  const root = await temporary(t);
  const directory = path.join(root, 'sample');
  await initProject(directory);
  const preview = await startPreview(directory, 0);
  t.after(() => preview.close());
  const response = await fetch(preview.url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /__nexia_reload/);
  assert.equal((await fetch(`${preview.url}/nexia.json`)).status, 404);
  assert.equal((await fetch(`${preview.url}/.env`)).status, 404);
  const badHostStatus = await new Promise((resolve, reject) => {
    get(preview.url, { headers: { Host: 'attacker.example' } }, (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(preview.url, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(preview.url, { method: 'POST' })).status, 405);
});

test('MCP validates local app and strips credentials from local binding output', async (t) => {
  const root = await temporary(t);
  const directory = path.join(root, 'sample');
  await initProject(directory);
  await mkdir(path.join(directory, '.nexia'));
  await writeFile(path.join(directory, '.nexia/project.json'), JSON.stringify({ project_id: 'local-draft', token: 'do-not-return', endpoint: 'https://user:password@example.com/private?token=hidden' }));
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'validate_manifest', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_project', arguments: {} } },
  ];
  let output = '';
  await serveMcp(directory, Readable.from(requests.map((item) => JSON.stringify(item) + '\n')), new Writable({ write(chunk, encoding, callback) { output += chunk.toString(); callback(); } }));
  const responses = output.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(responses[0].result.protocolVersion, '2024-11-05');
  assert.equal(responses[1].result.tools.length, 2);
  assert.equal(JSON.parse(responses[2].result.content[0].text).valid, true);
  const project = JSON.parse(responses[3].result.content[0].text);
  assert.equal(project.remotely_verified, false);
  assert.equal(project.binding.endpoint, 'https://example.com');
  assert.doesNotMatch(output, /do-not-return|password|hidden/);
});
