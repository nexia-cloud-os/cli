import { mkdir, readFile, writeFile, chmod, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const root = () => process.env.NEXIA_CONFIG_HOME || path.join(os.homedir(), '.config', 'nexia');
const configFile = () => path.join(root(), 'connection.json');
const defaultEndpoint = 'https://developers.nexia.to';

export function validateEndpoint(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(url.hostname) || url.hostname.endsWith('.test');
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
  const response = await fetch(`${endpoint}/developer-api/${route}`, {
    method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(authenticated ? { Authorization: `Bearer ${config.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Platform HTTP ${response.status}: ${Object.values(payload.errors || {}).flat().join(' ') || payload.message || response.statusText}`);
  return payload;
}

export async function login(projectId, { log = console.log, pollMs = 2000 } = {}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId || '')) throw new Error('Use nexia login <project-id> from your project page.');
  const current = await readConnection();
  const pairing = await request(current, 'pair', { method: 'POST', body: { project_id: projectId }, authenticated: false });
  const verification = new URL(pairing.verification_url);
  if (verification.origin !== new URL(current.endpoint).origin || !/^[a-f0-9]{64}$/.test(pairing.token)) throw new Error('Invalid pairing response.');
  log(`Open ${verification.href}\nEnter code: ${pairing.user_code}\nApprove only the project you intended. Waiting for browser approval (10 minutes)…`);
  const pending = { endpoint: current.endpoint, token: pairing.token };
  const deadline = Date.now() + Math.min(pairing.expires_in, 600) * 1000;
  while (Date.now() < deadline) {
    const result = await request(pending, 'connection');
    if (result.status === 'connected') {
      if (result.project.id !== projectId) throw new Error('The approved project does not match.');
      await saveConnection({ ...pending, project: result.project });
      log(`Connected: ${result.project.name}\nCLI credentials are stored privately and are never copied into the app.`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error('Browser approval expired. Run login again.');
}
