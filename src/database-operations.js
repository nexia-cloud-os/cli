import { setTimeout as delay } from 'node:timers/promises';
import { readConnection, request } from './connection.js';
import { preparationFailureDetails, preparationLocation, preparationNextAction } from './preparation-failure.js';
import { syncSource } from './sync.js';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

/** Apply an explicit, immutable local snapshot; source watching never authorizes migrations. */
export async function runDatabaseOperation(directory, binding, { command, options = {}, fixture, requestId, log = console.log, signal }) {
  const { config, app, project, connection } = binding;
  if (connection.capabilities?.explicit_development_migrations !== true) {
    throw new Error('The platform needs an update for explicit development migrations. No database request was sent.');
  }
  const modern = connection.capabilities?.development_database_commands === 2;
  if ((!['migrate', 'seed'].includes(command) || Object.keys(options).length) && !modern) {
    throw new Error('Update the platform and Manager to use these database commands. No database request was sent.');
  }
  const scope = { endpoint: config.endpoint, project_id: project.project_id, app_id: app.id };
  const route = `v2/apps/${app.id}/database-operations`;
  const deadline = AbortSignal.timeout(10 * 60 * 1000);
  const stopped = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const limitedRequest = async (route, options = {}) => {
    for (;;) {
      try { return await request(config, route, { ...options, signal: stopped }); }
      catch (error) {
        if (error.status !== 429) throw error;
        const wait = Math.max(5000, error.retryAfterMs ?? 60000);
        log(`Platform request limit reached; waiting ${Math.ceil(wait / 1000)}s before continuing. The database request ID is retained.`);
        await delay(wait, undefined, { signal: stopped });
      }
    }
  };
  const validate = operation => {
    if (!uuid(operation?.id) || operation.request_id !== requestId || operation.database_command !== command
        || (operation.database_fixture_key ?? null) !== (fixture ?? null)
        || operation.developer_project_id !== project.project_id || operation.developer_sandbox_id !== connection.sandbox?.id
        || !uuid(operation.source_revision_id) || !['queued', 'running', 'completed', 'failed', 'needs_review'].includes(operation.status)) {
      throw new Error('Platform returned a conflicting database operation. Keep the request ID for recovery.');
    }
    if (JSON.stringify(Object.entries(operation.database_options ?? {}).sort()) !== JSON.stringify(Object.entries(options).sort())) throw new Error('Platform returned different database options.');
    return operation;
  };
  log(`Database request: ${requestId}. If interrupted, resume waiting with --request-id ${requestId}.`);
  try {
    let operation = (await limitedRequest(`${route}?request_id=${requestId}`)).operation;
    if (operation) validate(operation);
    else {
      const { revision } = await syncSource(directory, { config, scope, log: () => {}, send: (_config, route, options) => limitedRequest(route, options) });
      let waiting = false;
      for (;;) {
        const selected = await readConnection();
        if (selected.endpoint !== config.endpoint || selected.token !== config.token) throw new Error('Login changed. No database request was sent with the new connection.');
        try {
          const result = await limitedRequest(route, { method: 'POST', signal: stopped, body: {
            command, ...(modern ? { options } : {}), ...(fixture ? { fixture_key: fixture } : {}), request_id: requestId,
            writer_session: requestId, source_revision_id: revision.id,
          } });
          operation = validate(result.operation);
          if (operation.source_revision_id !== revision.id) throw new Error('The database operation does not match the uploaded source. Keep the request ID for recovery.');
          break;
        } catch (error) {
          if (error.status !== 409 || error.platformStatus !== 'preparation_pending'
              || !['queued', 'running', 'failed'].includes(error.blockingOperation?.status)) throw error;
          if (!waiting) log('Waiting for the previous App execution to finish stopping or preparing. This normally clears shortly; the database command will continue automatically.');
          waiting = true;
          let blocking = error.blockingOperation;
          const blockingId = blocking.id;
          do {
            await delay(5000, undefined, { signal: stopped });
            blocking = (await limitedRequest(`v2/runtime-operations/${blockingId}`)).operation;
            if (blocking?.id !== blockingId || blocking.developer_project_id !== project.project_id
                || blocking.developer_sandbox_id !== connection.sandbox?.id) throw new Error('The blocking execution identity changed while waiting. No database request was accepted.');
          } while (['queued', 'running'].includes(blocking.status) || (blocking.status === 'failed' && !blocking.stopped_at));
        }
      }
    }
    const accepted = operation;
    let lastStatus;
    while (['queued', 'running'].includes(operation.status)
        || (operation.status === 'failed' && operation.started_at && !operation.stopped_at)) {
      if (operation.status !== lastStatus) log(operation.status === 'failed'
        ? `${command}: failed (${operation.id}). Waiting for execution to stop; this normally clears shortly.\n${preparationFailureDetails(operation.failure, operation.recovery_check)}${operation.database_result?.error ? formatDatabaseError(operation.database_result.error) : ''}`
        : `${command}: ${operation.status} (${operation.id})`);
      lastStatus = operation.status;
      await delay(5000, undefined, { signal: stopped });
      operation = validate((await limitedRequest(`v2/runtime-operations/${operation.id}`)).operation);
      if (operation.id !== accepted.id || operation.source_revision_id !== accepted.source_revision_id) {
        throw new Error('The database operation identity changed while waiting. Keep the request ID for recovery.');
      }
    }
    const logs = formatDatabaseLogs(operation.database_result);
    if (logs) log(logs);
    if (operation.status !== 'completed') {
      const next = operation.status === 'failed' && (operation.retry_allowed || !operation.started_at)
        ? 'Fix the reported source error, then run the database command again with a new request ID.'
        : preparationNextAction(operation);
      throw Object.assign(new Error(`${command}: ${operation.status} (${operation.id}).\n${preparationFailureDetails(operation.failure, operation.recovery_check)}${preparationLocation(operation, config.endpoint)}${next}${operation.database_result?.error ? `\n${formatDatabaseError(operation.database_result.error)}` : ''}`), { database_result: operation.database_result });
    }
    return { operation, request_id: requestId, ...(command === 'status' ? { last_operation: (await limitedRequest(route)).operation } : {}), ...(operation.database_result ? { database_result: operation.database_result } : {}) };
  } catch (error) {
    if (stopped.aborted) throw new Error(`Stopped waiting for database request ${requestId}; it may still be running. Check nexia db status or resume waiting with --request-id ${requestId}.`);
    throw error;
  }
}

