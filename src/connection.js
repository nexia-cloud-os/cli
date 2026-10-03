import { access, mkdir, readFile, writeFile, chmod, rename, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const root = () => process.env.NEXIA_CONFIG_HOME || path.join(os.homedir(), '.config', 'nexia');
const configFile = () => path.join(root(), 'connection.json');
const defaultEndpoint = 'https://developers.nexia.to';

export function validateEndpoint(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(url.hostname) || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.test');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !(url.protocol === 'https:' || (local && url.protocol === 'http:'))) {
    throw new Error('Use an HTTPS origin. HTTP is allowed only for an explicit local endpoint.');
  }
  return url.origin;
}

export async function readConnection() {
  try { return JSON.parse(await readFile(configFile(), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { endpoint: defaultEndpoint }; throw error; }
}

export async function saveConnection(config) {
  await mkdir(root(), { recursive: true, mode: 0o700 });
  await chmod(root(), 0o700);
  const temporary = `${configFile()}.${randomBytes(8).toString('hex')}`;
  await writeFile(temporary, JSON.stringify(config) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, configFile());
}

export async function setEndpoint(endpoint) {
  endpoint = validateEndpoint(endpoint);
  await saveConnection({ endpoint });
  return endpoint;
}

export async function request(config, route, { method = 'GET', body, authenticated = true } = {}) {
  if (authenticated && !config.token) throw new Error('Connect a project first: nexia login <project-id>');
  const endpoint = validateEndpoint(config.endpoint);
  // Immutable source snapshots can carry 24 MiB of JSON over local container
  // forwarding. This upload deadline does not extend runtime authority leases.
  const timeout = method === 'POST' && route === 'v2/sources' ? 120_000 : 30_000;
  const response = await fetch(`${endpoint}/developer-api/${route}`, {
    method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(authenticated ? { Authorization: `Bearer ${config.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(timeout),
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Platform HTTP ${response.status}: ${Object.values(payload.errors || {}).flat().join(' ') || payload.message || response.statusText}`);
    error.status = response.status;
    error.platformStatus = payload.status;
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const wait = /^\d+$/.test(retryAfter ?? '') ? Number(retryAfter) * 1000 : Date.parse(retryAfter ?? '') - Date.now();
      error.retryAfterMs = Number.isFinite(wait) ? Math.max(1000, Math.min(wait, 86_400_000)) : 60_000;
    }
    throw error;
  }
  return payload;
}

export async function openLoginBrowser(url) {
  if (!process.stdin.isTTY || process.env.SSH_CONNECTION || process.env.SSH_TTY
      || await access('/.dockerenv').then(() => true, () => false)
      || await access('/run/.containerenv').then(() => true, () => false)) return false;
  const launcher = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  try {
    await promisify(execFile)(launcher[0], launcher[1], { timeout: 5000, maxBuffer: 1024 });
    return true;
  } catch { return false; }
}

export async function login(projectId, { log = console.log, pollMs = 2000, openBrowser = openLoginBrowser, projectName, recoveryKey } = {}) {
  if (projectName !== undefined && (typeof projectName !== 'string' || !projectName.trim() || projectName.length > 100)) throw new Error('Project name must contain 1 to 100 characters.');
  if (projectName === undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId || '')) throw new Error('Use nexia login <project-id> from your project page.');
  if (projectName !== undefined) projectName = projectName.trim();
  const current = await readConnection();
  const recoveryFile = recoveryKey ? path.join(root(), `pairing-${createHash('sha256').update(`${current.endpoint}:${recoveryKey}`).digest('hex')}.json`) : null;
  let pairing;
  if (recoveryFile) {
    try {
      const saved = JSON.parse(await readFile(recoveryFile, 'utf8'));
      if (saved.project_name !== projectName || saved.project_id !== projectId) throw new Error('An earlier project approval is pending for this folder. Resume with the same project name.');
      pairing = saved.pairing;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!pairing) {
    pairing = await request(current, 'pair', { method: 'POST', body: projectName === undefined ? { project_id: projectId } : { project_name: projectName }, authenticated: false });
    if (recoveryFile) {
      await mkdir(root(), { recursive: true, mode: 0o700 });
      await writeFile(recoveryFile, JSON.stringify({ project_name: projectName, project_id: projectId, pairing }), { mode: 0o600, flag: 'wx' });
    }
  }
  const verification = new URL(pairing.verification_url);
  if (verification.origin !== new URL(current.endpoint).origin || !/^[a-f0-9]{64}$/.test(pairing.token)) throw new Error('Invalid pairing response.');
  log(`Open ${verification.href}\nEnter code: ${pairing.user_code}\nApprove only the project you intended. Waiting for browser approval (10 minutes)…`);
  if (openBrowser) await openBrowser(verification.href).catch(() => false);
  const pending = { endpoint: current.endpoint, token: pairing.token };
  const deadline = Date.now() + Math.min(pairing.expires_in, 600) * 1000;
  while (Date.now() < deadline) {
    let result;
    try { result = await request(pending, 'connection'); }
    catch (error) {
      // Only an explicitly expired, unapproved pairing is safe to replace.
      // Revoked or inaccessible approved projects must never create a duplicate.
      if (recoveryFile && error.status === 410 && error.platformStatus === 'pairing_expired') {
        await rm(recoveryFile);
        log('Unapproved pairing expired. Run the same create project command to request a new approval.');
      }
      throw error;
    }
    if (result.status === 'connected') {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(result.project?.id ?? '')) throw new Error('Platform returned an invalid project.');
      if ((projectName === undefined && result.project.id !== projectId) || (projectName !== undefined && result.project.name !== projectName)) throw new Error('The approved project does not match.');
      await saveConnection({ ...pending, project: result.project });
      log(`Connected: ${result.project.name}\nCLI credentials are stored privately and are never copied into the app.`);
      return { ...pending, project: result.project, recoveryFile };
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error('Browser approval expired. Run login again.');
}
