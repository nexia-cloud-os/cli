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
