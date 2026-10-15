import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevReporter, devFailure, devPanel, devTask, serverVersionRows } from '../src/dev-output.js';
import { displayWidth, plain } from '../src/terminal.js';

test('development output remains explicit without color', () => {
  const stream = { isTTY: false };
  assert.equal(devTask('people', 'success', 'Runtime ready', stream), '✓ people  DONE  Runtime ready');
  assert.equal(devTask('people', 'running', 'Building frontend', stream), '◆ people  PROCESSING  Building frontend');
  assert.equal(devTask('assets', 'warning', 'Run npm install', stream), '! assets  ACTION  Run npm install');
  assert.match(devPanel('Nexia development', [['Project', 'example'], ['Local', 'http://127.0.0.1:4310']], stream), /┌─ Nexia development ─+┐\n│ Project  example\s+│\n│ Local    http:\/\/127\.0\.0\.1:4310 │\n└─+┘/);
  const panel = devPanel('Nexia development', [
    ['', { formatted: devTask('startup', 'success', 'Found 27 Apps', stream) }],
    ['', { formatted: devTask('payroll', 'running', 'Runtime preparation queued…', stream) }],
    ['', { formatted: devTask('people', 'pending', 'Queued for development', stream) }],
  ], stream);
  assert.equal(new Set(panel.split('\n').map(displayWidth)).size, 1);
});

test('server versions use only the authenticated bounded platform contract', () => {
  assert.deepEqual(serverVersionRows({ core: '0.8.42', php_sdk: '0.9.3', react_sdk: '0.9.1' }), [
    ['Server Core', '0.8.42'], ['Core PHP SDK', '0.9.3'], ['Core React SDK', '0.9.1'],
  ]);
  assert.deepEqual(serverVersionRows(undefined), []);
  assert.deepEqual(serverVersionRows({ core: '\u001b[31msecret', php_sdk: '0.9.3', react_sdk: '0.9.1' }), []);
});

test('server versions are inserted immediately after the CLI version', () => {
  const writes = [];
  const timers = { setInterval() { return { unref() {} }; }, clearInterval() {} };
  const stream = { isTTY: true, columns: 160, write(value) { writes.push(value); } };
  const reporter = createDevReporter(() => {}, { stream, heartbeatMs: 0, timers });
  reporter.summary([['CLI version', '0.2.0-alpha.21'], ['Project folder', '/project']]);
  reporter.summary(serverVersionRows({ core: '0.8.42', php_sdk: '0.9.3', react_sdk: '0.9.1' }), { after: 'CLI version' });
  reporter.summary([['Apps', 'payroll']]);
  const panel = plain(writes.at(-1));
  assert.ok(panel.indexOf('CLI version') < panel.indexOf('Server Core'));
  assert.ok(panel.indexOf('Core React SDK') < panel.indexOf('Project folder'));
  reporter.close();
});

test('development failures are bounded unless verbose', () => {
  const error = new Error(Array.from({ length: 20 }, (_, index) => `line ${index} ${'x'.repeat(300)}`).join('\n'));
  const concise = devFailure(error);
  assert.ok(concise.split('\n').length <= 8);
  assert.match(concise, /rerun with --verbose/);
  assert.ok(concise.length < 2000);
  assert.ok(devFailure(error, { verbose: true }).length > concise.length);
});

test('TTY reporter redraws one boxed dashboard and times waiting and processing tasks', () => {
  const output = [], writes = [];
  let tick = 0, callback;
  const timers = { setInterval(fn) { callback = fn; return { unref() {} }; }, clearInterval() {} };
  const stream = { isTTY: true, write(value) { writes.push(value); } };
  const reporter = createDevReporter(line => output.push(line), { stream, now: () => tick, heartbeatMs: 1000, timers });
  reporter.summary([['App', 'people']]);
  reporter.task('people', 'pending', 'Runtime preparation queued');
  reporter.task('people', 'pending', 'Runtime preparation queued');
  tick = 1500; callback();
  assert.match(writes.at(-1), /WAITING.*1s elapsed/);
  reporter.task('people', 'running', 'Building frontend');
  tick = 3000; callback();
  reporter.task('people', 'success', 'Frontend ready');
  reporter.close();
  assert.equal(output.length, 0);
  assert.match(writes.join(''), /PROCESSING.*1s elapsed/);
  assert.match(writes.at(-1), /DONE/);
  assert.ok(writes.filter(value => value.includes('\x1b[J')).length >= 2);
});

test('TTY reporter can retain its dashboard while an interactive picker is open', () => {
  const writes = [];
  const timers = { setInterval() { return { unref() {} }; }, clearInterval() {} };
  const stream = { isTTY: true, write(value) { writes.push(value); } };
  const reporter = createDevReporter(() => {}, { stream, heartbeatMs: 0, timers });
  reporter.summary([['CLI version', '0.2.0-alpha.15 · up to date']]);
  const beforePause = writes.length;
  reporter.pause({ retain: true });
  assert.equal(writes.length, beforePause);
  reporter.resume();
  assert.match(writes.at(-1), /CLI version/);
  reporter.close();
});

