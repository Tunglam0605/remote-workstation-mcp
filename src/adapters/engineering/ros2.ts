import type { ProcessSnapshot } from '../../model.js';
import { PolicyEngine } from '../../policy.js';
import { PathGuard } from '../../security/path-guard.js';
import { ProcessManager } from '../process-manager.js';
import { EngineeringCommandRunner } from './command-runner.js';
import { resolveFirstExecutable } from './executable-resolver.js';

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

  private async run(workspace: string, cwdRelative: string, args: string[], timeoutMs = 15_000) {
    this.policy.assertEngineeringEnabled();
    const cwd = await this.paths.resolveExisting(workspace, cwdRelative);
    const result = await this.runner.run(await this.command(), args, cwd, timeoutMs);
    if (result.exitCode !== 0) throw new Error(`ros2 ${args.slice(0, 2).join(' ')} failed: ${result.stderr || result.stdout}`);
    return result;
  }

  async nodeList(workspace: string, cwd = '.') {
    const result = await this.run(workspace, cwd, ['node', 'list']);
    return lines(result.stdout);
  }

  async topicList(workspace: string, cwd = '.') {
    const result = await this.run(workspace, cwd, ['topic', 'list', '-t']);
    return typedList(result.stdout);
  }

  async topicEchoOnce(workspace: string, topic: string, cwd = '.', timeoutMs = 10_000) {
    if (!/^\/[A-Za-z0-9_\/]+$/.test(topic)) throw new Error('Invalid ROS 2 topic name.');
    const result = await this.run(workspace, cwd, ['topic', 'echo', topic, '--once'], timeoutMs);
    return { topic, output: result.stdout };
  }

  async serviceList(workspace: string, cwd = '.') {
    const result = await this.run(workspace, cwd, ['service', 'list', '-t']);
    return typedList(result.stdout);
  }

  async serviceCall(workspace: string, service: string, type: string, request: unknown, cwd = '.') {
    this.policy.assertHardwareMutation();
    if (!/^\/[A-Za-z0-9_\/]+$/.test(service)) throw new Error('Invalid ROS 2 service name.');
    if (!/^[A-Za-z0-9_]+\/[A-Za-z0-9_]+\/[A-Za-z0-9_]+$/.test(type)) throw new Error('Invalid ROS 2 service type.');
    const payload = JSON.stringify(request ?? {});
    const result = await this.run(workspace, cwd, ['service', 'call', service, type, payload], 30_000);
    return { service, type, output: result.stdout };
  }

  async actionList(workspace: string, cwd = '.') {
    const result = await this.run(workspace, cwd, ['action', 'list', '-t']);
    return typedList(result.stdout);
  }

  async paramList(workspace: string, node: string, cwd = '.') {
    if (!/^\/[A-Za-z0-9_\/]+$/.test(node)) throw new Error('Invalid ROS 2 node name.');
    const result = await this.run(workspace, cwd, ['param', 'list', node]);
    return lines(result.stdout);
  }

  async paramGet(workspace: string, node: string, parameter: string, cwd = '.') {
    if (!/^\/[A-Za-z0-9_\/]+$/.test(node) || !/^[A-Za-z0-9_.]+$/.test(parameter)) throw new Error('Invalid ROS 2 node or parameter name.');
    const result = await this.run(workspace, cwd, ['param', 'get', node, parameter]);
    return { node, parameter, output: result.stdout.trim() };
  }

  async paramSet(workspace: string, node: string, parameter: string, value: string, cwd = '.') {
    this.policy.assertHardwareMutation();
    if (!/^\/[A-Za-z0-9_\/]+$/.test(node) || !/^[A-Za-z0-9_.]+$/.test(parameter)) throw new Error('Invalid ROS 2 node or parameter name.');
    if (Buffer.byteLength(value, 'utf8') > 8192) throw new Error('ROS 2 parameter value is too large.');
    const result = await this.run(workspace, cwd, ['param', 'set', node, parameter, value]);
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
}
