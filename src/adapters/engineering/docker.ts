import { PolicyEngine } from '../../policy.js';
import { PathGuard } from '../../security/path-guard.js';
import { EngineeringCommandRunner } from './command-runner.js';
import { resolveFirstExecutable } from './executable-resolver.js';

function validateContainer(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error('Invalid container name/id.');
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
    validateContainer(container);
    const result = await this.run(workspace, cwd, ['inspect', container]);
    return JSON.parse(result.stdout) as unknown;
  }

  async logs(workspace: string, container: string, tail = 200, cwd = '.') {
    this.policy.assertEngineeringEnabled();
    validateContainer(container);
    if (!Number.isInteger(tail) || tail < 1 || tail > 5000) throw new Error('tail must be in range 1..5000.');
    const result = await this.run(workspace, cwd, ['logs', '--tail', String(tail), container]);
    return { container, stdout: result.stdout, stderr: result.stderr };
  }

  async start(workspace: string, container: string, cwd = '.') {
    this.policy.assertHardwareMutation();
    validateContainer(container);
    const result = await this.run(workspace, cwd, ['start', container]);
    return { container, output: result.stdout.trim() };
  }

  async stop(workspace: string, container: string, timeoutSeconds = 10, cwd = '.') {
    this.policy.assertHardwareMutation();
    validateContainer(container);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 120) throw new Error('timeoutSeconds must be in range 0..120.');
    const result = await this.run(workspace, cwd, ['stop', '-t', String(timeoutSeconds), container]);
    return { container, output: result.stdout.trim() };
  }

  async exec(workspace: string, container: string, program: string, args: string[] = [], cwd = '.') {
    this.policy.assertHardwareMutation();
    validateContainer(container);
    if (!/^[A-Za-z0-9_./:-]+$/.test(program)) throw new Error('Container program contains unsupported characters.');
    const programName = program.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
    if (new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']).has(programName)) {
      throw new Error('Container shell/interpreter hosts are not allowed by container_exec; use a direct executable with argv.');
    }
    if (args.length > 100 || args.some(arg => Buffer.byteLength(arg, 'utf8') > 8192)) throw new Error('Container argv exceeds limits.');
    const result = await this.run(workspace, cwd, ['exec', container, program, ...args], 60_000);
    return { container, program, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  async imageBuild(workspace: string, contextPath = '.', tag?: string) {
    this.policy.assertHardwareMutation();
    if (tag && !/^[A-Za-z0-9._/:\-]+$/.test(tag)) throw new Error('Docker image tag contains unsupported characters.');
    await this.paths.resolveExisting(workspace, contextPath);
    const args = ['build', ...(tag ? ['-t', tag] : []), '.'];
    const result = await this.run(workspace, contextPath, args, this.policy.config.engineering?.maxCommandRuntimeMs);
    return { tag, result };
  }
}
