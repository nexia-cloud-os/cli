import { watch } from 'node:fs';
import { readdir, lstat } from 'node:fs/promises';
import path from 'node:path';

// Docker bind mounts do not reliably forward filesystem events. Poll only the
// public tree; never traverse symlinks or inspect project secrets/configuration.
export async function watchPublic(root, onChange, { polling = false, interval = 500 } = {}) {
  let watcher, timer, previous, running;
  let closed = false;
  async function snapshot(directory = root) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await snapshot(file));
      else if (entry.isFile()) {
        const info = await lstat(file);
        if (info.isFile()) files.push([path.relative(root, file), info.size, info.mtimeMs, info.ctimeMs]);
      }
    }
    return files;
  }
  async function tick() {
    try {
      const current = JSON.stringify((await snapshot()).sort((a, b) => a[0].localeCompare(b[0])));
      if (!closed && previous !== undefined && current !== previous) onChange();
      previous = current;
    } catch { /* Atomic saves/removals can race a scan; retry the next interval. */ }
  }
  async function startPolling() {
    if (closed || timer) return;
    await tick();
    if (closed || timer) return;
    timer = setInterval(() => {
      if (!running) running = tick().finally(() => { running = undefined; });
    }, interval);
    timer.unref();
  }
  if (polling) await startPolling();
  else {
    try {
      watcher = watch(root, { recursive: true }, onChange);
      watcher.on('error', () => {
        watcher.close();
        void startPolling();
      });
    } catch { await startPolling(); }
  }
  return async () => {
    closed = true;
    watcher?.close();
    clearInterval(timer);
    await running;
  };
}
