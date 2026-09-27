import { PolicyEngine } from '../../policy.js';
import { PathGuard } from '../../security/path-guard.js';
import type { EngineeringCommandResult } from '../../engineering/types.js';
import { EngineeringCommandRunner } from './command-runner.js';
import { resolveFirstExecutable } from './executable-resolver.js';
import { EngineeringResourceManager } from './resource-manager.js';

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text.trim()) as T;
  } catch {
    throw new Error(`PlatformIO ${label} did not return valid JSON.`);
  }
}

function normalizeEnvironment(environment: string): string {
  const normalized = environment.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(normalized)) {
    throw new Error('PlatformIO environment must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.');
  }
  return normalized;
}

function normalizeUploadPort(uploadPort: string): string {
  const normalized = uploadPort.trim();
  if (!normalized || normalized.length > 256 || /[\r\n*?\[\]]/.test(normalized) || normalized.includes(String.fromCharCode(0))) {
    throw new Error('PlatformIO upload port must be one exact bounded port/address without wildcards or control characters.');
  }
  return normalized;
}

function uploadResourceId(uploadPort: string): string {
  return /^COM\d+$/i.test(uploadPort) || /^\/dev\//.test(uploadPort)
    ? `serial:${uploadPort}`
    : `platformio-upload:${uploadPort}`;
}

function commandSucceeded(result: EngineeringCommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
}

export class PlatformioAdapter {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly paths: PathGuard,
    private readonly runner: EngineeringCommandRunner,
    private readonly resources: EngineeringResourceManager
  ) {}

  private async executable(): Promise<string> {
    const resolved = await resolveFirstExecutable(['pio', 'platformio']);
    if (!resolved) throw new Error('PlatformIO Core CLI is unavailable.');
    return resolved.path;
  }

  async diagnostics(workspace: string, projectPath = '.') {
    this.policy.assertEngineeringExecute();
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const executable = await this.executable();
    const [version, metadata, projectConfig, systemInfo, devices] = await Promise.all([
      this.runner.run(executable, ['--version'], cwd, 10_000),
      this.runner.run(executable, ['project', 'metadata', '--json-output'], cwd, 60_000),
      this.runner.run(executable, ['project', 'config', '--lint', '--json-output'], cwd, 30_000),
      this.runner.run(executable, ['system', 'info', '--json-output'], cwd, 20_000),
      this.runner.run(executable, ['device', 'list', '--json-output'], cwd, 20_000)
    ]);
    if (version.exitCode !== 0 || version.timedOut) {
      throw new Error(`PlatformIO version probe failed: ${version.stderr || version.stdout || `exit=${version.exitCode}`}`);
    }
    if (metadata.exitCode !== 0 || metadata.timedOut) {
      throw new Error(`PlatformIO metadata failed: ${metadata.stderr || metadata.stdout || `exit=${metadata.exitCode}`}`);
    }
    const warnings: string[] = [];
    let computedConfig: unknown;
    let system: unknown;
    if (projectConfig.exitCode === 0 && !projectConfig.timedOut) {
      computedConfig = parseJson<unknown>(projectConfig.stdout, 'project config');
    } else {
      warnings.push(`PlatformIO project config lint failed: ${projectConfig.stderr || projectConfig.stdout || `exit=${projectConfig.exitCode}`}`);
    }
    if (systemInfo.exitCode === 0 && !systemInfo.timedOut) {
      system = parseJson<unknown>(systemInfo.stdout, 'system info');
    } else {
      warnings.push(`PlatformIO system info failed: ${systemInfo.stderr || systemInfo.stdout || `exit=${systemInfo.exitCode}`}`);
    }
    let serialDevices: unknown[] = [];
    if (devices.exitCode === 0 && !devices.timedOut) {
      const parsed = parseJson<unknown>(devices.stdout, 'device list');
      serialDevices = Array.isArray(parsed) ? parsed.slice(0, 128) : [];
    } else {
      warnings.push(`PlatformIO device discovery failed: ${devices.stderr || devices.stdout || `exit=${devices.exitCode}`}`);
    }
    return {
      provider: 'platformio' as const,
      version: (version.stdout || version.stderr).trim(),
      metadata: parseJson<unknown>(metadata.stdout, 'project metadata'),
      computedConfig,
      system,
      serialDevices,
      warnings
    };
  }

  async build(workspace: string, projectPath: string, environment: string) {
    this.policy.assertEngineeringExecute();
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const executable = await this.executable();
    const selectedEnvironment = normalizeEnvironment(environment);
    const result = await this.runner.run(executable, ['run', '--environment', selectedEnvironment], cwd, 20 * 60_000);
    return {
      provider: 'platformio' as const,
      environment: selectedEnvironment,
      result,
      succeeded: commandSucceeded(result)
    };
  }

  async upload(workspace: string, projectPath: string, environment: string, uploadPort: string) {
    this.policy.assertEngineeringExecute();
    this.policy.assertHardwareMutation();
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const executable = await this.executable();
    const selectedEnvironment = normalizeEnvironment(environment);
    const selectedUploadPort = normalizeUploadPort(uploadPort);
    const resourceId = uploadResourceId(selectedUploadPort);
    const result = await this.resources.withLease(resourceId, 'flashing', () =>
      this.runner.run(
        executable,
        ['run', '--environment', selectedEnvironment, '--target', 'upload', '--upload-port', selectedUploadPort],
        cwd,
        20 * 60_000
      )
    );
    return {
      provider: 'platformio' as const,
      environment: selectedEnvironment,
      uploadPort: selectedUploadPort,
      resourceId,
      result,
      succeeded: commandSucceeded(result)
    };
  }
}
