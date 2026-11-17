import { setTimeout as delay } from 'node:timers/promises';
import { request } from './connection.js';
import { devLog } from './dev-log.js';

export const nextRuntimeLogDelay = (current, changed, interval) => changed ? interval : Math.min(Math.max(interval, 30000), current * 2);

export function watchRuntimeLogs(config, operation, { log, signal, interval = 2000, verbose = false }) {
  const controller = new AbortController();
  const stopped = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let idleWait = interval, wakeSleep, wakeRequested = false, lastRequestAt = -Infinity;
  const finished = (async () => {
    let cursor = 0, disconnected = false;
    while (!stopped.aborted) {
      const remaining = lastRequestAt + interval - performance.now();
      if (remaining > 0) await delay(remaining, undefined, { signal: stopped }).catch(() => {});
      if (stopped.aborted) break;
      wakeRequested = false;
      let wait = interval, canWake = false;
      try {
        lastRequestAt = performance.now();
        const result = await request(config, `v2/runtime-operations/${operation}/logs?after=${cursor}&verbose=${verbose ? 1 : 0}`, { signal: stopped });
        if (stopped.aborted) break;
        if (result.operation_id !== operation || !Number.isSafeInteger(result.cursor) || result.cursor < cursor
          || typeof result.truncated !== 'boolean' || !Array.isArray(result.entries) || result.entries.length > 100
          || result.entries.some(row => !Number.isSafeInteger(row.id) || row.id <= cursor || row.id > result.cursor
            || !['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'].includes(row.level)
            || typeof row.message !== 'string' || row.message.length > 8192)) throw new Error('Invalid runtime log response.');
        if (disconnected) devLog(log, 'php', 'info', 'Runtime log connection restored.', { verbose });
        disconnected = false;
        if (result.truncated) devLog(log, 'php', 'warning', 'Earlier logs expired from the bounded buffer.', { verbose });
        for (const row of result.entries) devLog(log, 'php', row.level, row.message, { verbose });
        idleWait = nextRuntimeLogDelay(idleWait, result.cursor !== cursor, interval);
        wait = idleWait;
        canWake = true;
        cursor = result.cursor;
      } catch (error) {
        if (stopped.aborted) break;
        if ([401, 403, 404, 410].includes(error.status)) {
          devLog(log, 'php', 'warning', 'Runtime logs unavailable for this execution. Check login, runtime support and development selection.', { verbose });
          break;
        }
        if (!disconnected) devLog(log, 'php', 'warning', 'Runtime logs temporarily unavailable; reconnecting. Development continues.', { verbose });
        disconnected = true;
        wait = Math.max(10000, error.retryAfterMs || 0);
      }
      if (canWake && wakeRequested) wait = 0;
      const sleep = new AbortController();
      wakeSleep = canWake ? sleep : undefined;
      await delay(wait, undefined, { signal: AbortSignal.any([stopped, sleep.signal]) }).catch(() => {});
      wakeSleep = undefined;
    }
  })();
  return { operation, wake() { if (!stopped.aborted) { idleWait = interval; wakeRequested = true; wakeSleep?.abort(); } },
    close: async () => { controller.abort(); await finished; } };
}
