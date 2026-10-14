import { StringDecoder } from 'node:string_decoder';
import { plain, paint } from './terminal.js';

export function devLog(log, source, level, message) {
  // A slow pipe must not grow Node's terminal write queue indefinitely.
  if (process.stdout.writableLength > 65536 || process.stderr.writableLength > 65536) return;
  const color = ['error', 'fatal', 'critical', 'alert', 'emergency', 'warning', 'warn'].includes(level) ? 'warning' : 'muted';
  const lines = String(message).slice(0, 8192).split(/\r?\n/).slice(0, 40);
  const prefix = `[${source} ${level}]`;
  for (const line of lines) log(`${paint(prefix, color, process.stderr)} ${plain(line)}`);
}

export async function receiveBrowserLogs(req, res, app) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16384) { res.writeHead(413).end(); return; }
    chunks.push(chunk);
  }
  let events;
  try { events = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
  if (!Array.isArray(events) || events.length > 20 || events.some(event => !event
    || !['debug', 'info', 'log', 'warn', 'error'].includes(event.level)
    || typeof event.message !== 'string' || event.message.length > 8192)) { res.writeHead(400).end(); return; }
  const minute = Math.floor(Date.now() / 60000);
  if (app.logMinute !== minute) { app.logMinute = minute; app.logCount = 0; }
  for (const event of events) {
    if (!app.verbose && !['warn', 'error'].includes(event.level)) continue;
    app.logCount++;
    if (app.logCount <= 120) devLog(app.log, 'browser', event.level, event.message);
    else if (app.logCount === 121) devLog(app.log, 'browser', 'warn', 'Log limit reached (120/minute). Further messages remain in the browser console.');
  }
  res.writeHead(204).end();
}

// Keep at most 8 KiB of a partial line; newline-free build output cannot grow a readline buffer.
export function pipeBuildLogs(stream, log, level) {
  const decoder = new StringDecoder('utf8');
  let pending = '', dropping = false, minute = 0, count = 0;
  const emit = line => {
    const now = Math.floor(Date.now() / 60000);
    if (minute !== now) { minute = now; count = 0; }
    if (count >= 121) return;
    if (count++ === 120) devLog(log, 'build', 'warning', 'Log limit reached (120/minute). Further build messages are omitted.');
    else devLog(log, 'build', level, line);
  };
  stream.on('data', chunk => {
    // Process bounded slices even if a producer hands us an unusually large chunk.
    for (let start = 0; start < chunk.length; start += 8192) {
      const parts = decoder.write(chunk.subarray(start, start + 8192)).split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (!dropping) {
          const part = parts[i];
          const room = 8192 - pending.length;
          pending += part.slice(0, room);
          if (part.length > room) { emit(`${pending} [truncated]`); pending = ''; dropping = true; }
        }
        if (i < parts.length - 1) {
          if (!dropping) emit(pending.replace(/\r$/, ''));
          pending = ''; dropping = false;
        }
      }
    }
  });
  stream.once('end', () => { if (!dropping && pending) emit(pending + decoder.end()); });
}
