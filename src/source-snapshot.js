import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, readdir, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const roots = new Set(['src', 'database', 'resources', 'routes', 'config', 'tests', 'public']);
const files = new Set(['composer.json', 'composer.lock', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'tsconfig.json', 'phpunit.xml', 'nexia.json']);
const extensions = new Set(['.php', '.json', '.ts', '.tsx', '.js', '.jsx', '.css', '.scss', '.html', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.yaml', '.yml', '.xml']);
const sha256 = value => createHash('sha256').update(value).digest('hex');

/** Explicit development snapshot; no scripts, credentials, dependencies or symlinks. */
export async function sourceSnapshot(directory) {
  const root = path.resolve(directory);
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new Error('App source must be a real directory.');
  const result = [];
  let total = 0;
  async function visit(relative) {
    if (relative.length > 240 || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(relative) || relative.split('/').some(part => part.startsWith('.'))) throw new Error(`Unsupported source path: ${relative}`);
    const file = path.join(root, relative);
    if (relative.split('/').includes('auth.json') || (relative.startsWith('public/') && path.extname(relative) === '.php')) throw new Error(`Private server code or credentials cannot use this source path: ${relative}`);
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error(`Source symlinks are not supported: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(file)).sort()) {
        if (name.startsWith('.') || ['vendor', 'node_modules'].includes(name)) continue;
        await visit(`${relative}/${name}`);
      }
      return;
    }
    if (!stat.isFile() || (!files.has(relative) && !extensions.has(path.extname(relative)))) throw new Error(`Unsupported source file: ${relative}`);
    if (stat.size > 2 * 1024 * 1024 || total + stat.size > 8 * 1024 * 1024 || result.length >= 1000) throw new Error('Source snapshot exceeds 1000 files, 2 MiB per file, or 8 MiB total.');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('Source changed while reading. Save and retry.');
      const buffer = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      bytes = buffer.subarray(0, offset);
      if (bytes.length !== stat.size || !(await realpath(file)).startsWith(`${await realpath(root)}${path.sep}`)) throw new Error('Source changed while reading. Save and retry.');
    } finally { await handle.close(); }
    total += bytes.length;
    result.push({ path: relative, sha256: sha256(bytes), content: bytes.toString('base64') });
  }
  for (const name of (await readdir(root)).sort()) if (roots.has(name) || files.has(name)) await visit(name);
  if (!result.some(file => file.path === 'composer.json')) throw new Error('Native source requires composer.json.');
  result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { schema_version: 1, digest: sha256(result.map(file => `${file.path}\0${file.sha256}\n`).join('')), files: result };
}
