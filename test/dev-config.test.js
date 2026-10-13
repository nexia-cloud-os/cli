import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { configureDevApps, configuredDevApps } from '../src/dev-selection.js';
import { parseCommand } from '../src/commands.js';
import { createInput, Cancelled } from '../src/input.js';

const apps = [{ key: 'one', name: 'first' }, { key: 'two', name: 'second' }];
const quiet = () => {};
const noPrompt = { interactive: false, multiChoice: () => assert.fail('unexpected prompt') };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-dev-config-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, '.nexia'));
  return { root, project_id: '11111111-1111-4111-8111-111111111111', endpoint: 'https://example.test' };
}
const editor = result => ({ interactive: true, multiChoice: async () => result });
const configFile = workspace => path.join(workspace.root, '.nexia/dev.json');

test('saved keys are passed to the always-visible picker and explicit flags do not rewrite them', async t => {
  const workspace = await fixture(t);
  await configureDevApps(workspace, apps, undefined, editor(['two']), quiet);
  const before = await readFile(configFile(workspace), 'utf8');
  let calls = 0;
  const input = { interactive: true, multiChoice: async (label, choices, options) => {
    calls++;
    assert.equal(options.configure, true);
    assert.deepEqual(options.configKeys, ['two']);
    return options.configKeys;
  } };
  assert.deepEqual(await configuredDevApps(workspace, apps, undefined, input), ['two']);
  assert.deepEqual(await configuredDevApps(workspace, [{ key: 'two', name: 'renamed' }], undefined, input), ['two']);
  assert.equal(calls, 2);
  assert.deepEqual(await configuredDevApps(workspace, apps, 'first', noPrompt), ['one']);
  assert.equal(await readFile(configFile(workspace), 'utf8'), before);
});

test('temporary picker selection is not persisted', async t => {
  const workspace = await fixture(t);
  assert.deepEqual(await configuredDevApps(workspace, apps, undefined, editor(['one'])), ['one']);
  await assert.rejects(readFile(configFile(workspace)), { code: 'ENOENT' });
});

test('editing preselects saved identities; cancellation preserves the file', async t => {
  const workspace = await fixture(t);
  await configureDevApps(workspace, apps, undefined, editor(['two']), quiet);
  const before = await readFile(configFile(workspace), 'utf8');
  await assert.rejects(configureDevApps(workspace, apps, undefined, { interactive: true, multiChoice: async (label, choices, options) => {
    assert.deepEqual(options.initial, ['two']);
    throw new Cancelled();
  } }, quiet), Cancelled);
  assert.equal(await readFile(configFile(workspace), 'utf8'), before);
});

test('stale or invalid Config is disabled while manual choices remain available', async t => {
  const workspace = await fixture(t);
  await configureDevApps(workspace, apps, undefined, editor(['two']), quiet);
  const manual = { interactive: true, multiChoice: async (label, choices, options) => {
    assert.ok(options.configError);
    assert.deepEqual(options.configKeys, []);
    return ['one'];
  } };
  assert.deepEqual(await configuredDevApps(workspace, [apps[0]], undefined, manual), ['one']);
  await configuredDevApps({ ...workspace, endpoint: 'https://other.test' }, apps, undefined, manual);
  await writeFile(configFile(workspace), '{broken');
  await configuredDevApps(workspace, apps, undefined, manual);
  await configureDevApps(workspace, apps, undefined, editor(['one']), quiet);
  assert.deepEqual(JSON.parse(await readFile(configFile(workspace), 'utf8')).apps, ['one']);
});

test('configured All Apps remains dynamic and disables itself above the maximum', async t => {
  const workspace = await fixture(t);
  await configureDevApps(workspace, apps, undefined, editor(null), quiet);
  await configuredDevApps(workspace, apps, undefined, { interactive: true, multiChoice: async (label, choices, options) => {
    assert.equal(options.configAll, true);
    assert.deepEqual(options.configKeys, ['one', 'two']);
    return null;
  } });
  await configuredDevApps(workspace, Array.from({ length: 21 }, (_, i) => ({ key: `app-${i}` })), undefined, { interactive: true, multiChoice: async (label, choices, options) => {
    assert.match(options.configError, /20-App/);
    assert.deepEqual(options.configKeys, []);
    return ['app-0'];
  } });
});

test('automated config requires explicit Apps and confirmation', async t => {
  const workspace = await fixture(t);
  const input = createInput({ 'no-interactive': true }, { output: { write() {} } });
  await assert.rejects(configureDevApps(workspace, apps, undefined, input, quiet), /--app/);
  await assert.rejects(configureDevApps(workspace, apps, 'first', input, quiet), /--yes/);
  const options = parseCommand(['dev', 'config', '--app', 'first', '--app', 'second', '--no-interactive', '--yes']).options;
  await configureDevApps(workspace, apps, options.app, createInput(options, { output: { write() {} } }), quiet);
  assert.deepEqual(JSON.parse(await readFile(configFile(workspace), 'utf8')).apps, ['one', 'two']);
  assert.equal(await configuredDevApps(workspace, apps, undefined, noPrompt), undefined);
  assert.throws(() => parseCommand(['dev', 'config', '--port', '4310']));
});

test('config never follows symlinked files or configuration directories', async t => {
  const workspace = await fixture(t);
  const target = path.join(workspace.root, 'protected');
  await writeFile(target, 'keep');
  await symlink(target, configFile(workspace));
  await assert.rejects(configureDevApps(workspace, apps, undefined, editor(['one']), quiet), /regular file/);
  assert.equal(await readFile(target, 'utf8'), 'keep');
  await rm(path.join(workspace.root, '.nexia'), { recursive: true });
  await mkdir(path.join(workspace.root, 'other'));
  await symlink(path.join(workspace.root, 'other'), path.join(workspace.root, '.nexia'), 'dir');
  await assert.rejects(configureDevApps(workspace, apps, undefined, editor(['one']), quiet), /real directory/);
});