export function formatDatabaseError(error) {
  return `${error.file ?? ''}${error.line ? `:${error.line}` : ''}: ${error.kind}${error.object ? ` (${error.object})` : ''}${error.sqlstate ? ` [${error.sqlstate}]` : ''}. ${error.outcome === 'rolled_back' ? 'This migration transaction was rolled back.' : 'The database outcome is not confirmed; inspect the schema before retrying.'}`;
}


export function formatSeedingResult(result) {
  if (!Array.isArray(result?.seed_versions)) return '';
  const rows = result.seed_versions.slice(0, 200).filter(row => Number.isSafeInteger(row?.version) && row.version > 0
    && ['applied', 'skipped', 'changed', 'removed'].includes(row.status));
  const lines = rows.map(row => `Seeding version ${row.version}: ${row.status === 'applied' ? 'applied' : row.status === 'skipped' ? 'already completed; skipped' : 'already completed; changed source was not rerun'}`);
  if (rows.some(row => ['changed', 'removed'].includes(row.status))) {
    lines.push('Development is not blocked. For a clean test, nexia db fresh deletes this App development database; then run nexia db seed. Preserve published versions and add a new corrective version before publication. No administrator approval is needed.');
  }
  return lines.join('\n');
}

export function formatDatabaseLogs(result) {
  return typeof result?.logs === 'string' && result.logs.length <= 16384
    ? result.logs.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '') : '';
}
