import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
test('CLI owns prompts and delegates existing generator flags without reading login', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-generator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'), app = path.join(root, 'app with spaces');
  await mkdir(bin); await mkdir(app);
  const log = path.join(root, 'arguments.json');
  await writeFile(path.join(bin, 'php'), `#!${process.execPath}\nimport('node:fs').then(fs => fs.appendFileSync(process.env.GENERATOR_LOG, JSON.stringify(process.argv.slice(2)) + '\\n'));\n`, { mode: 0o755 });
  await writeFile(path.join(bin, 'nexia-app'), '<?php // independent fixture', { mode: 0o755 });
  await writeFile(path.join(app, 'nexia.json'), JSON.stringify({ schema_version: '2', runtime: 'laravel', app: { app_key: 'sample' } }));
  const invoke = (args, toolPath = bin, cwd = app) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, PATH: `${toolPath}${path.delimiter}${bin}`, GENERATOR_LOG: log, NEXIA_CONFIG_HOME: path.join(root, 'config') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject); child.once('close', code => resolve({ code, output }));
  });
  await mkdir(path.join(root, 'config'));
  const expired = JSON.stringify({ endpoint: 'http://localhost:1', token: 'expired-fixture-token' });
  await writeFile(path.join(root, 'config/connection.json'), expired);
  let result = await invoke(['make', 'page', 'Summary', '--label-ko', '요약', '--no-record', '--no-navigation', '--yes']);
  assert.equal(result.code, 0, result.output);
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2, 'preflight must precede writes');
  assert.deepEqual(calls[0].slice(1), ['make:page', await realpath(app), 'Summary', '--label-ko', '요약', '--without-record', '--without-navigation', '--dry-run', '--no-interaction']);
  assert.deepEqual(calls[1].slice(1), ['make:page', await realpath(app), 'Summary', '--label-ko', '요약', '--without-record', '--without-navigation', '--no-interaction']);
  assert.equal(await readFile(path.join(root, 'config/connection.json'), 'utf8'), expired);
  await writeFile(path.join(app, 'nexia-app'), '<?php // must not run', { mode: 0o755 });
  result = await invoke(['make', 'resource', 'Request', '--label-ko', '신청', '--yes'], app);
  assert.equal(result.code, 1); assert.match(result.output, /independently installed/);
  result = await invoke(['make', 'resource', 'Request', '--yes']);
  assert.equal(result.code, 2); assert.match(result.output, /label-ko/);
  result = await invoke(['check']);
  assert.equal(result.code, 0, result.output);
});

test('managed generators install through nexia without global Composer or App scripts', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-managed-generator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const config = path.join(root, 'config');
  const log = path.join(root, 'install.json');
  await mkdir(bin);
  await writeFile(path.join(bin, 'php'), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
  await writeFile(path.join(bin, 'composer'), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.INSTALL_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), home: process.env.COMPOSER_HOME }));
