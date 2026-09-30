import * as z from 'zod/v4';
import type {
  EngineeringWorkflowContribution,
  EngineeringWorkflowContributionExecution,
  EngineeringWorkflowStepResult
} from '../../adapters/engineering/workflow-contribution.js';
import { currentWorkSessionId } from '../../security/execution-context.js';
import { IMPLICIT_WORK_SESSION_ID } from '../../work-session.js';
import type { ComfyUiArtifactImporter } from './comfyui-artifacts.js';
import type { ComfyUiParameters, ComfyUiPresetJobs } from './comfyui-jobs.js';
import type { MediaVideoAdapter } from './media-adapter.js';
import type { RemotionRenderAdapter } from './remotion-render.js';

const presetId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const parameterValue = z.union([z.string().max(16_384), z.number().finite(), z.boolean()]);
const mediaParameters = z.record(
  z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/),
  parameterValue
).superRefine((value, ctx) => {
  if (Object.keys(value).length > 64) {
    ctx.addIssue({ code: 'custom', message: 'Media parameters are limited to 64 bindings.' });
  }
});

const remotionParameters = z.object({
  mediaPresetId: presetId,
  mediaParameters: mediaParameters.default({}),
  mediaOutput: z.string().min(1).max(1024),
  mediaOperationTimeoutMs: z.number().int().min(5_000).max(3_600_000).default(900_000)
}).strip();

const comfyParameters = z.object({
  mediaPresetId: presetId,
  mediaParameters: mediaParameters.default({}),
  mediaOutput: z.string().min(1).max(1024),
  mediaArtifactIndex: z.number().int().min(0).max(255).default(0),
  mediaPollIntervalMs: z.number().int().min(500).max(5_000).default(1_000),
  mediaCompletionTimeoutMs: z.number().int().min(1_000).max(300_000).default(120_000),
  mediaMaxBytes: z.number().int().min(1).max(1_073_741_824).default(536_870_912)
}).strip();

type ScalarParameters = Record<string, string | number | boolean>;

interface MediaWorkflowDependencies {
  adapter: MediaVideoAdapter;
  remotion: RemotionRenderAdapter;
  jobs: ComfyUiPresetJobs;
  artifacts: ComfyUiArtifactImporter;
}

