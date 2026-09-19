import type { EngineeringWorkflowExecutionService } from './engineering-workflow-execution.js';
import type { TaskExecutionCoordinator } from './task-executor.js';
import type { TaskGraphStore } from './task-graph.js';

export class TaskWorkflowExecutionService {
  constructor(
    private readonly taskGraphs: TaskGraphStore,
    private readonly taskExecutor: TaskExecutionCoordinator,
    private readonly workflowExecution: EngineeringWorkflowExecutionService
  ) {}

  async execute(objectiveId: string, taskId: string) {
    const objective = await this.taskGraphs.get(objectiveId);
    const task = objective.tasks.find(item => item.id === taskId);
    if (!task) throw new Error(`Unknown Work Task '${taskId}'.`);
    if (!task.execution || task.execution.kind !== 'engineering-workflow') {
      throw new Error(`TASK_NOT_DISPATCHABLE: Work Task '${taskId}' has no typed engineering-workflow binding.`);
    }

    const binding = task.execution;
    const executed = await this.taskExecutor.execute(objectiveId, taskId, async () => {
      const output = await this.workflowExecution.run(
        binding.workspace,
        binding.projectPath,
        binding.workflow,
        binding.parameters
      );
      const workflowRun = output.workflowRun as { status?: unknown } | undefined;
      if (workflowRun?.status !== 'succeeded') {
        throw new Error(
          `TASK_WORKFLOW_NOT_SUCCEEDED: workflow status=${String(workflowRun?.status ?? 'unknown')}.`
        );
      }
      return output;
    });

    return {
      task: executed.task,
      output: executed.result
    };
  }
}
