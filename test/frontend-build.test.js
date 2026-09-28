import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startFrontendBuild } from '../src/frontend-build.js';

test('generated App build starts, rebuilds and stops with one dev watcher', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-frontend-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const viteDir = path.join(root, 'node_modules', 'vite', 'bin');
  await mkdir(viteDir, { recursive: true });
  await writeFile(path.join(root, 'vite.config.mjs'), 'export default {}');
  await writeFile(path.join(root, 'source.txt'), 'first');
  await writeFile(path.join(viteDir, 'vite.js'), `
    const fs = require('node:fs');
    const path = require('node:path');
    if (process.argv.slice(2).join(' ') !== 'build --watch') process.exit(2);
    const output = path.join(process.cwd(), 'dist/frontend/.vite/manifest.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    let previous;
    setInterval(() => {
      const current = fs.readFileSync('source.txt', 'utf8');
      if (current !== previous) {
        previous = current;
        fs.writeFileSync(output, current);
        setTimeout(() => fs.writeFileSync(path.join(process.cwd(), 'dist/frontend/index.js'), current), 60);
      }
    }, 20);
  `);
  const build = await startFrontendBuild(root);
  const manifest = path.join(root, 'dist/frontend/.vite/manifest.json');
  try {
    assert.equal(await readFile(manifest, 'utf8'), 'first');
    assert.equal(await readFile(path.join(root, 'dist/frontend/index.js'), 'utf8'), 'first');
    await writeFile(path.join(root, 'source.txt'), 'second');
    for (let i = 0; i < 50 && (await readFile(manifest, 'utf8')) !== 'second'; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await readFile(manifest, 'utf8'), 'second');
    build.check();
  } finally { await build.close(); }
});