fs.mkdirSync('vendor/bin', { recursive: true });
fs.writeFileSync('vendor/bin/nexia-app', '<?php // installed generator');
fs.writeFileSync('composer.lock', JSON.stringify({ packages: [{ name: 'nexia-cloud-os/devtools', version: '0.1.0' }] }));
`, { mode: 0o755 });
  const invoke = (args, cwd = root) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, PATH: bin, NEXIA_CONFIG_HOME: config, INSTALL_LOG: log }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
  let result = await invoke(['setup', '--devtools', '--dry-run']);
  assert.equal(result.code, 0, result.output);
  await assert.rejects(readFile(log), { code: 'ENOENT' });
  result = await invoke(['setup', '--devtools', '--yes']);
  assert.equal(result.code, 0, result.output);
  const installed = JSON.parse(await readFile(log, 'utf8'));
  assert.deepEqual(installed.args, ['install', '--no-interaction', '--no-scripts', '--no-plugins', '--prefer-dist']);
  assert.equal(installed.cwd, await realpath(path.join(config, 'tools/devtools')));
  assert.equal(installed.home, path.join(config, 'tools/devtools/composer-home'));
  assert.deepEqual(JSON.parse(await readFile(path.join(installed.cwd, 'composer.json'), 'utf8')).config, { 'allow-plugins': false });
  const manifestPath = path.join(installed.cwd, 'composer.json');
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).require['nexia-cloud-os/devtools'], '^0.2');
  await writeFile(manifestPath, JSON.stringify({ require: { 'nexia/app-devtools': '*', 'example/keep': '^1' }, config: { 'allow-plugins': false } }));
  result = await invoke(['setup', '--devtools', '--yes']);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')).require, { 'nexia-cloud-os/devtools': '^0.2', 'example/keep': '^1' });
  assert.deepEqual(JSON.parse(await readFile(log, 'utf8')).args.slice(0, 4), ['update', 'nexia-cloud-os/devtools', '--with-all-dependencies', '--minimal-changes']);
  // Upgrade the CLI-managed default from the previous generator line.
  await writeFile(manifestPath, JSON.stringify({ require: { 'nexia-cloud-os/devtools': '^0.1', 'example/keep': '^1' } }));
  result = await invoke(['setup', '--devtools', '--yes']);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')).require, { 'nexia-cloud-os/devtools': '^0.2', 'example/keep': '^1' });
  // A second setup updates the existing lock; it does not silently reinstall the old version.
  result = await invoke(['setup', '--devtools', '--yes']);
  assert.equal(result.code, 0, result.output);
  assert.equal(JSON.parse(await readFile(log, 'utf8')).args[0], 'update');
  for (const oldName of ['nexia/devtools', 'nexia/app-devtools']) {
    await writeFile(manifestPath, JSON.stringify({ require: { [oldName]: '*', 'example/keep': '^1' }, config: { 'allow-plugins': false } }));
    await writeFile(path.join(installed.cwd, 'composer.lock'), JSON.stringify({ packages: [{ name: oldName, version: '0.1.0' }] }));
    result = await invoke(['setup', '--devtools', '--yes']);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')).require, { 'nexia-cloud-os/devtools': '^0.2', 'example/keep': '^1' });
    assert.deepEqual(JSON.parse(await readFile(log, 'utf8')).args.slice(0, 5), ['update', 'nexia-cloud-os/devtools', oldName, '--with-all-dependencies', '--minimal-changes']);
  }
  // An explicit supported pin is preserved during name migration.
  await writeFile(manifestPath, JSON.stringify({ require: { 'nexia/devtools': '0.1.0' } }));
  result = await invoke(['setup', '--devtools', '--yes']);
  assert.equal(result.code, 0, result.output);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).require['nexia-cloud-os/devtools'], '0.1.0');
  await writeFile(path.join(installed.cwd, 'composer.lock'), '{broken');
  const lastInstall = await readFile(log, 'utf8');
  result = await invoke(['setup', '--devtools', '--yes']);
  assert.equal(result.code, 1);
  assert.equal(await readFile(log, 'utf8'), lastInstall, 'Invalid locks must not be ignored');
  await writeFile(path.join(root, 'nexia.json'), JSON.stringify({ schema_version: '2', runtime: 'laravel' }));
  result = await invoke(['make', 'page', 'Summary', '--label-ko', '요약', '--yes']);
  assert.equal(result.code, 1, 'A tool located inside the App is rejected even when its path is managed');
  const app = await mkdtemp(path.join(tmpdir(), 'nexia-managed-app-'));
  t.after(() => rm(app, { recursive: true, force: true }));
  await writeFile(path.join(app, 'nexia.json'), JSON.stringify({ schema_version: '2', runtime: 'laravel' }));
  result = await invoke(['make', 'page', 'Summary', '--label-ko', '요약', '--yes'], app);
  assert.equal(result.code, 0, result.output);
});
