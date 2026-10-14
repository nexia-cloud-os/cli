import { watchRuntimeLogs } from './runtime-logs.js';
import { terminalLink } from './terminal-link.js';
import path from 'node:path';
import { retryDevRead, transientPlatformError } from './dev-retry.js';
import { message } from './input.js';
import { randomUUID } from 'node:crypto';
import { preparationFailureDetails, preparationLocation } from './preparation-failure.js';
import { lstat, readFile, writeFile, rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readConnection, request, validateEndpoint } from './connection.js';
import { sourceSnapshot } from './source-snapshot.js';
import { syncSource } from './sync.js';
import { readExecutionSelection, selectExecution } from './apps.js';
import { startNativePreview } from './native-preview.js';
import { startFrontendBuild } from './frontend-build.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

// Only public source/preparation APIs; no operator credentials or local App execution.
export async function nativeDev(directory, { signal, verbose = false, log = console.log, interval = 5000, port = 4310, container = false, previewHost = null, onStatus = () => {} } = {}) {
  const config = await readConnection();
  const local = path.join(directory, '.nexia');
  async function readLocal(name, optional = false) {
    const file = path.join(local, name);
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('Invalid local App binding or runtime state.');
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  }
  const stat = await lstat(local);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Link this App in a real directory first.');
  const binding = await readLocal('project.json');
  const identity = await readLocal('app.json');
  const scope = { endpoint: config.endpoint, project_id: binding.project_id, app_id: identity.id };
  const consoleUrl = new URL(`/projects/${scope.project_id}/development#project-apps`, config.endpoint);
  function preparationFailure(operation) {
    const retryable = operation.status === 'failed' && (!operation.started_at || operation.retry_allowed === true);
    const next = retryable
      ? 'Fix the reported error, wait for shutdown to finish, then restart nexia dev in the same project folder.'
      : 'This operation requires operator review before retrying; preparation may have changed data. Share this operation ID with developer support.';
    return Object.assign(new Error(`App preparation ${operation.status}: ${operation.id}.\n${preparationFailureDetails(operation.failure, operation.recovery_check)}${preparationLocation(operation, config.endpoint)}${next} Source, .nexia state and data were retained; no automatic retry was started.\nConsole: ${consoleUrl.href}`), {
      code: retryable ? 'APP_PREPARATION_FAILED' : 'APP_PREPARATION_REVIEW_REQUIRED',
    });
  }
  if (!uuid(scope.project_id) || !uuid(scope.app_id) || binding.endpoint !== config.endpoint || identity.endpoint !== config.endpoint) throw new Error('App bindings do not match this platform. Run nexia login and project nexia dev.');
  const initialConnection = await retryDevRead(async () => {
    const current = await readConnection();
    if (current.token !== config.token || current.endpoint !== config.endpoint) throw new Error('CLI connection changed. Restart nexia dev after login.');
    return request(config, 'connection');
  }, { signal, log, interval });
  if (!initialConnection) return;
  if (initialConnection.status !== 'connected' || initialConnection.project?.id !== scope.project_id) throw new Error('The linked project needs an approved connection.');
  if (initialConnection.capabilities?.explicit_development_migrations !== true) {
    throw new Error('The platform needs an update for explicit development migrations. nexia dev was not started because this platform may automatically migrate on source changes.');
  }
  if (initialConnection.sandbox?.id) scope.sandbox_id = initialConnection.sandbox.id;
  if (!initialConnection.capabilities?.development_logs) log('PHP log streaming needs a platform update. Local build and browser logs remain available.');
  let state = await readLocal('runtime.json', true);
  if (state && scope.sandbox_id && state.sandbox_id !== scope.sandbox_id) {
    await rename(path.join(local, 'runtime.json'), path.join(local, `runtime-previous-${randomUUID()}.json`));
    state = null;
  }
  if (state && (Object.entries(scope).some(([key, value]) => state[key] !== value)
    || !uuid(state.request_id) || !uuid(state.revision_id) || !/^[a-f0-9]{64}$/.test(state.digest)
    || (state.operation_id && !uuid(state.operation_id))
    || (state.selection_revision !== undefined && (!Number.isSafeInteger(state.selection_revision) || state.selection_revision < 0)))) throw new Error('Runtime state does not match this App binding. Keep it for recovery and restore the original binding.');
  async function persist(next) {
    const temporary = path.join(local, `runtime-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path.join(local, 'runtime.json'));
    state = next;
  }
  let lastStatus;
  const writerSession = randomUUID();
  let writer = null, writerCheckedAt = 0;
  let connectionChecked = false, startupSelectionChecked = false;
  let preview, build, runtimeLogs, browserRuntime = null;
  try {
    while (!signal?.aborted) {
      try {
        build?.check();
        if (runtimeLogs && runtimeLogs.operation !== browserRuntime?.operation_id) {
          await runtimeLogs.close(); runtimeLogs = null;
        }
        const selected = await readConnection();
        if (selected.endpoint !== config.endpoint || selected.token !== config.token) throw new Error('CLI connection changed. Restart nexia dev after login. Runtime data was not reset.');
        const currentProject = await readLocal('project.json');
        const currentApp = await readLocal('app.json');
        if (currentProject.endpoint !== scope.endpoint || currentApp.endpoint !== scope.endpoint
          || currentProject.project_id !== scope.project_id || currentApp.id !== scope.app_id) {
          throw new Error('App binding changed. Stop nexia dev and restore the original binding before restarting; data was retained.');
        }
        const databaseOperation = (await request(config, `v2/apps/${scope.app_id}/database-operations`)).operation;
        if (databaseOperation) {
          if (!uuid(databaseOperation.id) || databaseOperation.developer_project_id !== scope.project_id
              || databaseOperation.developer_sandbox_id !== scope.sandbox_id
              || !['migrate', 'seed', 'reset'].includes(databaseOperation.database_command)
              || !['queued', 'running', 'completed', 'failed', 'needs_review'].includes(databaseOperation.status)) {
            throw new Error('Platform returned a conflicting App database operation.');
          }
          if (databaseOperation.status === 'needs_review') throw preparationFailure(databaseOperation);
          if (['queued', 'running'].includes(databaseOperation.status)) {
            browserRuntime = null;
            const status = `database:${databaseOperation.id}:${databaseOperation.status}`;
            if (lastStatus !== status) log(`Database ${databaseOperation.database_command}: ${databaseOperation.status}. Source watching will resume after this operation finishes.`);
            lastStatus = status;
            await delay(interval, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
            continue;
          }
        }
        if (initialConnection.capabilities?.runtime_writers && Date.now() - writerCheckedAt >= 30000) {
          // The same session can safely renew its lease after a lost response.
          const response = await request(config, `v2/apps/${scope.app_id}/writer`, { method: 'PUT', body: { session_id: writerSession } });
          if (response.writer?.app_id !== scope.app_id || response.writer.sandbox_id !== scope.sandbox_id
            || !Number.isSafeInteger(response.writer.generation) || response.writer.generation < 1) throw new Error('Invalid development writer lease.');
          writer = response.writer;
          writerCheckedAt = Date.now();
        }
        if (!connectionChecked) {
          const connection = await request(config, 'connection');
          if (connection.status !== 'connected' || connection.project?.id !== scope.project_id || connection.sandbox?.status !== 'active') throw new Error('The linked project needs an active sandbox and approved connection.');
          const project = await readLocal('project.json'), app = await readLocal('app.json');
          if (project.project_id !== scope.project_id || app.id !== scope.app_id || project.endpoint !== scope.endpoint || app.endpoint !== scope.endpoint) throw new Error('App binding changed. Restore the original binding before restarting.');
          if (!connection.sandbox.workspace_url) throw new Error('The platform did not provide a sandbox workspace address.');
          const workspaceOrigin = validateEndpoint(connection.sandbox.workspace_url);
          const launch = new URL(connection.sandbox.launch_url);
          if (launch.origin !== new URL(config.endpoint).origin || launch.username || launch.password) throw new Error('Invalid workspace launch address.');
          build = await startFrontendBuild(directory, { verbose, signal, log, onInvalidate: () => { browserRuntime = null; } });
          if (signal?.aborted) break;
          preview = previewHost ? previewHost.attach(directory, () => browserRuntime, log, verbose)
            : await startNativePreview(directory, { workspaceOrigin, port, container, log, verbose, state: () => browserRuntime });
          launch.searchParams.set('preview', preview.url);
          onStatus({ status: 'watching', workspace_url: launch.href, apps: [identity.key] });
          log(`Nexia workspace: ${terminalLink(launch.href, 'Open workspace')}\n${message('Local App address (copy)', '로컬 앱 주소 (복사용)')}: ${preview.url}\n${build ? 'Frontend build/watch is running with nexia dev.' : 'Frontend files are served from dist/frontend; this App has no generated Vite build.'}\nDatabase migrations are manual. Save migration files freely; run nexia db migrate from this App in another terminal when ready.`);
          connectionChecked = true;
        }
        // This authenticated endpoint rechecks the connection/project/sandbox each poll.
        let selection = await readExecutionSelection(config, scope);
        if (scope.sandbox_id && selection.sandbox_id !== scope.sandbox_id) throw new Error('Personal sandbox changed. Restart dev; previous state was retained.');
        if (!startupSelectionChecked) {
          startupSelectionChecked = true;
          if (selection.mode === 'off' && !selection.resume_pending) {
            log(message('Requesting development execution for the selected App…', '선택한 앱의 개발 실행을 요청합니다…'));
            try { selection = await selectExecution(directory, 'development', { log, expected: selection }); }
            catch (error) {
              // Do not replay an uncertain mode switch against a newer Console decision.
              throw Object.assign(new Error(`${message('Automatic development resume was not confirmed', '자동 개발 실행 재개를 확인하지 못했습니다')}: ${error.message}\n${message('Check this App in development settings, then restart nexia dev. Source and data were retained.', '개발 설정에서 이 앱의 상태를 확인한 뒤 nexia dev를 다시 실행하세요. 소스와 데이터는 보존됩니다.')}\n${consoleUrl.href}`), { code: 'DEVELOPMENT_RESUME_UNCONFIRMED' });
            }
          }
        }
        if (selection.mode === 'off') {
          browserRuntime = { mode: 'off', app_id: scope.app_id, app_key: identity.key };
          const status = `off:${selection.revision}:${selection.stop_pending}:${selection.resume_pending}`;
          if (lastStatus !== status) {
            let next = message('Open the link below and choose Resume development for this App.', '아래 링크에서 이 앱의 ‘개발 실행 재개’를 누르세요.');
            if (selection.resume_pending) next = message('Switching from the installed App to development. Waiting for confirmed shutdown; development will resume automatically.', '설치본에서 개발본으로 전환 중입니다. 종료가 확인되면 자동으로 재개합니다.');
            else if (selection.stop_pending) next = message('Shutdown is still pending. Wait for it to finish, then resume development from the App list below.', '실행 종료를 기다리고 있습니다. 종료가 완료되면 아래 앱 목록에서 개발 실행을 재개하세요.');
            log(`${selection.resume_pending ? message('Development switch pending.', '개발 실행 전환 대기 중입니다.') : message('Development execution off. This App is not shown in the workspace.', '개발 실행이 꺼져 있어 워크스페이스에 이 앱이 표시되지 않습니다.')}\n${next}\n${terminalLink(consoleUrl.href, 'Open development settings')}\n${message('Local App address (copy)', '로컬 앱 주소 (복사용)')}: ${preview.url}\n${message('Keep nexia dev running; it will continue automatically after you resume. Source and data are retained.', 'nexia dev는 켜 두세요. 재개하면 자동으로 이어집니다. 소스와 데이터는 보존됩니다.')}`);
          }
          lastStatus = status;
          await delay(interval, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
          continue;
        }
        if (build && !build.ready()) {
          browserRuntime = null;
          await delay(Math.min(interval, 1000), undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
          continue;
        }
        const frontendGeneration = build?.generation();
        let candidateRuntime = null;
        let operation;
        let cancelled = false;
        let renewWriter = false;
        if (state) {
          let result;
          try {
            result = state.operation_id
              ? await request(config, `v2/runtime-operations/${state.operation_id}`)
              : await request(config, 'v2/runtime-operations', { method: 'POST', body: { source_revision_id: state.revision_id, request_id: state.request_id, ...(writer ? { writer_session: writerSession } : {}) } });
          } catch (error) {
            if (error.status === 410 && error.platformStatus === 'source_expired' && !state.operation_id) {
              // The server rejected an unbound, expired source; no operation was admitted.
              state = null;
              continue;
            }
            if (error.status === 409 && ['queued', 'running'].includes(error.blockingOperation?.status)
                && error.blockingOperation?.database_command) {
              await delay(interval, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
              continue;
            }
            // Another terminal can select off after this loop read the selection.
            // Preserve the same pending request; only an observed off choice permits waiting.
            if (error.status === 409 && (await readExecutionSelection(config, scope)).mode === 'off') continue;
            throw error;
          }
          operation = result.operation;
          if (!uuid(operation?.id) || operation.request_id !== state.request_id || operation.source_revision_id !== state.revision_id
            || (scope.sandbox_id && operation.developer_sandbox_id !== scope.sandbox_id)
            || operation.developer_project_id !== scope.project_id || !['queued', 'running', 'completed', 'failed', 'needs_review'].includes(operation.status)
            || (state.operation_id && operation.id !== state.operation_id)) throw new Error('Platform returned a conflicting runtime operation.');
          cancelled = operation.status === 'failed' && operation.stopped_at && selection.revision > (state.selection_revision ?? 0);
          const waitingForMigration = operation.status === 'failed' && operation.failure?.code === 'DATABASE_MIGRATION_REQUIRED';
          if (waitingForMigration && operation.retry_allowed && databaseOperation?.status === 'completed'
              && Date.parse(databaseOperation.created_at) >= Date.parse(operation.created_at)) cancelled = true;
          if (writer && (operation.writer_generation ?? state.writer_generation) !== writer.generation) {
            const reviewed = operation.status === 'failed' && operation.stopped_at && operation.retry_allowed === true;
            if (operation.status !== 'completed' && !cancelled && !reviewed && !(operation.status === 'failed' && !operation.started_at)) throw preparationFailure(operation);
            // Recover the old outcome first, then pin current source for this writer.
            // Resubmitting the previous revision can repeat an already repaired failure.
            renewWriter = true;
            browserRuntime = null;
          }
          if (!state.operation_id) await persist({ ...state, operation_id: operation.id });
          candidateRuntime = operation.status === 'completed' && !operation.stop_requested_at && !operation.stopped_at
            ? { operation_id: operation.id, source_revision_id: operation.source_revision_id, app_id: scope.app_id, app_key: identity.key } : null;
          const phase = ['failed', 'needs_review'].includes(operation.status) ? operation.status : operation.stopped_at ? 'stopped' : operation.stop_requested_at ? 'stopping' : operation.status;
          const status = `${operation.id}:${phase}`;
          if (lastStatus !== status) {
            log(['stopping', 'stopped'].includes(phase)
              ? `App execution ${phase}: ${operation.id}. Source and data retained.`
              : `App preparation ${phase}: ${operation.id}${phase === 'completed' ? '\nRuntime preparation confirmed; this does not publish or install a release.' : ''}`);
            if (waitingForMigration) log(preparationFailureDetails(operation.failure, operation.recovery_check).trim());
            lastStatus = status;
          }
          if (waitingForMigration && !cancelled && !renewWriter) {
            browserRuntime = null;
            await delay(interval, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
            continue;
          }
          if (['failed', 'needs_review'].includes(operation.status) && !cancelled && !renewWriter) throw preparationFailure(operation);
          if (operation.stop_requested_at && !operation.stopped_at) {
            // Keep the same operation until the operator acknowledges shutdown.
            // Do not expose stopped authority or submit replacement work early.
            browserRuntime = null;
            await delay(interval, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
            continue;
          }
        }
        if (!operation || operation.status === 'completed' || cancelled || renewWriter) {
          // ponytail: hash the bounded 16 MiB source tree; add incremental hashing only if measured watch cost warrants it.
          const snapshot = await sourceSnapshot(directory);
          if (build && (!build.ready() || build.generation() !== frontendGeneration)) { browserRuntime = null; continue; }
          if (!state || snapshot.digest !== state.digest || operation?.stopped_at || renewWriter) {
            const { revision } = await syncSource(directory, { log: () => {}, config, scope });
            // Persist the idempotency key BEFORE submitting. Ambiguous responses reuse it on restart.
            browserRuntime = null;
            await persist({ ...scope, digest: revision.digest, revision_id: revision.id, request_id: randomUUID(), selection_revision: selection.revision, ...(writer ? { writer_generation: writer.generation } : {}) });
            continue;
          }
          browserRuntime = candidateRuntime;
          if (initialConnection.capabilities?.development_logs && browserRuntime && runtimeLogs?.operation !== browserRuntime.operation_id) {
            await runtimeLogs?.close();
            runtimeLogs = watchRuntimeLogs(config, browserRuntime.operation_id, { log, signal, verbose });
          }
        }
        await delay(interval, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
      } catch (error) {
        if (error.code === 'SOURCE_BUSY') {
          browserRuntime = null;
          if (lastStatus !== 'source-busy') log(error.message);
          lastStatus = 'source-busy';
          await delay(interval, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
          continue;
        }
        // Source snapshots are immutable; preparation retries retain their persisted request ID.
        if (transientPlatformError(error)) {
          browserRuntime = null;
          const reason = error.status ? `HTTP ${error.status}` : error.name === 'TimeoutError' ? 'timeout' : 'connection interrupted';
          log(`Platform temporarily unavailable (${error.platformRequest ?? 'development request'}: ${reason}); retrying. Source and pending requests retained.`);
          await delay(Math.max(1000, interval), undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
          continue;
        }
        if (error.status !== 429) throw error;
        browserRuntime = null;
        log(`Platform request limit reached; retrying in ${Math.ceil(error.retryAfterMs / 1000)} seconds. Source, data and pending request retained.`);
        await delay(error.retryAfterMs, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
      }
    }
  } finally {
    await runtimeLogs?.close(); await preview?.close(); await build?.close();
    if (writer) await request(config, `v2/apps/${scope.app_id}/writer`, { method: 'PUT', body: { session_id: writerSession, release: true } })
      .catch(() => log('Writer release was not confirmed; it expires automatically. Runtime data was retained.'));
  }
  log('Source watch stopped. Sandbox data and pending preparation requests were retained.');
}
