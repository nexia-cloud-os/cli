import { watchRuntimeLogs } from './runtime-logs.js';
import { terminalLink } from './terminal-link.js';
import path from 'node:path';
import { retryDevRead, transientPlatformError } from './dev-retry.js';
import { message } from './input.js';
import { randomUUID } from 'node:crypto';
import { preparationFailureDetails, preparationLocation, preparationNextAction } from './preparation-failure.js';
import { lstat, readFile, writeFile, rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readConnection, request, validateEndpoint } from './connection.js';
import { sourceSnapshot, runtimeSourceDigest } from './source-snapshot.js';
import { syncSource } from './sync.js';
import { readExecutionSelection, selectExecution } from './apps.js';
import { startNativePreview } from './native-preview.js';
import { startFrontendBuild } from './frontend-build.js';
import { devPanel, devTask, serverVersionRows } from './dev-output.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

// Only public source/preparation APIs; no operator credentials or local App execution.
export async function nativeDev(directory, { signal, verbose = false, log = console.log, interval = 5000, port = 4310, container = false, previewHost = null, onStatus = () => {}, reporter = null, taskName } = {}) {
  const config = await readConnection();
  const local = path.join(directory, '.nexia');
  async function readLocal(name, optional = false) {
    const file = path.join(local, name);
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('Invalid local App binding or runtime state.');
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) { if (optional && error.code === 'ENOENT') return null; if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${file}. Restore the local binding or runtime state before retrying; data was retained.`); throw error; }
  }
  const stat = await lstat(local);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Link this App in a real directory first.');
  const binding = await readLocal('project.json');
  const identity = await readLocal('app.json');
  const name = taskName || identity.key;
  const task = (state, detail) => reporter ? reporter.task(name, state, detail) : log(devTask(name, state, detail));
  const detailLog = value => reporter ? reporter.message(name, value, { verbose }) : log(value);
  const scope = { endpoint: config.endpoint, project_id: binding.project_id, app_id: identity.id };
  const consoleUrl = new URL(`/projects/${scope.project_id}/development#project-apps`, config.endpoint);
  function preparationFailure(operation) {
    return Object.assign(new Error(`App execution failed: ${operation.id}.\n${preparationFailureDetails(operation.failure, operation.recovery_check)}${preparationLocation(operation, config.endpoint)}${preparationNextAction(operation)}\nConsole: ${consoleUrl.href}`), {
      code: 'APP_PREPARATION_FAILED',
    });
  }
  if (!uuid(scope.project_id) || !uuid(scope.app_id) || binding.endpoint !== config.endpoint || identity.endpoint !== config.endpoint) throw new Error('App bindings do not match this platform. Run nexia login and project nexia dev.');
  task('running', 'Checking project connection and sandbox…');
  const initialConnection = await retryDevRead(async () => {
    const current = await readConnection();
    if (current.token !== config.token || current.endpoint !== config.endpoint) throw new Error('CLI connection changed. Restart nexia dev after login.');
    return request(config, 'connection');
  }, { signal, log: detailLog, interval });
  if (!initialConnection) return;
  if (initialConnection.status !== 'connected' || initialConnection.project?.id !== scope.project_id) throw new Error('The linked project needs an approved connection.');
  const versionRows = serverVersionRows(initialConnection.platform_versions);
  if (reporter && !taskName) reporter.summary(versionRows, { after: 'CLI version' });
  if (initialConnection.capabilities?.explicit_development_migrations !== true) {
    throw new Error('The platform needs an update for explicit development migrations. nexia dev was not started because this platform may automatically migrate on source changes.');
  }
  if (initialConnection.sandbox?.id) scope.sandbox_id = initialConnection.sandbox.id;
  if (!initialConnection.capabilities?.development_logs) detailLog('PHP log streaming needs a platform update. Local build and browser logs remain available.');
  let state = await readLocal('runtime.json', true);
  if (state && scope.sandbox_id && state.sandbox_id !== scope.sandbox_id) {
    await rename(path.join(local, 'runtime.json'), path.join(local, `runtime-previous-${randomUUID()}.json`));
    state = null;
  }
  if (state && (Object.entries(scope).some(([key, value]) => state[key] !== value)
    || !uuid(state.request_id) || !uuid(state.revision_id) || !/^[a-f0-9]{64}$/.test(state.digest)
    || (state.runtime_digest !== undefined && !/^[a-f0-9]{64}$/.test(state.runtime_digest))
    || (state.operation_id && !uuid(state.operation_id))
    || (state.selection_revision !== undefined && (!Number.isSafeInteger(state.selection_revision) || state.selection_revision < 0)))) throw new Error('Runtime state does not match this App binding. Keep it for recovery and restore the original binding.');
  async function persist(next) {
    const temporary = path.join(local, `runtime-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path.join(local, 'runtime.json'));
    state = next;
  }
  let lastStatus, lastDatabaseStatus, quietDigest = null, platformCheckedAt = 0, uploadedSource = null;
  const writerSession = randomUUID();
  let writer = null, writerCheckedAt = 0;
  let connectionChecked = false, startupSelectionChecked = false;
  let preview, build, runtimeLogs, browserRuntime = null, preparationFailed = false;
  // Keep the App discoverable while its current execution is unavailable.
  // A preparing identity grants no operation or source authority.
  const previewState = () => browserRuntime ? { ...browserRuntime,
    update_status: preparationFailed ? 'runtime_failed' : build?.failed() ? 'build_failed' : (build && !build.ready())
      || (state && state.revision_id !== browserRuntime.source_revision_id) ? 'preparing' : 'ready',
  } : { mode: preparationFailed ? 'runtime_failed' : build?.failed() ? 'build_failed' : 'preparing', app_id: scope.app_id, app_key: identity.key };
  try {
    while (!signal?.aborted) {
      try {
        try { build?.check(); }
        catch (error) { await build.close(); await preview?.close(); build = null; preview = null; connectionChecked = false; throw error; }
        if (runtimeLogs && runtimeLogs.operation !== browserRuntime?.operation_id) {
          await runtimeLogs.close(); runtimeLogs = null;
        }
        const selected = await readConnection();
        if (selected.endpoint !== config.endpoint || selected.token !== config.token) throw new Error('CLI connection changed. Restart nexia dev after login. Runtime data was not reset.');
        const currentProject = await readLocal('project.json');
        const currentApp = await readLocal('app.json');
        if (currentProject.endpoint !== scope.endpoint || currentApp.endpoint !== scope.endpoint
          || currentProject.project_id !== scope.project_id || currentApp.id !== scope.app_id) {
          throw Object.assign(new Error('App binding changed. Stop nexia dev and restore the original binding before restarting; data was retained.'), { code: 'APP_BINDING_CHANGED' });
        }
        // Keep local edit detection responsive while reducing unchanged remote status reads.
        if (browserRuntime && quietDigest && Date.now() - platformCheckedAt < Math.min(15000, interval * 3)
            && (!initialConnection.capabilities?.runtime_writers || Date.now() - writerCheckedAt < 30000)
            && (await sourceSnapshot(directory)).digest === quietDigest) {
          await delay(interval, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
          continue;
        }
        platformCheckedAt = Date.now();
        const edited = await sourceSnapshot(directory);
        if (uploadedSource?.revision.digest !== edited.digest) {
          uploadedSource = await syncSource(directory, { log: () => {}, config, scope });
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
          task('running', 'Building frontend…');
          build = await startFrontendBuild(directory, { verbose, signal, log: detailLog, onInvalidate: () => {}, onState: (phase, detail) => {
            if (phase === 'building') task('running', 'Building frontend…');
            if (phase === 'failed') task('error', detail || 'Frontend build failed. Fix the build output; watching continues.');
            if (phase === 'ready') task('success', 'Frontend build ready');
          } });
          if (signal?.aborted) break;
          preview = previewHost ? previewHost.attach(directory, previewState, log, verbose)
            : await startNativePreview(directory, { workspaceOrigin, port, container, log, verbose, state: previewState });
          launch.searchParams.set('preview', preview.url);
          onStatus({ status: 'watching', workspace_url: launch.href, apps: [identity.key] });
          if (!previewHost) {
            const rows = [
              ['App', identity.key],
              ...versionRows,
              ['Workspace', { link: launch.href, label: 'Open workspace' }],
              [message('Local address', '로컬 주소'), preview.url],
              ['Frontend', build ? 'Build/watch running' : 'Serving dist/frontend'],
              ['Database', 'Migrations are manual: nexia db migrate'],
            ];
            if (reporter) reporter.summary([['App', identity.key], ['App folder', directory], ...rows.slice(1), ['Stop', 'Ctrl+C stops local development; sandbox data is retained']]);
            else log(devPanel('Nexia development', rows));
          }
          task('running', 'Checking development execution…');
          connectionChecked = true;
        }
        const databaseOperation = (await request(config, `v2/apps/${scope.app_id}/database-operations`)).operation;
        if (databaseOperation) {
          if (!uuid(databaseOperation.id) || databaseOperation.developer_project_id !== scope.project_id
              || databaseOperation.developer_sandbox_id !== scope.sandbox_id
              || !['migrate', 'seed', 'reset', 'rollback', 'rollback_all', 'refresh', 'fresh', 'seeder', 'status'].includes(databaseOperation.database_command)
              || !['queued', 'running', 'completed', 'failed', 'needs_review'].includes(databaseOperation.status)) {
            throw new Error('Platform returned a conflicting App database operation.');
          }
          if (['failed', 'needs_review'].includes(databaseOperation.status)) {
            const status = `database:${databaseOperation.id}:${databaseOperation.status}`;
            if (lastDatabaseStatus !== status) task('error', preparationFailure(databaseOperation).message);
            lastDatabaseStatus = status;
          }
          if (['queued', 'running'].includes(databaseOperation.status)) {
            browserRuntime = null;
            const status = `database:${databaseOperation.id}:${databaseOperation.status}`;
            if (lastStatus !== status) {
              if (reporter) task(databaseOperation.status === 'queued' ? 'pending' : 'running', `Database ${databaseOperation.database_command} ${databaseOperation.status}…`);
              else log(`Database ${databaseOperation.database_command}: ${databaseOperation.status}. Source watching continues while this database operation finishes.`);
            }
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
        // This authenticated endpoint rechecks the connection/project/sandbox each poll.
        let selection = await readExecutionSelection(config, scope);
        if (scope.sandbox_id && selection.sandbox_id !== scope.sandbox_id) throw new Error('Personal sandbox changed. Restart dev; previous state was retained.');
        if (!startupSelectionChecked) {
          startupSelectionChecked = true;
          if (selection.mode === 'off' && !selection.resume_pending) {
            task('running', message('Requesting development execution…', '개발 실행을 요청합니다…'));
            try { selection = await selectExecution(directory, 'development', { log: detailLog, expected: selection }); }
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
            if (reporter) {
              task('warning', selection.resume_pending ? 'Waiting for the installed App to stop before development resumes' : 'Development execution is off; resume it in Developers');
              reporter.panel(`${name} development action`, [
                ['Next', next],
                ['Settings', { link: consoleUrl.href, label: 'Open development settings' }],
                [message('Local address', '로컬 주소'), preview.url],
              ]);
            } else log(`${selection.resume_pending ? message('Development switch pending.', '개발 실행 전환 대기 중입니다.') : message('Development execution off. This App is not shown in the workspace.', '개발 실행이 꺼져 있어 워크스페이스에 이 앱이 표시되지 않습니다.')}\n${next}\n${terminalLink(consoleUrl.href, 'Open development settings')}\n${message('Local App address (copy)', '로컬 앱 주소 (복사용)')}: ${preview.url}\n${message('Keep nexia dev running; it will continue automatically after you resume. Source and data are retained.', 'nexia dev는 켜 두세요. 재개하면 자동으로 이어집니다. 소스와 데이터는 보존됩니다.')}`);
          }
          lastStatus = status;
          await delay(interval, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
          continue;
        }
        if (build && !build.ready()) {
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
              uploadedSource = null;
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
          preparationFailed = operation?.status === 'failed' || operation?.status === 'needs_review';
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
            if (reporter) {
              let state = phase === 'queued' ? 'pending' : 'running';
              let detail = phase === 'queued' ? 'Platform queue has not started runtime preparation…' : `Runtime preparation ${phase}…`;
              if (phase === 'completed') {
                const resolved = reporter.resolve?.(name) === true;
                state = 'success';
                detail = resolved ? 'Runtime preparation confirmed; previous failure resolved' : 'Runtime preparation confirmed';
              } else if (['failed', 'needs_review'].includes(phase)) {
                state = 'error';
                detail = `Runtime preparation ${phase.replace('_', ' ')}`;
              } else if (phase === 'stopped') {
                state = 'warning';
              }
              task(state, detail);
              if (operation.failure) reporter.message(name, preparationFailureDetails(operation.failure, operation.recovery_check).trim(), { verbose, failure: true });
            } else {
              log(['stopping', 'stopped'].includes(phase)
                ? `App execution ${phase}: ${operation.id}. Source and data retained.`
                : `App preparation ${phase}: ${operation.id}${phase === 'completed' ? '\nRuntime preparation confirmed; this does not publish or install a release.' : ''}`);
              if (operation.failure) log(preparationFailureDetails(operation.failure, operation.recovery_check).trim());
            }
            lastStatus = status;
          }
          if (waitingForMigration && operation.retry_allowed && uploadedSource.revision.digest !== state.digest) cancelled = true;
          if (waitingForMigration && !cancelled && !renewWriter) {
            browserRuntime = null;
            await delay(interval, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
            continue;
          }
          if (['failed', 'needs_review'].includes(operation.status) && operation.retry_allowed === true && !waitingForMigration && !cancelled && !renewWriter) {
            // A repaired source is a NEW request, never a replay of the failed
            // operation. Core must confirm that execution has stopped first.
            const repaired = await sourceSnapshot(directory);
            if (state.runtime_digest ? runtimeSourceDigest(repaired) !== state.runtime_digest : repaired.digest !== state.digest) cancelled = true;
            else {
              await delay(interval, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
              continue;
            }
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
          if (build && (!build.ready() || build.generation() !== frontendGeneration)) { continue; }
          const runtimeDigest = runtimeSourceDigest(snapshot);
          // Old CLI state can be upgraded only when the complete source still
          // matches the previously uploaded revision. Otherwise prepare once.
          if (build && state && !state.runtime_digest && snapshot.digest === state.digest) {
            await persist({ ...state, runtime_digest: runtimeDigest });
          }
          const unchanged = state && (snapshot.digest === state.digest
            || (build && state.runtime_digest === runtimeDigest));
          if (!unchanged || operation?.stopped_at || renewWriter) {
            task('running', 'Uploading changed source…');
            if (uploadedSource?.revision.digest !== snapshot.digest) {
              uploadedSource = await syncSource(directory, { log: () => {}, config, scope });
            }
            const { revision, runtime_digest } = uploadedSource;
            // Persist the idempotency key BEFORE submitting. Ambiguous responses reuse it on restart.
            preparationFailed = false;
            await persist({ ...scope, digest: revision.digest, runtime_digest, revision_id: revision.id, request_id: randomUUID(), selection_revision: selection.revision, ...(writer ? { writer_generation: writer.generation } : {}) });
            continue;
          }
          // Persisting legacy metadata can yield to the build worker. Recheck
          // before exposing an entry whose files may now be changing.
          if (build && (!build.ready() || build.generation() !== frontendGeneration)) { continue; }
          quietDigest = snapshot.digest;
          browserRuntime = candidateRuntime && { ...candidateRuntime, ...(build?.snapshot() ? { frontend_generation: build.snapshot() } : {}) };
          if (initialConnection.capabilities?.development_logs && browserRuntime && runtimeLogs?.operation !== browserRuntime.operation_id) {
            await runtimeLogs?.close();
            runtimeLogs = watchRuntimeLogs(config, browserRuntime.operation_id, { log: detailLog, signal, verbose });
          }
        }
        await delay(interval, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
      } catch (error) {
        if (error.code === 'SOURCE_BUSY') {
          browserRuntime = null;
          if (lastStatus !== 'source-busy') {
            if (reporter) task('running', error.message); else log(error.message);
          }
          lastStatus = 'source-busy';
          await delay(interval, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
          continue;
        }
        // Source snapshots are immutable; preparation retries retain their persisted request ID.
        if (transientPlatformError(error)) {
          browserRuntime = null;
          const reason = error.status ? `HTTP ${error.status}` : error.name === 'TimeoutError' ? 'timeout' : 'connection interrupted';
          if (reporter) task('running', `Platform temporarily unavailable (${reason}); retrying…`);
          else log(`Platform temporarily unavailable (${error.platformRequest ?? 'development request'}: ${reason}); retrying. Source and pending requests retained.`);
          await delay(Math.max(1000, interval), undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
          continue;
        }
        if ([401, 403].includes(error.status) || error.code === 'APP_BINDING_CHANGED') throw error;
        if (error.status === 409 && error.platformStatus === 'preparation_pending'
            && ['queued', 'running', 'failed'].includes(error.blockingOperation?.status)) {
          browserRuntime = null;
          if (lastStatus !== 'preparation-pending') task('running', 'Waiting for the previous App execution to finish stopping or preparing. This normally clears shortly; development will continue automatically.');
          lastStatus = 'preparation-pending';
          await delay(Math.max(5000, interval), undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
          continue;
        }
        if (error.status !== 429) {
          browserRuntime = null;
          const status = `error:${error.code || error.status || ''}:${error.message}`;
          if (lastStatus !== status) {
            task('error', `${error.message}\nWatching for changes. Fix the error; development stays open.`);
          }
          lastStatus = status;
          await delay(Math.max(1000, interval), undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
          continue;
        }
        browserRuntime = null;
        if (reporter) task('running', `Platform request limit reached; retrying in ${Math.ceil(error.retryAfterMs / 1000)}s…`);
        else log(`Platform request limit reached; retrying in ${Math.ceil(error.retryAfterMs / 1000)} seconds. Source, data and pending request retained.`);
        await delay(error.retryAfterMs, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
      }
    }
  } catch (error) {
    if (!reporter) task('error', String(error.message || error).split(/\r?\n/, 1)[0]);
    throw error;
  } finally {
    await runtimeLogs?.close(); await preview?.close(); await build?.close();
    if (writer) await request(config, `v2/apps/${scope.app_id}/writer`, { method: 'PUT', body: { session_id: writerSession, release: true } })
      .catch(() => detailLog('Writer release was not confirmed; it expires automatically. Runtime data was retained.'));
  }
  if (reporter) task('stopped', 'Local source watch stopped; sandbox data retained');
  else log('Source watch stopped. Sandbox data and pending preparation requests were retained.');
}
