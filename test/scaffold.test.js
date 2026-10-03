import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bindWorkspace } from '../src/workspace.js';
import { appTargets, appPlan, generatorPlan } from '../src/scaffold.js';
import { createInput } from '../src/input.js';

test('App subdirectories resolve locally, project checks cover all, and ambiguous mutations fail without prompts', async t => {
  const previous = process.cwd(), root = await realpath(await mkdtemp(path.join(tmpdir(), 'nexia-targets-')));
  t.after(async () => { process.chdir(previous); await rm(root, { recursive: true, force: true }); });
  await bindWorkspace(root, { endpoint: 'https://example.test', project: { id: '11111111-1111-4111-8111-111111111111', name: 'Example' } });
  for (const key of ['people', 'payroll']) {
    const directory = path.join(root, key);
    await mkdir(path.join(directory, 'src'), { recursive: true });
    await writeFile(path.join(directory, 'nexia.json'), JSON.stringify({ schema_version: '2', runtime: 'laravel', app: { app_key: key } }));
    await writeFile(path.join(directory, 'composer.json'), JSON.stringify({ name: `example/${key}` }));
  }
  const options = { 'no-interactive': true }, input = createInput(options);
  process.chdir(root);
  await assert.rejects(appTargets(options, input), /--app/);
  assert.equal((await appTargets(options, input, { all: true })).length, 2);
  assert.deepEqual(await appTargets({ ...options, app: 'payroll' }, input), [path.join(root, 'payroll')]);
  process.chdir(path.join(root, 'people/src'));
  assert.deepEqual(await appTargets(options, input), [path.join(root, 'people')]);
  const appOptions = { ...options, vendor: 'example', family: 'people' };
  const plan = await appPlan('benefits', appOptions, createInput(appOptions));
  assert.equal(plan.directory, path.join(root, 'benefits'));
  assert.equal(plan.values['table-prefix'], 'benefits');
  await assert.rejects(appPlan('people', appOptions, createInput(appOptions)), /already exists/);
});

test('menu-off creation asks no menu settings and supplied labels are not repeated', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nexia-questions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const questions = [];
  const options = { 'label-ko': '신청', 'label-ko-plural': '신청 목록', 'label-zh': '申请', 'label-zh-plural': '申请', 'record-owner': 'tenant', navigation: false };
  const input = createInput(options, { input: { isTTY: true }, output: { isTTY: true, write() {} }, ask: async question => { questions.push(question); throw new Error('Unexpected question'); } });
  const plan = await generatorPlan('resource', 'Request', options, input, root);
  assert.deepEqual(questions, []);
  assert.equal(plan.values.navigation, false);
  assert.equal(Object.hasOwn(plan.values, 'sort'), false);
});
