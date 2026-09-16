import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject, validateProject, resolvePublicFile } from '../src/project.js';

test('scaffold refuses to overwrite an existing app', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'example');
  await initProject(app);
  const before = await readFile(path.join(app, 'nexia.json'), 'utf8');
  await assert.rejects(initProject(app), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(app, 'nexia.json'), 'utf8'), before);
  assert.equal((await validateProject(app)).app.id, 'dev.local.example');
});

test('public file resolution refuses hidden files and escaping symlinks', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'example');
  await initProject(app);
  await writeFile(path.join(root, 'secret'), 'private');
  await symlink(path.join(root, 'secret'), path.join(app, 'public', 'escape.txt'));
  await assert.rejects(resolvePublicFile(path.join(app, 'public'), 'escape.txt'));
  await assert.rejects(resolvePublicFile(path.join(app, 'public'), '../nexia.json'));
});
