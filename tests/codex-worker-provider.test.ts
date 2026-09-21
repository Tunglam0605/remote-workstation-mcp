import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { EngineeringCommandResult } from '../src/engineering/types.js';
import { WorkerProviderRegistry, type WorkerDispatchRequest } from '../src/worker-provider.js';
import {
  CodexWorkerProvider,
  registerConfiguredCodexWorker
} from '../src/workers/codex-worker-provider.js';

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

function request(worktreePath = 'repo.rwmcp-session'): WorkerDispatchRequest {
  return {
    version: 1,
    workSessionId: '11111111-1111-4111-8111-111111111111',
    objective: {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Bounded implementation',
      objective: 'Implement one reviewed task only.'
    },
    task: {
      id: '33333333-3333-4333-8333-333333333333',
      generation: 1,
      title: 'Add safe typed adapter',
      description: 'Stay inside the assigned worktree and run local tests.'
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

test('Codex registration is default-empty and explicit opt-in only', () => {
  const registry = new WorkerProviderRegistry();
  const policy = fakePolicy();
  const paths = {} as any;
  const runner = {} as any;

  assert.equal(registerConfiguredCodexWorker(registry, policy, paths, runner, {}), false);
  assert.deepEqual(registry.descriptors(), []);

  assert.equal(
    registerConfiguredCodexWorker(
      registry,
      policy,
      paths,
      runner,
      { RWMCP_CODEX_WORKER_ENABLED: 'true' },
      { resolveExecutable: async () => 'codex' }
    ),
    false,
    'legacy environment flag alone must not bypass Control Center owner policy'
  );
  assert.equal(
    registerConfiguredCodexWorker(
      registry,
      policy,
      paths,
      runner,
      {},
      { resolveExecutable: async () => 'codex' },
      true
    ),
    true
  );
  assert.deepEqual(registry.descriptors(), [{
    id: 'codex-local',
    kind: 'codex',
    displayName: 'OpenAI Codex CLI (local)',
    worktreeAssignment: true,
    progressReporting: false,
    cancellationIntent: false
  }]);
});

test('Codex provider reports unavailable for missing CLI or missing authentication', async () => {
  const policy = fakePolicy();
  const paths = {} as any;
  const missing = new CodexWorkerProvider(policy, paths, {} as any, {
    resolveExecutable: async () => undefined
  });
  assert.deepEqual(await missing.status(), {
    availability: 'unavailable',
    detail: 'Codex CLI executable was not found.'
  });

  const unauth = new CodexWorkerProvider(policy, paths, {} as any, {
    resolveExecutable: async () => 'codex',
    processRunner: async (_program, args) => args[0] === '--version'
      ? { exitCode: 0, stdout: 'codex-cli 0.153.4', stderr: '', timedOut: false, durationMs: 1 }
      : { exitCode: 1, stdout: '', stderr: 'Not logged in', timedOut: false, durationMs: 1 }
  });
  const status = await unauth.status();
  assert.equal(status.availability, 'unavailable');
  assert.match(status.detail ?? '', /authentication unavailable/);
});



test('Codex provider runs Windows npm cmd shim without spawn EINVAL', { skip: process.platform !== 'win32' }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-codex-cmd-'));
  try {
    const shim = path.join(temp, 'codex.cmd');
    await fs.writeFile(shim, [
      '@echo off',
      'if "%~1"=="--version" echo codex-cli 0.153.4 & exit /b 0',
      'if "%~1"=="login" echo Logged in using ChatGPT & exit /b 0',
      'exit /b 2',
      ''
    ].join('\r\n'), 'utf8');
    const provider = new CodexWorkerProvider(fakePolicy(), {} as any, {} as any, {
      env: {
        PATH: process.env.PATH,
        ComSpec: process.env.ComSpec,
        SYSTEMROOT: process.env.SYSTEMROOT,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        USERPROFILE: process.env.USERPROFILE,
        APPDATA: process.env.APPDATA,
        LOCALAPPDATA: process.env.LOCALAPPDATA
      },
      resolveExecutable: async () => shim
    });
    const status = await provider.status();
    assert.equal(status.availability, 'available');
    assert.match(status.detail ?? '', /codex-cli 0\.153\.4; authenticated/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
test('Codex dispatch requires an isolated Git worktree and never escapes PathGuard', async () => {
  const policy = fakePolicy();
  const runner = { run: async () => commandResult() } as any;
  const providerMissing = new CodexWorkerProvider(policy, {
    resolveExisting: async () => { throw new Error('should not resolve'); }
  } as any, runner, { resolveExecutable: async () => 'codex' });

  const missing = request();
  delete missing.project!.worktreePath;
  assert.deepEqual(await providerMissing.dispatch(missing), {
    status: 'blocked',
    summary: 'Codex worker requires an explicit isolated Work Session worktree.'
  });

  const escaping = new CodexWorkerProvider(policy, {
    resolveExisting: async () => { throw new Error('Path escapes the authorized workspace.'); }
  } as any, runner, { resolveExecutable: async () => 'codex' });
  await assert.rejects(() => escaping.dispatch(request('../outside')), /Path escapes the authorized workspace/);
});

test('Codex dispatch uses safe CLI flags and blocks a read-only effective sandbox', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-codex-provider-'));
  try {
    await fs.mkdir(path.join(temp, '.git'));
    const calls: Array<{ args: string[]; input: string }> = [];
    const runner = {
      async run(_program: string, args: string[]) {
        if (args[0] === 'status') return commandResult({ stdout: ' M src/a.ts' });
        if (args[0] === 'diff') return commandResult({ stdout: ' src/a.ts | 2 ++' });
        return commandResult();
      }
    } as any;
    const provider = new CodexWorkerProvider(
      fakePolicy(),
      { resolveExisting: async () => temp } as any,
      runner,
      {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE },
        resolveExecutable: async command => command === 'git' ? 'git' : 'codex',
        processRunner: async (_program, args, _cwd, input) => {
          calls.push({ args, input });
          return {
            exitCode: 0,
            stdout: 'Implementation could not continue.',
            stderr: 'sandbox: read-only\nsession id: 44444444-4444-4444-8444-444444444444',
            timedOut: false,
            durationMs: 10
          };
        }
      }
    );
    const result = await provider.dispatch(request());
    assert.equal(result.status, 'blocked');
    assert.equal(result.runId, '44444444-4444-4444-8444-444444444444');
    assert.equal(calls.length, 1);
    const args = calls[0]!.args;
    const expectedPrefix = process.platform === 'win32'
      ? ['-c', 'windows.sandbox=unelevated', '-s', 'workspace-write', '-a', 'never', '-C', temp, 'exec']
      : ['-s', 'workspace-write', '-a', 'never', '-C', temp, 'exec'];
    assert.deepEqual(args.slice(0, expectedPrefix.length), expectedPrefix);
    assert.ok(args.includes('--ephemeral'));
    assert.ok(args.includes('--ignore-user-config'));
    assert.ok(!args.includes('--search'));
    assert.ok(!args.some(arg => /dangerously-bypass/i.test(arg)));
    assert.match(calls[0]!.input, /Do not push, merge, tag, release, deploy/);
    assert.match(calls[0]!.input, /ChatGPT Web owns planning/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('Codex dispatch trusts the CLI sandbox header over free-form model wording', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-codex-sandbox-header-'));
  try {
    await fs.mkdir(path.join(temp, '.git'));
    const runner = { run: async () => commandResult() } as any;
    const provider = new CodexWorkerProvider(
      fakePolicy(),
      { resolveExisting: async () => temp } as any,
      runner,
      {
        resolveExecutable: async command => command === 'git' ? 'git' : 'codex',
        processRunner: async () => ({
          exitCode: 0,
          stdout: 'Verification note: a dependency cache is read-only, but the assigned workspace edit succeeded.',
          stderr: 'sandbox: workspace-write\\nsession id: 55555555-5555-4555-8555-555555555555',
          timedOut: false,
          durationMs: 5
        })
      }
    );
    const result = await provider.dispatch(request());
    assert.equal(result.status, 'succeeded');
    assert.equal(result.runId, '55555555-5555-4555-8555-555555555555');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('Worker registry redacts secret-like Codex summaries', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-codex-redaction-'));
  try {
    await fs.mkdir(path.join(temp, '.git'));
    const runner = {
      async run(_program: string, args: string[]) {
        if (args[0] === '--version') return commandResult({ stdout: 'codex-cli 0.153.4' });
        if (args[0] === 'login') return commandResult({ stderr: 'Logged in using ChatGPT' });
        return commandResult();
      }
    } as any;
    const provider = new CodexWorkerProvider(
      fakePolicy(),
      { resolveExisting: async () => temp } as any,
      runner,
      {
        resolveExecutable: async command => command === 'git' ? 'git' : 'codex',
        processRunner: async (_program, args) => {
          if (args[0] === '--version') {
            return { exitCode: 0, stdout: 'codex-cli 0.153.4', stderr: '', timedOut: false, durationMs: 1 };
          }
          if (args[0] === 'login') {
            return { exitCode: 0, stdout: '', stderr: 'Logged in using ChatGPT', timedOut: false, durationMs: 1 };
          }
          return {
            exitCode: 0,
            stdout: 'finished api_key=super-secret-value-123456789',
            stderr: 'sandbox: workspace-write',
            timedOut: false,
            durationMs: 5
          };
        }
      }
    );
    const registry = new WorkerProviderRegistry();
    registry.register(provider);
    const result = await registry.dispatch('codex-local', request());
    assert.equal(result.status, 'succeeded');
    assert.equal(result.summary, '[redacted provider detail]');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});


test('Codex provider classifies quota and rate limits as bounded blocked outcomes for policy fallback', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-codex-limit-'));
  try {
    await fs.mkdir(path.join(temp, '.git'));
    const runner = {
      async run(_program: string, args: string[]) {
        if (args[0] === 'status' || args[0] === 'diff') return commandResult();
        return commandResult();
      }
    } as any;
    const provider = new CodexWorkerProvider(
      fakePolicy(),
      { resolveExisting: async () => temp } as any,
      runner,
      {
        resolveExecutable: async command => command === 'git' ? 'git' : 'codex',
        processRunner: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'HTTP 429: usage limit reached',
          timedOut: false,
          durationMs: 5
        })
      }
    );
    const result = await provider.dispatch(request());
    assert.equal(result.status, 'blocked');
    assert.match(result.summary ?? '', /CODEX_LIMIT_REACHED/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
