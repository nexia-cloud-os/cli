import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertStaticProject, validateProject, resolvePublicFile } from './project.js';

const extensions = new Set(['.html', '.js', '.css', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff2']);
export async function bundleProject(directory) {
  await assertStaticProject(directory);
  const manifest = await validateProject(directory);
  if (manifest.permissions?.required.length) throw new Error('Static deployments cannot request tenant permissions.');
  const root = path.join(path.resolve(directory), 'public');
  const files = {};
  let size = 0;
  async function visit(relative = '') {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const name = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Do not deploy symbolic links: ${name}`);
      if (entry.isDirectory()) { await visit(name); continue; }
      if (!extensions.has(path.extname(name).toLowerCase())) throw new Error(`Unsupported public asset: ${name}`);
      const file = await resolvePublicFile(root, name);
      const bytes = await readFile(file);
      size += bytes.length;
      if (size > 5 * 1024 * 1024 || Object.keys(files).length >= 100) throw new Error('App exceeds 5 MB or 100 files.');
      files[`public/${name}`] = bytes.toString('base64');
    }
  }
  await visit();
  return { manifest, files };
}

export async function deploy() {
  throw new Error('nexia deploy is retired. Use nexia submit --tag v1.2.0.');
}
