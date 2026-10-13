import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryDevRead, transientPlatformError } from '../src/dev-retry.js';

test('startup recovers from a transport timeout without hiding authorization failures', async () => {
  let reads = 0;
  const value = await retryDevRead(async () => {
    if (++reads === 1) throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    return { status: 'connected' };
  }, { log: () => {}, interval: 1 });
  assert.equal(value.status, 'connected');
  assert.equal(reads, 2);
  await assert.rejects(retryDevRead(() => { throw Object.assign(new Error('Unauthorized'), { status: 401 }); }, { log: () => {} }), /Unauthorized/);
  assert.equal(transientPlatformError(new Error('unknown failure')), false);
  const controller = new AbortController();
  const result = await retryDevRead(() => { throw Object.assign(new Error('Unavailable'), { status: 503 }); }, { signal: controller.signal, log: () => controller.abort() });
  assert.equal(result, null);
});
