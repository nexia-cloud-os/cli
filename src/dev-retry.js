import { setTimeout as delay } from 'node:timers/promises';

export function transientPlatformError(error) {
  if (error.name === 'TimeoutError' || [502, 503, 504].includes(error.status)) return true;
  const codes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'];
  const causes = [error, error.cause, ...(error.cause?.errors ?? [])];
  return causes.some(cause => codes.includes(cause?.code));
}

// Only startup reads use this helper. Mutations retain their existing request-ID recovery path.
export async function retryDevRead(read, { signal, log, interval = 5000 }) {
  while (!signal?.aborted) {
    try { return await read(); }
    catch (error) {
      if (!transientPlatformError(error) && error.status !== 429) throw error;
      log(error.status === 429
        ? `Platform request limit reached; waiting ${Math.ceil((error.retryAfterMs ?? 60000) / 1000)}s before retrying. Local watch and pending requests are retained.`
        : `Platform temporarily unavailable (${error.platformRequest ?? 'connection check'}); retrying. Local watch and pending requests are retained.`);
      await delay(error.retryAfterMs ?? (error.status === 429 ? 60000 : interval), undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
    }
  }
  return null;
}