test('TTY reporter keeps bounded details below the status box', () => {
  const term = process.env.TERM, noColor = process.env.NO_COLOR;
  process.env.TERM = 'xterm-256color';
  delete process.env.NO_COLOR;
  const writes = [];
  const stream = { isTTY: true, columns: 180, rows: 30, write(value) { writes.push(value); } };
  try {
    const reporter = createDevReporter(() => {}, { stream, heartbeatMs: 0 });
    reporter.summary([['CLI version', '0.2.0-alpha.16 · up to date']]);
    reporter.failure('people', new Error('Automatic development resume was not confirmed because the acknowledgement was not confirmed.'), {
      summary: 'Restart nexia dev required',
      next: 'Resolve the error, then restart nexia dev.',
    });
    reporter.message('people', `[build warning] ${'mixed static and dynamic imports '.repeat(8)}`);
    const frame = writes.at(-1), text = frame.split('\n').map(plain).join('\n');
    assert.ok(text.indexOf('Nexia development') < text.indexOf('Details'));
    assert.ok(text.indexOf('Details') < text.indexOf('[build warning]'));
    assert.match(text, /Details · resolve FAILED items first/);
    assert.match(text, /people  FAILED  Restart nexia dev required/);
    assert.match(text, /\n✕ people  Automatic development resume was not confirmed/);
    assert.match(text, /\n! people  \[build warning\]/);
    assert.doesNotMatch(text.slice(text.indexOf('Details')), /^[│└]/m);
    assert.match(frame, /\x1b\[1mpeople\x1b\[0m/);
    assert.match(frame, /\x1b\[33m\[build warning\]/);
    assert.ok(text.split('\n').every(line => line.length <= 120));
    reporter.close();
  } finally {
    process.env.TERM = term;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  }
});

test('resolved App failures disappear while build warnings remain', () => {
  const writes = [];
  const timers = { setInterval() { return { unref() {} }; }, clearInterval() {} };
  const stream = { isTTY: true, columns: 160, rows: 30, write(value) { writes.push(value); } };
  const reporter = createDevReporter(() => {}, { stream, heartbeatMs: 0, timers });
  reporter.message('people', '[build warning] chunk placement is unchanged');
  reporter.failure('people', new Error('[SDK_VERSION_MISMATCH] Failed step: PHP dependencies.'));
  assert.match(plain(writes.at(-1)), /resolve FAILED items first/);
  assert.equal(reporter.resolve('people'), true);
  reporter.task('people', 'success', 'Runtime preparation confirmed; previous failure resolved');
  const resolved = plain(writes.at(-1));
  assert.match(resolved, /build warning/);
  assert.match(resolved, /DONE.*previous failure resolved/);
  assert.doesNotMatch(resolved, /SDK_VERSION_MISMATCH|resolve FAILED items first/);
  reporter.close();
});

test('non-TTY output appends an explicit resolution after a prior failure', () => {
  const output = [];
  const reporter = createDevReporter(value => output.push(value), { stream: { isTTY: false } });
  reporter.message('people', '[SDK_VERSION_MISMATCH] Failed step: PHP dependencies.', { failure: true });
  const resolved = reporter.resolve('people');
  reporter.task('people', 'success', resolved
    ? 'Runtime preparation confirmed; previous failure resolved'
    : 'Runtime preparation confirmed');
  assert.match(plain(output.at(-1)), /✓ people\s+DONE\s+Runtime preparation confirmed; previous failure resolved/);
  reporter.close();
});

test('catalog failure keys and character limits survive a narrow terminal', async () => {
  const { preparationFailureDetails } = await import('../src/preparation-failure.js');
  const output = [];
  const reporter = createDevReporter(line => output.push(line), { stream: { isTTY: false, columns: 55 }, heartbeatMs: 0 });
  const key = 'payroll.approval.presets.payroll_adjustment_request.description';
  reporter.failure('payroll', new Error('Preparation failed\n' + preparationFailureDetails({
    code: 'CATALOG_VALIDATION_FAILED', stage: 'catalog', issues: [{
      field: 'catalog.translations.en.' + key, rule: 'too_long', limit: 2000, actual: 2001,
    }],
  })), { next: 'Fix the translation, then run nexia check.' });
  const details = output.slice(1).join('\n').split('\n').map(line => line.replace(/^[✕→] payroll  /, '')).join('');
  assert.ok(details.includes('maximum 2000 characters; actual 2001'));
  assert.ok(details.includes('Key: ' + key));
  assert.ok(details.includes('resources/lang/en.json'));
  reporter.close();
});
