import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startFrontendBuild } from '../src/frontend-build.js';
import { removeSession, removeSessionAssets, translationSessionPlugins, validateSessionAssets } from '../src/frontend-session.js';

async function waitFor(predicate, label) {
  for (let i = 0; i < 250; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

test('opt-in session preserves legacy output and old snapshots across rebuilds and failure', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-session-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const viteDir = path.join(root, 'node_modules/vite/dist/node');
  await mkdir(viteDir, { recursive: true });
  await mkdir(path.join(root, 'resources'), { recursive: true });
  await mkdir(path.join(root, 'dist/frontend'), { recursive: true });
  await writeFile(path.join(root, 'dist/frontend/user-owned.txt'), 'preserve');
  await writeFile(path.join(root, 'vite.config.mjs'), 'export default {}');
  const save = async text => {
    await writeFile(path.join(root, 'source.tmp'), text);
    await rename(path.join(root, 'source.tmp'), path.join(root, 'source.txt'));
  };
  await save('first');
  await writeFile(path.join(viteDir, 'index.js'), `
    const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
    exports.build = async options => {
      let output, wait, files = [];
      const api = { version: 1, acceptSession(value) { output = value.outDir; wait = value.waitForSnapshot; }, generatedFiles() { return files; }, candidateFiles() { return files; } };
      const sdk = { name: 'nexia:app-services', api: { nexiaTranslationSession: api } };
      const [cli, guard] = options.plugins;
      const config = { plugins: [Promise.resolve([sdk])], root: process.cwd(), publicDir: false, build: { outDir: 'dist/frontend' } };
      await cli.config.handler(config); config.build.outDir = output; cli.configResolved(config);
      guard.outputOptions.handler({ dir: output });
      fs.writeFileSync('session-path', output);
      const watcher = new (require('node:events').EventEmitter)(); let previous, busy = false;
      const timer = setInterval(async () => {
        const current = fs.readFileSync('source.txt', 'utf8'); if (busy || current === previous) return;
        previous = current; busy = true; watcher.emit('event', { code: 'START' });
        try {
          await Promise.all([cli.buildStart.handler(), wait()]);
          if (current === 'broken') throw Error('invalid source');
          fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'index.js'), current);
          const parts = {}; files = [];
          for (const locale of ['en','ko','zh']) {
            const body = JSON.stringify({ 'sample.title': current });
            const hash = crypto.createHash('sha256').update(body).digest('hex');
            const name = 'i18n/v1/' + locale + '/shared-' + hash + '.json';
            fs.mkdirSync(path.dirname(path.join(output, name)), { recursive: true });
            fs.writeFileSync(path.join(output, name), body); parts[locale] = name; files.push(name);
          }
          const index = JSON.stringify({version:1,app_key:'sample',locales:['en','ko','zh'],registration:['shared'],scopes:{'route:Overview':['shared']},parts:{shared:parts}});
          const indexName = 'i18n/v1/index-' + crypto.createHash('sha256').update(index).digest('hex') + '.json';
          fs.mkdirSync(path.dirname(path.join(output,indexName)), {recursive:true}); fs.writeFileSync(path.join(output,indexName),index);files.push(indexName);
          fs.writeFileSync(path.join(output,'nexia-host.json'),JSON.stringify({version:1,app_key:'sample',styles:[],translation_partitions:{version:1,index:indexName}}));
          const bundle = Object.fromEntries(files.map(name=>[name,{}])); guard.writeBundle.handler({}, bundle);
          watcher.emit('event', { code: 'END' });
        } catch (error) { watcher.emit('event', { code: 'ERROR', error }); watcher.emit('event', { code: 'END' }); }
        finally { busy = false; }
      }, 20);
      watcher.close = async () => clearInterval(timer); return watcher;
    };
  `);
  const events = [];
  const build = await startFrontendBuild(root, { onState: state => events.push(state), log: () => {} });
  let session;
  try {
    await waitFor(() => build.ready(), 'first generation');
    session = await readFile(path.join(root, 'session-path'), 'utf8');
    const first = build.snapshot();
    const firstRoot = path.join(root, 'dist/frontend-generations', first);
    assert.equal(await readFile(path.join(firstRoot, 'index.js'), 'utf8'), 'first');
    const host = JSON.parse(await readFile(path.join(firstRoot, 'nexia-host.json'), 'utf8'));
    const oldIndex = JSON.parse(await readFile(path.join(firstRoot, host.translation_partitions.index), 'utf8'));
    const oldPart = oldIndex.parts.shared.ko;
    assert.match(await readFile(path.join(firstRoot, oldPart), 'utf8'), /first/);
    await save('second');
    await waitFor(() => build.ready() && build.snapshot() !== first, 'second generation');
    assert.equal(await readFile(path.join(firstRoot, 'index.js'), 'utf8'), 'first');
    assert.match(await readFile(path.join(firstRoot, oldPart), 'utf8'), /first/);
    assert.equal(await readFile(path.join(root, 'dist/frontend/user-owned.txt'), 'utf8'), 'preserve');
    await assert.rejects(readFile(path.join(session, oldPart)), /ENOENT/);
    const second = build.snapshot();
    await save('broken');
    await waitFor(() => build.failed(), 'failed build');
    assert.equal(build.snapshot(), second);
    assert.match(await readFile(path.join(firstRoot, oldPart), 'utf8'), /first/);
    await save('recovered');
    await waitFor(() => build.ready() && build.snapshot() !== second, 'recovered build');
    assert.ok(events.includes('failed'));
    const previousSession = session, beforeLayout = build.snapshot();
    await writeFile(path.join(root, 'resources/added.ts'), 'export {};');
    await waitFor(async () => {
      session = await readFile(path.join(root, 'session-path'), 'utf8');
      return session !== previousSession && build.ready() && build.snapshot() !== beforeLayout;
    }, 'new watcher after layout change');
    await assert.rejects(lstat(previousSession), /ENOENT/);
    assert.match(await readFile(path.join(firstRoot, oldPart), 'utf8'), /first/);
    const generations = path.join(root, 'dist/frontend-generations');
    const before = new Set(await readdir(generations));
    await mkdir(path.join(session, 'many-files'));
    await Promise.all(Array.from({ length: 300 }, (_, i) => writeFile(path.join(session, 'many-files', `${i}.txt`), 'fixture')));
    await save('closing');
    await waitFor(async () => (await readdir(generations)).some(name => !before.has(name)), 'snapshot copy start');
    await build.close();
    await assert.rejects(lstat(session), /ENOENT/);
    assert.equal(await readFile(path.join(root, 'dist/frontend/user-owned.txt'), 'utf8'), 'preserve');
  } finally { await build.close(); }
  await assert.rejects(readFile(path.join(session, 'index.js')), /ENOENT/);
  assert.equal(await readFile(path.join(root, 'dist/frontend/user-owned.txt'), 'utf8'), 'preserve');
});

test('unsupported platforms and unavailable mount checks leave the legacy build path', async () => {
  let accepted = false;
  const sdk = { name: 'nexia:app-services', api: { nexiaTranslationSession: {
    version: 1, acceptSession() { accepted = true; }, generatedFiles() { return []; }, candidateFiles() { return []; },
  } } };
  const windows = translationSessionPlugins(async () => {}, () => {}, { platform: 'win32' });
  await windows.plugins[0].config.handler({ plugins: [sdk] });
  assert.equal(windows.getSession(), undefined);
  assert.equal(accepted, false);
  let attempted;
  const unavailable = translationSessionPlugins(async () => {}, () => {}, { platform: 'darwin', checkMount: async root => { attempted = root; throw new Error('unavailable'); } });
  await unavailable.plugins[0].config.handler({ plugins: [sdk] });
  assert.equal(unavailable.getSession(), undefined);
  assert.equal(accepted, false);
  await assert.rejects(lstat(attempted), /ENOENT/);
  const oldSdk = { name: 'nexia:app-services', api: { nexiaTranslationSession: {
    version: 1, acceptSession() { accepted = true; }, generatedFiles() { return []; },
  } } };
  const old = translationSessionPlugins(async () => {}, () => {}, { platform: 'darwin', checkMount: async () => true });
  await old.plugins[0].config.handler({ plugins: [oldSdk] });
  assert.equal(old.getSession(), undefined);
  assert.equal(accepted, false);
});

for (const failed of [false, true]) test(`a ${failed ? 'failed' : 'superseded'} build retires its own parts`, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-session-superseded-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const viteDir = path.join(root, 'node_modules/vite/dist/node');
  await mkdir(viteDir, { recursive: true });
  await mkdir(path.join(root, 'resources'), { recursive: true });
  await writeFile(path.join(root, 'vite.config.mjs'), 'export default {}');
  await writeFile(path.join(viteDir, 'index.js'), `
    const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
    exports.build=async options=>{
      let output,wait,files=[];const api={version:1,acceptSession(x){output=x.outDir;wait=x.waitForSnapshot},generatedFiles(){return files},candidateFiles(){return files}};
      const sdk={name:'nexia:app-services',api:{nexiaTranslationSession:api}},[cli,guard]=options.plugins;
      const config={plugins:[sdk],root:process.cwd(),publicDir:false,build:{outDir:'dist/frontend'}};
      await cli.config.handler(config);config.build.outDir=output;cli.configResolved(config);guard.outputOptions.handler({dir:output});fs.writeFileSync('session-path',output);
      const emit=value=>{
        const parts={};files=[];
        for(const locale of ['en','ko','zh']){
          const body=JSON.stringify({'sample.title':value}),hash=crypto.createHash('sha256').update(body).digest('hex');
          const name='i18n/v1/'+locale+'/shared-'+hash+'.json';fs.mkdirSync(path.dirname(path.join(output,name)),{recursive:true});
          fs.writeFileSync(path.join(output,name),body);parts[locale]=name;files.push(name);
        }
        const index=JSON.stringify({version:1,app_key:'sample',locales:['en','ko','zh'],registration:['shared'],scopes:{'route:Overview':['shared']},parts:{shared:parts}});
        const name='i18n/v1/index-'+crypto.createHash('sha256').update(index).digest('hex')+'.json';
        fs.writeFileSync(path.join(output,name),index);files.push(name);fs.writeFileSync(path.join(output,'index.js'),value);
        fs.writeFileSync(path.join(output,'nexia-host.json'),JSON.stringify({version:1,app_key:'sample',styles:[],translation_partitions:{version:1,index:name}}));
        guard.writeBundle.handler({},Object.fromEntries(files.map(name=>[name,{}])));
      };
      const watcher=new EventEmitter();const timer=setTimeout(async()=>{
        try {
          watcher.emit('event',{code:'START'});await cli.buildStart.handler();emit('first');
          ${failed ? "watcher.emit('event',{code:'ERROR',error:Error('failed after write')});" : ''}
          watcher.emit('event',{code:'END'});
          watcher.emit('event',{code:'START'});await Promise.all([cli.buildStart.handler(),wait()]);emit('second');watcher.emit('event',{code:'END'});
        }catch(error){watcher.emit('event',{code:'ERROR',error});watcher.emit('event',{code:'END'})}
      },30);
      watcher.close=async()=>clearTimeout(timer);return watcher;
    };
  `);
  const build = await startFrontendBuild(root, { log: () => {} });
  try {
    await waitFor(() => build.ready(), 'second generation');
    const session = await readFile(path.join(root, 'session-path'), 'utf8');
    assert.equal((await readdir(path.join(session, 'i18n/v1/ko'))).length, 1);
    assert.equal(await readFile(path.join(root, 'dist/frontend-generations', build.snapshot(), 'index.js'), 'utf8'), 'second');
  } finally { await build.close(); }
});

