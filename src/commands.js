// Public command vocabulary. PHP generator command names remain implementation details.
export const commands = {
  setup: { description: ['Prepare PHP, Composer and App generators', 'PHP·Composer와 앱 생성 도구 준비'], options: ['devtools', 'dry-run', 'yes'] },
  'create project': { argument: 'directory', description: ['Create and connect a project', '프로젝트 생성·연결'], options: ['name', 'no-browser', 'yes'] },
  'create app': { argument: 'directory', description: ['Create a PHP/React App', 'PHP/React 앱 생성'], options: ['name', 'vendor', 'family', 'key', 'display-name', 'table-prefix', 'prerequisite', 'dry-run', 'yes'] },
  connect: { argument: 'project-id', description: ['Connect this folder to a project', '현재 폴더를 프로젝트에 연결'], options: ['no-browser', 'yes'] },
  login: { argument: 'project-id', description: ['Authenticate for a project without changing folder bindings', '폴더 연결을 바꾸지 않고 프로젝트 인증'], options: ['no-browser'] },
  logout: { description: ['Revoke CLI authentication; retain folder bindings', 'CLI 인증 해제·폴더 연결 유지'], options: ['yes'] },
  'make resource': { argument: 'name', description: ['Generate a resource in an App', '앱에 리소스 생성'], options: ['app', 'label-ko', 'label-ko-plural', 'label-zh', 'label-zh-plural', 'record-owner', 'navigation', 'navigation-group', 'navigation-subgroup', 'icon', 'sort', 'dry-run', 'yes'] },
  'make page': { argument: 'name', description: ['Generate a business page in an App', '앱에 업무 페이지 생성'], options: ['app', 'label-ko', 'record', 'navigation', 'navigation-group', 'sort', 'dry-run', 'yes'] },
  dev: { description: ['Develop every App in the project; --app selects one', '프로젝트 전체 앱 개발·--app으로 하나 선택'], options: ['app', 'port', 'container'] },
  check: { description: ['Check this App, or all Apps from the project root', '현재 앱 또는 프로젝트 루트의 전체 앱 검사'], options: ['app'] },
  status: { description: ['Show authentication, project and sandbox status', '인증·프로젝트·샌드박스 상태 조회'], options: ['json'] },
  'db migrate': { description: ['Request an App sandbox migration', '앱 샌드박스 마이그레이션 요청'], options: ['app', 'request-id', 'json', 'yes'] },
  'db seed': { argument: 'key', description: ['Run declared development data for this App', '현재 앱의 선언된 개발 데이터 실행'], options: ['app', 'request-id', 'json', 'yes'] },
  'db status': { description: ['Inspect the App database operation', '앱 DB 작업 상태 조회'], options: ['app', 'json'] },
  submit: { description: ['Submit an existing Git tag for review', '기존 Git 태그를 심사에 제출'], options: ['app', 'tag', 'request-id', 'no-browser', 'json', 'yes'] },
  'submit status': { argument: 'submission-id', description: ['Inspect a submission', '제출 상태 조회'], options: ['json'] },
  'submit cancel': { argument: 'submission-id', description: ['Cancel a cancellable submission', '취소 가능한 제출 취소'], options: ['json', 'yes'] },
  'submit retry': { argument: 'submission-id', description: ['Retry a retryable submission', '재시도 가능한 제출 재요청'], options: ['json', 'yes'] },
};
export const groups = { create: ['project', 'app'], make: ['resource', 'page'], db: ['migrate', 'seed', 'status'] };
export const booleanOptions = new Set(['help', 'version', 'no-interactive', 'yes', 'json', 'dry-run', 'no-browser', 'devtools', 'container', 'navigation', 'record']);
export const optionDescriptions = {
  app: 'App folder name or key / 앱 폴더명 또는 식별자', name: 'Project display name or App code name / 프로젝트 표시 이름 또는 앱 코드 이름',
  vendor: 'Composer/npm package owner / 패키지 소유자', family: 'App navigation family / 앱 기능 그룹', key: 'Stable App key / 앱 식별자',
  'display-name': 'App display name / 앱 표시 이름', 'table-prefix': 'Database table prefix / 테이블 접두사', prerequisite: 'Required App key (repeatable) / 필수 선행 앱 (반복 가능)',
  'label-ko': 'Authored Korean label (required) / 한국어 표시 이름 (필수)', 'label-ko-plural': 'Korean list label / 한국어 목록 이름',
  'label-zh': 'Chinese label; omitted uses English fallback / 중국어 이름·생략 시 영어 fallback', 'label-zh-plural': 'Chinese list label / 중국어 목록 이름',
  'record-owner': 'legal_entity or tenant / 법인별 또는 테넌트 공통', navigation: 'Publish a menu entry / 메뉴 표시', record: 'Include record read/edit screens / 개별 항목 조회·수정 화면 포함',
  'navigation-group': 'insights, management, operations, master-data, settings', 'navigation-subgroup': 'Optional menu subgroup / 메뉴 하위 그룹',
  icon: 'Shell icon name / 아이콘 이름', sort: 'Menu order; resource default auto / 메뉴 순서·리소스 기본 auto', port: 'Local preview port (4310) / 로컬 포트',
  container: 'Listen for container development / 컨테이너 개발', tag: 'Existing version tag, e.g. v1.0.0 / 기존 버전 태그', 'request-id': 'UUID for recovering the same request / 동일 요청 복구용 UUID',
  'no-browser': 'Print the approval URL without opening a browser / 승인 URL만 출력', devtools: 'Install generators only / 생성 도구만 설치',
  'dry-run': 'Show the plan without writing / 변경 계획만 표시', yes: 'Accept final confirmation, not missing input / 최종 확인 생략',
  json: 'JSON result on stdout; no prompts / 표준 출력은 JSON·질문 없음', 'no-interactive': 'Never prompt; missing required values fail / 질문 없이 실행',
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
    if (Object.hasOwn(options, key) && key !== 'prerequisite') throw new InputError(`Do not repeat or contradict --${key}.`);
    options[key] = key === 'prerequisite' ? [...(options[key] || []), value] : value;
  }
  if (words[0] === 'help') { words.shift(); options.help = true; }
  if (Object.hasOwn(retired, words[0])) throw new InputError(`Use nexia ${retired[words[0]]}. ${words[0]} is no longer a command.`);
  let name = words.shift() || '';
  if (Object.hasOwn(groups, name) && words.length) name += ` ${words.shift()}`;
  else if (name === 'submit' && words.length) name += ` ${words.shift()}`;
  if (name && !Object.hasOwn(commands, name) && !Object.hasOwn(groups, name)) throw new InputError(`Unknown command: ${name}. Run nexia help.`);
  const definition = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (definition && words.length > (definition.argument ? 1 : 0)) throw new InputError(`Use nexia ${name}${definition.argument ? ` [${definition.argument}]` : ''}. Run from the intended folder; use --app to select an App.`);
  if (options.version && (name || Object.keys(options).length > 1)) throw new InputError('Use nexia --version.');
  if (definition) validateOptions(name, options);
  else if (!Object.hasOwn(groups, name) && Object.keys(options).some(key => !['help', 'version'].includes(key))) throw new InputError('Choose a command first. Run nexia help.');
  return { name, argument: words[0], options };
}
export function validateOptions(name, options) {
  const allowed = [...commands[name].options, 'help', 'no-interactive'];
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new InputError(`--${key} is not supported by nexia ${name}.`);
  if (options.navigation === false && ['navigation-group', 'navigation-subgroup', 'icon', 'sort'].some(key => Object.hasOwn(options, key))) throw new InputError('Menu options cannot be combined with --no-navigation.');
  if (options['label-zh-plural'] && !options['label-zh']) throw new InputError('--label-zh-plural requires --label-zh.');
}
export function helpText(name = '', language = 'en') {
  const index = language === 'ko' ? 1 : 0, definition = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (definition) return [`nexia ${name}${definition.argument ? ` [${definition.argument}]` : ''}`, definition.description[index], '', ...[...definition.options, 'no-interactive', 'help'].map(key => `  --${key}${['navigation', 'record'].includes(key) ? ` / --no-${key}` : booleanOptions.has(key) ? '' : ' <value>'}  ${optionDescriptions[key] || 'Show help / 도움말'}`), '', 'Options skip matching questions. Run from an App or its project.'].join('\n');
  const names = Object.hasOwn(groups, name) ? groups[name].map(child => `${name} ${child}`) : Object.keys(commands);
  return ['Nexia', '', ...names.map(key => `  ${key.padEnd(22)} ${commands[key].description[index]}`), '', 'nexia help <command>    nexia --version', index ? '옵션을 생략하면 단계별로 질문합니다. SSO·프로필은 지원하지 않습니다.' : 'Omit values for step-by-step questions. SSO and profiles are not supported.'].join('\n');
}
