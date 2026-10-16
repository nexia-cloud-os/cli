import { request, validateEndpoint } from './connection.js';
import { open, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { preparationFailureDetails, preparationLocation, preparationRecoveryGuidance } from './preparation-failure.js';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

/** Reconcile one existing execution. Never replace its request ID or replay App code. */
export async function recoverOperation(config, id, { statusOnly = false, preserveAndReplace = false, confirmPreserve = false, exportData } = {}) {
  if (!uuid(id) || !uuid(config.project?.id)) throw new Error('Use nexia recover <operation-id> from the connected project.');
  if (preserveAndReplace !== confirmPreserve || (statusOnly && preserveAndReplace)) throw new Error('Replacement requires both --preserve-and-replace --confirm-preserve, without --status. It stops all sandbox Apps and creates an empty sandbox while preserving the old data.');
  if (exportData !== undefined && (typeof exportData !== 'string' || !exportData.trim() || statusOnly || preserveAndReplace)) throw new Error('Use --export-data <new-file.jsonl.gz> by itself to recover preserved App data.');
  const route = `v2/runtime-operations/${id}`;
  const validate = result => {
    if (result?.operation?.id !== id || result.operation.developer_project_id !== config.project.id) {
      throw new Error('Recovery operation does not match the connected project. No new execution was requested.');
    }
    return result;
  };
  const current = validate(await request(config, route));
  if (statusOnly) return current;
  if (exportData !== undefined) {
    const prepared = current.preserved_export?.status === 'ready' ? current
      : validate(await request(config, `${route}/preserved-data`, { method: 'POST', body: {} }));
    if (prepared.preserved_export?.status !== 'ready') return prepared;
    const file = await downloadPreserved(config, route, prepared.preserved_export, exportData);
    return { ...prepared, download: { file } };
  }
  try { return validate(await request(config, `${route}/recover`, { method: 'POST', body: preserveAndReplace ? { action: 'preserve_and_replace', confirm_preserve: true } : {} })); }
  catch (error) {
    if ([404, 405].includes(error.status)) {
      throw new Error('This platform does not support self-service inspection yet. Keep this operation ID and data; no execution was retried.');
    }
    throw error;
  }
}

export function formatRecovery(result, endpoint) {
  const operation = result?.operation;
  if (!uuid(operation?.id)) throw new Error('Invalid recovery response. Keep the original operation ID.');
  const statuses = ['queued', 'running', 'completed', 'failed', 'needs_review'];
  const state = statuses.includes(operation.status) ? operation.status : 'unknown';
  const recovery = result.recovery;
  const inspection = ['checking', 'retry_allowed', 'blocked'].includes(recovery?.status) ? recovery.status : 'unknown';
  const reason = typeof recovery?.reason === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(recovery.reason) ? `\nInspection reason: ${recovery.reason}` : '';
  return `Operation: ${operation.id}\nExecution: ${state}\nInspection: ${inspection}${reason}\n`
    + preparationFailureDetails(operation.failure, operation.recovery_check)
    + preparationLocation(operation, endpoint)
    + preparationRecoveryGuidance(operation, recovery)
    + (result.replacement && ['stopping', 'provisioning', 'ready'].includes(result.replacement.status) && result.replacement.data_preserved === true
      ? `\nReplacement: ${result.replacement.status}. Old sandbox data is preserved in isolation; the replacement is empty. All old sandbox Apps must stop before replacement becomes ready.` : '')
    + (result.preserved_export ? `\nPreserved data: ${['queued', 'running', 'ready', 'failed'].includes(result.preserved_export.status) ? result.preserved_export.status : 'unknown'}. Repeat --export-data <new-file.jsonl.gz> when ready.` : '')
    + (result.preserved_export?.reason === 'export_size_limit' ? '\nExport exceeds the 2 GiB uncompressed limit. Repeating the same export will not resolve this limit. Original data remains preserved; nothing was deleted.' : '')
    + (result.download ? '\nVerified preserved App data saved to the requested file.' : '')
    + '\nNo App execution was replayed. Existing source, request IDs and data are retained.';
}

async function downloadPreserved(config, route, receipt, target) {
  if (!/^[a-f0-9]{64}$/.test(receipt.sha256 ?? '') || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1 || receipt.bytes > 2147483648) throw new Error('Invalid preserved-data receipt.');
  const file = path.resolve(target), handle = await open(file, 'wx', 0o600);
  try {
    const response = await fetch(`${validateEndpoint(config.endpoint)}/developer-api/${route}/preserved-data`, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/gzip' }, redirect: 'error', signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok || !response.body) throw new Error(`Preserved-data download failed (HTTP ${response.status}).`);
    const hash = createHash('sha256'); let bytes = 0;
    await pipeline(Readable.fromWeb(response.body), async function* (source) {
      for await (const chunk of source) {
        bytes += chunk.length;
        if (bytes > receipt.bytes) throw new Error('Preserved-data size mismatch.');
        hash.update(chunk); yield chunk;
      }
    }, handle.createWriteStream());
    if (bytes !== receipt.bytes || hash.digest('hex') !== receipt.sha256) throw new Error('Preserved-data integrity mismatch.');
    return file;
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(file, { force: true });
    throw error;
  }
}