test('session assets reject collisions, modified bytes and symlinks without touching outside files', async t => {
  const parent = await mkdtemp(path.join(tmpdir(), 'nexia-session-path-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = await realpath(parent);
  const info = await lstat(root);
  const session = { root, dev: info.dev, ino: info.ino };
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const files = [];
  const parts = { shared: {} };
  for (const locale of ['en', 'ko', 'zh']) {
    const bytes = JSON.stringify({ 'sample.key': locale });
    const name = `i18n/v1/${locale}/shared-${hash(bytes)}.json`;
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), bytes);
    parts.shared[locale] = name; files.push(name);
  }
  const index = JSON.stringify({ version: 1, app_key: 'sample', locales: ['en', 'ko', 'zh'], registration: ['shared'], scopes: { 'route:Overview': ['shared'] }, parts });
  const indexName = `i18n/v1/index-${hash(index)}.json`;
  await writeFile(path.join(root, indexName), index); files.push(indexName);
  await writeFile(path.join(root, 'nexia-host.json'), JSON.stringify({ version: 1, app_key: 'sample', translation_partitions: { version: 1, index: indexName } }));
  const sdk = { generatedFiles: () => [...files] };
  assert.deepEqual(new Set(await validateSessionAssets(session, sdk, files)), new Set(files));
  await assert.rejects(validateSessionAssets(session, sdk, [...files, 'i18n/v1/unowned.json']), /collision/);
  const owned = path.join(root, parts.shared.ko), outside = path.join(root, 'outside.txt');
  await writeFile(outside, 'user-owned');
  await writeFile(owned, 'changed');
  await assert.rejects(removeSessionAssets(session, files), /changed before cleanup/);
  assert.equal(await readFile(owned, 'utf8'), 'changed');
  await rm(owned); await symlink(outside, owned);
  await assert.rejects(validateSessionAssets(session, sdk, files), /Linked or mounted/);
  await assert.rejects(removeSessionAssets(session, files), /Linked or mounted/);
  await assert.rejects(removeSession(session), /Unsafe frontend session contents/);
  assert.equal(await readFile(outside, 'utf8'), 'user-owned');
});

