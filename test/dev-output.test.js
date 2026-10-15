import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevReporter, devFailure, devPanel, devTask } from '../src/dev-output.js';
import { displayWidth, plain } from '../src/terminal.js';

test('development output remains explicit without color', () => {
  const stream = { isTTY: false };
  assert.equal(devTask('people', 'success', 'Runtime ready', stream), '✓ people  DONE  Runtime ready');
  assert.equal(devTask('assets', 'warning', 'Run npm install', stream), '! assets  ACTION  Run npm install');
  assert.match(devPanel('Nexia development', [['Project', 'example'], ['Local', 'http://127.0.0.1:4310']], stream), /┌─ Nexia development ─+┐\n│ Project  example\s+│\n│ Local    http:\/\/127\.0\.0\.1:4310 │\n└─+┘/);
  const panel = devPanel('Nexia development', [
    ['', { formatted: devTask('startup', 'success', 'Found 27 Apps', stream) }],
    ['', { formatted: devTask('payroll', 'running', 'Runtime preparation queued…', stream) }],
    ['', { formatted: devTask('people', 'pending', 'Queued for development', stream) }],
  ], stream);
  assert.equal(new Set(panel.split('\n').map(displayWidth)).size, 1);
});

test('development failures are bounded unless verbose', () => {
  const error = new Error(Array.from({ length: 20 }, (_, index) => `line ${index} ${'x'.repeat(300)}`).join('\n'));
  const concise = devFailure(error);
  assert.ok(concise.split('\n').length <= 8);
  assert.match(concise, /rerun with --verbose/);
  assert.ok(concise.length < 2000);
  assert.ok(devFailure(error, { verbose: true }).length > concise.length);
});

test('TTY reporter redraws one boxed dashboard instead of appending heartbeat lines', () => {
  const output = [], writes = [];
  let tick = 0, callback;
  const timers = { setInterval(fn) { callback = fn; return { unref() {} }; }, clearInterval() {} };
  const stream = { isTTY: true, write(value) { writes.push(value); } };
  const reporter = createDevReporter(line => output.push(line), { stream, now: () => tick, heartbeatMs: 1000, timers });
  reporter.summary([['App', 'people']]);
  reporter.task('people', 'running', 'Building frontend');
  reporter.task('people', 'running', 'Building frontend');
  tick = 1500; callback();
  reporter.task('people', 'success', 'Frontend ready');
  reporter.close();
  assert.equal(output.length, 0);
  assert.match(writes.join(''), /1s elapsed/);
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
    reporter.task('people', 'error', 'Automatic development resume was not confirmed because the acknowledgement was not confirmed.');
    reporter.message('people', `[build warning] ${'mixed static and dynamic imports '.repeat(8)}`);
    const frame = writes.at(-1), text = frame.split('\n').map(plain).join('\n');
    assert.ok(text.indexOf('Nexia development') < text.indexOf('Details'));
    assert.ok(text.indexOf('Details') < text.indexOf('[build warning]'));
    assert.match(text, /Details · resolve FAILED items first/);
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
