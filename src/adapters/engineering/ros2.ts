import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProcessSnapshot } from '../../model.js';
import { PolicyEngine } from '../../policy.js';
import { PathGuard } from '../../security/path-guard.js';
import { ProcessManager } from '../process-manager.js';
import { EngineeringCommandRunner } from './command-runner.js';
import { resolveFirstExecutable } from './executable-resolver.js';

export interface Ros2RuntimeContext {
  distro?: string;
  workspaceSetup?: string;
  domainId?: number;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
}

function typedList(text: string): Array<{ name: string; types: string[] }> {
  return lines(text).map(line => {
    const match = line.match(/^(\S+)\s+\[(.*)\]$/);
    if (!match) return { name: line, types: [] };
    return { name: match[1]!, types: match[2]!.split(',').map(item => item.trim()).filter(Boolean) };
  });
}

function helperPath(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../scripts', name);
}

function validateRuntime(runtime: Ros2RuntimeContext | undefined): void {
  if (!runtime) return;
  if (runtime.distro && !/^[a-z][a-z0-9_-]{0,31}$/.test(runtime.distro)) {
    throw new Error('ROS 2 distro must be a simple lowercase distro identifier.');
  }
  if (runtime.domainId !== undefined && (!Number.isInteger(runtime.domainId) || runtime.domainId < 0 || runtime.domainId > 232)) {
    throw new Error('ROS_DOMAIN_ID must be an integer in the range 0..232.');
  }
}

