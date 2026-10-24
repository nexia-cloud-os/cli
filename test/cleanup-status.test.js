import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupStatus } from '../src/cleanup-status.js';
test('cleanup status distinguishes observed removal from pending and excludes raw messages', () => {
  const text = cleanupStatus([{ operation: '11111111-1111-4111-8111-111111111111', observations: {
    files: { status: 'removed' }, networks: { status: 'protected', reason: 'private-secret' },
  } }]);
  assert.match(text, /Temporary files: removal confirmed/);
  assert.match(text, /Private networks: pending/);
  assert.ok(!text.includes('private-secret'));
  assert.equal(cleanupStatus([{ operation: 'untrusted', observations: { files: { status: 'removed' } } }]), '');
});
