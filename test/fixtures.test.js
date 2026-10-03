import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/commands.js';
test('excluded fixtures command has no hidden public execution path', () => {
  assert.throws(() => parseCommand(['fixtures', 'list']), /Unknown command/);
});
