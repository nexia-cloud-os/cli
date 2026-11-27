import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRuntimeLogFile } from '../src/runtime-log-file.js';

test('development runtime logs are private, sandbox-scoped, and rotate at the size limit', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-runtime-logs-'));
  const original = process.env.NEXIA_CONFIG_HOME;
  process.env.NEXIA_CONFIG_HOME = root;
  t.after(async () => {
    if (original === undefined) delete process.env.NEXIA_CONFIG_HOME;
    else process.env.NEXIA_CONFIG_HOME = original;
    await rm(root, { recursive: true, force: true });
  });

  const scope = { endpoint: 'https://test.example', project_id: 'project', app_id: 'app', sandbox_id: 'one' };
  const { filename, write } = await createRuntimeLogFile(scope, 'trial');
  const other = await createRuntimeLogFile({ ...scope, sandbox_id: 'two' }, 'trial');
  assert.notEqual(other.filename, filename);
  const row = { time: '2026-11-27T03:40:00Z', level: 'error', source: 'laravel', message: 'row lock denied\n\u001b[31msource line\u001b[0m' };
  await write('operation-one', [row]);
  assert.match(await readFile(filename, 'utf8'), /ERROR laravel \[operation-one\] row lock denied\n    source line\n/);
  if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o600);

  const batch = Array.from({ length: 100 }, () => ({ ...row, message: 'x'.repeat(7000) }));
  for (let i = 0; i < 4; i++) await write('operation-two', batch);
  assert.ok((await stat(filename)).size <= 2 * 1024 * 1024);
  assert.ok((await stat(filename + '.1')).size <= 2 * 1024 * 1024);
  assert.match(await readFile(filename + '.1', 'utf8'), /operation-one/);
});
