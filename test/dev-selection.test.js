import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInput, Cancelled } from '../src/input.js';
import { parseCommand } from '../src/commands.js';
import { selectDevApps, filterDevApps } from '../src/dev-selection.js';

const apps = Array.from({ length: 27 }, (_, index) => ({ name: `folder-${index}`, key: `key-${index}` }));

test('only dev permits repeated App flags, regardless of option position', () => {
  for (const args of [['dev', '--app', 'people', '--app=payroll'], ['--app', 'people', 'dev', '--app', 'payroll']]) {
    assert.deepEqual(parseCommand(args).options.app, ['people', 'payroll']);
  }
  assert.equal(parseCommand(['dev', '--app', 'people']).options.app, 'people');
  for (const command of [['check'], ['db', 'migrate'], ['submit'], ['make', 'resource']]) {
    assert.throws(() => parseCommand([...command, '--app', 'people', '--app', 'payroll']), /Only nexia dev/);
  }
});

test('selection resolves names and keys, deduplicates identities, rejects invalid and oversized scopes', async () => {
  const input = { interactive: false };
  const selected = await selectDevApps(apps, ['folder-0', 'key-0', 'folder-2'], input);
  assert.deepEqual(selected, ['key-0', 'key-2']);
  assert.deepEqual(filterDevApps(apps, selected), [apps[0], apps[2]]);
  assert.deepEqual(filterDevApps(apps, 'folder-0'), [apps[0]]);
  assert.equal(filterDevApps(apps, undefined), apps);
  const colliding = [{ name: 'first', key: 'second' }, { name: 'second', key: 'third' }];
  assert.deepEqual(filterDevApps(colliding, await selectDevApps(colliding, 'first', input)), [colliding[0]]);
  await assert.rejects(selectDevApps(apps, ['missing'], input), /Unknown or ambiguous/);
  await assert.rejects(selectDevApps([{ name: 'same', key: 'one' }, { name: 'two', key: 'same' }], 'same', input), /ambiguous/);
  await assert.rejects(selectDevApps(apps, [], input), /1–20/);
  await assert.rejects(selectDevApps(apps, apps.slice(0, 21).map(app => app.key), input), /1–20/);
  assert.equal((await selectDevApps(apps, apps.slice(0, 20).map(app => app.key), input)).length, 20);
  await assert.rejects(selectDevApps(apps, undefined, input), /Repeat --app/);
  assert.equal(await selectDevApps(apps.slice(0, 20), undefined, input), undefined);
  assert.equal(await selectDevApps([], undefined, input), undefined);
});

test('comma-separated App flags compose with repeated flags and keep validation', async () => {
  const input = { interactive: false };
  const options = parseCommand(['dev', '--app=folder-0, key-2', '--app', 'key-0,folder-3']).options;
  assert.deepEqual(await selectDevApps(apps, options.app, input), ['key-0', 'key-2', 'key-3']);
  assert.deepEqual(await selectDevApps(apps, 'folder-0,key-2', input), ['key-0', 'key-2']);
  for (const value of ['folder-0,', ',folder-0', 'folder-0,,key-2', 'folder-0, ,key-2', 'folder-0,missing']) {
    await assert.rejects(selectDevApps(apps, value, input), /Unknown or ambiguous/);
  }
  assert.equal((await selectDevApps(apps, apps.slice(0, 20).map(app => app.key).join(','), input)).length, 20);
  await assert.rejects(selectDevApps(apps, apps.slice(0, 21).map(app => app.key).join(','), input), /1–20/);
});

test('interactive selection occurs for multiple Apps, supplied flags and single Apps skip it', async () => {
  let calls = 0;
  const input = { interactive: true, multiChoice: async (label, choices, options) => {
    calls++;
    assert.equal(options.max, 20);
    assert.equal(choices.length, 27);
    return ['key-1', 'key-4'];
  } };
  assert.deepEqual(await selectDevApps(apps, undefined, input), ['key-1', 'key-4']);
  assert.equal(await selectDevApps(apps.slice(0, 1), undefined, input), undefined);
  assert.deepEqual(await selectDevApps(apps, 'folder-3', input), ['key-3']);
  assert.equal(calls, 1);
  assert.equal(await selectDevApps(apps.slice(0, 2), undefined, { interactive: true, multiChoice: async () => null }), undefined);
});

function picker(count, max = 20, settings = {}, rows = 24) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = value => { stdin.isRaw = value; };
  stdin.pause();
  let rendered = '';
  const output = { isTTY: true, columns: 100, rows, write: value => { rendered += value; } };
  const input = createInput({}, { input: stdin, output });
  const result = input.multiChoice('Apps', apps.slice(0, count).map(app => ({ value: app.key, label: app.name })), { max, ...settings });
  const key = (name, ctrl = false) => stdin.emit('keypress', name === 'space' ? ' ' : '', { name, ctrl });
  return { stdin, result, key, rendered: () => rendered };
}

test('Space toggles choices, arrows scroll, empty Enter waits, and limit does not silently truncate', async () => {
  const p = picker(27);
  p.key('return');
  assert.match(p.rendered(), /at least one|하나 이상/);
  p.key('space');
  assert.match(p.rendered(), /individual|개별/);
  for (let i = 0; i < 21; i++) { p.key('down'); p.key('space'); }
  p.key('return');
  assert.deepEqual(await p.result, apps.slice(0, 20).map(app => app.key));
  assert.match(p.rendered(), /Limit reached|최대 개수/);
  assert.equal(p.stdin.isRaw, false);
  assert.equal(p.stdin.isPaused(), true);
  assert.equal(p.stdin.listenerCount('keypress'), 0);
});

