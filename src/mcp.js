import { createInterface } from 'node:readline';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { validateProject } from './project.js';

export async function serveMcp(directory, input = process.stdin, output = process.stdout) {
  const root = await realpath(directory);
  const tools = [
    { name: 'validate_manifest', description: 'Validate this local project manifest and preview entries. Does not access Core.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'get_project', description: 'Read the local .nexia/project.json binding. It is not authoritative remote state.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  ];
  const send = (message) => output.write(JSON.stringify(message) + '\n');
  // Newline-delimited JSON-RPC stdio. Stdout is reserved for protocol messages.
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); continue;
    }
    if (message.id === undefined) continue;
    const response = { jsonrpc: '2.0', id: message.id };
    if (message.method === 'initialize') response.result = { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'nexia-local', version: '0.1.0-alpha.1' } };
    else if (message.method === 'ping') response.result = {};
    else if (message.method === 'tools/list') response.result = { tools };
    else if (message.method === 'tools/call') {
      try {
        if (Object.keys(message.params?.arguments || {}).length) throw new Error('This tool accepts no arguments; use the configured project directory.');
        let result;
        if (message.params?.name === 'validate_manifest') {
          const manifest = await validateProject(root);
          result = { valid: true, app: manifest.app, mode: 'local-preview' };
        } else if (message.params?.name === 'get_project') {
          let binding;
          try {
            const filename = await realpath(path.join(root, '.nexia/project.json'));
            if (!filename.startsWith(root + path.sep)) throw new Error('Project binding must remain inside the configured directory.');
            const stored = JSON.parse(await readFile(filename, 'utf8'));
            // Allowlist informational fields: never return tokens or arbitrary file content.
            binding = Object.fromEntries(['project_id', 'app_id', 'environment', 'endpoint'].filter((key) => typeof stored[key] === 'string').map((key) => [key, key === 'endpoint' ? safeEndpoint(stored[key]) : stored[key]]));
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          result = { source: 'local', remotely_verified: false, binding: binding ?? null };
        } else throw new Error('Unknown tool');
        response.result = { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) { response.result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
    } else response.error = { code: -32601, message: 'Method not found' };
    send(response);
  }
}

function safeEndpoint(value) {
  const endpoint = new URL(value);
  if (!['https:', 'http:'].includes(endpoint.protocol)) throw new Error('Invalid saved endpoint.');
  return endpoint.origin;
}
