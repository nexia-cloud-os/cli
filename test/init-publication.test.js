import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initLaravelApp } from '../src/devtools.js';
import { discoverApps } from '../src/workspace.js';

test('init publishes a complete App once and leaves no discoverable partial App after failure', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-init-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'People');
  const options = { vendor: 'example', family: 'people' };
  const generate = async args => {
    const directory = args[3];
    assert.notEqual(directory, target);
    await mkdir(path.join(directory, 'resources/js'), { recursive: true });
    await writeFile(path.join(directory, 'nexia.json'), JSON.stringify({ schema_version: '2', runtime: 'laravel', app: { app_key: 'example-people' } }));
    await writeFile(path.join(directory, 'composer.json'), '{"name":"example/people"}');
    assert.equal((await discoverApps(root)).apps.length, 0);
    await writeFile(path.join(directory, 'package.json'), '{}');
    await writeFile(path.join(directory, 'resources/js/index.ts'), 'export {};');
  };
  await assert.rejects(initLaravelApp(target, options, { generate: async args => { await generate(args); throw new Error('Cancelled'); } }), /Cancelled/);
  assert.deepEqual(await readdir(root), []);
  await initLaravelApp(target, options, { generate });
  assert.deepEqual((await discoverApps(root)).apps.map(app => app.name), ['People']);
  await assert.rejects(initLaravelApp(target, options, { generate }), /Existing files/);
});
