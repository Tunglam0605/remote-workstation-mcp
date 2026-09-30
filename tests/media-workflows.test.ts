import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaWorkflowContributions } from '../src/extensions/media/workflows.js';
import { runWithWorkSession } from '../src/security/execution-context.js';

function fixture() {
  let statusCalls = 0;
  const probe = {
    file: 'out.mp4',
    format: { formatName: 'mov,mp4', durationSeconds: 1, sizeBytes: 4096 },
    streams: [{ index: 0, codecType: 'video', codecName: 'h264' }]
  };
  const deps = {
    adapter: {
      async providerStatus() {
        return { ffprobeAvailable: true };
      },
      async comfyUiStatus(profileId: string) {
        return { profileId, reachable: true };
      },
      async probeFile() {
        return probe;
      }
    },
    remotion: {
      async plan(_workspace: string, _projectPath: string, presetId: string, parameters: object, output: string) {
        return {
          preset: { id: presetId },
          output,
          resolvedParameterKeys: Object.keys(parameters),
          localRemotionAvailable: true,
          browserAvailable: true,
          overwritePolicy: 'fail-if-exists'
        };
      },
      async render(_workspace: string, _projectPath: string, presetId: string, _parameters: object, output: string) {
        return {
          presetId,
          compositionId: 'Main',
          output,
          durationMs: 10,
          bytes: 4096,
          sha256: 'a'.repeat(64),
          backend: 'project-local-remotion'
        };
      }
    },
    jobs: {
      async plan(presetId: string, parameters: object) {
        return {
          preset: { id: presetId },
          provider: { profileId: 'local', endpoint: 'http://127.0.0.1:8188' },
          workflowNodeCount: 2,
          resolvedParameters: parameters,
          authority: 'owner-local-preset-only',
          submitEndpoint: '/prompt'
        };
      },
      async submit(presetId: string) {
        return {
          presetId,
          profileId: 'local',
          promptId: 'prompt-1',
          accepted: true,
          resolvedParameters: {}
        };
      },
      async status() {
        statusCalls += 1;
        return {
          profileId: 'local',
          promptId: 'prompt-1',
          found: true,
          completed: true,
          status: 'success',
          artifacts: [{ nodeId: '9', kind: 'videos', filename: 'clip.mp4', subfolder: '', type: 'output' }]
        };
      }
    },
    artifacts: {
      async importArtifact(
        _profileId: string,
        _promptId: string,
        _artifactIndex: number,
        workspace: string,
        projectPath: string,
        destination: string
      ) {
        return {
          profileId: 'local',
          promptId: 'prompt-1',
          artifact: { index: 0, filename: 'clip.mp4', type: 'output' },
          workspace,
          projectPath,
          destination,
          bytes: 4096,
          sha256: 'b'.repeat(64),
          contentType: 'video/mp4'
        };
      }
    }
  };
  return { deps, probe, getStatusCalls: () => statusCalls };
}

test('Remotion contribution plans safely and requires explicit Work Session for mutation', async () => {
  const f = fixture();
  const remotion = mediaWorkflowContributions(f.deps as never).find(item => item.id === 'media.remotion.render_accept')!;
  const parameters = {
    mediaPresetId: 'robotics',
    mediaParameters: { title: 'ROS 2' },
    mediaOutput: 'renders/lesson.mp4',
    mediaOperationTimeoutMs: 30_000
  };

  const plan = await remotion.plan({ workspace: 'w', projectPath: 'project', parameters });
  assert.equal(plan.ready, true);
  assert.deepEqual((plan.resolved as any).parameterKeys, ['title']);

  await assert.rejects(
    () => remotion.run({ workspace: 'w', projectPath: 'project', parameters, plan }),
    /explicit Work Session/
  );

  const executed = await runWithWorkSession('media-test-session', () =>
    remotion.run({ workspace: 'w', projectPath: 'project', parameters, plan })
  );
  assert.equal(executed.status, 'succeeded');
  assert.deepEqual(executed.steps.map(step => step.id), ['media.remotion.render', 'media.acceptance.ffprobe']);
  assert.equal((executed.outputs?.artifact as any).sha256, 'a'.repeat(64));
  assert.equal((executed.outputs?.acceptance as any).format.sizeBytes, 4096);
});

test('ComfyUI contribution composes bounded submit, completion, import and FFprobe acceptance', async () => {
  const f = fixture();
  const comfy = mediaWorkflowContributions(f.deps as never).find(item => item.id === 'media.comfyui.generate_import_accept')!;
  const parameters = {
    mediaPresetId: 'wan-lite',
    mediaParameters: { prompt: 'robot arm demo', seed: 42 },
    mediaOutput: 'artifacts/clip.mp4',
    mediaArtifactIndex: 0,
    mediaPollIntervalMs: 500,
    mediaCompletionTimeoutMs: 2_000,
    mediaMaxBytes: 10_000_000
  };

  const plan = await comfy.plan({ workspace: 'w', projectPath: 'project', parameters });
  assert.equal(plan.ready, true);
  assert.equal((plan.resolved as any).profileId, 'local');

  const executed = await runWithWorkSession('media-test-session', () =>
    comfy.run({ workspace: 'w', projectPath: 'project', parameters, plan })
  );
  assert.equal(executed.status, 'succeeded');
  assert.equal(f.getStatusCalls(), 1);
  assert.deepEqual(
    executed.steps.map(step => step.id),
    ['media.comfyui.submit', 'media.comfyui.wait', 'media.comfyui.import', 'media.acceptance.ffprobe']
  );
  assert.equal((executed.outputs?.artifact as any).sha256, 'b'.repeat(64));
});

test('Media acceptance workflow reports failed acceptance without hiding the created artifact evidence', async () => {
  const f = fixture();
  (f.deps.adapter as any).probeFile = async () => ({
    file: 'bad.mp4',
    format: { sizeBytes: 4096 },
    streams: []
  });
  const remotion = mediaWorkflowContributions(f.deps as never).find(item => item.id === 'media.remotion.render_accept')!;
  const parameters = { mediaPresetId: 'robotics', mediaOutput: 'renders/bad.mp4' };
  const plan = await remotion.plan({ workspace: 'w', projectPath: 'project', parameters });

  const executed = await runWithWorkSession('media-test-session', () =>
    remotion.run({ workspace: 'w', projectPath: 'project', parameters, plan })
  );
  assert.equal(executed.status, 'failed');
  assert.equal((executed.outputs?.artifact as any).output, 'renders/bad.mp4');
  assert.equal(executed.steps.at(-1)?.id, 'media.acceptance.validate');
});
