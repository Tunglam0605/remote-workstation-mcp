import { PolicyEngine } from '../policy.js';
import { ProcessManager } from './process-manager.js';

export class TaskAdapter {
  constructor(private readonly policy: PolicyEngine, private readonly processes: ProcessManager) {}

  list() {
    return Object.entries(this.policy.config.tasks ?? {}).map(([name, task]) => ({
      name,
      program: task.program,
      args: task.args ?? [],
      cwd: task.cwd ?? '.'
    }));
  }

  async run(workspace: string, name: string, extraArgs: string[] = []) {
    const task = (this.policy.config.tasks ?? {})[name];
    if (!task) throw new Error(`Unknown task profile '${name}'.`);
    return this.processes.start(workspace, task.program, [...(task.args ?? []), ...extraArgs], task.cwd ?? '.');
  }
}
