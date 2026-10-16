import { setTimeout as delay } from 'node:timers/promises';
import { readConnection, request } from './connection.js';
import { preparationFailureDetails, preparationLocation, preparationRecoveryGuidance } from './preparation-failure.js';
import { syncSource } from './sync.js';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

/** Apply an explicit, immutable local snapshot; source watching never authorizes migrations. */
export async function runDatabaseOperation(directory, binding, { command, fixture, requestId, log = console.log, signal }) {
  const { config, app, project, connection } = binding;
  if (connection.capabilities?.explicit_development_migrations !== true) {
    throw new Error('The platform needs an update for explicit development migrations. No database request was sent.');
  }
  const scope = { endpoint: config.endpoint, project_id: project.project_id, app_id: app.id };
  const route = `v2/apps/${app.id}/database-operations`;
  const deadline = AbortSignal.timeout(10 * 60 * 1000);
  const stopped = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const validate = operation => {
    if (!uuid(operation?.id) || operation.request_id !== requestId || operation.database_command !== command
        || (operation.database_fixture_key ?? null) !== (fixture ?? null)
        || operation.developer_project_id !== project.project_id || operation.developer_sandbox_id !== connection.sandbox?.id
        || !uuid(operation.source_revision_id) || !['queued', 'running', 'completed', 'failed', 'needs_review'].includes(operation.status)) {
      throw new Error('Platform returned a conflicting database operation. Keep the request ID for recovery.');
    }
    return operation;
  };
  log(`Database request: ${requestId}. If interrupted, recover with --request-id ${requestId}.`);
  try {
    let operation = (await request(config, `${route}?request_id=${requestId}`, { signal: stopped })).operation;
    if (operation) validate(operation);
    else {
      const { revision } = await syncSource(directory, { config, scope, log: () => {} });
      let waiting = false;
      for (;;) {
        const selected = await readConnection();
        if (selected.endpoint !== config.endpoint || selected.token !== config.token) throw new Error('Login changed. No database request was sent with the new connection.');
        try {
          const result = await request(config, route, { method: 'POST', signal: stopped, body: {
            command, ...(fixture ? { fixture_key: fixture } : {}), request_id: requestId,
            writer_session: requestId, source_revision_id: revision.id,
          } });
          operation = validate(result.operation);
          if (operation.source_revision_id !== revision.id) throw new Error('The database operation does not match the uploaded source. Keep the request ID for recovery.');
          break;
        } catch (error) {
          if (error.status !== 409 || error.platformStatus !== 'preparation_pending'
              || !['queued', 'running'].includes(error.blockingOperation?.status)) throw error;
          if (!waiting) log('Waiting for the current App preparation to finish before applying database changes.');
          waiting = true;
          await delay(1000, undefined, { signal: stopped });
        }
      }
    }
    const accepted = operation;
    let lastStatus;
    while (['queued', 'running'].includes(operation.status)
        || (operation.status === 'failed' && operation.recovery_check?.retry_safe === true && !operation.stopped_at)) {
      if (operation.status !== lastStatus) log(`${command}: ${operation.status} (${operation.id})`);
      lastStatus = operation.status;
      await delay(1000, undefined, { signal: stopped });
      operation = validate((await request(config, `v2/runtime-operations/${operation.id}`, { signal: stopped })).operation);
      if (operation.id !== accepted.id || operation.source_revision_id !== accepted.source_revision_id) {
        throw new Error('The database operation identity changed while waiting. Keep the request ID for recovery.');
      }
    }
    if (operation.status !== 'completed') {
      const next = operation.status === 'failed' && (operation.retry_allowed || !operation.started_at)
        ? 'Fix the reported source error, then run the database command again with a new request ID.'
        : preparationRecoveryGuidance(operation);
      throw new Error(`${command}: ${operation.status} (${operation.id}).\n${preparationFailureDetails(operation.failure, operation.recovery_check)}${preparationLocation(operation, config.endpoint)}${next}`);
    }
    return { operation, request_id: requestId };
  } catch (error) {
    if (stopped.aborted) throw new Error(`Stopped waiting for database request ${requestId}; it may still be running. Check nexia db status or recover with --request-id ${requestId}.`);
    throw error;
  }
}
