import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { configDirectory } from './connection.js';
import { plain } from './terminal.js';

const maxBytes = 2 * 1024 * 1024;
const appendFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);

export async function createRuntimeLogFile(scope, appKey) {
  const identity = createHash('sha256').update(JSON.stringify([
    scope.endpoint, scope.project_id, scope.app_id, scope.sandbox_id,
  ])).digest('hex').slice(0, 24);
  const directory = path.join(configDirectory(), 'logs');
  const name = /^[a-z][a-z0-9-]{0,99}$/.test(appKey) ? appKey : 'app';
  const filename = path.join(directory, name + '-' + identity + '.laravel.log');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await lstat(directory);
  if (!dir.isDirectory() || (process.platform !== 'win32' && (dir.mode & 0o077) !== 0)) {
    throw new Error('Runtime log directory must be private.');
  }

  async function append(bytes) {
    for (const rotate of [true, false]) {
      const handle = await open(filename, appendFlags, 0o600);
      try {
        const current = await handle.stat();
        if (!current.isFile() || current.nlink !== 1
            || (process.platform !== 'win32' && (current.mode & 0o077) !== 0)) {
          throw new Error('Runtime log file must be private.');
        }
        if (!rotate || current.size + bytes.length <= maxBytes) {
          await handle.appendFile(bytes);
          return;
        }
      } finally {
        await handle.close();
      }
      await rename(filename, filename + '.1');
    }
  }

  await append(Buffer.alloc(0));
  return {
    filename,
    async write(operation, entries) {
      const lines = entries.map(row => {
        const time = typeof row.time === 'string' && /^\d{4}-\d\d-\d\dT[0-9:+.Z-]+$/.test(row.time)
          ? row.time : new Date().toISOString();
        const source = ['laravel', 'request', 'work', 'runtime'].includes(row.source) ? row.source : 'runtime';
        const message = row.message.split('\n').map(plain).join('\n    ');
        return '[' + time + '] ' + row.level.toUpperCase() + ' ' + source + ' [' + operation + '] ' + message + '\n';
      });
      if (lines.length) await append(Buffer.from(lines.join('')));
    },
  };
}
