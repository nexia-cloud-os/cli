import test from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isNewer, latestVersion, updateCli, installCli } from '../src/update.js';
import { createInput, Cancelled } from '../src/input.js';
import { parseCommand, helpText } from '../src/commands.js';

const day = 86400000;
async function fixture(t, answer = 'skip', options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexia-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = { lookups: 0, installs: [], questions: [], logs: [] };
  const input = createInput(options, { input: { isTTY: true }, output: { isTTY: true, write() {} }, ask: async question => { calls.questions.push(question); return answer; } });
  const settings = { automatic: true, current: '0.2.0-alpha.7', cacheFile: path.join(directory, 'update.json'), now: day * 100, env: {}, installedGlobally: true,
    getLatest: async () => { calls.lookups++; return '0.2.0-alpha.10'; }, installVersion: async version => { calls.installs.push(version); }, log: text => calls.logs.push(text) };
  return { input, settings, calls };
}

test('SemVer ordering handles prereleases, release versions, metadata and invalid input', () => {
  for (const [a, b] of [['0.2.0-alpha.10', '0.2.0-alpha.9'], ['0.2.0', '0.2.0-alpha.10'], ['1.0.0', '0.99.99'], ['1.0.0-beta', '1.0.0-alpha'], ['1.0.0-alpha.1', '1.0.0-alpha'], ['1.0.0-a', '1.0.0-1']]) {
    assert.equal(isNewer(a, b), true, `${a} > ${b}`);
    assert.equal(isNewer(b, a), false);
  }
  for (const version of ['0.2.0-alpha.7', '0.2.0-alpha.7+build', '0.2.0-alpha.07', 'latest', '1.0.0; touch /tmp/no', null, '01.0.0']) assert.equal(isNewer(version, '0.2.0-alpha.7'), false);
});

test('registry request is bounded and validates the package and version', async () => {
  assert.equal(await latestVersion(async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/@nexia%2fcli/alpha');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => ({ name: '@nexia/cli', version: '0.2.0-alpha.10' }) };
  }), '0.2.0-alpha.10');
  for (const data of [{ name: 'other', version: '1.0.0' }, { name: '@nexia/cli', version: '--bad' }]) await assert.rejects(latestVersion(async () => ({ ok: true, json: async () => data })), /Invalid/);
  await assert.rejects(latestVersion(async () => ({ ok: false, status: 503 })), /503/);
});

test('skip continues the command and cached version avoids another lookup', async t => {
  const { input, settings, calls } = await fixture(t);
  assert.equal(await updateCli(input, {}, settings), false);
  assert.equal(await updateCli(input, {}, settings), false);
  assert.equal(calls.lookups, 1);
  assert.equal(calls.questions.length, 2);
  assert.deepEqual(calls.installs, []);
  await updateCli(input, {}, { ...settings, now: settings.now + day });
  assert.equal(calls.lookups, 2);
});

test('later snoozes 24 hours while an explicit update bypasses snooze/cache', async t => {
  const { input, settings, calls } = await fixture(t, 'later');
  await updateCli(input, {}, settings);
  assert.equal(await updateCli(input, {}, { ...settings, now: settings.now + day - 1 }), false);
  assert.equal(calls.questions.length, 1);
  const explicit = createInput({ yes: true }, { output: { write() {} } });
  assert.equal(await updateCli(explicit, { yes: true }, { ...settings, automatic: false }), true);
  assert.equal(calls.lookups, 2);
  assert.deepEqual(calls.installs, ['0.2.0-alpha.10']);
});

test('automatic update returns a stop signal only after installing the displayed version', async t => {
  const { input, settings, calls } = await fixture(t, 'update');
  assert.equal(await updateCli(input, {}, settings), true);
  assert.deepEqual(calls.installs, ['0.2.0-alpha.10']);
  assert.match(calls.logs.at(-1), /0.2.0-alpha.10/);
});

test('automation, dry runs, explicit yes and source checkouts never auto-check', async t => {
  const { input, settings, calls } = await fixture(t, 'update');
  for (const options of [{ json: true }, { 'no-interactive': true }, { 'dry-run': true }, { yes: true }]) assert.equal(await updateCli(input, options, settings), false);
  for (const extra of [{ env: { CI: 'true' } }, { installedGlobally: false }]) assert.equal(await updateCli(input, {}, { ...settings, ...extra }), false);
  assert.equal(await updateCli({ interactive: false }, {}, settings), false);
  assert.equal(calls.lookups, 0);
  assert.equal(calls.questions.length, 0);
  assert.deepEqual(calls.installs, []);
});

test('network failures are cached and fail open only for automatic checks', async t => {
  const { input, settings, calls } = await fixture(t);
  settings.getLatest = async () => { calls.lookups++; throw new Error('offline'); };
  assert.equal(await updateCli(input, {}, settings), false);
  assert.equal(await updateCli(input, {}, settings), false);
  assert.equal(calls.lookups, 1);
  await assert.rejects(updateCli(input, {}, { ...settings, automatic: false }), /offline/);
  assert.deepEqual(calls.installs, []);
});

