#!/usr/bin/env node
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, lstat, writeFile } from 'node:fs/promises';
import { setup } from './setup.js';
import { initLaravelApp, runDevtools, installDevtools } from './devtools.js';
import { readConnection, setEndpoint, login, request, saveConnection, validateEndpoint } from './connection.js';
import { repository, submitTag, isVersionTag } from './repository.js';
import { workspaceDev } from './workspace-dev.js';
import { nativeDev } from './native-dev.js';
import { bindWorkspace, findWorkspace, discoverApps } from './workspace.js';
import { commands, groups, parseCommand, validateOptions, helpText, InputError } from './commands.js';
import { Cancelled, createInput, language, message } from './input.js';
import { appTargets, appPlan, generatorPlan, generatorArguments, planSummary, findApp, isUuid } from './scaffold.js';

const exists = file => lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const log = value => console.error(value);
const output = (options, data, text) => console.log(options.json ? JSON.stringify(data) : text);

async function readBinding(directory, name) {
  const folder = path.join(directory, '.nexia'), file = path.join(folder, name);
  for (const target of [folder, file]) {
    const stat = await lstat(target).catch(error => { if (error.code === 'ENOENT') throw new InputError('Run nexia dev in the intended project to register this App first.'); throw error; });
    if (stat.isSymbolicLink() || (target === file && (!stat.isFile() || stat.size > 8192))) throw new InputError('Invalid App binding.');
  }
  return JSON.parse(await readFile(file, 'utf8'));
}
async function databaseBinding(directory) {
  const config = await readConnection();
  const [project, app] = await Promise.all(['project.json', 'app.json'].map(name => readBinding(directory, name)));
  if (!isUuid(project.project_id || '') || !isUuid(app.id || '') || validateEndpoint(project.endpoint) !== validateEndpoint(config.endpoint) || validateEndpoint(app.endpoint) !== validateEndpoint(config.endpoint)) throw new InputError('App binding is invalid.');
  const connection = await request(config, 'connection');
  if (connection.status !== 'connected' || connection.project?.id !== project.project_id) throw new InputError('This App is linked to another project. Run nexia login from its project folder.');
  return { config, app };
}
async function authenticate(projectId, options, workspace) {
  const config = await readConnection();
  const endpoint = workspace?.endpoint || process.env.NEXIA_ENDPOINT || config.endpoint;
  validateEndpoint(endpoint);
  if (endpoint !== config.endpoint) await setEndpoint(endpoint);
  return login(projectId, { log, ...(options['no-browser'] ? { openBrowser: false } : {}) });
}
async function review(input, options, title, makePlan) {
  let plan = await makePlan();
  if (!input.interactive || options.yes || options['dry-run']) {
    await input.confirm(planSummary(title, plan));
    return plan;
  }
  while (true) {
    log(planSummary(title, plan));
    const action = await input.choice('review', message('Review the plan', '내용을 확인하세요'), [
      { value: 'run', label: message('Create', '생성') }, { value: 'edit', label: message('Edit an answer', '답변 수정') }, { value: 'cancel', label: message('Cancel', '취소') },
    ], 'cancel');
    if (action === 'run') return plan;
    if (action === 'cancel') throw new Cancelled();
    const fields = Object.entries(plan.values).filter(([key]) => !(key === 'sort' && plan.values.navigation === false));
    const key = await input.choice('edit-field', message('Which setting?', '수정할 항목'), fields.map(([key, value]) => ({ value: key, label: `${key}: ${value}` })));
    // Keep all answers except the edited field. Re-run the same validators and dependencies.
    const editedOptions = { ...options, chinese: Boolean(plan.values['label-zh']), ...plan.values, ...(plan.name ? { name: plan.name } : {}) };
    delete editedOptions[key];
    if (key === 'navigation') for (const dependent of ['navigation-group', 'navigation-subgroup', 'icon', 'sort']) delete editedOptions[dependent];
    input.setOptions(editedOptions);
    plan = await makePlan(input, editedOptions);
  }
}

