import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sourceSnapshot, runtimeSourceDigest } from '../src/source-snapshot.js';

test('native snapshot is deterministic, bounded and excludes local secrets and dependencies', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-source-'));
  try {
    await mkdir(path.join(root, 'src'));
    await mkdir(path.join(root, 'vendor'));
    await writeFile(path.join(root, 'composer.json'), '{"name":"example/app"}');
    await writeFile(path.join(root, 'src', 'Example.php'), '<?php // App code');
    await writeFile(path.join(root, 'vite.config.mjs'), 'export default {};');
    await writeFile(path.join(root, '.env'), 'PRIVATE=not-for-upload');
    await writeFile(path.join(root, 'vendor', 'secret.php'), 'private');
    const first = await sourceSnapshot(root);
    assert.deepEqual(first.files.map(file => file.path), ['composer.json', 'src/Example.php', 'vite.config.mjs']);
    assert.deepEqual(await sourceSnapshot(root), first);
    await writeFile(path.join(root, 'vite.config.mjs'), 'export default { build: {} };');
    assert.notEqual((await sourceSnapshot(root)).digest, first.digest);
    await writeFile(path.join(root, 'src', 'Example.php'), '<?php // changed');
    assert.notEqual((await sourceSnapshot(root)).digest, first.digest);
    await symlink(path.join(root, '.env'), path.join(root, 'src', 'Leak.php'));
    await assert.rejects(sourceSnapshot(root), /symlinks/);
    await rm(path.join(root, 'src', 'Leak.php'));
    await writeFile(path.join(root, 'src', 'huge.php'), Buffer.alloc(2 * 1024 * 1024 + 1));
    await assert.rejects(sourceSnapshot(root), /exceeds/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native snapshot waits through Git merge and worktree locks without executing Git', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-source-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'composer.json'), '{}');
  const git = path.join(root, 'git-metadata');
  await mkdir(git);
  await writeFile(path.join(root, '.git'), 'gitdir: git-metadata\n');
  for (const marker of ['index.lock', 'MERGE_HEAD', 'rebase-merge']) {
    await writeFile(path.join(git, marker), 'pending');
    await assert.rejects(sourceSnapshot(root), { code: 'SOURCE_BUSY' });
    await rm(path.join(git, marker));
  }
  assert.equal((await sourceSnapshot(root)).files.length, 1);
});

test('browser edits retain Backend identity but shared and execution inputs do not', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-runtime-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'composer.json'), '{}');
  const files = ['resources/js/Page.tsx', 'resources/css/app.css', 'resources/lang/ko.json',
    'resources/views/report.blade.php', 'resources/js/server.php', 'src/Handler.php',
    'database/migrations/Create.php', 'routes/routes.php', 'nexia.json', 'vite.config.mjs', 'package.json'];
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), 'initial');
  }
  const baseline = await sourceSnapshot(root);
  for (const file of files) {
    await writeFile(path.join(root, file), 'changed');
    const updated = await sourceSnapshot(root);
    assert.notEqual(updated.digest, baseline.digest, 'full uploaded source always retains the change');
    assert.equal(runtimeSourceDigest(updated) === runtimeSourceDigest(baseline), files.indexOf(file) < 2, file);
    await writeFile(path.join(root, file), 'initial');
  }
  await rm(path.join(root, 'resources/js/Page.tsx'));
  assert.equal(runtimeSourceDigest(await sourceSnapshot(root)), runtimeSourceDigest(baseline));
  await rm(path.join(root, 'src/Handler.php'));
  assert.notEqual(runtimeSourceDigest(await sourceSnapshot(root)), runtimeSourceDigest(baseline));
});

test('native snapshot supports a complete App and retains file and byte ceilings', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-source-capacity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'composer.json'), '{}');
  for (let i = 0; i < 1999; i++) await writeFile(path.join(root, 'src', `${i}.php`), Buffer.alloc(5000, 32));
  assert.equal((await sourceSnapshot(root)).files.length, 2000);
  await writeFile(path.join(root, 'src', 'extra.php'), '');
  await assert.rejects(sourceSnapshot(root), /2000 files/);
  await rm(path.join(root, 'src', 'extra.php'));
  for (let i = 0; i < 4; i++) await writeFile(path.join(root, 'src', `${i}.php`), Buffer.alloc(2 * 1024 * 1024, 32));
  await assert.rejects(sourceSnapshot(root), /16 MiB total/);
});


test('native snapshot retains Vitest configuration and existing test sources without widening private paths', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-vitest-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'composer.json'), '{}');
  await mkdir(path.join(root, 'tests/frontend'), { recursive: true });
  await mkdir(path.join(root, 'resources/js'), { recursive: true });
  await writeFile(path.join(root, 'tests/frontend/setup.tsx'), 'export {};');
  await writeFile(path.join(root, 'resources/js/Page.test.tsx'), 'export {};');
  await writeFile(path.join(root, '.env'), 'PRIVATE=excluded');
  await writeFile(path.join(root, 'vitest.config.private'), 'excluded');
  await writeFile(path.join(root, 'private-setup.ts'), 'excluded');
  const config = `export default { test: { environment: 'jsdom', setupFiles: ['./tests/frontend/setup.tsx'], include: ['resources/js/**/*.test.{ts,tsx}'], maxWorkers: 2 } };`;
  for (const extension of ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts']) {
    const name = `vitest.config.${extension}`;
    await writeFile(path.join(root, name), config);
    const snapshot = await sourceSnapshot(root);
    assert.deepEqual(snapshot.files.map(file => file.path), ['composer.json', 'resources/js/Page.test.tsx', 'tests/frontend/setup.tsx', name]);
    assert.equal(Buffer.from(snapshot.files.find(file => file.path === name).content, 'base64').toString(), config);
    await writeFile(path.join(root, name), `${config} // changed`);
    const changed = await sourceSnapshot(root);
    assert.notEqual(changed.digest, snapshot.digest);
    assert.notEqual(runtimeSourceDigest(changed), runtimeSourceDigest(snapshot));
    await rm(path.join(root, name));
  }
  await symlink(path.join(root, '.env'), path.join(root, 'vitest.config.ts'));
  await assert.rejects(sourceSnapshot(root), /symlinks/);
});
