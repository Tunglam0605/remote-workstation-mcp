import { PolicyEngine } from '../../policy.js';
import { PathGuard } from '../../security/path-guard.js';
import { EngineeringCommandRunner } from './command-runner.js';
import { resolveFirstExecutable } from './executable-resolver.js';

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text.trim()) as T;
  } catch {
    throw new Error(`PlatformIO ${label} did not return valid JSON.`);
  }
}

export class PlatformioAdapter {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly paths: PathGuard,
    private readonly runner: EngineeringCommandRunner
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
}
