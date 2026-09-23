import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { EngineeringCommandResult } from '../src/engineering/types.js';
import type { WorkerDispatchRequest } from '../src/worker-provider.js';
import { CodexWorkerProvider } from '../src/workers/codex-worker-provider.js';

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
        inheritEnv: ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'CODEX_HOME'],
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
      name: 'Shared skill acceptance',
      objective: 'Use one owner-approved Codex skill without widening worker authority.'
    },
    task: {
      id: '33333333-3333-4333-8333-333333333333',
      generation: 1,
      title: 'Use systematic debugging',
      description: 'Use the systematic-debugging skill for this bounded task.'
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

function healthyPoolBroker() {
  return {
    async status() {
      return {
        requestedMode: 'cockpit-api-pool',
        effectiveBackend: 'cockpit-api-pool',
        pool: { detail: 'HTTP 200', accountIds: ['codex-a'], routingStrategy: 'auto' }
      };
    },
    async poolLaunch() {
      return {
        args: [
          '-c', 'model_provider=rwmcp_cockpit_pool',
          '-c', 'model_providers.rwmcp_cockpit_pool.base_url=http://127.0.0.1:56096/v1',
          '-c', 'model_providers.rwmcp_cockpit_pool.env_key=RWMCP_COCKPIT_CODEX_API_KEY'
        ],
        env: { RWMCP_COCKPIT_CODEX_API_KEY: 'test-only-key' }
      };
    }
  } as any;
}

test('Codex shared skills use an isolated worktree-local snapshot and never load the owner config', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-shared-skills-'));
  const worktree = path.join(base, 'repo');
  const ownerHome = path.join(base, 'owner-codex');
  const sourceSkill = path.join(ownerHome, 'skills', 'systematic-debugging');
  await fs.mkdir(path.join(worktree, '.git'), { recursive: true });
  await fs.mkdir(path.join(sourceSkill, 'references'), { recursive: true });
  await fs.writeFile(path.join(sourceSkill, 'SKILL.md'), [
    '---',
    'name: systematic-debugging',
    'description: Root-cause-first debugging.',
    '---',
    '# Systematic Debugging',
    'Find root cause before fixes.',
    ''
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(sourceSkill, 'references', 'checklist.md'), 'evidence first\n', 'utf8');
  await fs.writeFile(path.join(ownerHome, 'config.toml'), 'plugins = ["must-not-copy"]\n', 'utf8');
  await fs.mkdir(path.join(ownerHome, 'plugins'), { recursive: true });
  await fs.writeFile(path.join(ownerHome, 'plugins', 'secret.txt'), 'must-not-copy\n', 'utf8');
  await fs.writeFile(path.join(ownerHome, 'auth.json'), '{"secret":"must-not-copy"}\n', 'utf8');

  const calls: Array<{ args: string[]; input: string; env: NodeJS.ProcessEnv }> = [];
  let snapshotHome = '';
  const provider = new CodexWorkerProvider(
    fakePolicy(),
    { resolveExisting: async () => worktree } as any,
    { run: async () => commandResult() } as any,
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        CODEX_HOME: ownerHome
      },
      accountBroker: healthyPoolBroker(),
      model: 'gpt-6-sol',
      skillSharingEnabled: true,
      resolveExecutable: async command => command === 'git' ? 'git' : 'codex',
      processRunner: async (_program, args, _cwd, input, _timeout, env) => {
        calls.push({ args, input, env });
        if (/SANDBOX_ATTESTED/.test(input)) {
          assert.ok(args.includes('--ignore-user-config'));
          return {
            exitCode: 0,
            stdout: 'SANDBOX_ATTESTED',
            stderr: 'sandbox: workspace-write\nsession id: 44444444-4444-4444-8444-444444444444',
            timedOut: false,
            durationMs: 1
          };
        }

        assert.ok(!args.includes('--ignore-user-config'));
        snapshotHome = env.CODEX_HOME ?? '';
        assert.ok(snapshotHome.startsWith(worktree + path.sep));
        assert.match(path.basename(snapshotHome), /^\.rwmcp-codex-home-/);
        assert.equal(await fs.readFile(path.join(snapshotHome, 'skills', 'systematic-debugging', 'SKILL.md'), 'utf8').then(text => /root cause/i.test(text)), true);
        assert.equal(await fs.readFile(path.join(snapshotHome, 'skills', 'systematic-debugging', 'references', 'checklist.md'), 'utf8'), 'evidence first\n');
        await assert.rejects(fs.access(path.join(snapshotHome, 'plugins')));
        await assert.rejects(fs.access(path.join(snapshotHome, 'auth.json')));
        const isolatedConfig = await fs.readFile(path.join(snapshotHome, 'config.toml'), 'utf8');
        assert.match(isolatedConfig, /isolated Codex home/);
        assert.doesNotMatch(isolatedConfig, /must-not-copy/);
        return {
          exitCode: 0,
          stdout: [
            JSON.stringify({ type: 'thread.started', thread_id: '55555555-5555-4555-8555-555555555555' }),
            JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Shared skill applied.' } })
          ].join('\n') + '\n',
          stderr: 'sandbox: workspace-write\n',
          timedOut: false,
          durationMs: 5
        };
      }
    }
  );

  try {
    const result = await provider.dispatch(request());
    assert.equal(result.status, 'succeeded');
    assert.equal(calls.length, 2);
    assert.match(result.summary ?? '', /sharedSkills=1/);
    assert.match(result.summary ?? '', /Shared skill applied/);
    assert.ok(snapshotHome);
    await assert.rejects(fs.access(snapshotHome), /ENOENT/);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('Codex shared skills fail closed unless the isolated Cockpit API pool is active', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-shared-skills-pool-'));
  const worktree = path.join(base, 'repo');
  const ownerHome = path.join(base, 'owner-codex');
  await fs.mkdir(path.join(worktree, '.git'), { recursive: true });
  await fs.mkdir(path.join(ownerHome, 'skills', 'test-skill'), { recursive: true });
  await fs.writeFile(path.join(ownerHome, 'skills', 'test-skill', 'SKILL.md'), '---\nname: test-skill\ndescription: Test\n---\n', 'utf8');
  let invoked = false;
  const provider = new CodexWorkerProvider(
    fakePolicy(),
    { resolveExisting: async () => worktree } as any,
    { run: async () => commandResult() } as any,
    {
      env: { CODEX_HOME: ownerHome },
      skillSharingEnabled: true,
      resolveExecutable: async command => command === 'git' ? 'git' : 'codex',
      processRunner: async () => {
        invoked = true;
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
      }
    }
  );
  try {
    const result = await provider.dispatch(request());
    assert.equal(result.status, 'blocked');
    assert.match(result.summary ?? '', /CODEX_SHARED_SKILLS_REQUIRE_POOL/);
    assert.equal(invoked, false);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
