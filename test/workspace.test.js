import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bindWorkspace, findWorkspace, discoverApps, resolveAppDirectory } from '../src/workspace.js';

test('project binding writes the original instructions and preserves existing files and symlinks', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-workspace-agents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binding = { endpoint: 'http://localhost:8080', project: { id: '11111111-1111-4111-8111-111111111111', name: 'Timeline $& {{ endpoint }}' } };
  const file = path.join(root, 'AGENTS.md');
  await bindWorkspace(root, binding);
  const instructions = await readFile(file, 'utf8');
  assert.ok(instructions.includes('Project name: "Timeline $& {{ endpoint }}"'));
  assert.ok(instructions.includes(`nexia link-project ${binding.project.id}`));
  assert.ok(instructions.includes(`Platform: ${binding.endpoint}`));
  assert.ok(instructions.includes('## Delivery and safety'));
  await writeFile(file, 'Custom project rules\n');
  await bindWorkspace(root, binding);
  assert.equal(await readFile(file, 'utf8'), 'Custom project rules\n');
  await rm(file);
  const target = path.join(root, 'custom.md');
  await writeFile(target, 'Linked rules\n');
  await symlink(target, file);
  await bindWorkspace(root, binding);
  assert.equal(await readFile(target, 'utf8'), 'Linked rules\n');
});

test('project discovery isolates immediate Apps and rejects ambiguous identities and foreign bindings', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { id: '11111111-1111-4111-8111-111111111111' };
  const endpoint = 'http://localhost:8080';
  await bindWorkspace(root, { endpoint, project });
  const app = async (name, key) => {
    const directory = path.join(root, name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'nexia.json'), JSON.stringify({ schema_version: '2', runtime: 'laravel', app: { app_key: key } }));
    await writeFile(path.join(directory, 'composer.json'), JSON.stringify({ name: `example/${key}` }));
    return directory;
  };
  const people = await app('People', 'example-people');
  await app('Payroll', 'example-payroll');
  await app('.staging/Incomplete', 'example-hidden');
  await symlink(people, path.join(root, 'Linked'));
  await mkdir(path.join(people, 'src'));
  assert.equal((await findWorkspace(path.join(people, 'src'))).root, root);
  assert.equal(await resolveAppDirectory(root, 'example-people'), people);
  assert.equal(await resolveAppDirectory(path.join(people, 'src')), people);
  await assert.rejects(resolveAppDirectory(root), /Select an App/);
  assert.equal((await discoverApps(root)).apps.length, 2);
  await app('Duplicate', 'example-people');
  const discovered = await discoverApps(root);
  assert.deepEqual(discovered.apps.map(app => app.name), ['Payroll']);
  assert.equal(discovered.errors.length, 2);
  await assert.rejects(bindWorkspace(root, { endpoint, project: { id: '22222222-2222-4222-8222-222222222222' } }), /already connected/);
  await assert.rejects(bindWorkspace(people, { endpoint, project }), /outside an App/);
});

test('App link cannot erase a project marker and project link rejects an App before login', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-workspace-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { id: '11111111-1111-4111-8111-111111111111' };
  await bindWorkspace(root, { endpoint: 'http://127.0.0.1:1', project });
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const options = { cwd: root, env: { ...process.env, NEXIA_CONFIG_HOME: path.join(root, 'private') } };
  await assert.rejects(promisify(execFile)(process.execPath, [cli, 'link'], options), /project workspace/);
  assert.equal((await findWorkspace(root)).project_id, project.id);
  const app = path.join(root, 'people');
  await mkdir(app);
  await writeFile(path.join(app, 'nexia.json'), '{}');
  await assert.rejects(promisify(execFile)(process.execPath, [cli, 'link-project', project.id], { ...options, cwd: app }), /outside an App/);
});
