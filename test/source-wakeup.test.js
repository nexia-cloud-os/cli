import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSourceChange } from '../src/source-snapshot.js';
import { sourceWakeup } from '../src/source-wakeup.js';

test('only source paths wake the development loop', () => {
  assert.equal(isSourceChange('src/Controller.php'), true);
  assert.equal(isSourceChange('composer.json'), true);
  assert.equal(isSourceChange('node_modules/example/index.js'), false);
  assert.equal(isSourceChange('resources/.secret'), false);
  assert.equal(isSourceChange('dist/frontend/index.js'), false);
});

test('source notification wakes a pending wait and polling works without a watcher', async () => {
  let event;
  const changes = sourceWakeup('/app', (_directory, _options, callback) => {
    event = callback;
    return { on() {}, close() {} };
  });
  try {
    const waiting = changes.wait(3000);
    event('change', 'src/Example.php');
    await waiting;
    // An edit arriving during a completed loop must also wake the next wait.
    changes.notify();
    const immediate = changes.wait(3000);
    const finished = await Promise.race([immediate.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))]);
    assert.equal(finished, true);
    const aborted = new AbortController();
    aborted.abort();
    await changes.wait(3000, aborted.signal);
  } finally {
    changes.close();
  }
  const fallback = sourceWakeup('/app', () => { throw new Error('unsupported'); });
  await fallback.wait(1);
  fallback.close();
});
