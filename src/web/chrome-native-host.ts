import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  CHROME_BRIDGE_EXTENSION_ID,
  CHROME_BRIDGE_MAX_MESSAGE_BYTES,
  CHROME_BRIDGE_PIPE,
  type ChromeBridgeRequest,
  type ChromeBridgeResponse
} from './chrome-bridge-protocol.js';

const expectedOrigin = `chrome-extension://${CHROME_BRIDGE_EXTENSION_ID}/`;
const actualOrigin = process.argv[2] ?? '';
if (actualOrigin !== expectedOrigin) {
  process.stderr.write('[rwmcp-chrome-bridge] rejected unexpected extension origin\n');
  process.exit(2);
}

const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) {
  process.stderr.write('[rwmcp-chrome-bridge] LOCALAPPDATA is unavailable\n');
  process.exit(2);
}
const bridgeDir = path.join(localAppData, 'RemoteWorkstationMCP', 'chrome-bridge');
const tokenPath = path.join(bridgeDir, 'bridge-token.txt');
const diagnosticPath = path.join(bridgeDir, 'native-host.log');
fs.mkdirSync(bridgeDir, { recursive: true });
function diagnostic(event: string, detail = ''): void {
  try {
    fs.appendFileSync(diagnosticPath, `${new Date().toISOString()} ${event}${detail ? ' ' + detail : ''}\n`, 'utf8');
  } catch {}
}
diagnostic('host_start', actualOrigin === expectedOrigin ? 'origin_ok' : 'origin_rejected');
let expectedToken = '';
try {
  expectedToken = fs.readFileSync(tokenPath, 'utf8').trim();
} catch {
  process.stderr.write('[rwmcp-chrome-bridge] bridge token is unavailable\n');
  process.exit(2);
}
if (expectedToken.length < 32) {
  process.stderr.write('[rwmcp-chrome-bridge] bridge token is invalid\n');
  process.exit(2);
}

let nativeBuffer = Buffer.alloc(0);
let extensionReady = false;
const pending = new Map<string, net.Socket>();

function writeNative(message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > CHROME_BRIDGE_MAX_MESSAGE_BYTES) throw new Error('Native message exceeds bridge limit.');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function sendSocket(socket: net.Socket, message: unknown): void {
  const line = JSON.stringify(message);
  if (Buffer.byteLength(line, 'utf8') > CHROME_BRIDGE_MAX_MESSAGE_BYTES) {
    socket.write(JSON.stringify({ type: 'error', code: 'MESSAGE_TOO_LARGE', message: 'Bridge response exceeds limit.' }) + '\n');
    return;
  }
  socket.write(line + '\n');
}

function handleNative(message: any): void {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'bridge_hello') {
    extensionReady = true;
    diagnostic('bridge_hello');
    return;
  }
  if (message.type !== 'bridge_response' || typeof message.id !== 'string') return;
  diagnostic('bridge_response', message.ok === true ? 'ok' : 'error');
  const socket = pending.get(message.id);
  if (!socket) return;
  pending.delete(message.id);
  const response: ChromeBridgeResponse = {
    type: 'response',
    id: message.id,
    ok: message.ok === true,
    ...(message.ok === true ? { result: message.result } : {
      error: {
        code: typeof message.error?.code === 'string' ? message.error.code.slice(0, 64) : 'EXTENSION_ERROR',
        message: typeof message.error?.message === 'string' ? message.error.message.slice(0, 1024) : 'Chrome extension request failed.'
      }
    })
  };
  sendSocket(socket, response);
}

process.stdin.on('data', chunk => {
  nativeBuffer = Buffer.concat([nativeBuffer, chunk]);
  while (nativeBuffer.length >= 4) {
    const length = nativeBuffer.readUInt32LE(0);
    if (length < 2 || length > CHROME_BRIDGE_MAX_MESSAGE_BYTES) process.exit(3);
    if (nativeBuffer.length < 4 + length) return;
    const body = nativeBuffer.subarray(4, 4 + length);
    nativeBuffer = nativeBuffer.subarray(4 + length);
    try { handleNative(JSON.parse(body.toString('utf8'))); } catch {}
  }
});

process.stdin.on('end', () => process.exit(0));

fs.mkdirSync(bridgeDir, { recursive: true });

const server = net.createServer(socket => {
  socket.setEncoding('utf8');
  let authenticated = false;
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, 'utf8') > CHROME_BRIDGE_MAX_MESSAGE_BYTES) {
      socket.destroy();
      return;
    }
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: any;
      try { message = JSON.parse(line); } catch {
        sendSocket(socket, { type: 'error', code: 'INVALID_JSON', message: 'Invalid bridge message.' });
        continue;
      }
      if (!authenticated) {
        if (message?.type !== 'auth' || message?.token !== expectedToken) {
          sendSocket(socket, { type: 'error', code: 'UNAUTHORIZED', message: 'Bridge authentication failed.' });
          socket.end();
          return;
        }
        authenticated = true;
        diagnostic('pipe_auth_ok', extensionReady ? 'extension_ready' : 'extension_not_ready');
        sendSocket(socket, { type: 'auth_ok', extensionReady, hostPid: process.pid, host: os.hostname() });
        continue;
      }
      if (!extensionReady) {
        diagnostic('request_rejected', 'extension_not_ready');
        sendSocket(socket, { type: 'error', code: 'EXTENSION_NOT_READY', message: 'Chrome extension is not connected.' });
        continue;
      }
      if (message?.type !== 'request' || typeof message.id !== 'string' || typeof message.command !== 'string') {
        sendSocket(socket, { type: 'error', code: 'INVALID_REQUEST', message: 'Invalid bridge request.' });
        continue;
      }
      const request: ChromeBridgeRequest = {
        type: 'request',
        id: message.id.slice(0, 96),
        command: message.command,
        payload: message.payload && typeof message.payload === 'object' ? message.payload : undefined
      } as ChromeBridgeRequest;
      pending.set(request.id, socket);
      diagnostic('request_forward', request.command);
      try {
        writeNative({ type: 'bridge_request', id: request.id, command: request.command, payload: request.payload ?? {} });
      } catch (error) {
        pending.delete(request.id);
        sendSocket(socket, { type: 'error', code: 'FORWARD_FAILED', message: error instanceof Error ? error.message : 'Forward failed.' });
      }
    }
  });
  socket.on('close', () => {
    for (const [id, pendingSocket] of pending) if (pendingSocket === socket) pending.delete(id);
  });
});

server.on('error', error => {
  process.stderr.write(`[rwmcp-chrome-bridge] pipe error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(4);
});
server.listen(CHROME_BRIDGE_PIPE, () => {
  diagnostic('pipe_listen');
  process.stderr.write('[rwmcp-chrome-bridge] native host ready\n');
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
