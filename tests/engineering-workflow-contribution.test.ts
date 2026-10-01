import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineeringWorkflowEngine } from '../src/adapters/engineering/workflow-engine.js';
import { EngineeringWorkflowContributionRegistry } from '../src/adapters/engineering/workflow-contribution.js';

function minimalEngine() {
  return new EngineeringWorkflowEngine(
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never
  );
}

test('workflow contribution registry rejects reserved and duplicate ids', () => {
  const registry = new EngineeringWorkflowContributionRegistry(new Set(['firmware.build']));
  const contribution = {
    id: 'media.test',
    description: 'test workflow',
    destructive: false,
    async plan() { return { ready: true }; },
    async run() { return { status: 'succeeded' as const, steps: [] }; }
  };
  registry.add(contribution);
  assert.throws(() => registry.add(contribution), /Duplicate engineering workflow contribution id/);
  assert.throws(() => registry.add({ ...contribution, id: 'firmware.build' }), /collides with a built-in workflow id/);
  assert.throws(() => registry.add({ ...contribution, id: 'Media Invalid' }), /Invalid engineering workflow contribution id/);
});

test('EngineeringWorkflowEngine delegates extension plan/run without widening built-in authority', async () => {
  const engine = minimalEngine();
  const calls: string[] = [];
  engine.registerContribution({
    id: 'media.test.accept',
    description: 'extension acceptance test',
    destructive: true,
    async plan(context) {
      calls.push('plan');
      return { ready: true, workspace: context.workspace, value: context.parameters.mediaPresetId };
    },
    async run(context) {
      calls.push('run');
      assert.equal(context.plan.ready, true);
      return {
        status: 'succeeded',
        steps: [{ id: 'accept', status: 'succeeded', durationMs: 1 }],
        outputs: { accepted: true }
      };
    }
  });

  (engine as any).state = async () => ({
    profileFound: false,
    manifestPath: '.rwmcp/project.yaml',
    project: { workspace: 'w', projectPath: 'p', family: 'generic', framework: 'generic', ros2: false, docker: false },
    profile: { version: 1, id: 'p', kind: 'generic' }
  });
  (engine as any).workflowIds = () => [];

  const listed = await engine.list('w', 'p');
  assert.deepEqual(listed.workflows, [{
    id: 'media.test.accept',
    destructive: true,
    description: 'extension acceptance test',
    source: 'extension'
  }]);

  const plan = await engine.plan('w', 'p', 'media.test.accept', { mediaPresetId: 'demo' });
  assert.equal(plan.source, 'extension');
  assert.equal(plan.value, 'demo');

  const run = await engine.run('w', 'p', 'media.test.accept', { mediaPresetId: 'demo' });
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.outputs, { accepted: true });
  assert.deepEqual(calls, ['plan', 'plan', 'run']);

  assert.throws(
    () => engine.registerContribution({
      id: 'firmware.build',
      description: 'must not shadow core',
      destructive: false,
      async plan() { return {}; },
      async run() { return { status: 'succeeded', steps: [] }; }
    }),
    /collides with a built-in workflow id/
  );
});
