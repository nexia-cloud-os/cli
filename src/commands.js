import { paint } from './terminal.js';
// Public command vocabulary. PHP generator command names remain implementation details.
export const commands = {
  update: { description: ['Update the CLI from npm (alpha)', 'npm에서 CLI 업데이트 (alpha)'], options: ['dry-run', 'yes'] },
  docs: { description: ['Read the App development starting guide', '앱 개발 시작 가이드 읽기'], options: ['locale', 'json'] },
  'docs search': { argument: 'query', description: ['Search public developer documentation', '공개 개발 문서 검색'], options: ['locale', 'json'] },
  'docs read': { argument: 'document-id', description: ['Read a public document as Markdown', '공개 문서를 Markdown으로 읽기'], options: ['locale', 'json'] },
  setup: { description: ['Prepare PHP, Composer and App generators', 'PHP·Composer와 앱 생성 도구 준비'], options: ['devtools', 'dry-run', 'yes'] },
  'create project': { argument: 'directory', description: ['Create and connect a project', '프로젝트 생성·연결'], options: ['name', 'no-browser', 'yes'] },
  'create app': { argument: 'directory', description: ['Create a PHP/React App', 'PHP/React 앱 생성'], options: ['name', 'vendor', 'family', 'key', 'display-name', 'table-prefix', 'prerequisite', 'dry-run', 'yes'] },
  connect: { argument: 'project-id', description: ['Connect this folder to a project', '현재 폴더를 프로젝트에 연결'], options: ['no-browser', 'yes'] },
  login: { argument: 'project-id', description: ['Sign in again for the connected project', '연결된 프로젝트에 다시 로그인'], options: ['no-browser'] },
  logout: { description: ['Sign out of the CLI; keep project and sandbox data', 'CLI 로그아웃·프로젝트와 샌드박스 데이터 보존'], options: ['yes'] },
  'make resource': { argument: 'name', description: ['Generate a resource in an App', '앱에 리소스 생성'], options: ['app', 'label-ko', 'label-ko-plural', 'label-zh', 'label-zh-plural', 'record-owner', 'navigation', 'navigation-group', 'navigation-subgroup', 'icon', 'sort', 'dry-run', 'yes'] },
  'make page': { argument: 'name', description: ['Generate a business page in an App', '앱에 업무 페이지 생성'], options: ['app', 'label-ko', 'record', 'navigation', 'navigation-group', 'sort', 'dry-run', 'yes'] },
  dev: { description: ['Choose All Apps, configured Apps, or individual Apps (up to 20)', '전체·Config 설정·개별 앱 선택 (최대 20개)'], options: ['app', 'port', 'container', 'verbose'] },
  'dev config': { description: ['Config Apps: save the default development selection', 'Config Apps: 기본 개발 앱 선택 저장'], options: ['app', 'yes'] },
  check: { description: ['Check this App, or all Apps from the project root', '현재 앱 또는 프로젝트 루트의 전체 앱 검사'], options: ['app'] },
  ps: { description: ['List local development sessions, ports and Apps', '로컬 개발 세션·포트·앱 조회'], options: ['json'] },
  stop: { description: ['Stop local development for this project; retain sandbox data', '현재 프로젝트의 로컬 개발 종료·샌드박스 데이터 보존'], options: ['port', 'json'] },
  status: { description: ['Show authentication, project and sandbox status', '인증·프로젝트·샌드박스 상태 조회'], options: ['json'] },
  'db migrate': { description: ['Request an App sandbox migration', '앱 샌드박스 마이그레이션 요청'], options: ['app', 'request-id', 'json', 'yes'] },
  'db seed': { argument: 'key', description: ['Run declared development data for this App', '현재 앱의 선언된 개발 데이터 실행'], options: ['app', 'request-id', 'json', 'yes'] },
  'db status': { description: ['Inspect the App database operation', '앱 DB 작업 상태 조회'], options: ['app', 'json'] },
  submit: { description: ['Submit an existing Git tag for review', '기존 Git 태그를 심사에 제출'], options: ['app', 'tag', 'request-id', 'no-browser', 'json', 'yes'] },
  'submit list': { description: ['List recent submissions for this project or App', '현재 프로젝트 또는 앱의 최근 제출 목록'], options: ['page', 'json'] },
  'submit status': { argument: 'submission-id', description: ['Choose a recent submission or inspect an ID', '최근 제출 선택 또는 ID로 상태 조회'], options: ['json'] },
  'submit cancel': { argument: 'submission-id', description: ['Cancel a cancellable submission', '취소 가능한 제출 취소'], options: ['json', 'yes'] },
  'submit retry': { argument: 'submission-id', description: ['Retry a retryable submission', '재시도 가능한 제출 재요청'], options: ['json', 'yes'] },
};
export const groups = { create: ['project', 'app'], make: ['resource', 'page'], db: ['migrate', 'seed', 'status'] };
export const booleanOptions = new Set(['help', 'version', 'no-interactive', 'yes', 'json', 'dry-run', 'no-browser', 'devtools', 'container', 'verbose', 'navigation', 'record']);
export const optionDescriptions = {
  page: 'Recent submission page (20 per page)',
  locale: 'Document language: en or ko (default: en)',
  app: 'App folder name or key', name: 'Project display name or App code name',
  vendor: 'Composer/npm package owner', family: 'App navigation family', key: 'Stable App key',
  'display-name': 'App display name', 'table-prefix': 'Database table prefix', prerequisite: 'Required App key (repeatable)',
  'label-ko': 'Authored Korean label (required)', 'label-ko-plural': 'Korean list label',
  'label-zh': 'Chinese label; omitted uses English fallback', 'label-zh-plural': 'Chinese list label',
  'record-owner': 'legal_entity or tenant', navigation: 'Publish a menu entry', record: 'Include record read/edit screens',
  'navigation-group': 'insights, management, operations, master-data, settings', 'navigation-subgroup': 'Optional menu subgroup',
  icon: 'Shell icon name', sort: 'Menu order; resource default auto', port: 'Local preview port (4310)',
  container: 'Listen for container development', tag: 'Existing version tag, e.g. v1.0.0', 'request-id': 'UUID for recovering the same request',
  'no-browser': 'Print the approval URL without opening a browser', devtools: 'Install generators only',
  'dry-run': 'Show the plan without writing', yes: 'Accept final confirmation, not missing input',
  json: 'JSON result on stdout; no prompts', 'no-interactive': 'Never prompt; missing required values fail',
  verbose: 'Include general development logs',
};
const retired = { init: 'create app', 'create-project': 'create project', 'link-project': 'connect', link: 'connect', validate: 'check', 'make:resource': 'make resource', 'make:page': 'make page', submissions: 'submit status', deploy: 'submit' };
export class InputError extends Error { constructor(message) { super(message); this.code = 'INVALID_INPUT'; this.exitCode = 2; } }
export function parseCommand(argv) {
  const words = [], options = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('-')) { words.push(raw); continue; }
    const normalized = raw === '-h' ? '--help' : raw === '-v' ? '--version' : raw;
    if (!normalized.startsWith('--')) throw new InputError(`Unknown option: ${raw}`);
    const equal = normalized.indexOf('=');
    let key = normalized.slice(2, equal < 0 ? undefined : equal), value;
    const negative = ['no-navigation', 'no-record'].includes(key);
    if (negative) key = key.slice(3);
    const known = booleanOptions.has(key) || Object.values(commands).some(command => command.options.includes(key));
    if (!known) throw new InputError(`Unknown option: --${key}`);
    if (booleanOptions.has(key)) {
      if (equal >= 0) throw new InputError(`--${key} does not take a value.`);
      value = !negative;
    } else {
      value = equal < 0 ? argv[++i] : normalized.slice(equal + 1);
      if (value === undefined || value.startsWith('--') || value.trim() === '') throw new InputError(`--${key} needs a value.`);
    }
    if (Object.hasOwn(options, key) && !['prerequisite', 'app'].includes(key)) throw new InputError(`Do not repeat or contradict --${key}.`);
    options[key] = key === 'prerequisite' ? [...(options[key] || []), value]
      : key === 'app' && options.app !== undefined ? [...[options.app].flat(), value] : value;
  }
  if (words[0] === 'help') { words.shift(); options.help = true; }
  if (Object.hasOwn(retired, words[0])) throw new InputError(`Use nexia ${retired[words[0]]}. ${words[0]} is no longer a command.`);
  let name = words.shift() || '';
  if (Object.hasOwn(groups, name) && words.length) name += ` ${words.shift()}`;
  else if (['submit', 'dev', 'docs'].includes(name) && words.length) name += ` ${words.shift()}`;
  if (name && !Object.hasOwn(commands, name) && !Object.hasOwn(groups, name)) throw new InputError(`Unknown command: ${name}. Run nexia help.`);
  const definition = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (definition && words.length > (definition.argument ? 1 : 0)) throw new InputError(`Use nexia ${name}${definition.argument ? ` [${definition.argument}]` : ''}. Run from the intended folder; use --app to select an App.`);
  if (options.version && (name || Object.keys(options).length > 1)) throw new InputError('Use nexia --version.');
  if (definition) validateOptions(name, options);
  else if (!Object.hasOwn(groups, name) && Object.keys(options).some(key => !['help', 'version'].includes(key))) throw new InputError('Choose a command first. Run nexia help.');
  return { name, argument: words[0], options };
}
export function validateOptions(name, options) {
  if (!['dev', 'dev config'].includes(name) && Array.isArray(options.app)) throw new InputError('Only nexia dev and nexia dev config support repeated --app.');
  const allowed = [...commands[name].options, 'help', 'no-interactive'];
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new InputError(`--${key} is not supported by nexia ${name}.`);
  if (options.navigation === false && ['navigation-group', 'navigation-subgroup', 'icon', 'sort'].some(key => Object.hasOwn(options, key))) throw new InputError('Menu options cannot be combined with --no-navigation.');
  if (options['label-zh-plural'] && !options['label-zh']) throw new InputError('--label-zh-plural requires --label-zh.');
}
export function helpText(name = '') {
  const index = 0, definition = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (name === 'docs') return [
    'nexia docs', commands.docs.description[index], '',
    'nexia docs search "query" [--locale en|ko] [--json]',
    'nexia docs read <document-id> [--locale en|ko] [--json]', '',
    'Read public documentation without login or a project. Defaults to English; use --locale ko for Korean documents.',
  ].join('\n');
  if (definition) return [`nexia ${name}${definition.argument ? ` [${definition.argument}]` : ''}`, definition.description[index], '', ...[...definition.options, 'no-interactive', 'help'].map(key => `  --${key}${['navigation', 'record'].includes(key) ? ` / --no-${key}` : booleanOptions.has(key) ? '' : ' <value>'}  ${optionDescriptions[key] || 'Show help'}`), '', name.startsWith('docs ') ? 'No login or project required. Quote search queries containing spaces.' : 'Options skip matching questions. Run from an App or its project.'].join('\n');
  const sections = name && Object.hasOwn(groups, name)
    ? [{ title: [name, name], names: groups[name].map(child => `${name} ${child}`) }]
    : [
      { title: ['Start & connect', '시작·연결'], names: ['setup', 'update', 'create project', 'connect', 'login', 'logout', 'status'] },
      { title: ['Build & develop', '생성·개발'], names: ['create app', 'make resource', 'make page', 'dev', 'dev config', 'check', 'ps', 'stop'] },
      { title: ['Sandbox database', '샌드박스 데이터'], names: ['db migrate', 'db seed', 'db status'] },
      { title: ['Submit & review', '제출·심사'], names: ['submit', 'submit list', 'submit status', 'submit cancel', 'submit retry'] },
      { title: ['Documentation', '개발 문서'], names: ['docs', 'docs search', 'docs read'] },
    ];
  return [paint('Nexia', 'title'), ...sections.flatMap(section => [
    '', paint(section.title[index], 'title'),
    ...section.names.map(key => process.stdout.columns && process.stdout.columns < 100
      ? `  ${paint(key, 'accent')}\n    ${commands[key].description[index]}`
      : `  ${paint(key.padEnd(24), 'accent')} ${commands[key].description[index]}`),
  ]), '', paint('nexia help <command>    nexia --version', 'muted'),
  'Omit values for guided input. Automation: --no-interactive or --json.'].join('\n');
}
