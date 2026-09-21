import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ACCOUNTS = 64;
const MAX_ACCOUNT_ID = 128;
const MAX_EMAIL = 320;
const API_KEY_ENV = 'RWMCP_COCKPIT_CODEX_API_KEY';

export type CodexBrokerMode = 'native' | 'cockpit-api-pool';

export interface CodexBrokerSettings {
  enabled: boolean;
  mode: CodexBrokerMode;
}

export interface CodexBrokerAccount {
  id: string;
  emailMasked: string;
  planType?: string;
  lastUsed?: number;
  poolMember: boolean;
}

export interface CodexPoolStatus {
  configured: boolean;
  enabled: boolean;
  healthy: boolean;
  detail: string;
  port?: number;
  gatewayMode?: string;
  routingStrategy?: string;
  sessionAffinity?: boolean;
  coolingEnabled?: boolean;
  accountIds: string[];
  apiKeyConfigured: boolean;
}

export interface CodexAccountBrokerStatus {
  detected: boolean;
  brokerEnabled: boolean;
  requestedMode: CodexBrokerMode;
  effectiveBackend: 'native' | 'cockpit-api-pool' | 'blocked';
  accounts: CodexBrokerAccount[];
  pool: CodexPoolStatus;
}

interface CockpitAccountIndexEntry {
  id?: unknown;
  email?: unknown;
  plan_type?: unknown;
  last_used?: unknown;
}

interface CockpitAccountIndex {
  accounts?: unknown;
}

interface CockpitPoolConfig {
  enabled?: unknown;
  port?: unknown;
  apiKey?: unknown;
  accessScope?: unknown;
  clientBaseUrlHost?: unknown;
  gatewayMode?: unknown;
  routingStrategy?: unknown;
  sessionAffinity?: unknown;
  disableCooling?: unknown;
  accountIds?: unknown;
}

interface BrokerPaths {
  homeDir?: string;
  dataRoot?: string;
}

export interface CodexPoolLaunch {
  args: string[];
  env: Record<string, string>;
}

function asString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > max || text.includes('\0')) return undefined;
  return text;
}

function asPort(value: unknown): number | undefined {
  if (!Number.isInteger(value)) return undefined;
  const port = Number(value);
  return port >= 1024 && port <= 65535 ? port : undefined;
}

function maskEmail(value: unknown): string {
  const email = asString(value, MAX_EMAIL);
  if (!email) return 'unknown';
  if (!email.includes('@')) return email.length <= 8 ? email : `${email.slice(0, 4)}…`;
  const [local, domain] = email.split('@', 2);
  if (!domain) return 'unknown';
  const keep = Math.min(3, Math.max(1, local.length));
  return `${local.slice(0, keep)}***@${domain}`;
}

function safeAccountIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value
    .map(item => asString(item, MAX_ACCOUNT_ID))
    .filter((item): item is string => Boolean(item));
  return [...new Set(ids)].slice(0, MAX_ACCOUNTS);
}

async function readBoundedJson(file: string): Promise<unknown> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('not a regular file');
  if (stat.size > MAX_JSON_BYTES) throw new Error('file exceeds broker JSON size limit');
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as unknown;
}

function defaultDataRoot(homeDir = os.homedir()): string {
  return path.join(homeDir, '.antigravity_cockpit');
}

function isLoopbackPool(config: CockpitPoolConfig): boolean {
  const scope = asString(config.accessScope, 64)?.toLowerCase();
  const host = asString(config.clientBaseUrlHost, 256)?.toLowerCase();
  const scopeOk = !scope || scope === 'localhost' || scope === 'loopback';
  const hostOk = !host || host === 'localhost' || host === '127.0.0.1' || host === '::1';
  return scopeOk && hostOk;
}

function poolUrl(port: number): string {
  return `http://127.0.0.1:${port}/v1`;
}

