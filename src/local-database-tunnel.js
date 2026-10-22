import { connect as http2Connect, constants } from 'node:http2';
import { connect as tcpConnect, isIP } from 'node:net';

const MAX_FRAME = 16 * 1024;
const OPEN = 1, DATA = 2, CLOSE = 3;

function frame(kind, id, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(9);
  header[0] = kind;
  header.writeUInt32BE(id, 1);
  header.writeUInt32BE(payload.length, 5);
  return Buffer.concat([header, payload]);
}

/** Relay only to an explicitly selected loopback PostgreSQL listener. */
export async function connectDatabaseTunnel({ endpoint, token, appId, host = '127.0.0.1', port = 5432, signal }) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !/^[a-f0-9]{64}$/.test(token) || !/^[a-f0-9-]{36}$/.test(appId)
      || !['127.0.0.1', '::1'].includes(host) || isIP(host) === 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid local PostgreSQL tunnel settings.');
  }
  const session = http2Connect(url.origin, { rejectUnauthorized: true });
  const stream = session.request({ ':method': 'POST', ':path': '/database-tunnel',
    authorization: `Bearer ${token}`, 'x-nexia-app': appId, 'content-type': 'application/octet-stream' }, { endStream: false });
  const sockets = new Map();
  let pending = Buffer.alloc(0), ready = false;
  const close = () => { for (const socket of sockets.values()) socket.destroy(); stream.close(); session.close(); };
  signal?.addEventListener('abort', close, { once: true });
  const accepted = new Promise((resolve, reject) => {
    stream.once('response', headers => headers[':status'] === constants.HTTP_STATUS_OK ? (ready = true, resolve())
      : reject(new Error(`Database tunnel rejected (${headers[':status']}).`)));
    stream.once('error', reject);
    session.once('error', reject);
    stream.once('close', () => { if (!ready) reject(new Error('Database tunnel closed before admission.')); });
  });
  stream.on('data', bytes => {
    try {
      pending = Buffer.concat([pending, bytes]);
      while (pending.length >= 9) {
        const kind = pending[0], id = pending.readUInt32BE(1), size = pending.readUInt32BE(5);
        if (size > MAX_FRAME || ![OPEN, DATA, CLOSE].includes(kind) || id === 0 || (kind !== DATA && size !== 0)) throw new Error();
        if (pending.length < size + 9) break;
        const payload = pending.subarray(9, 9 + size);
        pending = pending.subarray(9 + size);
        if (kind === OPEN) {
          if (sockets.has(id) || sockets.size >= 16) throw new Error();
          const socket = tcpConnect({ host, port });
          sockets.set(id, socket);
          socket.on('data', chunk => {
            for (let offset = 0; offset < chunk.length; offset += MAX_FRAME) {
              if (!stream.write(frame(DATA, id, chunk.subarray(offset, offset + MAX_FRAME)))) socket.pause();
            }
          });
          socket.on('close', () => { sockets.delete(id); if (!socket.remoteClosed && !stream.destroyed) stream.write(frame(CLOSE, id)); });
          socket.on('error', () => socket.destroy());
          socket.on('drain', () => stream.resume());
        } else {
          const socket = sockets.get(id);
          if (!socket) throw new Error();
          if (kind === CLOSE) { socket.remoteClosed = true; socket.destroy(); }
          else if (!socket.write(payload)) stream.pause();
        }
      }
      if (pending.length > MAX_FRAME + 9) throw new Error();
    } catch { close(); }
  });
  stream.on('drain', () => { for (const socket of sockets.values()) socket.resume(); });
  stream.on('close', close);
  try { await accepted; return { close, closed: new Promise(resolve => stream.once('close', resolve)) }; }
  catch (error) { close(); throw error; }
}
