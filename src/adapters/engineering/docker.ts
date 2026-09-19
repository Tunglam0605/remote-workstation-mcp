import path from 'node:path';
import { PolicyEngine } from '../../policy.js';
import { PathGuard } from '../../security/path-guard.js';
import { EngineeringCommandRunner } from './command-runner.js';
import { resolveFirstExecutable } from './executable-resolver.js';

function validateContainer(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error('Invalid container name/id.');
}

export type ContainerRiskLevel = 'standard' | 'elevated' | 'high';

export interface ContainerRiskFinding {
  id: string;
  severity: 'elevated' | 'high';
  detail: string;
}

export interface DockerDaemonRisk {
  context?: string;
  endpoint?: string;
  remote: boolean;
  rootless?: boolean;
  rootful?: boolean;
}

export interface ContainerRiskAssessment {
  container?: string;
  level: ContainerRiskLevel;
  highRisk: boolean;
  findings: ContainerRiskFinding[];
  daemon: DockerDaemonRisk;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeHostPath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() || '/';
}

function isHostRoot(value: string): boolean {
  const normalized = normalizeHostPath(value);
  return normalized === '/' || /^[a-z]:$/.test(normalized);
}

function isSensitiveHostPath(value: string): boolean {
  const normalized = normalizeHostPath(value);
  const unix = ['/etc', '/proc', '/sys', '/var/run', '/run', '/root', '/boot', '/dev'];
  if (unix.some(prefix => normalized === prefix || normalized.startsWith(`${prefix}/`))) return true;
  const windows = ['c:/windows', 'c:/programdata/docker', 'c:/programdata/dockerdesktop'];
  return windows.some(prefix => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function isDockerSocketPath(value: string): boolean {
  const normalized = normalizeHostPath(value);
  return normalized.endsWith('/var/run/docker.sock')
    || normalized.endsWith('/run/docker.sock')
    || normalized.includes('pipe/docker_engine');
}

function dockerBindSource(bind: string): string {
  const value = bind.trim();
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    const separator = value.indexOf(':', 2);
    return separator >= 0 ? value.slice(0, separator) : value;
  }
  const separator = value.indexOf(':');
  return separator >= 0 ? value.slice(0, separator) : value;
}

function parseJsonMaybe<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw.trim()) as T; } catch { return fallback; }
}

function endpointIsRemote(endpoint?: string): boolean {
  if (!endpoint) return false;
  const normalized = endpoint.trim().toLowerCase();
  if (normalized.startsWith('unix://') || normalized.startsWith('npipe://')) return false;
  return /^(tcp|ssh|http|https):\/\//.test(normalized);
}

