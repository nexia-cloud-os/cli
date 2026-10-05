import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, helpText } from '../src/commands.js';
import { createInput, Cancelled } from '../src/input.js';
import { generatorArguments } from '../src/scaffold.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('command errors link to troubleshooting without corrupting JSON output', async () => {
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  for (const json of [false, true]) {
    await assert.rejects(promisify(execFile)(process.execPath, [cli, 'unknown-command', ...(json ? ['--json'] : [])]), error => {
      if (json) {
        assert.ok(JSON.parse(error.stdout).error.message);
        assert.equal(error.stderr, '');
      } else {
        assert.match(error.stderr, /Troubleshooting: https:\/\/developers.nexia.to\/docs\/troubleshooting-common-installation-errors/);
      }
      return true;
    });
  }
});

test('public commands have no retired aliases and reject unsupported or contradictory options', () => {
  for (const name of ['constructor', 'toString', '__proto__', 'init', 'create-project', 'link-project', 'link', 'validate', 'make:resource', 'make:page', 'sync', 'mcp', 'fixtures', 'resources', 'app', 'apps', 'config', 'doctor', 'deploy', 'submissions']) assert.throws(() => parseCommand([name]));
  for (const args of [['db', 'reset'], ['make', 'resource', '--navigation', '--no-navigation'], ['make', 'page', '--no-navigation', '--sort', '2'], ['dev', '--profile', 'work'], ['create', 'app', '--force'], ['submit', '--yes=false'], ['dev', '--port=']]) assert.throws(() => parseCommand(args));
  assert.deepEqual(parseCommand(['make', 'page', 'Summary', '--no-record']).options, { record: false });
  assert.deepEqual(parseCommand(['create', 'app', 'people', '--prerequisite', 'one', '--prerequisite=two']).options.prerequisite, ['one', 'two']);
  assert.equal(parseCommand(['help', 'make', 'resource']).options.help, true);
  assert.match(helpText('make resource'), /--no-navigation/);
});

test('supplied options skip questions, invalid interactive values retry, and defaults remain visible', async () => {
  const questions = [], answers = ['bad', '42'];
  const input = createInput({ vendor: 'acme' }, { input: { isTTY: true }, output: { isTTY: true, write() {} }, ask: async text => { questions.push(text); return answers.shift(); } });
  assert.equal(await input.text('vendor', 'Vendor', { required: true }), 'acme');
  assert.equal(questions.length, 0);
  assert.equal(await input.text('sort', 'Order', { defaultValue: '10', validate: value => /^\d+$/.test(value) }), '42');
  assert.equal(questions.length, 2);
  assert.match(questions[0], /\[10\]/);
});

test('noninteractive mode never fabricates required settings or consent', async () => {
  let asked = false;
  const input = createInput({ 'no-interactive': true }, { ask: async () => { asked = true; }, output: { write() {} } });
  await assert.rejects(input.text('vendor', 'Vendor', { required: true }), /--vendor/);
  await assert.rejects(input.confirm('Plan'), /--yes/);
  assert.equal(await input.boolean('navigation', 'Menu?', true), true);
  assert.equal(asked, false);
  const accepted = createInput({ 'no-interactive': true, yes: true }, { output: { write() {} } });
  await accepted.confirm('Plan');
  await assert.rejects(accepted.text('vendor', 'Vendor', { required: true }), /--vendor/);
});

test('JSON disables prompts and cancellation is a distinct result', async () => {
  const json = createInput({ json: true }, { input: { isTTY: true }, output: { isTTY: true, write() {} }, ask: () => assert.fail('must not prompt') });
  await assert.rejects(json.text('key', 'Key', { required: true }));
  const interactive = createInput({}, { input: { isTTY: true }, output: { isTTY: true, write() {} }, ask: async () => 'no' });
  await assert.rejects(interactive.confirm('Plan'), error => error instanceof Cancelled && error.exitCode === 130);
});

test('public booleans map to the existing generator contract without changing labels or sort defaults', () => {
  assert.deepEqual(generatorArguments('resource', { directory: '/app', name: 'Request', values: { 'label-ko': '신청', navigation: false, sort: 'auto' } }), ['make:resource', '/app', 'Request', '--label-ko', '신청', '--without-navigation']);
  assert.deepEqual(generatorArguments('page', { directory: '/app', name: 'Summary', values: { record: false, navigation: true } }, { dryRun: true }), ['make:page', '/app', 'Summary', '--without-record', '--dry-run']);
});
