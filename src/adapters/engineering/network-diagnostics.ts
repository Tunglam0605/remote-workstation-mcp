import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import { PolicyEngine } from '../../policy.js';
import { EngineeringCommandRunner } from './command-runner.js';
import { resolveFirstExecutable } from './executable-resolver.js';

export interface PingOptions {
  count?: number;
  timeoutMs?: number;
}

export interface TcpReachabilityOptions {
  timeoutMs?: number;
}

function assertHost(value: string): string {
  const host = value.trim();
  if (!host || host.length > 253) throw new Error('Host must be 1..253 characters.');
  if (net.isIP(host)) return host;
  if (!/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(host)) {
    throw new Error('Host must be a valid IPv4, IPv6, or DNS hostname.');
  }
  return host;
}

function assertPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TCP port must be in range 1..65535.');
  return port;
}

function parseLinuxRoutes(stdout: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error('ip route did not return valid JSON.'); }
  if (!Array.isArray(parsed)) throw new Error('ip route JSON result was not an array.');
  return parsed.slice(0, 1024).map((item: any) => ({
    destination: typeof item.dst === 'string' ? item.dst : 'default',
    gateway: typeof item.gateway === 'string' ? item.gateway : undefined,
    interface: typeof item.dev === 'string' ? item.dev : undefined,
    protocol: typeof item.protocol === 'string' ? item.protocol : undefined,
    scope: typeof item.scope === 'string' ? item.scope : undefined,
    source: typeof item.prefsrc === 'string' ? item.prefsrc : undefined,
    metric: Number.isFinite(item.metric) ? item.metric : undefined,
    table: item.table
  }));
}

function parseWindowsRoutes(stdout: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error('Get-NetRoute did not return valid JSON.'); }
  const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : [];
  return rows.slice(0, 1024).map((item: any) => ({
    destination: typeof item.DestinationPrefix === 'string' ? item.DestinationPrefix : undefined,
    gateway: typeof item.NextHop === 'string' && item.NextHop !== '0.0.0.0' && item.NextHop !== '::' ? item.NextHop : undefined,
    interfaceIndex: Number.isFinite(item.InterfaceIndex) ? item.InterfaceIndex : undefined,
    metric: Number.isFinite(item.RouteMetric) ? item.RouteMetric : undefined,
    protocol: typeof item.Protocol === 'string' ? item.Protocol : undefined,
    addressFamily: Number.isFinite(item.AddressFamily) ? item.AddressFamily : undefined,
    state: typeof item.State === 'string' ? item.State : undefined
  }));
}

function parsePing(stdout: string, stderr: string, exitCode: number | null, durationMs: number) {
  const text = `${stdout}\n${stderr}`;
  const transmittedMatch = text.match(/(\d+)\s+packets transmitted/i);
  const receivedMatch = text.match(/(\d+)\s+(?:packets )?received/i);
  const windowsLoss = text.match(/Sent = (\d+), Received = (\d+), Lost = (\d+) \((\d+)% loss\)/i);
  const unixLoss = text.match(/([\d.]+)%\s*packet loss/i);
  const avgUnix = text.match(/(?:min\/avg\/max(?:\/mdev)?|round-trip min\/avg\/max(?:\/stddev)?)\s*=\s*[\d.]+\/([\d.]+)/i);
  const avgWindows = text.match(/Average = (\d+)ms/i);
  const transmitted = windowsLoss ? Number(windowsLoss[1]) : transmittedMatch ? Number(transmittedMatch[1]) : undefined;
  const received = windowsLoss ? Number(windowsLoss[2]) : receivedMatch ? Number(receivedMatch[1]) : undefined;
  const packetLossPercent = windowsLoss ? Number(windowsLoss[4]) : unixLoss ? Number(unixLoss[1]) : undefined;
  const averageRttMs = avgWindows ? Number(avgWindows[1]) : avgUnix ? Number(avgUnix[1]) : undefined;
  return {
    reachable: exitCode === 0 && (received === undefined || received > 0),
    exitCode,
    transmitted,
    received,
    packetLossPercent,
    averageRttMs,
    durationMs
  };
}

