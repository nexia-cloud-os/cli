import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readConnection, request, openLoginBrowser } from './connection.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

async function scope(directory) {
  const config = await readConnection();
  const connection = await request(config, 'connection');
  const root = path.join(directory, '.nexia');
  for (const file of [root, path.join(root, 'project.json'), path.join(root, 'app.json')]) {
    if ((await lstat(file)).isSymbolicLink()) throw new Error('App bindings must not be symbolic links.');
  }
  const project = JSON.parse(await readFile(path.join(root, 'project.json'), 'utf8'));
  const app = JSON.parse(await readFile(path.join(root, 'app.json'), 'utf8'));
  if (connection.status !== 'connected' || project.endpoint !== config.endpoint || app.endpoint !== config.endpoint
    || project.project_id !== connection.project.id || !uuid(app.id)) throw new Error('Run nexia link and nexia app register for the intended project.');
  return { config, app, project };
}

export async function repository(directory, action, { openBrowser = openLoginBrowser, log = console.log, pollMs = 2000, timeoutMs = 600000 } = {}) {
  const { config, app, project } = await scope(directory);
  const route = `v2/apps/${app.id}/repository`;
  let result = await request(config, route);
  if (action === 'status') {
    log(result.repository ? `${result.repository.full_name}: ${result.repository.status}\nAutomatic submission: ${result.repository.automatic ? 'on' : 'off'}` : 'No repository connected. Run nexia repository connect.');
    return result;
  }
  if (action !== 'connect') throw new Error('Use nexia repository connect|status.');
  const url = new URL(result.console_url);
  if (url.origin !== new URL(config.endpoint).origin || url.username || url.password || url.search || url.hash
    || url.pathname !== `/projects/${project.project_id}/apps/${app.id}/repository`) throw new Error('Invalid Console connection URL.');
  log(`Open ${url.href}\nApprove repository access in Console. Waiting for a saved connection…`);
  await openBrowser(url.href).catch(() => false);
  const initial = JSON.stringify(result.repository);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    result = await request(config, route);
    if (result.repository?.status === 'connected' && (initial === 'null' || JSON.stringify(result.repository) !== initial)) {
      log(`Connected: ${result.repository.full_name}`);
      return result;
    }
  }
  throw new Error('Connection confirmation timed out. Check nexia repository status; no submission was made.');
}

export async function submitTag(directory, tag, requestId = randomUUID(), { log = console.log } = {}) {
  if (typeof tag !== 'string' || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/.test(tag) || tag.length > 101 || !uuid(requestId)) throw new Error('Use nexia submit --tag v1.2.0 [--request-id <uuid>].');
  const { config, app } = await scope(directory);
  log(`Request: ${requestId}. If the response is lost, repeat with --request-id ${requestId}.`);
  const result = await request(config, 'v2/submissions', { method: 'POST', body: { app_id: app.id, tag, request_id: requestId } });
  if (!uuid(result.submission?.id) || result.submission.tag !== tag || result.submission.version !== tag.slice(1)
    || !/^[a-f0-9]{40}$/.test(result.submission.commit_sha)) throw new Error('Invalid submission acknowledgement. Check Console before retrying.');
  log(`${tag}: ${result.submission.status}\nSubmission: ${result.submission.id}\nCommit: ${result.submission.commit_sha}\nCheck: nexia submissions status ${result.submission.id}\nReview requested; publication and installation are separate.`);
  return result;
}
