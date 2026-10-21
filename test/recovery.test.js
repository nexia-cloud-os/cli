import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/commands.js';
import { preparationNextAction } from '../src/preparation-failure.js';

test('development has no recover command or administrator retry approval', () => {
  assert.throws(() => parseCommand(['recover', '01a14429-1170-7357-9335-65d590242d3a']));
  for (const status of ['failed', 'needs_review']) {
    const action = preparationNextAction({ status });
    assert.match(action, /keep nexia dev running/);
    assert.doesNotMatch(action, /nexia recover|preserve-and-replace|restart nexia dev/);
  }
  assert.match(preparationNextAction({ failure: { code: 'PREPARATION_FAILED', stage: 'database_probe' } }), /Platform recovery is required/);
});
