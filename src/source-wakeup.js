import { watch } from 'node:fs';
import { isSourceChange } from './source-snapshot.js';

// Filesystem notifications accelerate polling; snapshots remain authoritative.
export function sourceWakeup(directory, watchSource = watch, onChange = () => {}) {
  let watcher, changed = false, wake;
  const notify = () => { changed = true; wake?.(); onChange(); };
  try {
    watcher = watchSource(directory, { recursive: true }, (_event, file) => { if (isSourceChange(file)) notify(); });
    watcher.on('error', () => { watcher.close(); watcher = undefined; });
  } catch { /* Unsupported filesystems continue using the normal polling interval. */ }
  return {
    notify,
    async wait(ms, signal) {
      if (!changed && !signal?.aborted) await new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); wake = undefined; resolve(); };
        const timer = setTimeout(done, ms);
        wake = done;
        signal?.addEventListener('abort', done, { once: true });
      });
      changed = false;
    },
    close() { watcher?.close(); wake?.(); },
  };
}
