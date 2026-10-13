import test from 'node:test';
import assert from 'node:assert/strict';
import { preparationFailureDetails } from '../src/preparation-failure.js';

const mismatch = { code: 'SDK_VERSION_MISMATCH', stage: 'dependencies', required_sdk: '^0.8.6 || ^0.9.0', installed_sdk: 'v0.8.4' };

test('SDK mismatch identifies server versus App versions and the responsible support path', () => {
  const message = preparationFailureDetails(mismatch);
  assert.match(message, /App requires PHP SDK: \^0\.8\.6 \|\| \^0\.9\.0/);
  assert.match(message, /Server PHP SDK: v0\.8\.4/);
  assert.match(message, /Contact developer support/);
  assert.match(message, /Local composer install or deleting \.nexia will not change/);
  assert.doesNotMatch(message, /restart nexia dev|safe to retry/i);
});

test('old, unknown and terminal-control diagnostics are not rendered', () => {
  for (const failure of [null, {}, { code: 'UNKNOWN', stage: 'dependencies', message: 'secret' },
    { ...mismatch, required_sdk: '^0.8.6\nFAKE SUCCESS' }, { ...mismatch, installed_sdk: '\x1b[2J0.8.4' },
    { ...mismatch, required_sdk: '1'.repeat(161) }, { ...mismatch, stage: '__proto__' },
    { ...mismatch, stage: 'migrate' }]) assert.equal(preparationFailureDetails(failure), '');
  assert.doesNotMatch(preparationFailureDetails({ ...mismatch, stderr: 'password=secret' }), /password|secret/);
});

test('uncertain migration failures retain evidence and identify the failed step', () => {
  const message = preparationFailureDetails({ code: 'PREPARATION_FAILED', stage: 'migrate' });
  assert.match(message, /database migrations/);
  assert.match(message, /do not delete migration history or reset data/);
  assert.doesNotMatch(message, /safe to retry|restart nexia dev/i);
});
