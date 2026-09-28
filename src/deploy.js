import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { syncSource } from './sync.js';
import { assertStaticProject, validateProject, resolvePublicFile } from './project.js';
import { readConnection, request } from './connection.js';

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

export async function deploy(directory, { version } = {}) {
  let native = false;
  try { native = Boolean(await lstat(path.join(directory, 'composer.json'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (native) return deployNative(directory, version);
  if (version !== undefined) throw new Error('Browser Apps use the version in nexia.json.');
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
  console.log(`Project: ${connection.project.name}\nVersion: ${result.deployment.version}\nStatus: ${result.deployment.status}\n${result.project_url}\nSubmission status is shown above; this does not publish or install the app.`);
  return result;
}


async function deployNative(directory, version) {
  if (typeof version !== 'string' || version.length > 100 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/.test(version)) {
    throw new Error('Choose the immutable App version: nexia deploy --version 1.0.0');
  }
  const config = await readConnection();
  const connection = await request(config, 'connection');
  if (connection.status !== 'connected' || connection.capabilities?.native_artifact_builds !== true) {
    throw new Error('This platform is not accepting Native artifact builds. Check the project connection and operator configuration.');
  }
  const local = path.join(directory, '.nexia');
  const readScope = async () => {
    for (const file of [local, path.join(local, 'project.json'), path.join(local, 'app.json')]) {
      if ((await lstat(file)).isSymbolicLink()) throw new Error('App bindings must not be symbolic links.');
    }
    const binding = JSON.parse(await readFile(path.join(local, 'project.json'), 'utf8'));
    const identity = JSON.parse(await readFile(path.join(local, 'app.json'), 'utf8'));
    if (binding.endpoint !== config.endpoint || identity.endpoint !== config.endpoint || binding.project_id !== connection.project.id) {
      throw new Error('App binding does not match this project. Run nexia link and nexia app register.');
    }
    return { endpoint: config.endpoint, project_id: binding.project_id, app_id: identity.id };
  };
  const scope = await readScope();
  const { revision } = await syncSource(directory, { config, scope, log: () => {} });
  const latest = await readConnection();
  const current = await readScope();
  if (latest.endpoint !== config.endpoint || latest.token !== config.token || current.app_id !== scope.app_id) {
    throw new Error('App binding or CLI connection changed. No build was submitted.');
  }
  const result = await request(config, 'v2/artifact-builds', { method: 'POST', body: {
    source_revision_id: revision.id, request_id: randomUUID(), version,
  } });
  const build = result.build;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(build?.id ?? '')
      || build.source_revision_id !== revision.id || build.source_digest !== revision.digest
      || build.developer_project_id !== scope.project_id || build.version !== version
      || !['queued', 'running', 'built', 'failed', 'needs_review', 'cancelled', 'approved', 'rejected', 'published'].includes(build.status)) {
    throw new Error('Submission acknowledgement did not match. Check the project before retrying the same version.');
  }
  console.log(`Project: ${connection.project.name}\nVersion: ${build.version}\nBuild: ${build.id}\nStatus: ${build.status}\nCheck: nexia submissions status ${build.id}\nBuild processing is separate from review approval, publication and installation.`);
  return result;
}
