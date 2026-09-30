import { realpath, mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { sourceSnapshot } from './source-snapshot.js';

/** Operator inspection only. No login, Composer scripts, network or host vendor are supplied. */
export async function validateInRuntime(directory, image) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Use the exact operator Runtime image ID (sha256:...).');
  const snapshot = await sourceSnapshot(await realpath(directory));
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexia-catalog-'));
  const container = `nexia-catalog-${randomUUID()}`;
  try {
    await chmod(root, 0o755);
    for (const file of snapshot.files) {
      const target = path.join(root, file.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await writeFile(target, Buffer.from(file.content, 'base64'), { mode: 0o644 });
    }
    if (root.includes(',') || /[\r\n]/.test(root)) throw new Error('Runtime validation requires a path without commas or line breaks.');
    const args = ['run', '--rm', '--name', container, '--read-only', '--network=none', '--user=10001:10001',
      '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--pids-limit=64', '--memory=512m', '--cpus=1',
      '--mount', `type=bind,src=${root},dst=/workspace/app,readonly`,
      '--tmpfs', '/opt/runtime/storage:rw,noexec,nosuid,uid=10001,gid=10001,size=16m',
      '--tmpfs', '/opt/runtime/bootstrap/cache:rw,noexec,nosuid,uid=10001,gid=10001,size=4m',
      '--env', `NEXIA_SOURCE_DIGEST=${snapshot.digest}`, '--env', 'NEXIA_APP_ROOT=/workspace/app', '--env', 'NEXIA_APP_BOOT_MODE=catalog', '--env', 'APP_DEBUG=false',
      '--entrypoint', 'php', image, '/opt/runtime/inspect.php'];
    await new Promise((resolve, reject) => {
      const child = spawn('docker', args, { shell: false, stdio: ['ignore', 'inherit', 'inherit'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error('Runtime/Catalog validation failed. No App execution was activated.'));
      });
    });
  } finally {
    await new Promise(resolve => {
      const cleanup = spawn('docker', ['rm', '--force', container], { stdio: 'ignore', shell: false });
      cleanup.once('error', resolve);
      cleanup.once('close', resolve);
    });
    await rm(root, { recursive: true, force: true });
  }
}