export class NetworkDiagnosticsAdapter {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly runner: EngineeringCommandRunner,
    private readonly platform: NodeJS.Platform | string = process.platform
  ) {}

  async providerStatus() {
    const ping = await resolveFirstExecutable(['ping']);
    const routeProvider = this.platform === 'win32'
      ? await resolveFirstExecutable(['powershell.exe', 'powershell'])
      : this.platform === 'linux'
        ? await resolveFirstExecutable(['ip'])
        : undefined;
    return {
      supported: ['win32', 'linux', 'darwin'].includes(this.platform),
      platform: this.platform,
      interfaceInventory: true,
      dnsLookup: true,
      tcpReachability: true,
      icmpPing: Boolean(ping),
      routeInventory: Boolean(routeProvider),
      authority: 'read-only',
      unavailable: ['IP configuration', 'route mutation', 'DNS configuration', 'firewall mutation', 'socket injection', 'packet capture']
    };
  }

  async interfaceList() {
    this.policy.assertEngineeringExecute();
    const interfaces = os.networkInterfaces();
    const rows: Array<Record<string, unknown>> = [];
    for (const [name, entries] of Object.entries(interfaces)) {
      for (const entry of entries ?? []) {
        rows.push({
          name,
          address: entry.address,
          family: entry.family,
          netmask: entry.netmask,
          cidr: entry.cidr,
          mac: entry.mac,
          internal: entry.internal,
          scopeid: entry.scopeid
        });
        if (rows.length >= 512) break;
      }
      if (rows.length >= 512) break;
    }
    return { interfaces: rows, count: rows.length, truncated: rows.length >= 512 };
  }

  async routeList() {
    this.policy.assertEngineeringExecute();
    if (this.platform === 'linux') {
      const ip = await resolveFirstExecutable(['ip']);
      if (!ip) throw new Error('iproute2 ip executable is unavailable.');
      const result = await this.runner.run(ip.path, ['-json', 'route', 'show', 'table', 'all'], process.cwd(), 10_000);
      if (result.timedOut || result.exitCode !== 0) throw new Error(`Network route inspection failed: ${result.stderr || result.stdout || result.exitCode}`);
      return { platform: this.platform, routes: parseLinuxRoutes(result.stdout) };
    }
    if (this.platform === 'win32') {
      const ps = await resolveFirstExecutable(['powershell.exe', 'powershell']);
      if (!ps) throw new Error('PowerShell is unavailable for Windows route inspection.');
      const fixedCommand = "Get-NetRoute | Select-Object DestinationPrefix,NextHop,InterfaceIndex,RouteMetric,Protocol,AddressFamily,State | ConvertTo-Json -Compress";
      const result = await this.runner.run(ps.path, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', fixedCommand], process.cwd(), 15_000);
      if (result.timedOut || result.exitCode !== 0) throw new Error(`Network route inspection failed: ${result.stderr || result.stdout || result.exitCode}`);
      return { platform: this.platform, routes: parseWindowsRoutes(result.stdout) };
    }
    throw new Error(`Route inventory is not supported on platform '${this.platform}'.`);
  }

  async dnsLookup(host: string, family: 0 | 4 | 6 = 0) {
    this.policy.assertEngineeringExecute();
    const selected = assertHost(host);
    const records = await dns.lookup(selected, { all: true, verbatim: true, family });
    return {
      host: selected,
      family,
      addresses: records.slice(0, 64).map(item => ({ address: item.address, family: item.family })),
      count: Math.min(records.length, 64),
      truncated: records.length > 64
    };
  }

  async ping(host: string, options: PingOptions = {}) {
    this.policy.assertEngineeringExecute();
    const selected = assertHost(host);
    const count = options.count ?? 4;
    const timeoutMs = options.timeoutMs ?? 2_000;
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('Ping count must be in range 1..20.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error('Ping timeoutMs must be in range 100..30000.');
    const ping = await resolveFirstExecutable(['ping']);
    if (!ping) throw new Error('ping executable is unavailable.');
    const args = this.platform === 'win32'
      ? ['-n', String(count), '-w', String(timeoutMs), selected]
      : ['-n', '-c', String(count), '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), selected];
    const result = await this.runner.run(ping.path, args, process.cwd(), Math.min(120_000, count * timeoutMs + 5_000));
    return { host: selected, count, timeoutMs, ...parsePing(result.stdout, result.stderr, result.exitCode, result.durationMs) };
  }

  async tcpReachability(host: string, port: number, options: TcpReachabilityOptions = {}) {
    this.policy.assertEngineeringExecute();
    const selected = assertHost(host);
    const selectedPort = assertPort(port);
    const timeoutMs = options.timeoutMs ?? 2_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000) throw new Error('TCP timeoutMs must be in range 50..30000.');
    const started = Date.now();
    return await new Promise<{ host: string; port: number; reachable: boolean; elapsedMs: number; localAddress?: string; remoteAddress?: string; errorCode?: string }>(resolve => {
      const socket = net.createConnection({ host: selected, port: selectedPort });
      let settled = false;
      const finish = (value: { reachable: boolean; errorCode?: string }) => {
        if (settled) return;
        settled = true;
        const snapshot = {
          host: selected,
          port: selectedPort,
          reachable: value.reachable,
          elapsedMs: Date.now() - started,
          localAddress: socket.localAddress,
          remoteAddress: socket.remoteAddress,
          ...(value.errorCode ? { errorCode: value.errorCode } : {})
        };
        socket.destroy();
        resolve(snapshot);
      };
      socket.setTimeout(timeoutMs, () => finish({ reachable: false, errorCode: 'ETIMEDOUT' }));
      socket.once('connect', () => finish({ reachable: true }));
      socket.once('error', error => finish({ reachable: false, errorCode: (error as NodeJS.ErrnoException).code ?? 'ERROR' }));
    });
  }
}

export const __test = { assertHost, assertPort, parseLinuxRoutes, parseWindowsRoutes, parsePing };