test('missing partial files are tolerated only while the original session root exists', async t => {
  const parent = await mkdtemp(path.join(tmpdir(), 'nexia-session-missing-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = await realpath(parent), info = await lstat(root);
  const session = { root, dev: info.dev, ino: info.ino };
  const name = `i18n/v1/ko/part-${'a'.repeat(64)}.json`;
  await assert.rejects(removeSessionAssets(session, [name]), /ENOENT/);
  assert.equal(await removeSessionAssets(session, [name], { allowMissing: true }), true);
  await rm(root, { recursive: true });
  await assert.rejects(removeSessionAssets(session, [name], { allowMissing: true }), /ENOENT/);
});

for (const hangs of [false, true]) test(`shutdown retains a ${hangs ? 'stalled' : 'starting'} session`, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-session-startup-'));
  let session;
  t.after(async () => { if (session) await rm(session, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); });
  const viteDir = path.join(root, 'node_modules/vite/dist/node');
  await mkdir(viteDir, { recursive: true });
  await mkdir(path.join(root, 'resources'), { recursive: true });
  await writeFile(path.join(root, 'vite.config.mjs'), 'export default {}');
  await writeFile(path.join(viteDir, 'index.js'), `
    const fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events');
    exports.build=async options=>{
      let out;const api={version:1,acceptSession(x){out=x.outDir},generatedFiles(){return []},candidateFiles(){return []}};
      const sdk={name:'nexia:app-services',api:{nexiaTranslationSession:api}};
      await options.plugins[0].config.handler({plugins:[sdk]});fs.writeFileSync('session-path',out);
      const fd=fs.openSync(path.join(out,'held-open.txt'),'w');
      await ${hangs ? 'new Promise(()=>{})' : 'new Promise(resolve=>setTimeout(resolve,250))'};
      fs.closeSync(fd);fs.writeFileSync('startup-finished','yes');const watcher=new EventEmitter();watcher.close=async()=>{};return watcher;
    };
  `);
  const build = await startFrontendBuild(root, { log: () => {} });
  try {
    await waitFor(async () => { try { session = await readFile(path.join(root, 'session-path'), 'utf8'); return true; } catch { return false; } }, 'session allocation');
    await build.close();
    assert.equal(await readFile(path.join(session, 'held-open.txt'), 'utf8'), '');
    await assert.rejects(lstat(path.join(root, 'startup-finished')), /ENOENT/);
  } finally { await build.close(); }
});
