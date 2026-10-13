import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startDevSession, listDevSessions, stopDevSessions } from '../src/dev-sessions.js';

test('another caller can inspect and stop only the selected authenticated session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-sessions-'));
  let first, second;
  try {
    first = await startDevSession(root, { port: 4310, stop: () => { void first.close(); } });
    second = await startDevSession(root, { port: 4311, stop: () => { void second.close(); } });
    first.update({ status: 'watching', apps: ['people', 'payroll'], workspace_url: 'https://example.com/workspace' });
    const sessions = await listDevSessions(root);
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions.find(session => session.port === 4310).apps, ['people', 'payroll']);
    assert.ok(!JSON.stringify(sessions).includes('token'));
    assert.deepEqual((await stopDevSessions(root, 4310)).map(session => session.status), ['stopped']);
    assert.equal((await listDevSessions(root))[0].port, 4311);
    assert.deepEqual((await stopDevSessions(root)).map(session => session.status), ['stopped']);
  } finally { await first?.close(); await second?.close(); await rm(root, { recursive: true, force: true }); }
});

test('an unauthenticated or stale record cannot stop a process with the same PID', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-session-auth-'));
  let stops = 0;
  const session = await startDevSession(root, { port: 4310, stop: () => stops++ });
  try {
    const directory = path.join(root, '.nexia/dev-sessions');
    const file = path.join(directory, (await readdir(directory))[0]);
    const record = JSON.parse(await readFile(file, 'utf8'));
    const url = `http://127.0.0.1:${record.control_port}/stop`;
    assert.equal((await fetch(url, { method: 'POST' })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${record.token}`, Origin: 'https://evil.example' } })).status, 403);
    await writeFile(file, JSON.stringify({ ...record, token: '0'.repeat(64) }));
    assert.equal((await stopDevSessions(root))[0].status, 'unreachable');
    assert.equal(stops, 0);
  } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});

test('CLI finds a background session from a nested project folder without platform login', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdir } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-session-cli-'));
  const nested = path.join(root, 'notes');
  await mkdir(nested);
  let session;
  try {
    session = await startDevSession(root, { port: 4310, stop: () => { void session.close(); } });
    await writeFile(path.join(root, '.nexia/project.json'), JSON.stringify({ kind: 'project', schema_version: 1,
      project_id: '12345678-1234-1234-1234-123456789abc', endpoint: 'https://example.test' }));
    const run = args => promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), ...args],
      { cwd: nested, env: { ...process.env, NEXIA_CONFIG_HOME: path.join(root, 'empty-config') }, timeout: 15000 });
    assert.equal(JSON.parse((await run(['ps', '--json'])).stdout).sessions[0].port, 4310);
    assert.equal(JSON.parse((await run(['stop', '--port', '4310', '--json'])).stdout).sessions[0].status, 'stopped');
    assert.deepEqual(JSON.parse((await run(['ps', '--json'])).stdout).sessions, []);
  } finally { await session?.close(); await rm(root, { recursive: true, force: true }); }
});
