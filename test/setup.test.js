import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../src/setup.js';

test('dry-run reports the installation plan without running Homebrew', async () => {
  const messages = [];
  await setup({ dryRun: true, platform: 'darwin', log: (message) => messages.push(message) });
  assert.ok(messages.some((message) => message.includes('brew update')));
  assert.ok(messages.some((message) => message.includes('Homebrew is missing')));
  assert.ok(messages.some((message) => message.includes('No commands were run')));
});

test('unsupported platforms get an actionable limitation', async () => {
  await assert.rejects(setup({ dryRun: true, platform: 'linux' }), /macOS with Homebrew only/);
});
