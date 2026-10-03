import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startFrontendBuild } from '../src/frontend-build.js';

test('generated App build starts, rebuilds and stops with one dev watcher', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-frontend-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const viteDir = path.join(root, 'node_modules', 'vite', 'dist', 'node');
  await mkdir(viteDir, { recursive: true });
  await mkdir(path.join(root, 'resources'), { recursive: true });
  await writeFile(path.join(root, 'vite.config.mjs'), 'export default {}');
  const saveSource = async content => {
    await writeFile(path.join(root, 'source.tmp'), content);
    await rename(path.join(root, 'source.tmp'), path.join(root, 'source.txt'));
  };
  await saveSource('first');
  await writeFile(path.join(viteDir, 'index.js'), `
    const fs = require('node:fs');
    const path = require('node:path');
    exports.build = async () => {
    // A build captures glob matches once; its incremental watcher only notices
    // edits to the already imported source. New files require a new graph.
    const matches = fs.readdirSync('resources').sort();
    const watcher = new (require('node:events').EventEmitter)();
    const output = path.join(process.cwd(), 'dist/frontend/.vite/manifest.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    let previous;
    const timer = setInterval(() => {
      const current = fs.readFileSync('source.txt', 'utf8');
      if (current !== previous) {
        previous = current;
        watcher.emit('event', { code: 'START' });
        if (current === 'broken') { watcher.emit('event', { code: 'ERROR' }); watcher.emit('event', { code: 'END' }); return; }
        fs.writeFileSync(output, current);
        fs.writeFileSync(path.join(process.cwd(), 'dist/frontend/matches.json'), JSON.stringify(matches));
        setTimeout(() => { fs.writeFileSync(path.join(process.cwd(), 'dist/frontend/index.js'), current); watcher.emit('event', { code: 'END' }); }, 60);
      }
    }, 20);
    watcher.close = async () => clearInterval(timer);
    return watcher;
    };
  `);
  const build = await startFrontendBuild(root);
  const manifest = path.join(root, 'dist/frontend/.vite/manifest.json');
  try {
    assert.equal(await readFile(manifest, 'utf8'), 'first');
    assert.equal(await readFile(path.join(root, 'dist/frontend/index.js'), 'utf8'), 'first');
    await saveSource('second');
    for (let i = 0; i < 50 && (await readFile(manifest, 'utf8')) !== 'second'; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await readFile(manifest, 'utf8'), 'second');
    for (let i = 0; i < 50 && !build.ready(); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(build.ready(), true);
    await saveSource('broken');
    for (let i = 0; i < 50 && build.ready(); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(build.ready(), false, 'a failed compile cannot expose the previous frontend as ready');
    await saveSource('fixed');
    for (let i = 0; i < 50 && !build.ready(); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(build.ready(), true);
    assert.equal(await readFile(path.join(root, 'dist/frontend/index.js'), 'utf8'), 'fixed');
    const matches = path.join(root, 'dist/frontend/matches.json');
    const waitForMatches = async expected => {
      for (let i = 0; i < 100; i++) {
        if (build.ready() && await readFile(matches, 'utf8') === JSON.stringify(expected)) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(await readFile(matches, 'utf8'), JSON.stringify(expected));
      assert.equal(build.ready(), true);
    };
    await writeFile(path.join(root, 'resources', 'TaskSurface.tsx'), 'new surface');
    await waitForMatches(['TaskSurface.tsx']);
    await rename(path.join(root, 'resources', 'TaskSurface.tsx'), path.join(root, 'resources', 'RenamedSurface.tsx'));
    await waitForMatches(['RenamedSurface.tsx']);
    await rm(path.join(root, 'resources', 'RenamedSurface.tsx'));
    await waitForMatches([]);
    build.check();
  } finally { await build.close(); }
});
