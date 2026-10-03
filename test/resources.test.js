import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/commands.js';
test('excluded resources command has no hidden public execution path', () => {
  assert.throws(() => parseCommand(['resources', 'list']), /Unknown command/);
});
