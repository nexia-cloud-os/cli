import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { readConnection, request } from './connection.js';
import { sourceSnapshot } from './source-snapshot.js';

export async function syncSource(directory, { log = console.log, config = null, scope = null } = {}) {
  config ??= await readConnection();
  const local = path.join(directory, '.nexia');
  for (const file of [local, path.join(local, 'project.json'), path.join(local, 'app.json')]) {
    if ((await lstat(file)).isSymbolicLink()) throw new Error('App bindings must not be symbolic links.');
  }
  const binding = JSON.parse(await readFile(path.join(local, 'project.json'), 'utf8'));
  const identity = JSON.parse(await readFile(path.join(local, 'app.json'), 'utf8'));
  if (scope && (scope.endpoint !== config.endpoint || binding.endpoint !== scope.endpoint
    || identity.endpoint !== scope.endpoint || binding.project_id !== scope.project_id || identity.id !== scope.app_id)) {
    throw new Error('App binding changed. Stop nexia dev and restore the original binding before restarting; data was retained.');
  }
  const connection = await request(config, 'connection');
  if (connection.status !== 'connected' || connection.sandbox?.status !== 'active') throw new Error('Prepare the project sandbox before syncing.');
  if (binding.endpoint !== config.endpoint || identity.endpoint !== config.endpoint || binding.project_id !== connection.project.id) throw new Error('App is linked to another project. Run nexia login, then nexia dev in the intended project.');
  const source = await sourceSnapshot(directory);
  const result = await request(config, 'v2/sources', { method: 'POST', body: { app_id: identity.id, source } });
  if (result.revision?.digest !== source.digest || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(result.revision?.id || '')) throw new Error('Platform returned a conflicting source revision.');
  log(`Source saved: ${result.revision.id} (${result.revision.file_count} files)\nThis private snapshot does not activate, publish or install the App.`);
  return result;
}
