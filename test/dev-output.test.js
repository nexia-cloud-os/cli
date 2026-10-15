import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevReporter, devFailure, devPanel, devTask } from '../src/dev-output.js';

test('development output remains explicit without color', () => {
  const stream = { isTTY: false };
  assert.equal(devTask('people', 'success', 'Runtime ready', stream), '✓ people  DONE  Runtime ready');
  assert.equal(devTask('assets', 'warning', 'Run npm install', stream), '! assets  ACTION  Run npm install');
  assert.match(devPanel('Nexia development', [['Project', 'example'], ['Local', 'http://127.0.0.1:4310']], stream), /┌─ Nexia development ─+┐\n│ Project  example\s+│\n│ Local    http:\/\/127\.0\.0\.1:4310 │\n└─+┘/);
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