test('corrupt or unwritable cache does not block the original command', async t => {
  const { input, settings } = await fixture(t);
  await writeFile(settings.cacheFile, '{broken');
  assert.equal(await updateCli(input, {}, settings), false);
  assert.equal(JSON.parse(await readFile(settings.cacheFile, 'utf8')).latest, '0.2.0-alpha.10');
  assert.equal(await updateCli(input, {}, { ...settings, cacheFile: path.join(settings.cacheFile, 'impossible') }), false);
});

test('explicit dry run and missing consent never install', async t => {
  const { settings, calls } = await fixture(t);
  const dry = createInput({ 'dry-run': true }, { output: { write() {} } });
  await updateCli(dry, { 'dry-run': true }, { ...settings, automatic: false });
  await assert.rejects(readFile(settings.cacheFile), { code: 'ENOENT' });
  const unattended = createInput({ 'no-interactive': true }, { output: { write() {} } });
  await assert.rejects(updateCli(unattended, {}, { ...settings, automatic: false }), /--yes/);
  assert.deepEqual(calls.installs, []);
});

test('current or newer installed versions do not prompt or downgrade', async t => {
  const { input, settings, calls } = await fixture(t, 'update');
  for (const current of ['0.2.0-alpha.10', '0.2.0', '1.0.0']) assert.equal(await updateCli(input, {}, { ...settings, current }), false);
  assert.equal(calls.questions.length, 0);
  assert.deepEqual(calls.installs, []);
});

test('cancellation and installation failure stop the command without success output', async t => {
  const { input, settings, calls } = await fixture(t, 'update');
  await assert.rejects(updateCli(input, {}, { ...settings, installVersion: async () => { throw new Error('npm failed'); } }), /npm failed/);
  assert.equal(calls.logs.some(text => /Updated to/.test(text)), false);
  await assert.rejects(updateCli({ interactive: true, choice: async () => { throw new Cancelled(); } }, {}, settings), Cancelled);
});

test('update command exposes confirmation and preview flags without arbitrary package/channel input', () => {
  assert.equal(parseCommand(['update', '--no-interactive', '--yes']).name, 'update');
  assert.equal(parseCommand(['update', '--dry-run']).options['dry-run'], true);
  for (const args of [['update', 'other-package'], ['update', '--tag', 'latest'], ['update', '--json']]) assert.throws(() => parseCommand(args));
  assert.match(helpText('update'), /--dry-run/);
});


test('installer verifies npm ownership and passes an exact version without a shell', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexia-install-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, '@nexia', 'cli');
  await mkdir(root, { recursive: true });
  const pkg = path.join(root, 'package.json');
  await writeFile(pkg, JSON.stringify({ version: '0.2.0-alpha.7' }));
  const options = { root, platform: 'darwin', findNpm: async () => '/usr/bin/npm',
    run: async (file, args, config) => {
      assert.equal(file, '/usr/bin/npm');
      assert.deepEqual(args, ['root', '--global']);
      assert.equal(config.timeout, 5000);
      return { stdout: directory + '\n' };
    },
    start: (file, args, config) => {
      assert.equal(file, '/usr/bin/npm');
      assert.deepEqual(args, ['install', '--global', '@nexia/cli@0.2.0-alpha.10', '--registry=https://registry.npmjs.org/']);
      assert.equal(config.shell, false);
      assert.equal(config.stdio, 'inherit');
      const child = new EventEmitter();
      writeFile(pkg, JSON.stringify({ version: '0.2.0-alpha.10' })).then(() => child.emit('close', 0), error => child.emit('error', error));
      return child;
    } };
  await installCli('0.2.0-alpha.10', options);
  const forbid = () => assert.fail('must not install');
  await assert.rejects(installCli('0.2.0-alpha.10', { ...options, root: directory, start: forbid }), /not the active/);
  await assert.rejects(installCli('0.2.0-alpha.10', { ...options, platform: 'win32', start: forbid }), /terminal/);
  await assert.rejects(installCli('0.2.0-alpha.10', { ...options, findNpm: async () => null, start: forbid }), /not found/);
  await assert.rejects(installCli('--bad', { ...options, start: forbid }), /Invalid/);
  for (const code of [1, 0]) {
    await writeFile(pkg, JSON.stringify({ version: '0.2.0-alpha.7' }));
    await assert.rejects(installCli('0.2.0-alpha.10', { ...options, start: () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', code));
      return child;
    } }), code ? /update failed/ : /Could not verify/);
  }
  await rm(root, { recursive: true });
  const source = path.join(directory, 'source');
  await mkdir(source);
  await symlink(source, root, 'dir');
  await assert.rejects(installCli('0.2.0-alpha.10', { ...options, root: source, start: forbid }), /npm-linked/);
});
