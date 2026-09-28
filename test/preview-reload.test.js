import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/project.js';
import { startPreview } from '../src/preview.js';

for (const container of [false, true]) {
  test(`saved App assets refresh in ${container ? 'Docker polling' : 'local'} mode`, { timeout: 8000 }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexia-reload-'));
    const app = path.join(root, 'app');
    await initProject(app);
    const preview = await startPreview(app, 0, { container });
    const abort = new AbortController();
    t.after(async () => {
      abort.abort();
      await preview.close();
      await rm(root, { recursive: true, force: true });
    });
    const response = await fetch(`${preview.url}/__nexia_reload`, { signal: abort.signal });
    const reader = response.body.getReader();
    await reader.read(); // Subscription ready; initial SSE comment.
    await appendFile(path.join(app, 'public/index.html'), '\n<p>saved change</p>');
    const event = new TextDecoder().decode((await reader.read()).value);
    assert.match(event, /data: reload/);
    assert.match(await (await fetch(preview.url)).text(), /saved change/);
    assert.equal((await fetch(`${preview.url}/.env`)).status, 404);
  });
}