function healthProbe(port: number, apiKey: string, timeoutMs = 1800): Promise<{ ok: boolean; detail: string }> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      resolve({ ok, detail: detail.slice(0, 256) });
    };
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/models',
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` }
    }, res => {
      res.resume();
      const code = res.statusCode ?? 0;
      finish(code >= 200 && code < 300, `loopback API responded HTTP ${code}`);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(false, 'loopback API health probe timed out');
    });
    req.once('error', error => { const e = error as NodeJS.ErrnoException; finish(false, `loopback API unavailable: ${e.code ?? e.message}`); });
    req.end();
  });
}

export class CodexAccountBroker {
  private readonly dataRoot: string;

  constructor(
    private readonly settings: CodexBrokerSettings,
    paths: BrokerPaths = {}
  ) {
    this.dataRoot = path.resolve(paths.dataRoot ?? defaultDataRoot(paths.homeDir));
  }

  private async readAccounts(): Promise<CodexBrokerAccount[]> {
    const file = path.join(this.dataRoot, 'codex_accounts.json');
    try {
      const raw = await readBoundedJson(file) as CockpitAccountIndex | CockpitAccountIndexEntry[];
      const entries = Array.isArray(raw) ? raw : Array.isArray(raw?.accounts) ? raw.accounts as CockpitAccountIndexEntry[] : [];
      return entries.slice(0, MAX_ACCOUNTS).flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const id = asString((item as CockpitAccountIndexEntry).id, MAX_ACCOUNT_ID);
        if (!id) return [];
        const lastUsedRaw = (item as CockpitAccountIndexEntry).last_used;
        const lastUsed = Number.isSafeInteger(lastUsedRaw) && Number(lastUsedRaw) >= 0 ? Number(lastUsedRaw) : undefined;
        const planType = asString((item as CockpitAccountIndexEntry).plan_type, 64);
        return [{
          id,
          emailMasked: maskEmail((item as CockpitAccountIndexEntry).email),
          ...(planType ? { planType } : {}),
          ...(lastUsed !== undefined ? { lastUsed } : {}),
          poolMember: false
        }];
      });
    } catch {
      return [];
    }
  }

  private async readPoolConfig(): Promise<{ config?: CockpitPoolConfig; key?: string; error?: string }> {
    const file = path.join(this.dataRoot, 'codex_local_access.json');
    try {
      const raw = await readBoundedJson(file);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Cockpit API Service config is malformed.' };
      const config = raw as CockpitPoolConfig;
      const key = asString(config.apiKey, 4096);
      return { config, ...(key ? { key } : {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Cockpit API Service config unavailable: ${message}` };
    }
  }

  async status(options: { probe?: boolean } = {}): Promise<CodexAccountBrokerStatus> {
    const accounts = await this.readAccounts();
    const poolRead = await this.readPoolConfig();
    const config = poolRead.config;
    const port = config ? asPort(config.port) : undefined;
    const poolIds = config ? safeAccountIds(config.accountIds) : [];
    const poolSet = new Set(poolIds);
    for (const account of accounts) account.poolMember = poolSet.has(account.id);

    const configured = Boolean(config);
    const enabled = config?.enabled === true;
    const apiKeyConfigured = Boolean(poolRead.key);
    const loopback = config ? isLoopbackPool(config) : false;
    const gatewayMode = config ? asString(config.gatewayMode, 64) : undefined;
    const routingStrategy = config ? asString(config.routingStrategy, 64) : undefined;
    const sessionAffinity = config?.sessionAffinity === true;
    const coolingEnabled = config ? config.disableCooling !== true : undefined;

    let healthy = false;
    let detail = poolRead.error ?? 'Cockpit API Service config not found.';
    const prerequisites = enabled
      && Boolean(port)
      && apiKeyConfigured
      && loopback
      && gatewayMode === 'sidecar'
      && routingStrategy === 'auto'
      && sessionAffinity
      && coolingEnabled === true
      && poolIds.length > 0;

    if (configured && !enabled) detail = 'Cockpit API Service is disabled.';
    else if (configured && !loopback) detail = 'Cockpit API Service is not loopback-only.';
    else if (configured && !port) detail = 'Cockpit API Service port is invalid.';
    else if (configured && !apiKeyConfigured) detail = 'Cockpit API Service API key is missing.';
    else if (configured && gatewayMode !== 'sidecar') detail = 'Cockpit API Service must use sidecar gateway mode.';
    else if (configured && routingStrategy !== 'auto') detail = 'Cockpit API Service routingStrategy must be auto.';
    else if (configured && !sessionAffinity) detail = 'Cockpit API Service session affinity must be enabled.';
    else if (configured && coolingEnabled !== true) detail = 'Cockpit API Service cooling must be enabled.';
    else if (configured && poolIds.length === 0) detail = 'Cockpit API Service account pool is empty.';
    else if (prerequisites && options.probe !== false && port && poolRead.key) {
      const probe = await healthProbe(port, poolRead.key);
      healthy = probe.ok;
      detail = probe.detail;
    } else if (prerequisites) {
      healthy = true;
      detail = 'Cockpit API Service configuration is eligible; live health probe skipped.';
    }

    let effectiveBackend: CodexAccountBrokerStatus['effectiveBackend'] = 'native';
    if (this.settings.enabled && this.settings.mode === 'cockpit-api-pool') {
      effectiveBackend = healthy ? 'cockpit-api-pool' : 'blocked';
    }

    return {
      detected: accounts.length > 0 || configured,
      brokerEnabled: this.settings.enabled,
      requestedMode: this.settings.mode,
      effectiveBackend,
      accounts,
      pool: {
        configured,
        enabled,
        healthy,
        detail,
        ...(port ? { port } : {}),
        ...(gatewayMode ? { gatewayMode } : {}),
        ...(routingStrategy ? { routingStrategy } : {}),
        ...(typeof sessionAffinity === 'boolean' ? { sessionAffinity } : {}),
        ...(typeof coolingEnabled === 'boolean' ? { coolingEnabled } : {}),
        accountIds: poolIds,
        apiKeyConfigured
      }
    };
  }

  async poolLaunch(): Promise<CodexPoolLaunch> {
    if (!this.settings.enabled || this.settings.mode !== 'cockpit-api-pool') {
      throw new Error('CODEX_BROKER_NATIVE: Cockpit API pool is not the selected owner mode.');
    }
    const status = await this.status({ probe: true });
    if (status.effectiveBackend !== 'cockpit-api-pool' || !status.pool.port) {
      throw new Error(`CODEX_BROKER_POOL_UNAVAILABLE: ${status.pool.detail}`);
    }
    const poolRead = await this.readPoolConfig();
    if (!poolRead.key) throw new Error('CODEX_BROKER_POOL_UNAVAILABLE: API key missing.');
    const baseUrl = poolUrl(status.pool.port);
    return {
      args: [
        '-c', 'model_provider=rwmcp_cockpit_pool',
        '-c', 'model_providers.rwmcp_cockpit_pool.name=CockpitPool',
        '-c', `model_providers.rwmcp_cockpit_pool.base_url=${baseUrl}`,
        '-c', `model_providers.rwmcp_cockpit_pool.env_key=${API_KEY_ENV}`,
        '-c', 'model_providers.rwmcp_cockpit_pool.wire_api=responses',
        '-c', 'model_providers.rwmcp_cockpit_pool.requires_openai_auth=false'
      ],
      env: {
        [API_KEY_ENV]: poolRead.key,
        NO_PROXY: '127.0.0.1,localhost,::1',
        no_proxy: '127.0.0.1,localhost,::1'
      }
    };
  }
}

export const CODEX_COCKPIT_API_KEY_ENV = API_KEY_ENV;