function requireExplicitWorkSession(): void {
  if (currentWorkSessionId() === IMPLICIT_WORK_SESSION_ID) {
    throw new Error('Media mutation workflows require an explicit Work Session.');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function capture<T>(
  steps: EngineeringWorkflowStepResult[],
  id: string,
  operation: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false }> {
  const started = Date.now();
  try {
    const value = await operation();
    steps.push({ id, status: 'succeeded', durationMs: Date.now() - started, result: value });
    return { ok: true, value };
  } catch (error) {
    steps.push({ id, status: 'failed', durationMs: Date.now() - started, error: errorMessage(error) });
    return { ok: false };
  }
}

function mediaAccepted(probe: Awaited<ReturnType<MediaVideoAdapter['probeFile']>>): boolean {
  return Boolean(
    probe.format.sizeBytes &&
    probe.format.sizeBytes > 0 &&
    probe.streams.length > 0
  );
}

function blockedExecution(plan: Record<string, unknown>, reason: string): EngineeringWorkflowContributionExecution {
  return {
    status: 'blocked',
    steps: [{ id: 'preflight', status: 'blocked', durationMs: 0, error: reason }],
    outputs: { plan }
  };
}

export function mediaWorkflowContributions(
  deps: MediaWorkflowDependencies
): EngineeringWorkflowContribution[] {
  const remotion: EngineeringWorkflowContribution = {
    id: 'media.remotion.render_accept',
    description: 'Validate one owner-local Remotion preset, render a project-scoped MP4, then require bounded FFprobe acceptance evidence before reporting success.',
    destructive: true,
    async plan({ workspace, projectPath, parameters }) {
      const parsed = remotionParameters.parse(parameters);
      const [renderPlan, provider] = await Promise.all([
        deps.remotion.plan(
          workspace,
          projectPath,
          parsed.mediaPresetId,
          parsed.mediaParameters as ScalarParameters,
          parsed.mediaOutput
        ),
        deps.adapter.providerStatus()
      ]);
      const blockers: string[] = [];
      if (!renderPlan.localRemotionAvailable) blockers.push('project-local Remotion CLI is unavailable');
      if (!renderPlan.browserAvailable) blockers.push('local Chrome/Chromium is unavailable');
      if (!provider.ffprobeAvailable) blockers.push('FFprobe is unavailable for acceptance');
      return {
        ready: blockers.length === 0,
        steps: ['media.remotion.plan', 'media.remotion.render', 'media.acceptance.ffprobe'],
        blockers,
        resolved: {
          presetId: parsed.mediaPresetId,
          output: parsed.mediaOutput,
          parameterKeys: Object.keys(parsed.mediaParameters).sort(),
          operationTimeoutMs: parsed.mediaOperationTimeoutMs
        },
        provider: {
          ffprobeAvailable: provider.ffprobeAvailable
        },
        render: renderPlan
      };
    },
    async run({ workspace, projectPath, parameters, plan }) {
      requireExplicitWorkSession();
      const parsed = remotionParameters.parse(parameters);
      const blockers = Array.isArray(plan.blockers) ? plan.blockers.map(String) : [];
      if (plan.ready === false || blockers.length) {
        return blockedExecution(plan, blockers.join('; ') || 'Remotion workflow preflight is not ready.');
      }

      const steps: EngineeringWorkflowStepResult[] = [];
      const rendered = await capture(steps, 'media.remotion.render', () =>
        deps.remotion.render(
          workspace,
          projectPath,
          parsed.mediaPresetId,
          parsed.mediaParameters as ScalarParameters,
          parsed.mediaOutput,
          parsed.mediaOperationTimeoutMs
        )
      );
      if (!rendered.ok) return { status: 'failed', steps };

      const probe = await capture(steps, 'media.acceptance.ffprobe', () =>
        deps.adapter.probeFile(workspace, projectPath, parsed.mediaOutput, 15_000)
      );
      if (!probe.ok || !mediaAccepted(probe.value)) {
        if (probe.ok) {
          steps.push({
            id: 'media.acceptance.validate',
            status: 'failed',
            durationMs: 0,
            error: 'FFprobe did not report a non-empty media stream set.'
          });
        }
        return {
          status: 'failed',
          steps,
          outputs: { artifact: rendered.value, acceptance: probe.ok ? probe.value : undefined }
        };
      }

      return {
        status: 'succeeded',
        steps,
        outputs: {
          artifact: rendered.value,
          acceptance: probe.value
        }
      };
    }
  };

  const comfy: EngineeringWorkflowContribution = {
    id: 'media.comfyui.generate_import_accept',
    description: 'Validate and submit one owner-local ComfyUI preset, bounded-poll completion, atomically import one durable output artifact, then require FFprobe acceptance evidence.',
    destructive: true,
    async plan({ workspace, projectPath, parameters }) {
      const parsed = comfyParameters.parse(parameters);
      const jobPlan = await deps.jobs.plan(parsed.mediaPresetId, parsed.mediaParameters as ComfyUiParameters);
      const provider = await deps.adapter.providerStatus();
      const blockers: string[] = [];
      let comfyStatus: unknown;
      try {
        comfyStatus = await deps.adapter.comfyUiStatus(jobPlan.provider.profileId, 3_000);
      } catch (error) {
        blockers.push(`ComfyUI preflight failed: ${errorMessage(error)}`);
      }
      if (!provider.ffprobeAvailable) blockers.push('FFprobe is unavailable for acceptance');
      return {
        ready: blockers.length === 0,
        steps: [
          'media.comfyui.preflight',
          'media.comfyui.submit',
          'media.comfyui.wait',
          'media.comfyui.import',
          'media.acceptance.ffprobe'
        ],
        blockers,
        resolved: {
          presetId: parsed.mediaPresetId,
          profileId: jobPlan.provider.profileId,
          output: parsed.mediaOutput,
          artifactIndex: parsed.mediaArtifactIndex,
          parameterKeys: Object.keys(parsed.mediaParameters).sort(),
          pollIntervalMs: parsed.mediaPollIntervalMs,
          completionTimeoutMs: parsed.mediaCompletionTimeoutMs,
          maxBytes: parsed.mediaMaxBytes
        },
        job: jobPlan,
        provider: {
          ffprobeAvailable: provider.ffprobeAvailable,
          comfyui: comfyStatus
        },
        project: { workspace, projectPath }
      };
    },
    async run({ workspace, projectPath, parameters, plan }) {
      requireExplicitWorkSession();
      const parsed = comfyParameters.parse(parameters);
      const blockers = Array.isArray(plan.blockers) ? plan.blockers.map(String) : [];
      if (plan.ready === false || blockers.length) {
        return blockedExecution(plan, blockers.join('; ') || 'ComfyUI workflow preflight is not ready.');
      }

      const steps: EngineeringWorkflowStepResult[] = [];
      const submitted = await capture(steps, 'media.comfyui.submit', () =>
        deps.jobs.submit(parsed.mediaPresetId, parsed.mediaParameters as ComfyUiParameters, 10_000)
      );
      if (!submitted.ok) return { status: 'failed', steps };

      const deadline = Date.now() + parsed.mediaCompletionTimeoutMs;
      const maxPolls = Math.ceil(parsed.mediaCompletionTimeoutMs / parsed.mediaPollIntervalMs) + 1;
      let finalStatus: Awaited<ReturnType<ComfyUiPresetJobs['status']>> | undefined;
      let polls = 0;
      const waitStarted = Date.now();
      while (Date.now() <= deadline && polls < maxPolls) {
        polls += 1;
        try {
          const status = await deps.jobs.status(submitted.value.profileId, submitted.value.promptId, 5_000);
          if (status.found && status.completed) {
            finalStatus = status;
            break;
          }
        } catch (error) {
          if (Date.now() >= deadline) {
            steps.push({
              id: 'media.comfyui.wait',
              status: 'failed',
              durationMs: Date.now() - waitStarted,
              error: errorMessage(error)
            });
            return {
              status: 'failed',
              steps,
              outputs: { submission: submitted.value, polls }
            };
          }
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(parsed.mediaPollIntervalMs, remaining)));
      }

      if (!finalStatus) {
        steps.push({
          id: 'media.comfyui.wait',
          status: 'failed',
          durationMs: Date.now() - waitStarted,
          error: `ComfyUI completion deadline exceeded after ${polls} bounded poll(s). The remote job is not implicitly cancelled.`
        });
        return {
          status: 'failed',
          steps,
          outputs: { submission: submitted.value, polls }
        };
      }
      steps.push({
        id: 'media.comfyui.wait',
        status: 'succeeded',
        durationMs: Date.now() - waitStarted,
        result: { polls, status: finalStatus }
      });

      const imported = await capture(steps, 'media.comfyui.import', () =>
        deps.artifacts.importArtifact(
          submitted.value.profileId,
          submitted.value.promptId,
          parsed.mediaArtifactIndex,
          workspace,
          projectPath,
          parsed.mediaOutput,
          { timeoutMs: 60_000, maxBytes: parsed.mediaMaxBytes }
        )
      );
      if (!imported.ok) {
        return {
          status: 'failed',
          steps,
          outputs: { submission: submitted.value, completion: finalStatus }
        };
      }

      const probe = await capture(steps, 'media.acceptance.ffprobe', () =>
        deps.adapter.probeFile(workspace, projectPath, parsed.mediaOutput, 15_000)
      );
      if (!probe.ok || !mediaAccepted(probe.value)) {
        if (probe.ok) {
          steps.push({
            id: 'media.acceptance.validate',
            status: 'failed',
            durationMs: 0,
            error: 'FFprobe did not report a non-empty media stream set.'
          });
        }
        return {
          status: 'failed',
          steps,
          outputs: {
            submission: submitted.value,
            completion: finalStatus,
            artifact: imported.value,
            acceptance: probe.ok ? probe.value : undefined
          }
        };
      }

      return {
        status: 'succeeded',
        steps,
        outputs: {
          submission: submitted.value,
          completion: finalStatus,
          artifact: imported.value,
          acceptance: probe.value
        }
      };
    }
  };

  return [remotion, comfy];
}
