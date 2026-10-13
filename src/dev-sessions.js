import { terminalLink } from './terminal-link.js';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, realpath, lstat, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function sessionDirectory(root) {
  const local = path.join(root, '.nexia'), directory = path.join(local, 'dev-sessions');
  for (const folder of [local, directory]) {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const stat = await lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Development sessions require a real directory.');
  }
  return directory;
}

// Control the original process over an authenticated loopback channel; never signal a recycled PID.
export async function startDevSession(root, { port, projectId, stop }) {
  root = await realpath(root);
  const directory = await sessionDirectory(root), id = randomUUID(), token = randomBytes(32).toString('hex');
  const file = path.join(directory, `${id}.json`);
  let state = { id, root, project_id: projectId ?? null, pid: process.pid, port, status: 'starting', apps: [], started_at: new Date().toISOString() };
  const server = createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${server.address().port}` || req.headers.origin || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/status') { res.end(JSON.stringify(state)); return; }
    if (req.method === 'POST' && req.url === '/stop') {
      state = { ...state, status: 'stopping' };
      res.end(JSON.stringify({ id, status: 'stopping' }));
      stop();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    await writeFile(file, JSON.stringify({ id, token, control_port: server.address().port, root, port, pid: process.pid }), { flag: 'wx', mode: 0o600 });
  } catch (error) { server.close(); throw error; }
  return {
    update: value => { state = { ...state, ...value, ...(state.status === 'stopping' ? { status: 'stopping' } : {}) }; },
    async close() { await new Promise(resolve => server.close(resolve)); await rm(file, { force: true }); },
  };
}

async function query(record, method = 'GET') {
  const response = await fetch(`http://127.0.0.1:${record.control_port}/${method === 'POST' ? 'stop' : 'status'}`, {
    method, headers: { Authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(2000), redirect: 'error',
  });
  if (!response.ok) throw new Error('Development session could not be authenticated.');
  const status = await response.json();
  if (status.id !== record.id) throw new Error('Development session identity changed.');
  return status;
}

async function records(root) {
  const directory = path.join(root, '.nexia', 'dev-sessions');
  for (const folder of [path.dirname(directory), directory]) {
    const stat = await lstat(folder).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!stat) return [];
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Invalid development session directory.');
  }
  const result = [];
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const file = path.join(directory, name), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('Invalid development session record.');
    const record = JSON.parse(await readFile(file, 'utf8'));
    if (`${record.id}.json` !== name || record.root !== root || !/^[a-f0-9]{64}$/.test(record.token)
      || !Number.isInteger(record.control_port) || record.control_port < 1 || record.control_port > 65535) throw new Error('Invalid development session record.');
    result.push({ ...record, file });
  }
  return result;
}

export async function listDevSessions(root) {
  root = await realpath(root);
  return Promise.all((await records(root)).map(async record => {
    try { return await query(record); }
    catch { return { id: record.id, root, pid: record.pid, port: record.port, status: 'unreachable', apps: [] }; }
  }));
}

export async function stopDevSessions(root, port) {
  root = await realpath(root);
  const results = [];
  for (const record of await records(root)) {
    if (port !== undefined && record.port !== port) continue;
    try {
      await query(record);
      await query(record, 'POST');
      // Removal is the owning process's acknowledgement that all watchers have closed.
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (!await lstat(record.file).catch(error => { if (error.code !== 'ENOENT') throw error; })) break;
        await delay(100);
      }
      const pending = await lstat(record.file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      results.push({ port: record.port, pid: record.pid, status: pending ? 'stopping' : 'stopped' });
    } catch {
      results.push({ port: record.port, pid: record.pid, status: 'unreachable' });
    }
  }
  return results;
}

export function formatSessions(sessions, stream = process.stdout, env = process.env) {
  if (!sessions.length) return 'No tracked local development sessions. Start nexia dev with this CLI version.';
  return ['PORT\tPID\tSTATUS\tAPPS', ...sessions.flatMap(session => [
    `${session.port}\t${session.pid}\t${session.status}\t${session.apps.join(', ') || '—'}`,
    ...(session.workspace_url ? [`Workspace: ${terminalLink(session.workspace_url, 'Open workspace', stream, env)}`] : []),
  ]), 'Stop this project: nexia stop | Stop one session: nexia stop --port <port>',
  'Unreachable records do not prove a process is running. Older CLI sessions require Ctrl+C or manual port inspection.'].join('\n');
}
