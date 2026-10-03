import path from 'node:path';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { discoverApps, findWorkspace } from './workspace.js';
import { InputError } from './commands.js';
import { message } from './input.js';

export const isKey = value => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) && value.length <= 63;
export const isClass = value => /^[A-Z][A-Za-z0-9]*$/.test(value);
export const isUuid = value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const label = value => value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value);
const kebab = value => value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const studly = value => value.split(/[-_ ]+/).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');

export async function findApp(directory = process.cwd()) {
  for (let root = await realpath(directory);;) {
    try {
      const file = path.join(root, 'nexia.json');
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new InputError('Use a regular nexia.json file.');
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      if (manifest.schema_version !== '2' || manifest.runtime !== 'laravel') throw new InputError('This CLI supports PHP/React Apps with nexia.json version 2.');
      return root;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}
export async function appTargets(options, input, { all = false } = {}) {
  const cwd = await realpath(process.cwd()), workspace = await findWorkspace(cwd), current = await findApp(cwd);
  if (!workspace) {
    if (options.app) throw new InputError('--app requires a connected project. Run nexia connect from the project folder.');
    if (current) return [current];
    throw new InputError('Run inside an App or connected project. Start with nexia create or nexia connect.');
  }
  const { apps, errors } = await discoverApps(workspace.root);
  const problems = errors.map(item => `${item.directory}: ${item.message}`).join('\n');
  if (options.app) {
    const matches = apps.filter(app => app.key === options.app || app.name === options.app);
    if (matches.length !== 1) throw new InputError(`Choose one App: ${apps.map(app => app.name).join(', ')}`);
    return [matches[0].directory];
  }
  if (current) {
    if (!apps.some(app => app.directory === current)) throw new InputError(problems || 'This App must be an immediate project child with a unique key.');
    return [current];
  }
  if (all && cwd === workspace.root) {
    if (problems) throw new InputError(problems);
    if (apps.length) return apps.map(app => app.directory);
  }
  if (apps.length === 1) return [apps[0].directory];
  if (!apps.length) throw new InputError('No Apps found. Run nexia create app.');
  const selection = await input.choice('app', message('Choose an App', '앱을 선택하세요'), apps.map(app => ({ value: app.name, label: `${app.manifest.app.app_name || app.key} (${app.name})` })));
  return [apps.find(app => app.name === selection).directory];
}

export async function appPlan(argument, options, input) {
  const workspace = await findWorkspace(process.cwd());
  if (!workspace && await findApp()) throw new InputError('Create Apps from a project folder, not inside another App.');
  const folder = await input.text('directory', message('App folder (created directly inside the project)', '앱 폴더 (프로젝트 바로 아래에 생성)'), { value: argument, hint: 'nexia create app <directory>', required: true, validate: value => isKey(value) });
  const directory = path.resolve(workspace?.root || process.cwd(), folder);
  try { await lstat(directory); throw new InputError(`Destination already exists: ${directory}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const values = {};
  values.name = await input.text('name', message('Code name (PHP class, e.g. People)', '코드 이름 (PHP 클래스, 예: People)'), { defaultValue: studly(folder), required: true, validate: isClass });
  values.vendor = await input.text('vendor', message('Package owner (Composer/npm vendor, e.g. acme)', '패키지 소유자 (Composer/npm vendor, 예: acme)'), { required: true, validate: isKey });
  values.key = await input.text('key', message('Stable App key', '앱 식별자'), { defaultValue: kebab(values.name), required: true, validate: isKey });
  values['display-name'] = await input.text('display-name', message('App display name', '앱 표시 이름'), { defaultValue: values.name, required: true, validate: label });
  values.family = await input.text('family', message('Navigation family (e.g. people)', '메뉴 기능 그룹 (예: people)'), { required: true, validate: isKey });
  values['table-prefix'] = await input.text('table-prefix', message('Database table prefix', 'DB 테이블 접두사'), { defaultValue: values.key.replaceAll('-', '_'), required: true, validate: value => /^[a-z][a-z0-9_]*$/.test(value) && value.length <= 63 });
  const prerequisites = await input.text('prerequisite', message('Required App keys (comma-separated; empty for none)', '필수 선행 앱 식별자 (쉼표 구분·없으면 Enter)'), { value: options.prerequisite?.join(','), validate: value => value.split(',').every(item => isKey(item.trim()) && item.trim() !== values.key) });
  values.prerequisite = prerequisites ? [...new Set(prerequisites.split(',').map(item => item.trim()))] : [];
  return { directory, values };
}

export async function generatorPlan(kind, argument, options, input, selectedDirectory) {
  const directory = selectedDirectory || (await appTargets(options, input))[0];
  const name = await input.text('name', message('Code name (PascalCase, e.g. LeaveRequest)', '코드 이름 (PascalCase, 예: LeaveRequest)'), { value: argument, hint: `nexia make ${kind} <name>`, required: true, validate: isClass });
  const values = {};
  values['label-ko'] = await input.text('label-ko', message('Korean display name (authored translation required)', '한국어 표시 이름'), { required: true, validate: label });
  if (kind === 'resource') {
    values['label-ko-plural'] = await input.text('label-ko-plural', message('Korean list/menu name', '한국어 목록·메뉴 이름'), { defaultValue: values['label-ko'], required: true, validate: label });
    if (options['label-zh'] !== undefined || await input.boolean('chinese', message('Add Chinese display names? Otherwise use the existing English fallback.', '중국어 표시 이름을 추가할까요? 생략하면 기존 영어 fallback을 사용합니다.'), false)) {
      values['label-zh'] = await input.text('label-zh', message('Chinese display name', '중국어 표시 이름'), { required: true, validate: label });
      values['label-zh-plural'] = await input.text('label-zh-plural', message('Chinese list/menu name', '중국어 목록·메뉴 이름'), { defaultValue: values['label-zh'], required: true, validate: label });
    }
    values['record-owner'] = await input.choice('record-owner', message('Data ownership (access permissions are separate)', '데이터 소유 범위 (접근 권한은 별도)'), [
      { value: 'legal_entity', label: message('Per legal entity', '법인별') }, { value: 'tenant', label: message('Tenant-wide', '테넌트 공통') },
    ], 'legal_entity');
  } else values.record = await input.boolean('record', message('Include individual record read/edit screens?', '개별 항목 조회·수정 화면도 만들까요?'), true);
  values.navigation = await input.boolean('navigation', message('Show in the App menu?', '앱 메뉴에 표시할까요?'), true);
  if (values.navigation) {
    values['navigation-group'] = await input.choice('navigation-group', message('Menu group', '메뉴 그룹'), ['insights', 'management', 'operations', 'master-data', 'settings'], 'operations');
    if (kind === 'resource') {
      values['navigation-subgroup'] = await input.text('navigation-subgroup', message('Menu subgroup (optional)', '메뉴 하위 그룹 (선택)'), { validate: isKey });
      values.icon = await input.text('icon', message('Icon', '아이콘'), { defaultValue: 'box', required: true, validate: isKey });
    }
    values.sort = await input.text('sort', message('Menu order (resource: auto keeps the next available position)', '메뉴 순서 (리소스: auto는 다음 순서를 자동 선택)'), { defaultValue: kind === 'resource' ? 'auto' : '100', validate: value => (kind === 'resource' && value === 'auto') || (kind === 'resource' ? /^-?\d{1,6}$/ : /^\d{1,6}$/).test(value) });
  }
  return { directory, name, values };
}
export function generatorArguments(kind, plan, { dryRun = false } = {}) {
  const args = [`make:${kind}`, plan.directory, plan.name];
  for (const [key, value] of Object.entries(plan.values)) {
    if (['navigation', 'record'].includes(key)) { if (!value) args.push(`--without-${key}`); }
    else if (value !== '' && !(key === 'sort' && value === 'auto')) args.push(`--${key}`, String(value));
  }
  if (dryRun) args.push('--dry-run');
  return args;
}
export function planSummary(title, plan) {
  const lines = Object.entries(plan.values).map(([key, value]) => {
    const display = Array.isArray(value) ? value.join(', ') : String(value);
    return `  ${key}: ${display || '—'}`;
  });
  return [title, `  ${plan.directory}`, ...(plan.name ? [`  ${plan.name}`] : []), ...lines].join('\n');
}
