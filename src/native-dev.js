import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readConnection, request, validateEndpoint } from './connection.js';
import { sourceSnapshot } from './source-snapshot.js';
import { syncSource } from './sync.js';
import { readExecutionSelection } from './apps.js';
import { startNativePreview } from './native-preview.js';
import { startFrontendBuild } from './frontend-build.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

// Only public source/preparation APIs; no operator credentials or local App execution.
export async function nativeDev(directory, { signal, log = console.log, interval = 5000, port = 4310, container = false } = {}) {
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
  if (!uuid(scope.project_id) || !uuid(scope.app_id) || binding.endpoint !== config.endpoint || identity.endpoint !== config.endpoint) throw new Error('App bindings do not match this platform. Run nexia link and nexia app register.');
  let state = await readLocal('runtime.json', true);
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
  let connectionChecked = false;
  let preview, build, browserRuntime = null;
  try {
    while (!signal?.aborted) {
      try {
        build?.check();
        const selected = await readConnection();
        if (selected.endpoint !== config.endpoint || selected.token !== config.token) throw new Error('CLI connection changed. Restart nexia dev after login. Runtime data was not reset.');
        const currentProject = await readLocal('project.json');
        const currentApp = await readLocal('app.json');
        if (currentProject.endpoint !== scope.endpoint || currentApp.endpoint !== scope.endpoint
          || currentProject.project_id !== scope.project_id || currentApp.id !== scope.app_id) {
          throw new Error('App binding changed. Stop nexia dev and restore the original binding before restarting; data was retained.');
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
          build = await startFrontendBuild(directory, { signal });
          if (signal?.aborted) break;
          preview = await startNativePreview(directory, { workspaceOrigin, port, container, state: () => browserRuntime });
          launch.searchParams.set('preview', preview.url);
          log(`Nexia workspace: ${launch.href}\n${build ? 'Frontend build/watch is running with nexia dev.' : 'Frontend files are served from dist/frontend; this App has no generated Vite build.'}`);
          connectionChecked = true;
        }
        // This authenticated endpoint rechecks the connection/project/sandbox each poll.
        const selection = await readExecutionSelection(config, scope);
        if (selection.mode === 'off') {
          browserRuntime = { mode: 'off' };
          const status = `off:${selection.revision}:${selection.stop_pending}`;
          if (lastStatus !== status) log(`Development execution off${selection.stop_pending ? '; operator shutdown pending' : ''}. Source and data retained. Use nexia app runtime development to resume.`);
          lastStatus = status;
          await delay(interval, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
          continue;
        }
        let operation;
        let cancelled = false;
        if (state) {
          let result;
          try {
            result = state.operation_id
              ? await request(config, `v2/runtime-operations/${state.operation_id}`)
              : await request(config, 'v2/runtime-operations', { method: 'POST', body: { source_revision_id: state.revision_id, request_id: state.request_id } });
          } catch (error) {
            // Another terminal can select off after this loop read the selection.
            // Preserve the same pending request; only an observed off choice permits waiting.
            if (error.status === 409 && (await readExecutionSelection(config, scope)).mode === 'off') continue;
            throw error;
          }
          operation = result.operation;
          if (!uuid(operation?.id) || operation.request_id !== state.request_id || operation.source_revision_id !== state.revision_id
            || operation.developer_project_id !== scope.project_id || !['queued', 'running', 'completed', 'failed', 'needs_review'].includes(operation.status)
            || (state.operation_id && operation.id !== state.operation_id)) throw new Error('Platform returned a conflicting runtime operation.');
          if (!state.operation_id) await persist({ ...state, operation_id: operation.id });
          browserRuntime = operation.status === 'completed' && !operation.stop_requested_at && !operation.stopped_at
            ? { operation_id: operation.id, source_revision_id: operation.source_revision_id, app_id: scope.app_id, app_key: identity.key } : null;
          const phase = operation.stopped_at ? 'stopped' : operation.stop_requested_at ? 'stopping' : operation.status;
          const status = `${operation.id}:${phase}`;
          if (lastStatus !== status) {
            log(['stopping', 'stopped'].includes(phase)
              ? `App execution ${phase}: ${operation.id}. Source and data retained.`
              : `App preparation ${phase}: ${operation.id}${phase === 'completed' ? '\nRuntime preparation confirmed; this does not publish or install a release.' : ''}`);
            lastStatus = status;
          }
          cancelled = operation.status === 'failed' && operation.stopped_at && selection.revision > (state.selection_revision ?? 0);
          if (['failed', 'needs_review'].includes(operation.status) && !cancelled) throw new Error('App preparation failed or requires operator review. The request and data are retained; no automatic retry was started.');
          if (operation.stop_requested_at && !operation.stopped_at) throw new Error('Runtime shutdown is still pending. Retry nexia dev after the operator confirms shutdown; data was retained.');
        }
        if (!operation || operation.status === 'completed' || cancelled) {
          // ponytail: hash the bounded 8 MiB source tree; add incremental hashing only if measured watch cost warrants it.
          const snapshot = await sourceSnapshot(directory);
          if (!state || snapshot.digest !== state.digest || operation?.stopped_at) {
            const { revision } = await syncSource(directory, { log: () => {}, config, scope });
            // Persist the idempotency key BEFORE submitting. Ambiguous responses reuse it on restart.
            browserRuntime = null;
            await persist({ ...scope, digest: revision.digest, revision_id: revision.id, request_id: randomUUID(), selection_revision: selection.revision });
            continue;
          }
        }
        await delay(interval, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
      } catch (error) {
        if (error.status !== 429) throw error;
        browserRuntime = null;
        log(`Platform request limit reached; retrying in ${Math.ceil(error.retryAfterMs / 1000)} seconds. Source, data and pending request retained.`);
        await delay(error.retryAfterMs, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
      }
    }
  } finally { await preview?.close(); await build?.close(); }
  log('Source watch stopped. Sandbox data and pending preparation requests were retained.');
}
