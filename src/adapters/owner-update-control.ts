import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { PolicyEngine } from '../policy.js';

export type OwnerUpdateTransport = (url: string, init: RequestInit) => Promise<Response>;
const DEVELOPMENT_TAG = /^v\d+\.\d+\.\d+-dev\.\d+$/;
const MANAGED_SLOT = /^v\d+\.\d+\.\d+(?:-dev\.\d+)?$/;

export function verifyOfficialDevelopmentTag(version: string): string {
  if (!DEVELOPMENT_TAG.test(version)) {
    throw new Error('Explicit development update requires exact vX.Y.Z-dev.N tag; latest/URLs/commands are not accepted.');
  }
  return version;
}

export function verifyManagedSlotPath(base: string, raw: string): { root: string; version: string } {
  const candidate = path.resolve(raw.replace(/^\uFEFF/, '').trim());
  const versions = path.resolve(base, 'versions');
  const segment = path.relative(versions, candidate);
  if (!MANAGED_SLOT.test(segment) || segment !== path.basename(candidate)) {
    throw new Error('Current runtime must be exactly one verified version directory below managed versions/.');
  }
  return { root: candidate, version: segment.slice(1) };
}

/**
 * A *typed*, owner-granted bridge to the already existing persistent Control
 * Center update worker. Never exposes arbitrary executables or URLs to MCP.
 * The Control Center enforces signed-in owner loopback+Origin+CSRF, exact-tag
 * GitHub preflight, SHA256 before slot switch, and durable update transactions.
 */
export class OwnerUpdateControl {
  constructor(
    private readonly policy: Pick<PolicyEngine, 'assertFullControl'>,
    private readonly controlPort: number,
    private readonly transport: OwnerUpdateTransport = (url, init) => fetch(url, init),
    private readonly platform: NodeJS.Platform = os.platform(),
    private readonly localBase: string = process.env.LOCALAPPDATA ?? ''
  ) {}

  private verifyOwner(): string {
    this.policy.assertFullControl();
    if (this.platform !== 'win32') {
      throw new Error('Managed owner update tools currently support Windows only.');
    }
    if (!Number.isInteger(this.controlPort) || this.controlPort < 1024 || this.controlPort > 65535) {
      throw new Error('Configured Control Center port is invalid.');
    }
    if (!this.localBase) throw new Error('LOCALAPPDATA is required for managed Windows update.');
    return path.join(this.localBase, 'RemoteWorkstationMCP');
  }

  private async post(endpoint: '/api/update/install' | '/api/runtime/action', body: Record<string,string>): Promise<Record<string,unknown>> {
    this.verifyOwner();
    const origin = `http://127.0.0.1:${this.controlPort}`;
    const page = await this.transport(origin + '/', {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000)
    });
    if (page.status !== 200) throw new Error('Owner Control Center is unavailable.');
    const html = await page.text();
    const match = html.match(/<meta name="rwmcp-setup-token" content="([A-Za-z0-9_-]{32,})">/);
    if (!match) throw new Error('Owner Control Center CSRF token was not present in its local HTML.');
    const response = await this.transport(origin + endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json', 'x-rwmcp-setup-token': match[1]!, Origin: origin },
      body: JSON.stringify(body)
    });
    if (![200,202].includes(response.status)) {
      throw new Error(`Owner Control Center rejected the typed request (HTTP ${response.status}).`);
    }
    const payload = await response.json() as Record<string,unknown>;
    if (payload.accepted !== true) throw new Error('Owner Control Center did not accept the typed request.');
    return {
      accepted: true,
      action: endpoint === '/api/update/install' ? 'install' : 'restart',
      state: (payload.transaction as Record<string,unknown> | undefined)?.state ?? 'accepted',
      alreadyRunning: payload.alreadyRunning === true,
      ...((payload.transaction as Record<string,unknown> | undefined)?.requestedVersion
        ? { requestedVersion: (payload.transaction as Record<string,unknown>).requestedVersion } : {})
    };
  }

  async install(version: string): Promise<Record<string,unknown>> {
    this.verifyOwner();
    return await this.post('/api/update/install', { version: verifyOfficialDevelopmentTag(version) });
  }

  async status(): Promise<Record<string,unknown>> {
    const base = this.verifyOwner();
    const read = async (file: string): Promise<string | undefined> => {
      try { return await fs.readFile(file, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    };
    const current = await read(path.join(base, 'current.txt'));
    const previous = await read(path.join(base, 'previous.txt'));
    const tx = await read(path.join(base, 'runtime', 'update-transaction.json'));
    const parse = (raw: string | undefined) => raw ? verifyManagedSlotPath(base, raw).version : undefined;
    const transaction = tx ? JSON.parse(tx.replace(/^\uFEFF/, '')) as Record<string,unknown> : undefined;
    return {
      installedVersion: parse(current),
      rollbackVersion: parse(previous),
      transaction: transaction ? {
        state: transaction.state,
        fromVersion: transaction.fromVersion,
        toVersion: transaction.toVersion,
        requestedVersion: transaction.requestedVersion,
        exitCode: transaction.exitCode,
        message: typeof transaction.message === 'string' ? transaction.message.slice(0,256) : undefined
      } : null
    };
  }

  async restart(expectedVersion: string): Promise<Record<string,unknown>> {
    this.verifyOwner();
    verifyOfficialDevelopmentTag(expectedVersion);
    const state = await this.status();
    if (state.installedVersion !== expectedVersion.slice(1)) {
      throw new Error('Managed current slot does not match exact requested version. Refusing restart.');
    }
    const tx = state.transaction as Record<string,unknown> | null;
    if (tx && (tx.state === 'STARTING' || tx.state === 'RUNNING')) {
      throw new Error('A managed update worker is still active. Wait for completion before restart.');
    }
    return await this.post('/api/runtime/action', { action: 'Restart', mode: 'OpenAI' });
  }
}
