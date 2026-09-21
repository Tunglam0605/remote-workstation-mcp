import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { EngineeringCommandResult } from '../src/engineering/types.js';
import { WorkerProviderRegistry, type WorkerDispatchRequest } from '../src/worker-provider.js';
import {
  AntigravityWorkerProvider,
  probeAntigravityCli,
  registerConfiguredAntigravityWorker
} from '../src/workers/antigravity-worker-provider.js';

function commandResult(overrides: Partial<EngineeringCommandResult> = {}): EngineeringCommandResult {
  return {
    program: 'fake',
    args: [],
    cwd: '.',
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    durationMs: 1,
    ...overrides
  };
}

function fakePolicy() {
  return {
    assertEngineeringEnabled() {},
    assertEngineeringExecute() {},
    config: {
      engineering: { maxCommandRuntimeMs: 600_000 },
      process: {
        inheritEnv: ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'GEMINI_API_KEY'],
        maxOutputBytes: 256 * 1024,
        maxRuntimeMs: 600_000
      }
    }
  } as any;
}

function request(worktreePath = 'repo.rwmcp-session'): WorkerDispatchRequest {
  return {
    version: 1,
    workSessionId: '11111111-1111-4111-8111-111111111111',
    objective: {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Frontend implementation',
      objective: 'Implement one reviewed frontend task only.'
    },
    task: {
      id: '33333333-3333-4333-8333-333333333333',
      generation: 1,
      title: 'Improve responsive dashboard',
      description: 'Stay inside the assigned worktree and verify locally.'
    },
    project: {
      workspace: 'projects',
      projectPath: 'repo',
      worktreePath,
      branch: 'rwmcp/session/test',
      commit: '0123456789abcdef'
    }
  };
}

const modelEnvelope = JSON.stringify({
  conversation_id: '',
  status: 'SUCCESS',
  response: 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n',
  duration_seconds: 0,
  num_turns: 0,
  usage: { total_tokens: 0 },
  command: {
    name: 'model',
    data: { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', effort: 'high' }
  }
});

const usageEnvelope = JSON.stringify({
  conversation_id: '',
  status: 'SUCCESS',
  response: '',
  duration_seconds: 0,
  num_turns: 0,
  usage: { total_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.994, reset_time: '2026-09-25T16:47:46Z' },
            { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1, reset_time: '2026-09-21T19:41:52Z' }
          ]
        }
      ]
    }
  }
});

test('Antigravity registration is owner opt-in only and uses a dedicated provider kind', () => {
  const registry = new WorkerProviderRegistry();
  const policy = fakePolicy();
  const paths = {} as any;
  const runner = {} as any;

  assert.equal(registerConfiguredAntigravityWorker(registry, policy, paths, runner, {}), false);
  assert.deepEqual(registry.descriptors(), []);
  assert.equal(
    registerConfiguredAntigravityWorker(
      registry,
      policy,
      paths,
      runner,
      {},
      { resolveExecutable: async () => 'agy' },
      true
    ),
    true
  );
  assert.deepEqual(registry.descriptors(), [{
    id: 'antigravity-local',
    kind: 'antigravity',
    displayName: 'Google Antigravity CLI (local)',
    worktreeAssignment: true,
    progressReporting: false,
    cancellationIntent: false
  }]);
});

test('Antigravity read-only probe returns model and quota without an agent turn', async () => {
  const calls: string[][] = [];
  const status = await probeAntigravityCli({
    env: { LOCALAPPDATA: 'C:\\Temp', USERPROFILE: 'C:\\Users\\Test' },
    resolveExecutable: async () => 'agy',
    processRunner: async (_program, args) => {
      calls.push(args);
      if (args[0] === '--version') {
        return { exitCode: 0, stdout: '1.2.7\n', stderr: '', timedOut: false, durationMs: 1 };
      }
      if (args.includes('/model')) {
        return { exitCode: 0, stdout: modelEnvelope, stderr: '', timedOut: false, durationMs: 1 };
      }
      return { exitCode: 0, stdout: usageEnvelope, stderr: '', timedOut: false, durationMs: 1 };
    }
  });

  assert.equal(status.available, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.version, '1.2.7');
  assert.equal(status.model?.id, 'gemini-3.8-flash-high');
  assert.equal(status.quotaGroups?.[0]?.buckets[0]?.remainingFraction, 0.994);
  assert.ok(calls.some(args => args.includes('/model')));
  assert.ok(calls.some(args => args.includes('/usage')));
  assert.ok(calls.filter(args => args.includes('/model') || args.includes('/usage')).every(args => args.includes('--output-format') && args.includes('json')));
});