test('All Apps uses exclusive dynamic scope; selecting an App switches to only that App', async () => {
  const all = picker(3);
  all.key('space'); all.key('return');
  assert.equal(await all.result, null);
  const some = picker(3);
  some.key('space'); some.key('down'); some.key('space'); some.key('return');
  assert.deepEqual(await some.result, ['key-0']);
});

test('Ctrl+C, EOF and stream errors restore terminal state and cancel', async () => {
  for (const end of [p => p.key('c', true), p => p.stdin.emit('end'), p => p.stdin.emit('error', new Error('input failed'))]) {
    const p = picker(3);
    end(p);
    await assert.rejects(p.result, error => error instanceof Cancelled || error.message === 'input failed');
    assert.equal(p.stdin.isRaw, false);
    assert.equal(p.stdin.isPaused(), true);
    assert.equal(p.stdin.listenerCount('keypress'), 0);
    assert.equal(p.stdin.listenerCount('end'), 0);
  }
});

test('non-interactive CLI rejects over-limit selection before reading authentication', async t => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const { bindWorkspace } = await import('../src/workspace.js');
  const root = await mkdtemp(join(tmpdir(), 'nexia-dev-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await bindWorkspace(root, { endpoint: 'https://example.test', project: { id: '11111111-1111-4111-8111-111111111111', name: 'Fixture' } });
  for (const app of apps.slice(0, 21)) {
    const directory = join(root, app.name);
    await mkdir(directory);
    await writeFile(join(directory, 'composer.json'), JSON.stringify({ name: `example/${app.name}` }));
    await writeFile(join(directory, 'nexia.json'), JSON.stringify({ schema_version: '2', runtime: 'laravel', app: { app_key: app.key } }));
  }
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'dev', '--no-interactive'], {
    cwd: root, env: { ...process.env, NEXIA_CONFIG_HOME: join(root, 'unused-config') }, timeout: 5000,
  }), error => error.code === 2 && /at most 20/.test(error.stderr));
});


test('picker uses terminal height and Config is selected by default', async () => {
  const large = picker(27, 20, { configure: true, configKeys: ['key-0'] }, 40);
  assert.match(large.rendered(), /folder-26/);
  assert.match(large.rendered(), /\[x\] Config/);
  assert.match(large.rendered(), /folder-0 \(Config\)/);
  large.key('return');
  assert.deepEqual(await large.result, ['key-0']);
  const small = picker(27, 20, {}, 12);
  assert.doesNotMatch(small.rendered(), /folder-10/);
  small.key('down'); small.key('space'); small.key('return');
  assert.deepEqual(await small.result, ['key-0']);
});

test('Config locks its members, permits additions, and counts distinct Apps', async () => {
  const p = picker(3, 2, { configure: true, configKeys: ['key-0'] });
  p.key('down'); p.key('space');
  assert.match(p.rendered(), /Included in Config|Config 포함/);
  p.key('down'); p.key('space');
  p.key('down'); p.key('space');
  assert.match(p.rendered(), /Limit reached|최대 개수/);
  p.key('return');
  assert.deepEqual(new Set(await p.result), new Set(['key-0', 'key-1']));
});

test('All Apps clears Config and extras; manual selection clears All Apps', async () => {
  const p = picker(3, 20, { configure: true, configKeys: ['key-0'] });
  p.key('down'); p.key('down'); p.key('space');
  p.key('up'); p.key('up'); p.key('up'); p.key('space'); p.key('return');
  assert.equal(await p.result, null);
  const q = picker(3, 20, { configure: true, configKeys: ['key-0'] });
  q.key('up'); q.key('space');
  q.key('down'); q.key('down'); q.key('down'); q.key('space'); q.key('return');
  assert.deepEqual(await q.result, ['key-1']);
});

test('turning Config off retains extras and enabling it removes duplicate manual choices', async () => {
  const p = picker(3, 20, { configure: true, configKeys: ['key-0'] });
  p.key('down'); p.key('down'); p.key('space');
  p.key('up'); p.key('up'); p.key('space'); p.key('return');
  assert.deepEqual(await p.result, ['key-1']);
  const q = picker(3, 20, { configure: true, configKeys: ['key-0'] });
  q.key('space'); q.key('down'); q.key('space'); q.key('up'); q.key('space'); q.key('return');
  assert.deepEqual(await q.result, ['key-0']);
});

test('configuration editor preselects saved identities or All Apps', async () => {
  const initial = picker(3, 20, { initial: ['key-1'], saving: true });
  initial.key('return');
  assert.deepEqual(await initial.result, ['key-1']);
  const all = picker(3, 20, { initial: null, saving: true });
  all.key('return');
  assert.equal(await all.result, null);
});


test('unconfigured Config opens setup and manual selection remains available', async () => {
  const p = picker(3, 20, { configure: true });
  p.key('space');
  assert.deepEqual(await p.result, { configure: true });
  const q = picker(3, 20, { configure: true });
  q.key('down'); q.key('space'); q.key('return');
  assert.deepEqual(await q.result, ['key-0']);
});

test('Config cannot be enabled when its union with extra Apps exceeds the maximum', async () => {
  const p = picker(3, 2, { configure: true, configKeys: ['key-0', 'key-1'] });
  p.key('space');
  p.key('down'); p.key('down'); p.key('down'); p.key('space');
  p.key('up'); p.key('up'); p.key('up'); p.key('space');
  assert.match(p.rendered(), /Limit reached|최대 개수/);
  p.key('return');
  assert.deepEqual(await p.result, ['key-2']);
});
