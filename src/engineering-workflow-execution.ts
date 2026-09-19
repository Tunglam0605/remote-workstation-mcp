import {
  EngineeringWorkflowEngine,
  type EngineeringWorkflowId,
  type EngineeringWorkflowOverrides
} from './adapters/engineering/workflow-engine.js';
import { deriveQualityCompatibilityInput, type QualityObservationStore } from './quality-learning.js';
import type { NodeInterlockStore } from './node-interlock.js';
import type { WorkflowRunStore } from './workflow-run-store.js';

export class EngineeringWorkflowExecutionService {
  constructor(
    private readonly engine: EngineeringWorkflowEngine,
    private readonly workflowRuns: WorkflowRunStore,
    private readonly qualityObservations: QualityObservationStore,
    private readonly nodeInterlocks: NodeInterlockStore
  ) {}

  async run(
    workspace: string,
    projectPath: string,
    workflow: string,
    runtimeParameters: EngineeringWorkflowOverrides = {}
  ): Promise<Record<string, unknown>> {
    const run = await this.workflowRuns.begin(workspace, projectPath, workflow);
    let interlock: Awaited<ReturnType<NodeInterlockStore['acquireWorkflow']>> | undefined;
    try {
      interlock = await this.nodeInterlocks.acquireWorkflow(`${workflow}:${workspace}:${projectPath}`);
      const output = await this.engine.run(
        workspace,
        projectPath,
        workflow as EngineeringWorkflowId,
        runtimeParameters
      );
      const outputStatus = typeof output === 'object' && output && 'status' in output
        ? String((output as { status?: unknown }).status ?? '')
        : '';
      const explicitOutcome = ['succeeded', 'blocked', 'failed'].includes(outputStatus);
      const runStatus = outputStatus === 'succeeded'
        ? 'succeeded'
        : outputStatus === 'blocked'
          ? 'blocked'
          : outputStatus === 'failed'
            ? 'failed'
            : 'succeeded';
      const finished = await this.workflowRuns.finish(run.id, runStatus);

      let qualityObservation: unknown;
      try {
        const observation = await this.qualityObservations.observe(finished, {
          completionSource: 'workflow-output',
          explicitOutcome,
          compatibility: deriveQualityCompatibilityInput({
            workspace,
            projectPath,
            workflow,
            runtimeParameters: runtimeParameters as Record<string, unknown>,
            output
          })
        });
        qualityObservation = {
          recorded: observation !== undefined,
          disabled: observation === undefined,
          observation: observation ?? null
        };
      } catch (telemetryError) {
        qualityObservation = {
          recorded: false,
          error: (telemetryError instanceof Error ? telemetryError.message : String(telemetryError)).slice(0, 512)
        };
      }

      return {
        ...(typeof output === 'object' && output ? output : { output }),
        workflowRun: finished,
        qualityObservation
      };
    } catch (error) {
      const finished = await this.workflowRuns.finish(
        run.id,
        'failed',
        error instanceof Error ? error.message : String(error)
      );
      await this.qualityObservations.observe(finished, {
        completionSource: 'exception',
        explicitOutcome: true,
        compatibility: deriveQualityCompatibilityInput({
          workspace,
          projectPath,
          workflow,
          runtimeParameters: runtimeParameters as Record<string, unknown>
        })
      }).catch(() => undefined);
      throw error;
    } finally {
      if (interlock) await this.nodeInterlocks.release(interlock.id);
    }
  }
}
