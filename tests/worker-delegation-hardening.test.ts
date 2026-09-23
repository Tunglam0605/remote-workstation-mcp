import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { EngineeringCommandResult } from '../src/engineering/types.js';
import type { WorkerDispatchRequest } from '../src/worker-provider.js';
import { CodexWorkerProvider } from '../src/workers/codex-worker-provider.js';
import { AntigravityWorkerProvider } from '../src/workers/antigravity-worker-provider.js';

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
        inheritEnv: ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'],
        maxOutputBytes: 256 * 1024,
        maxRuntimeMs: 600_000
      }
    }
  } as any;
}

function request(worktreePath = 'repo'): WorkerDispatchRequest {
  return {
    version: 1,
    workSessionId: '11111111-1111-4111-8111-111111111111',
    objective: {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Worker delegation acceptance',
      objective: 'Verify bounded worker delegation.'
    },
    task: {
      id: '33333333-3333-4333-8333-333333333333',
      generation: 1,
      title: 'Inspect worker integration',
      description: 'Delegation to EAS scout is explicitly authorized for this task.'
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

const EAS_ROLES = ['architect', 'debugger', 'implementer', 'researcher', 'reviewer', 'scout', 'test-engineer'] as const;

async function writeEasRoles(home: string) {
  const root = path.join(home, '.codex', 'agents');
  await fs.mkdir(root, { recursive: true });
  for (const role of EAS_ROLES) {
    const sandbox = ['implementer', 'debugger', 'test-engineer'].includes(role) ? 'workspace-write' : 'read-only';
    const model = ['researcher', 'scout'].includes(role) ? 'gpt-6-luna' : 'gpt-6-sol';
    await fs.writeFile(path.join(root, `${role}.toml`), [
      `name = "${role}"`,
      `description = "EAS ${role}"`,
      `model = "${model}"`,
      'model_reasoning_effort = "medium"',
      `sandbox_mode = "${sandbox}"`,
      'developer_instructions = "Stay inside the assigned scope."',
      ''
    ].join('\n'), 'utf8');
  }
}

test('Codex worker projects only validated EAS roles while keeping user config ignored', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-codex-eas-'));
  const repo = path.join(temp, 'repo');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await writeEasRoles(temp);
  const calls: string[][] = [];
  const provider = new CodexWorkerProvider(
    fakePolicy(),
    { resolveExisting: async () => repo } as any,
    { run: async () => commandResult() } as any,
    {
      env: { PATH: process.env.PATH, USERPROFILE: temp },
      model: 'gpt-6-sol',
      agentDelegationEnabled: true,
      resolveExecutable: async command => command === 'git' ? 'git' : 'codex',
      processRunner: async (_program, args) => {
        calls.push(args);
        return {
          exitCode: 0,
          stdout: 'bounded worker completed',
          stderr: 'sandbox: workspace-write\nsession id: 44444444-4444-4444-8444-444444444444',
          timedOut: false,
          durationMs: 5
        };
      }
    }
  );
  const result = await provider.dispatch(request());
  assert.equal(result.status, 'succeeded');
  assert.equal(calls.length, 1);
  const args = calls[0]!;
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--json'));
  assert.ok(args.includes('--json'));
  assert.ok(args.includes('model="gpt-6-sol"'));
  assert.ok(args.includes('features.multi_agent=true'));
  assert.ok(args.includes('agents.enabled=true'));
  assert.ok(args.includes('agents.max_concurrent_threads_per_session=2'));
  for (const role of EAS_ROLES) {
    assert.ok(args.some(arg => arg.startsWith(`agents.${role}.description=`)));
    assert.ok(args.some(arg => arg.startsWith(`agents.${role}.config_file=`)));
  }
  assert.match(result.summary ?? '', /easRoles=7/);
  await fs.rm(temp, { recursive: true, force: true });
});

test('Codex EAS projection fails closed on unsafe role configuration', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-codex-eas-invalid-'));
  const repo = path.join(temp, 'repo');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await writeEasRoles(temp);
  await fs.appendFile(path.join(temp, '.codex', 'agents', 'scout.toml'), '\n[mcp_servers.unsafe]\ncommand = "bad"\n', 'utf8');
  let invoked = false;
  const provider = new CodexWorkerProvider(
    fakePolicy(),
    { resolveExisting: async () => repo } as any,
    { run: async () => commandResult() } as any,
    {
      env: { PATH: process.env.PATH, USERPROFILE: temp },
      model: 'gpt-6-sol',
      agentDelegationEnabled: true,
      resolveExecutable: async command => command === 'git' ? 'git' : 'codex',
      processRunner: async () => {
        invoked = true;
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
      }
    }
  );
  const result = await provider.dispatch(request());
  assert.equal(result.status, 'blocked');
  assert.match(result.summary ?? '', /CODEX_EAS_CONFIG_INVALID/);
  assert.equal(invoked, false);
  await fs.rm(temp, { recursive: true, force: true });
});

test('Codex authentication failures are bounded blocked outcomes with useful diagnostics', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-codex-auth-'));
  const repo = path.join(temp, 'repo');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  const provider = new CodexWorkerProvider(
    fakePolicy(),
    { resolveExisting: async () => repo } as any,
    { run: async () => commandResult() } as any,
    {
      resolveExecutable: async command => command === 'git' ? 'git' : 'codex',
      processRunner: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'sandbox: workspace-write\nsession id: 55555555-5555-4555-8555-555555555555\nHTTP 401 Unauthorized: Incorrect API key provided',
        timedOut: false,
        durationMs: 5
      })
    }
  );
  const result = await provider.dispatch(request());
  assert.equal(result.status, 'blocked');
  assert.match(result.summary ?? '', /CODEX_AUTH_REQUIRED/);
  assert.match(result.summary ?? '', /401 Unauthorized/);
  await fs.rm(temp, { recursive: true, force: true });
});

test('Antigravity production dispatch fails fast unless sandbox automation policy is configured', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-agy-policy-'));
  const repo = path.join(temp, 'repo');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  let invoked = false;
  const makeProvider = () => new AntigravityWorkerProvider(
    fakePolicy(),
    { resolveExisting: async () => repo } as any,
    { run: async () => commandResult() } as any,
    {
      env: { PATH: process.env.PATH, USERPROFILE: temp },
      requireSandboxAutomationPolicy: true,
      resolveExecutable: async command => command === 'git' ? 'git' : 'agy',
      processRunner: async () => {
        invoked = true;
        return {
          exitCode: 0,
          stdout: [
            JSON.stringify({ event: 'init', conversation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', init: { permission_mode: 'proceed-in-sandbox' } }),
            JSON.stringify({ event: 'result', result: { conversation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'SUCCESS', response: 'done', usage: { total_tokens: 10 } } })
          ].join('\n') + '\n',
          stderr: '',
          timedOut: false,
          durationMs: 5
        };
      }
    }
  );

  const blocked = await makeProvider().dispatch(request());
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.summary ?? '', /ANTIGRAVITY_SANDBOX_POLICY_REQUIRED/);
  assert.equal(invoked, false);

  const settingsDir = path.join(temp, '.gemini', 'antigravity-cli');
  await fs.mkdir(settingsDir, { recursive: true });
  await fs.writeFile(path.join(settingsDir, 'settings.json'), JSON.stringify({
    enableTerminalSandbox: true,
    toolPermission: 'proceed-in-sandbox'
  }), 'utf8');
  const succeeded = await makeProvider().dispatch(request());
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(invoked, true);
  await fs.rm(temp, { recursive: true, force: true });
});