let input, parsed;
try {
  parsed = parseCommand(process.argv.slice(2));
  let { name, argument, options } = parsed;
  if (options.version) { const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')); console.log(pkg.version); }
  else if (options.help || !name) console.log(helpText(name, language));
  else {
    input = createInput(options);
    if (groups[name]) {
      const child = await input.choice('command', message('Choose a task', '작업을 선택하세요'), groups[name].map(child => ({ value: child, label: commands[`${name} ${child}`].description[language === 'ko' ? 1 : 0] })), undefined, { hint: `nexia ${name} <${groups[name].join('|')}>` });
      name += ` ${child}`;
      validateOptions(name, options);
    }
    if (name === 'setup') {
      const generatorsOnly = await input.boolean('devtools', message('Install App generators only? Choose No to also install/upgrade PHP and Composer (macOS).', '앱 생성 도구만 설치할까요? 아니요를 선택하면 PHP·Composer도 설치/업그레이드합니다 (macOS).'), false);
      if (!generatorsOnly && process.platform !== 'darwin') throw new InputError('Automatic system installation supports macOS only. Install PHP 8.4+ and Composer, then run nexia setup --devtools.');
      await input.confirm(generatorsOnly ? 'Install/update managed PHP App generators.' : 'Install/upgrade Homebrew PHP and Composer, then install/update managed App generators. Existing runtime versions may change.');
      input.close();
      if (!generatorsOnly) await setup({ dryRun: options['dry-run'] });
      await installDevtools({ dryRun: options['dry-run'] });
    } else if (name === 'create app') {
      let originalArgument = argument;
      const plan = await review(input, options, message('Create App', '앱 생성'), async (editor = input, edited = options) => {
        const result = await appPlan(originalArgument, edited, editor);
        originalArgument = path.basename(result.directory);
        return result;
      });
      input.close();
      await initLaravelApp(plan.directory, { ...plan.values, dryRun: options['dry-run'] });
      console.log(`${options['dry-run'] ? 'Plan' : 'Created'}: ${plan.directory}\nNext: install App dependencies (composer install --no-scripts, npm install), then nexia dev.`);
    } else if (name.startsWith('make ')) {
      const kind = name.split(' ')[1];
      let originalArgument = argument, selectedDirectory;
      const plan = await review(input, options, message(`Create ${kind}`, `${kind} 생성`), async (editor = input, edited = options) => {
        const result = await generatorPlan(kind, originalArgument, edited, editor, selectedDirectory);
        selectedDirectory = result.directory;
        originalArgument = result.name;
        return result;
      });
      input.close();
      const args = generatorArguments(kind, plan);
      // Keep the generator's preflight and existing-file policy before any write.
      await runDevtools([...args, '--dry-run'], plan.directory);
      if (!options['dry-run']) await runDevtools(args, plan.directory);
    } else if (name === 'create project') {
      const folder = await input.text('directory', message('New project folder', '새 프로젝트 폴더'), { value: argument, hint: 'nexia create project <directory>', required: true, validate: value => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) });
      const directory = path.resolve(folder);
      if (await findWorkspace(path.dirname(directory)) || await findApp(path.dirname(directory))) throw new InputError('Do not create a project inside another project or App.');
      if (await exists(directory) && ((await lstat(directory)).isSymbolicLink() || (await readdir(directory)).length)) throw new InputError('Use a new or empty project folder.');
      const projectName = await input.text('name', message('Project display name', '프로젝트 표시 이름'), { defaultValue: path.basename(directory), required: true, validate: value => value.length <= 100 });
      const current = await readConnection(), endpoint = validateEndpoint(process.env.NEXIA_ENDPOINT || current.endpoint);
      await input.confirm(`Create project: ${projectName}\nFolder: ${directory}\nPlatform: ${endpoint}\nBrowser approval is required.`);
      await mkdir(directory, { recursive: true });
      if (endpoint !== current.endpoint) await setEndpoint(endpoint);
      const connected = await login(undefined, { projectName, recoveryKey: directory, log, ...(options['no-browser'] ? { openBrowser: false } : {}) });
      await bindWorkspace(directory, { endpoint: connected.endpoint, project: connected.project });
      if (connected.recoveryFile) await rm(connected.recoveryFile);
      console.log(`Project created: ${connected.project.name}\nNext: cd ${JSON.stringify(directory)}, then nexia create app.`);
    } else if (['connect', 'login'].includes(name)) {
      const workspace = await findWorkspace(process.cwd());
      if (name === 'connect' && (workspace && workspace.root !== process.cwd() || await findApp())) throw new InputError('Run nexia connect from the project root, outside an App.');
      const standalone = !workspace && name === 'login' ? await findApp() : null;
      const appBinding = standalone && await exists(path.join(standalone, '.nexia/project.json')) ? await readBinding(standalone, 'project.json') : null;
      const loginScope = workspace || appBinding;
      const projectId = await input.text('project-id', message('Project ID from Developers', 'Developers의 프로젝트 ID'), { value: argument ?? loginScope?.project_id, hint: `nexia ${name} <project-id>`, required: true, validate: isUuid });
      if (loginScope && projectId !== loginScope.project_id) throw new InputError('This folder belongs to another project. Use a separate project folder.');
      if (name === 'connect') await input.confirm(`Connect folder: ${process.cwd()}\nProject: ${projectId}`);
      const connected = await authenticate(projectId, options, loginScope);
      if (name === 'connect') {
        await bindWorkspace(process.cwd(), { endpoint: connected.endpoint, project: connected.project });
        console.log(`Project connected: ${connected.project.name}\nNext: create or clone Apps directly inside this folder, then nexia dev.`);
      }
    } else if (name === 'logout') {
      await input.confirm(message('Revoke CLI authentication. Project folder bindings and data are retained.', 'CLI 인증을 해제합니다. 프로젝트 폴더 연결과 데이터는 유지합니다.'));
      const config = await readConnection();
      if (config.token) await request(config, 'connection', { method: 'DELETE' });
      await saveConnection({ endpoint: config.endpoint });
      console.log(message('Logged out.', '로그아웃했습니다.'));
    } else if (name === 'status') {
      const workspace = await findWorkspace(process.cwd()), currentApp = await findApp(), config = await readConnection();
      const connection = config.token ? await request(config, 'connection') : null;
      const data = { authenticated: connection?.status === 'connected', endpoint: config.endpoint, project: connection?.project || null,
        folder: workspace ? { root: workspace.root, project_id: workspace.project_id } : null, app: currentApp,
        matches_folder: workspace ? connection?.project?.id === workspace.project_id && config.endpoint === workspace.endpoint : null,
        sandbox: connection?.sandbox ? { id: connection.sandbox.id, status: connection.sandbox.status } : null };
      output(options, data, `${data.authenticated ? 'Authenticated' : 'Not authenticated — run nexia login'}\nPlatform: ${data.endpoint}\nProject: ${data.project?.name || '—'}\nFolder: ${workspace?.root || 'Not connected — run nexia connect'}\nApp: ${currentApp || '—'}\nSandbox: ${data.sandbox?.status || '—'}${data.matches_folder === false ? '\nFolder and login differ. Run nexia login from this project.' : ''}`);
    } else if (name === 'check') {
      const targets = await appTargets(options, input, { all: true });
      input.close();
      let failed = false;
      for (const directory of targets) {
        log(`Check: ${directory}`);
        try { await runDevtools(['validate', directory], directory); }
        catch (error) { failed = true; log(error.message); }
      }
      if (failed) throw new Error('One or more App checks failed. See the results above.');
      console.log('Source checks passed. Runtime behavior, review and production deployment were not verified.');
    } else if (name === 'dev') {
      const workspace = await findWorkspace(process.cwd());
      if (options.app && !workspace) throw new InputError('--app requires a connected project.');
      const port = options.port === undefined ? 4310 : Number(options.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InputError('--port must be an integer from 1 to 65535.');
      const directory = workspace ? workspace.root : await findApp();
      if (!directory) throw new InputError('Run nexia connect from your project folder, then nexia dev.');
      if (workspace) {
        const { apps, errors } = await discoverApps(workspace.root);
        if (options.app && apps.filter(app => app.key === options.app || app.name === options.app).length !== 1) throw new InputError(`Choose one App with --app. Available: ${apps.map(app => app.name).join(', ')}`);
        log(`Project development: ${workspace.root}\nScope: ${options.app || `all Apps (${apps.map(app => app.name).join(', ') || 'waiting for Apps'})`}`);
        for (const error of errors) log(`${error.directory}: ${error.message}`);
      }
      input.close();
      const shutdown = new AbortController(), stop = () => shutdown.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try {
        const devOptions = { signal: shutdown.signal, port, container: options.container === true, app: options.app };
        await (workspace ? workspaceDev(workspace, devOptions) : nativeDev(directory, devOptions));
      } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    } else if (name.startsWith('db ')) {
      const action = name.split(' ')[1], [directory] = await appTargets(options, input);
      const binding = await databaseBinding(directory), route = `v2/apps/${binding.app.id}/database-operations`;
      if (action === 'status') {
        const result = await request(binding.config, route);
        output(options, result, result.operation ? `${result.operation.database_command}: ${result.operation.status} (${result.operation.id})` : 'No App database operation has been requested.');
      } else {
        let fixture;
        if (action === 'seed') {
          if (argument) fixture = await input.text('key', 'Declared fixture key', { value: argument, hint: 'nexia db seed <key>', required: true, validate: value => value.length <= 160 });
          else {
            const result = await request(binding.config, 'fixtures');
            const fixtures = result.apps.find(app => app.app_key === binding.app.key)?.fixtures || [];
            if (!fixtures.length) throw new InputError('This App exposes no development fixture keys in the active sandbox.');
            fixture = await input.choice('key', message('Choose development data', '개발 데이터를 선택하세요'), fixtures, undefined, { hint: 'nexia db seed <key>' });
          }
        }
        const id = options['request-id'] || randomUUID();
        if (!isUuid(id)) throw new InputError('--request-id must be a UUID.');
        await input.confirm(`App: ${directory}\nDatabase operation: ${action}${fixture ? ` (${fixture})` : ''}\nRequest: ${id}`);
        log(`Database request: ${id}. If the response is lost, repeat with --request-id ${id}. Stop nexia dev first if it owns this App writer lease.`);
        const result = await request(binding.config, route, { method: 'POST', body: { command: action, ...(fixture ? { fixture_key: fixture } : {}), request_id: id, writer_session: id } });
        const released = await request(binding.config, `v2/apps/${binding.app.id}/writer`, { method: 'PUT', body: { session_id: id, release: true } });
        if (released.writer?.released !== true) throw new Error('The accepted request did not release its writer lease. Retry with the same --request-id.');
        output(options, { ...result, request_id: id }, `${result.operation.database_command}: ${result.operation.status} (${result.operation.id})\nCheck: nexia db status\nAccepted does not mean completed.`);
      }
    } else if (name === 'submit') {
      const [directory] = await appTargets(options, input);
      const tag = await input.text('tag', message('Existing Git version tag (e.g. v1.0.0)', '기존 Git 버전 태그 (예: v1.0.0)'), { required: true, validate: isVersionTag });
      const requestId = options['request-id'] || randomUUID();
      if (!isUuid(requestId)) throw new InputError('--request-id must be a UUID.');
      await input.confirm(`Submit App: ${directory}\nTag: ${tag}\nRequest: ${requestId}\nReview submission only. No Git commit, tag, push or production installation.`);
      const connected = await repository(directory, 'status', { log });
      if (connected.repository?.status !== 'connected') {
        if (!input.interactive) throw new InputError(`Connect the repository in Developers first: ${connected.console_url}`);
        await repository(directory, 'connect', { log, ...(options['no-browser'] ? { openBrowser: async () => false } : {}) });
      }
      const result = await submitTag(directory, tag, requestId, { log });
      output(options, { ...result, request_id: requestId }, `Check: nexia submit status ${result.submission.id}`);
    } else if (name.startsWith('submit ')) {
      const action = name.split(' ')[1];
      const id = await input.text('submission-id', message('Submission ID from the submission receipt or Developers', '제출 결과 또는 Developers의 제출 ID'), { value: argument, hint: `nexia submit ${action} <submission-id>`, required: true, validate: isUuid });
      if (action !== 'status') await input.confirm(`${action}: ${id}`);
      const result = await request(await readConnection(), `v2/submissions/${id}${action === 'status' ? '' : `/${action}`}`, action === 'status' ? undefined : { method: 'POST', body: {} });
      if (result.submission?.id !== id) throw new Error('Platform returned a different submission.');
      output(options, result, `${result.submission.tag}: ${result.submission.status}\n${result.submission.failure || ''}\n${result.submission.retryable ? `Retry: nexia submit retry ${id}` : 'Code changes require a new version tag.'}`);
    }
  }
} catch (error) {
  const code = error.code || (error.status ? 'PLATFORM_ERROR' : 'OPERATION_FAILED');
  if (parsed?.options.json || process.argv.includes('--json')) console.log(JSON.stringify({ error: { code, message: error.message } }));
  else console.error(`Nexia [${code}]: ${error.message}\nTroubleshooting: https://developers.nexia.to/docs/troubleshooting-common-installation-errors`);
  process.exitCode = error.exitCode || 1;
} finally { input?.close(); }
