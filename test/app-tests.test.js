import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { testApp } from '../src/app-tests.js';
import { parseCommand } from '../src/commands.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-test-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'vendor/bin'), { recursive: true });
  await Promise.all(['phpunit.xml', 'vendor/autoload.php', 'vendor/bin/pest'].map(file => writeFile(path.join(root, file), '')));
  return realpath(root);
}

test('test command selects an App and preserves filter values without shell execution', async t => {
  const root = await fixture(t), calls = [];
  const parsed = parseCommand(['test', '--database', '--filter', 'a;$(false)', '--testsuite', 'Domain']);
  assert.equal(parsed.name, 'test');
  assert.equal(parsed.options.database, true);
  await testApp(root, { filter: 'a;$(false)', testsuite: 'Domain' }, {
    environment: {}, log() {}, execute: async (...args) => calls.push(args),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'php');
  assert.deepEqual(calls[0][1], ['vendor/bin/pest', '--configuration', 'phpunit.xml', '--bootstrap', 'vendor/autoload.php', '--fail-on-empty-test-suite', '--do-not-cache-result', '--filter', 'a;$(false)', '--testsuite', 'Domain']);
  assert.equal(calls[0][2].cwd, root);
  assert.equal(calls[0][2].env.APP_ENV, 'testing');
});

test('disposable database is loopback-only and is removed after the test runner fails', async t => {
  const root = await fixture(t), calls = [], failure = Object.assign(new Error('test assertion failed'), { exitCode: 7 });
  const execute = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'port') return '127.0.0.1:54321';
    if (command === 'php') throw failure;
    return '';
  };
  await assert.rejects(testApp(root, { database: true }, { execute, log() {}, environment: { DB_URL: 'private', DATABASE_URL: 'private' } }), error => error === failure);
  const started = calls[0].args;
  assert.equal(started[started.indexOf('--publish') + 1], '127.0.0.1::5432');
  assert.ok(started.includes('--tmpfs'));
  const php = calls.find(call => call.command === 'php');
  assert.equal(php.options.env.NEXIA_TEST_DB_HOST, '127.0.0.1');
  assert.equal(php.options.env.NEXIA_TEST_DB_PORT, '54321');
  assert.equal(php.options.env.DB_PASSWORD, '');
  assert.equal(php.options.env.DB_URL, undefined);
  assert.equal(php.options.env.DATABASE_URL, undefined);
  assert.deepEqual(calls.at(-1).args, ['rm', '--force', started[started.indexOf('--name') + 1]]);
});

test('failed database startup never executes PHP and cleanup does not mask the cause', async t => {
  const root = await fixture(t), calls = [], failure = new Error('Docker unavailable');
  await assert.rejects(testApp(root, { database: true }, { log() {}, execute: async (command, args) => {
    calls.push([command, args]);
    throw args[0] === 'run' ? failure : new Error('not created');
  } }), error => error === failure);
  assert.equal(calls.some(([command]) => command === 'php'), false);
});

test('abort removes the disposable database without reusing the aborted signal', async t => {
  const root = await fixture(t), controller = new AbortController(), calls = [];
  await assert.rejects(testApp(root, { database: true }, { signal: controller.signal, log() {}, execute: async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'port') return '127.0.0.1:54321';
    if (command === 'php') { controller.abort(); controller.signal.throwIfAborted(); }
    return '';
  } }), { name: 'AbortError' });
  assert.equal(calls.at(-1).args[0], 'rm');
  assert.equal(calls.at(-1).options.signal, undefined);
});

test('missing App test dependencies fail before provisioning a database', async t => {
  const root = await fixture(t);
  await rm(path.join(root, 'vendor/bin/pest'));
  await assert.rejects(testApp(root, { database: true }, { execute: () => assert.fail('must not execute') }), /development dependencies/);
});

test('frontend tests need no PHP and preserve failure and filter arguments', async t => {
  const root = await fixture(t), calls = [];
  await rm(path.join(root, 'vendor'), { recursive: true });
  await rm(path.join(root, 'phpunit.xml'));
  await mkdir(path.join(root, 'node_modules/vitest'), { recursive: true });
  await writeFile(path.join(root, 'node_modules/vitest/vitest.mjs'), '');
  const { options } = parseCommand(['test', '--frontend', '--filter', 'a;$(false)']);
  const failure = Object.assign(new Error('assertion failed'), { exitCode: 1 });
  await assert.rejects(testApp(root, options, {
    environment: {}, log() {}, execute: async (...args) => { calls.push(args); throw failure; },
  }), error => error === failure);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], process.execPath);
  assert.deepEqual(calls[0][1], ['node_modules/vitest/vitest.mjs', 'run', '--testNamePattern', 'a;$(false)']);
  assert.equal(calls[0][2].env.NODE_ENV, 'test');
  for (const option of ['database', 'testsuite']) {
    await assert.rejects(testApp(root, { frontend: true, [option]: true }, {
      execute: () => assert.fail('must not execute'),
    }), /cannot be combined/);
  }
});