test('Antigravity provider requires an isolated Git worktree', async () => {
  const provider = new AntigravityWorkerProvider(
    fakePolicy(),
    { resolveExisting: async () => 'C:\\missing' } as any,
    { run: async () => commandResult() } as any,
    { resolveExecutable: async () => 'agy' }
  );
  const result = await provider.dispatch({ ...request(), project: { workspace: 'projects', projectPath: 'repo' } });
  assert.equal(result.status, 'blocked');
  assert.match(result.summary ?? '', /isolated Work Session worktree/);
});

test('Antigravity dispatch uses sandboxed stream-json stdin and filters secret-like environment values', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-agy-worker-'));
  try {
    await fs.mkdir(path.join(temp, '.git'));
    const invocations: Array<{ args: string[]; input: string; env: NodeJS.ProcessEnv }> = [];
    const provider = new AntigravityWorkerProvider(
      fakePolicy(),
      { resolveExisting: async () => temp } as any,
      { run: async () => commandResult() } as any,
      {
        env: {
          PATH: process.env.PATH,
          USERPROFILE: process.env.USERPROFILE,
          APPDATA: process.env.APPDATA,
          LOCALAPPDATA: process.env.LOCALAPPDATA,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          GEMINI_API_KEY: 'must-never-reach-child'
        },
        model: 'gemini-3.8-flash-high',
        resolveExecutable: async command => command === 'git' ? 'git' : 'agy',
        processRunner: async (_program, args, _cwd, input, _timeout, env) => {
          invocations.push({ args, input, env });
          return {
            exitCode: 0,
            stdout: [
              JSON.stringify({ event: 'init', conversation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', init: { permission_mode: 'request-review' } }),
              JSON.stringify({ event: 'step_update', step_update: { tool_info: { name: 'write_to_file' } } }),
              JSON.stringify({
                event: 'result',
                result: {
                  conversation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                  status: 'SUCCESS',
                  response: 'Implemented responsive dashboard and verified locally.',
                  usage: { total_tokens: 1234 }
                }
              })
            ].join('\n') + '\n',
            stderr: '',
            timedOut: false,
            durationMs: 10
          };
        }
      }
    );

    const result = await provider.dispatch(request());
    assert.equal(result.status, 'succeeded');
    assert.equal(result.runId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.match(result.summary ?? '', /permission=request-review/);
    assert.match(result.summary ?? '', /tokens=1234/);
    assert.equal(invocations.length, 1);
    const call = invocations[0]!;
    assert.ok(call.args.includes('--input-format'));
    assert.ok(call.args.includes('stream-json'));
    assert.ok(call.args.includes('--output-format'));
    assert.ok(call.args.includes('--sandbox'));
    assert.ok(call.args.includes('--model'));
    assert.ok(call.args.includes('gemini-3.8-flash-high'));
    assert.ok(!call.args.includes('--dangerously-skip-permissions'));
    assert.ok(!call.args.some(arg => arg.includes('Improve responsive dashboard')));
    const input = JSON.parse(call.input.trim());
    assert.equal(input.event, 'user');
    assert.match(input.message.content, /Improve responsive dashboard/);
    assert.equal(call.env.GEMINI_API_KEY, undefined);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('Antigravity quota/rate-limit errors fail closed as blocked work', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-agy-limit-'));
  try {
    await fs.mkdir(path.join(temp, '.git'));
    const provider = new AntigravityWorkerProvider(
      fakePolicy(),
      { resolveExisting: async () => temp } as any,
      { run: async () => commandResult() } as any,
      {
        resolveExecutable: async command => command === 'git' ? 'git' : 'agy',
        processRunner: async () => ({
          exitCode: 3,
          stdout: JSON.stringify({
            event: 'result',
            result: {
              conversation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              status: 'ERROR',
              response: '',
              error: 'resource exhausted: weekly quota reached',
              usage: { total_tokens: 0 }
            }
          }) + '\n',
          stderr: 'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","retryable":true,"http_code":429}',
          timedOut: false,
          durationMs: 3
        })
      }
    );
    const result = await provider.dispatch(request());
    assert.equal(result.status, 'blocked');
    assert.match(result.summary ?? '', /ANTIGRAVITY_LIMIT_REACHED/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
