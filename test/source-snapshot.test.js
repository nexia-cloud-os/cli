import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sourceSnapshot } from '../src/source-snapshot.js';

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