export class DockerAdapter {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly paths: PathGuard,
    private readonly runner: EngineeringCommandRunner
  ) {}

  private async docker(): Promise<string> {
    const docker = await resolveFirstExecutable(['docker']);
    if (!docker) throw new Error('Docker CLI is unavailable.');
    return docker.path;
  }

  private async run(workspace: string, cwdRelative: string, args: string[], timeoutMs = 30_000) {
    const cwd = await this.paths.resolveExisting(workspace, cwdRelative);
    const result = await this.runner.run(await this.docker(), args, cwd, timeoutMs);
    if (result.exitCode !== 0) throw new Error(`docker ${args[0] ?? ''} failed: ${result.stderr || result.stdout}`);
    return result;
  }

  private async inspectRaw(workspace: string, container: string, cwd = '.'): Promise<unknown> {
    validateContainer(container);
    const result = await this.run(workspace, cwd, ['inspect', container]);
    return JSON.parse(result.stdout) as unknown;
  }

  private async daemonRisk(workspace: string, cwd = '.'): Promise<DockerDaemonRisk> {
    const contextResult = await this.run(workspace, cwd, ['context', 'show'], 10_000);
    const context = contextResult.stdout.trim() || undefined;
    let endpoint: string | undefined;
    if (context) {
      const endpointResult = await this.run(
        workspace,
        cwd,
        ['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}'],
        10_000
      );
      endpoint = parseJsonMaybe<string | undefined>(endpointResult.stdout, endpointResult.stdout.trim() || undefined);
    }

    const securityResult = await this.run(
      workspace,
      cwd,
      ['info', '--format', '{{json .SecurityOptions}}'],
      10_000
    );
    const security = parseJsonMaybe<unknown[]>(securityResult.stdout, []);
    const flattened = JSON.stringify(security).toLowerCase();
    const rootless = flattened.includes('rootless');
    return {
      ...(context ? { context } : {}),
      ...(endpoint ? { endpoint } : {}),
      remote: endpointIsRemote(endpoint),
      rootless,
      rootful: !rootless
    };
  }

  private classifyContainer(container: string, inspection: unknown, daemon: DockerDaemonRisk): ContainerRiskAssessment {
    const item = Array.isArray(inspection) ? asRecord(inspection[0]) : asRecord(inspection);
    const config = asRecord(item.Config);
    const host = asRecord(item.HostConfig);
    const mounts = Array.isArray(item.Mounts) ? item.Mounts.map(asRecord) : [];
    const findings: ContainerRiskFinding[] = [];
    const add = (id: string, severity: 'elevated' | 'high', detail: string) => {
      if (!findings.some(item => item.id === id)) findings.push({ id, severity, detail });
    };

    if (host.Privileged === true) add('privileged', 'high', 'Container is configured as privileged.');
    if (String(host.PidMode ?? '').toLowerCase() === 'host') add('host-pid', 'high', 'Container shares the host PID namespace.');
    if (String(host.NetworkMode ?? '').toLowerCase() === 'host') add('host-network', 'high', 'Container shares the host network namespace.');

    const binds = Array.isArray(host.Binds) ? host.Binds.filter((value): value is string => typeof value === 'string') : [];
    for (const bind of binds) {
      const source = dockerBindSource(bind);
      if (isDockerSocketPath(source) || isDockerSocketPath(bind)) add('docker-socket', 'high', 'Container bind-mounts the Docker daemon socket/pipe.');
      if (source && isHostRoot(source)) add('host-root-bind', 'high', `Container bind-mounts host root '${source}'.`);
      else if (source && isSensitiveHostPath(source)) add('sensitive-host-bind', 'high', `Container bind-mounts sensitive host path '${source}'.`);
    }

    for (const mount of mounts) {
      const source = typeof mount.Source === 'string' ? mount.Source : '';
      const destination = typeof mount.Destination === 'string' ? mount.Destination : '';
      if (isDockerSocketPath(source) || isDockerSocketPath(destination)) add('docker-socket', 'high', 'Container mount exposes the Docker daemon socket/pipe.');
      if (source && isHostRoot(source)) add('host-root-bind', 'high', `Container mounts host root '${source}'.`);
      else if (source && isSensitiveHostPath(source)) add('sensitive-host-bind', 'high', `Container mounts sensitive host path '${source}'.`);
    }

    const devices = Array.isArray(host.Devices) ? host.Devices : [];
    const deviceRequests = Array.isArray(host.DeviceRequests) ? host.DeviceRequests : [];
    if (devices.length > 0 || deviceRequests.length > 0) add('device-passthrough', 'high', 'Container has host device passthrough.');

    const user = String(config.User ?? '').trim().toLowerCase();
    if (!user || user === '0' || user === 'root' || user.startsWith('0:') || user.startsWith('root:')) {
      add('root-user', 'elevated', 'Container process user resolves to root.');
    }

    if (daemon.remote) add('remote-daemon', 'high', `Docker context endpoint is remote (${daemon.endpoint ?? daemon.context ?? 'unknown'}).`);

    const highRisk = findings.some(item => item.severity === 'high');
    const level: ContainerRiskLevel = highRisk ? 'high' : findings.length > 0 ? 'elevated' : 'standard';
    return { container, level, highRisk, findings, daemon };
  }

  async riskAssessment(workspace: string, container: string, cwd = '.'): Promise<ContainerRiskAssessment> {
    this.policy.assertEngineeringEnabled();
    const [inspection, daemon] = await Promise.all([
      this.inspectRaw(workspace, container, cwd),
      this.daemonRisk(workspace, cwd)
    ]);
    return this.classifyContainer(container, inspection, daemon);
  }

  async list(workspace: string, all = true, cwd = '.') {
    this.policy.assertEngineeringEnabled();
    const args = ['ps', ...(all ? ['-a'] : []), '--format', '{{json .}}'];
    const result = await this.run(workspace, cwd, args);
    return result.stdout.split(/\r?\n/).filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    });
  }

  async inspect(workspace: string, container: string, cwd = '.') {
    this.policy.assertEngineeringEnabled();
    const inspection = await this.inspectRaw(workspace, container, cwd);
    const daemon = await this.daemonRisk(workspace, cwd);
    return {
      raw: inspection,
      risk: this.classifyContainer(container, inspection, daemon)
    };
  }

  async logs(workspace: string, container: string, tail = 200, cwd = '.') {
    this.policy.assertEngineeringEnabled();
    validateContainer(container);
    if (!Number.isInteger(tail) || tail < 1 || tail > 5000) throw new Error('tail must be in range 1..5000.');
    const result = await this.run(workspace, cwd, ['logs', '--tail', String(tail), container]);
    return { container, stdout: result.stdout, stderr: result.stderr };
  }

  async start(workspace: string, container: string, cwd = '.') {
    const risk = await this.riskAssessment(workspace, container, cwd);
    this.policy.assertContainerCapability('lifecycle', risk.highRisk);
    const result = await this.run(workspace, cwd, ['start', container]);
    return { container, risk, output: result.stdout.trim() };
  }

  async stop(workspace: string, container: string, timeoutSeconds = 10, cwd = '.') {
    const risk = await this.riskAssessment(workspace, container, cwd);
    this.policy.assertContainerCapability('lifecycle', risk.highRisk);
    validateContainer(container);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 120) throw new Error('timeoutSeconds must be in range 0..120.');
    const result = await this.run(workspace, cwd, ['stop', '-t', String(timeoutSeconds), container]);
    return { container, risk, output: result.stdout.trim() };
  }

  async exec(workspace: string, container: string, program: string, args: string[] = [], cwd = '.') {
    validateContainer(container);
    if (!/^[A-Za-z0-9_./:-]+$/.test(program)) throw new Error('Container program contains unsupported characters.');
    const programName = program.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
    if (new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']).has(programName)) {
      throw new Error('Container shell/interpreter hosts are not allowed by container_exec; use a direct executable with argv.');
    }
    if (args.length > 100 || args.some(arg => Buffer.byteLength(arg, 'utf8') > 8192)) throw new Error('Container argv exceeds limits.');
    const risk = await this.riskAssessment(workspace, container, cwd);
    this.policy.assertContainerCapability('exec', risk.highRisk);
    const result = await this.run(workspace, cwd, ['exec', container, program, ...args], 60_000);
    return { container, program, risk, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  async imageBuild(workspace: string, contextPath = '.', tag?: string) {
    if (tag && !/^[A-Za-z0-9._/:\-]+$/.test(tag)) throw new Error('Docker image tag contains unsupported characters.');
    await this.paths.resolveExisting(workspace, contextPath);
    const daemon = await this.daemonRisk(workspace, contextPath);
    const highRisk = daemon.remote;
    this.policy.assertContainerCapability('image_build', highRisk);
    const args = ['build', ...(tag ? ['-t', tag] : []), '.'];
    const result = await this.run(workspace, contextPath, args, this.policy.config.engineering?.maxCommandRuntimeMs);
    return {
      tag,
      risk: {
        level: highRisk ? 'high' : daemon.rootful ? 'elevated' : 'standard',
        highRisk,
        findings: highRisk ? [{ id: 'remote-daemon', severity: 'high', detail: `Docker build targets remote daemon '${daemon.endpoint ?? daemon.context ?? 'unknown'}'.` }] : [],
        daemon
      },
      result
    };
  }
}
