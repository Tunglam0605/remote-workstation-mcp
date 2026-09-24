import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setupConfigDir } from '../setup/settings.js';
import {
  CHROME_BRIDGE_MAX_MESSAGE_BYTES,
  CHROME_BRIDGE_PIPE,
  type ChromeBridgeCommand,
  type ChromeBridgeResponse
} from './chrome-bridge-protocol.js';

export class ExistingChromeBridgeClient {
  constructor(
    private readonly tokenPath = path.join(setupConfigDir(), 'chrome-bridge', 'bridge-token.txt'),
    private readonly pipeName = CHROME_BRIDGE_PIPE
  ) {}

  async availability(): Promise<{ available: boolean; extensionReady?: boolean; reason?: string }> {
    try {
      const result = await this.request('status', {}, 2_500);
      return { available: true, extensionReady: true, ...(result && typeof result === 'object' ? {} : {}) };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message.slice(0, 256) : 'Chrome bridge unavailable.' };
    }
  }

  async request(command: ChromeBridgeCommand, payload: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<any> {
    const token = (await fs.readFile(this.tokenPath, 'utf8')).trim();
    if (token.length < 32) throw new Error('Chrome bridge token is unavailable.');
    const id = randomUUID();
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipeName);
      socket.setEncoding('utf8');
      let buffer = '';
      let authenticated = false;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('Chrome bridge request timed out.'));
      }, timeoutMs);
      const finish = (error?: Error, value?: unknown) => {
        clearTimeout(timer);
        socket.end();
        if (error) reject(error); else resolve(value);
      };
      socket.on('connect', () => socket.write(JSON.stringify({ type: 'auth', token }) + '\n'));
      socket.on('error', error => finish(new Error(`Chrome bridge unavailable: ${error.message}`)));
      socket.on('data', chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, 'utf8') > CHROME_BRIDGE_MAX_MESSAGE_BYTES) {
          finish(new Error('Chrome bridge response exceeded limit.'));
          return;
        }
        while (true) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) return;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let message: any;
          try { message = JSON.parse(line); } catch { continue; }
          if (!authenticated) {
            if (message.type === 'auth_ok') {
              authenticated = true;
              socket.write(JSON.stringify({ type: 'request', id, command, payload }) + '\n');
              continue;
            }
            finish(new Error(message.message ?? 'Chrome bridge authentication failed.'));
            return;
          }
          if (message.type === 'error') {
            finish(new Error(message.message ?? message.code ?? 'Chrome bridge request failed.'));
            return;
          }
          const response = message as ChromeBridgeResponse;
          if (response.type !== 'response' || response.id !== id) continue;
          if (!response.ok) {
            finish(new Error(`${response.error?.code ?? 'EXTENSION_ERROR'}: ${response.error?.message ?? 'Chrome extension request failed.'}`));
            return;
          }
          finish(undefined, response.result);
          return;
        }
      });
    });
  }
}