export class Ros2Adapter {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly paths: PathGuard,
    private readonly runner: EngineeringCommandRunner,
    private readonly processes: ProcessManager
  ) {}

  private async command(): Promise<string> {
    const ros2 = await resolveFirstExecutable(['ros2']);
    if (!ros2) throw new Error('ROS 2 CLI (ros2) is unavailable in the RWMCP runtime environment.');
    return ros2.path;
  }

  private async run(
    workspace: string,
    cwdRelative: string,
    args: string[],
    timeoutMs = 15_000,
    runtime?: Ros2RuntimeContext
  ) {
    this.policy.assertEngineeringEnabled();
    validateRuntime(runtime);
    const cwd = await this.paths.resolveExisting(workspace, cwdRelative);

    let program: string;
    let commandArgs: string[];

    if (!runtime || (!runtime.distro && !runtime.workspaceSetup && runtime.domainId === undefined)) {
      program = await this.command();
      commandArgs = args;
    } else {
      this.policy.assertEngineeringExecute();
      if (os.platform() === 'win32') {
        throw new Error('ROS 2 project environment bootstrap is currently supported on POSIX hosts only; configure ros2 on PATH for Windows.');
      }
      if (!runtime.distro) {
        throw new Error('ros2.distro is required when project environment bootstrap is enabled.');
      }
      const distroSetup = `/opt/ros/${runtime.distro}/setup.bash`;
      try {
        await fs.access(distroSetup);
      } catch {
        throw new Error(`ROS 2 distro setup was not found: ${distroSetup}`);
      }
      const workspaceSetup = runtime.workspaceSetup
        ? await this.paths.resolveExisting(workspace, runtime.workspaceSetup)
        : '';
      const bash = await resolveFirstExecutable(['bash']);
      if (!bash) throw new Error('bash is required for ROS 2 environment bootstrap.');
      program = bash.path;
      commandArgs = [
        helperPath('ros2-run.sh'),
        distroSetup,
        workspaceSetup,
        runtime.domainId === undefined ? '' : String(runtime.domainId),
        ...args
      ];
    }

    const result = await this.runner.run(program, commandArgs, cwd, timeoutMs);
    if (result.exitCode !== 0) {
      throw new Error(`ros2 ${args.slice(0, 2).join(' ')} failed: ${result.stderr || result.stdout}`);
    }
    return result;
  }

  async build(
    workspace: string,
    cwd = '.',
    runtime?: Ros2RuntimeContext,
    options: { symlinkInstall?: boolean; mergeInstall?: boolean; packagesSelect?: string[] } = {}
  ) {
    this.policy.assertEngineeringExecute();
    validateRuntime(runtime);
    const resolvedCwd = await this.paths.resolveExisting(workspace, cwd);
    const packages = options.packagesSelect ?? [];
    if (packages.length > 50 || packages.some(name => !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name))) {
      throw new Error('ROS 2 packagesSelect must contain at most 50 safe package names.');
    }
    if (options.symlinkInstall && options.mergeInstall) {
      throw new Error('colcon --symlink-install and --merge-install cannot be combined.');
    }

    const args = ['build'];
    if (options.symlinkInstall ?? true) args.push('--symlink-install');
    if (options.mergeInstall) args.push('--merge-install');
    if (packages.length) args.push('--packages-select', ...packages);

    let program: string;
    let commandArgs: string[];
    if (runtime?.distro) {
      if (os.platform() === 'win32') {
        throw new Error('Profile-driven colcon environment bootstrap is currently supported on POSIX hosts only.');
      }
      const distroSetup = `/opt/ros/${runtime.distro}/setup.bash`;
      try {
        await fs.access(distroSetup);
      } catch {
        throw new Error(`ROS 2 distro setup was not found: ${distroSetup}`);
      }
      const bash = await resolveFirstExecutable(['bash']);
      if (!bash) throw new Error('bash is required for ROS 2 colcon environment bootstrap.');
      program = bash.path;
      commandArgs = [
        helperPath('ros2-colcon-run.sh'),
        distroSetup,
        '',
        runtime.domainId === undefined ? '' : String(runtime.domainId),
        ...args
      ];
    } else {
      const colcon = await resolveFirstExecutable(['colcon']);
      if (!colcon) throw new Error('colcon is unavailable in the RWMCP runtime environment.');
      program = colcon.path;
      commandArgs = args;
    }

    const result = await this.runner.run(program, commandArgs, resolvedCwd, 600_000);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`colcon build failed: ${result.stderr || result.stdout || `exit=${result.exitCode}`}`);
    }
    return {
      provider: 'colcon' as const,
      options: {
        symlinkInstall: options.symlinkInstall ?? true,
        mergeInstall: options.mergeInstall ?? false,
        packagesSelect: packages
      },
      result
    };
  }

  async topicInfo(workspace: string, topic: string, cwd = '.', runtime?: Ros2RuntimeContext) {
    if (!/^\/[A-Za-z0-9_\/]+$/.test(topic)) throw new Error('Invalid ROS 2 topic name.');
    const result = await this.run(workspace, cwd, ['topic', 'info', topic, '--verbose'], 15_000, runtime);
    return { topic, output: result.stdout.trim() };
  }

  async nodeList(workspace: string, cwd = '.', runtime?: Ros2RuntimeContext) {
    const result = await this.run(workspace, cwd, ['node', 'list'], 15_000, runtime);
    return lines(result.stdout);
  }

  async topicList(workspace: string, cwd = '.', runtime?: Ros2RuntimeContext) {
    const result = await this.run(workspace, cwd, ['topic', 'list', '-t'], 15_000, runtime);
    return typedList(result.stdout);
  }

  async topicEchoOnce(workspace: string, topic: string, cwd = '.', timeoutMs = 10_000, runtime?: Ros2RuntimeContext) {
    if (!/^\/[A-Za-z0-9_\/]+$/.test(topic)) throw new Error('Invalid ROS 2 topic name.');
    const result = await this.run(workspace, cwd, ['topic', 'echo', topic, '--once'], timeoutMs, runtime);
    return { topic, output: result.stdout };
  }

  async serviceList(workspace: string, cwd = '.', runtime?: Ros2RuntimeContext) {
    const result = await this.run(workspace, cwd, ['service', 'list', '-t'], 15_000, runtime);
    return typedList(result.stdout);
  }

  async serviceCall(workspace: string, service: string, type: string, request: unknown, cwd = '.', runtime?: Ros2RuntimeContext) {
    this.policy.assertHardwareMutation();
    if (!/^\/[A-Za-z0-9_\/]+$/.test(service)) throw new Error('Invalid ROS 2 service name.');
    if (!/^[A-Za-z0-9_]+\/[A-Za-z0-9_]+\/[A-Za-z0-9_]+$/.test(type)) throw new Error('Invalid ROS 2 service type.');
    const payload = JSON.stringify(request ?? {});
    const result = await this.run(workspace, cwd, ['service', 'call', service, type, payload], 30_000, runtime);
    return { service, type, output: result.stdout };
  }

  async actionList(workspace: string, cwd = '.', runtime?: Ros2RuntimeContext) {
    const result = await this.run(workspace, cwd, ['action', 'list', '-t'], 15_000, runtime);
    return typedList(result.stdout);
  }

  async paramList(workspace: string, node: string, cwd = '.', runtime?: Ros2RuntimeContext) {
    if (!/^\/[A-Za-z0-9_\/]+$/.test(node)) throw new Error('Invalid ROS 2 node name.');
    const result = await this.run(workspace, cwd, ['param', 'list', node], 15_000, runtime);
    return lines(result.stdout);
  }

  async paramGet(workspace: string, node: string, parameter: string, cwd = '.', runtime?: Ros2RuntimeContext) {
    if (!/^\/[A-Za-z0-9_\/]+$/.test(node) || !/^[A-Za-z0-9_.]+$/.test(parameter)) throw new Error('Invalid ROS 2 node or parameter name.');
    const result = await this.run(workspace, cwd, ['param', 'get', node, parameter], 15_000, runtime);
    return { node, parameter, output: result.stdout.trim() };
  }

  async paramSet(workspace: string, node: string, parameter: string, value: string, cwd = '.', runtime?: Ros2RuntimeContext) {
    this.policy.assertHardwareMutation();
    if (!/^\/[A-Za-z0-9_\/]+$/.test(node) || !/^[A-Za-z0-9_.]+$/.test(parameter)) throw new Error('Invalid ROS 2 node or parameter name.');
    if (Buffer.byteLength(value, 'utf8') > 8192) throw new Error('ROS 2 parameter value is too large.');
    const result = await this.run(workspace, cwd, ['param', 'set', node, parameter, value], 15_000, runtime);
    return { node, parameter, output: result.stdout.trim() };
  }

  async bagRecord(workspace: string, topics: string[], output: string, cwd = '.'): Promise<ProcessSnapshot> {
    this.policy.assertHardwareMutation();
    if (topics.length < 1 || topics.length > 100 || topics.some(topic => !/^\/[A-Za-z0-9_\/]+$/.test(topic))) {
      throw new Error('ROS 2 bag topics must contain 1..100 valid absolute topic names.');
    }
    if (!/^[A-Za-z0-9._-]+$/.test(output)) throw new Error('ros2 bag output name must be a simple relative name.');
    const command = await this.command();
    return this.processes.start(workspace, command, ['bag', 'record', '-o', output, ...topics], cwd, true);
  }

  async packageList(workspace: string, cwd = '.', runtime?: Ros2RuntimeContext) {
    const result = await this.run(workspace, cwd, ['pkg', 'list'], 20_000, runtime);
    return lines(result.stdout);
  }

  async diagnostics(workspace: string, cwd = '.', runtime?: Ros2RuntimeContext) {
    const [health, packages] = await Promise.all([
      this.health(workspace, cwd, runtime),
      this.packageList(workspace, cwd, runtime)
    ]);
    return {
      ...health,
      summary: {
        ...health.summary,
        packages: packages.length
      },
      packages
    };
  }

  async health(workspace: string, cwd = '.', runtime?: Ros2RuntimeContext) {
    this.policy.assertEngineeringExecute();
    const nodes = await this.nodeList(workspace, cwd, runtime);
    const topics = await this.topicList(workspace, cwd, runtime);
    const services = await this.serviceList(workspace, cwd, runtime);
    const actions = await this.actionList(workspace, cwd, runtime);
    return {
      environment: {
        distro: runtime?.distro,
        workspaceSetup: runtime?.workspaceSetup,
        domainId: runtime?.domainId
      },
      summary: {
        nodes: nodes.length,
        topics: topics.length,
        services: services.length,
        actions: actions.length
      },
      nodes,
      topics,
      services,
      actions
    };
  }
}
