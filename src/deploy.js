import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateProject, resolvePublicFile } from './project.js';
import { readConnection, request } from './connection.js';

const extensions = new Set(['.html', '.js', '.css', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff2']);
export async function bundleProject(directory) {
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

export async function deploy(directory) {
  const config = await readConnection();
  const connection = await request(config, 'connection');
  if (connection.status !== 'connected') throw new Error('Approve your CLI connection first.');
  // Bind a starter to the project that created it. A directory never silently changes target.
  let binding;
  try { binding = JSON.parse(await readFile(path.join(directory, '.nexia', 'project.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!binding || binding.project_id !== connection.project.id || binding.endpoint !== config.endpoint) {
    throw new Error('This directory is not bound to the connected project. Run nexia link in this directory and confirm the printed target.');
  }
  const result = await request(config, 'deployments', { method: 'POST', body: await bundleProject(directory) });
  console.log(`Project: ${connection.project.name}\nVersion: ${result.deployment.version}\nStatus: ${result.deployment.status}\n${result.project_url}\nSubmission is awaiting review; this does not publish or install the app.`);
  return result;
}
