import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { EngineeringCommandResult } from '../engineering/types.js';
import { PolicyEngine } from '../policy.js';
import { PathGuard } from '../security/path-guard.js';
import { buildSafeEnvironment } from '../security/env-filter.js';
import { ProcessTreeSupervisor } from '../adapters/process-tree-supervisor.js';
import { resolveExecutable } from '../adapters/engineering/executable-resolver.js';
import type {
  WorkerDispatchRequest,
  WorkerDispatchResult,
  WorkerProvider,
  WorkerProviderRegistry
} from '../worker-provider.js';

const PROVIDER_ID = 'codex-local';
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_EVIDENCE_BYTES = 8 * 1024;

interface RunnerLike {
  run(program: string, args: string[], cwd: string, timeoutMs?: number): Promise<EngineeringCommandResult>;
}

interface CodexExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

interface CodexWorkerOptions {
  env?: NodeJS.ProcessEnv;
  resolveExecutable?: (command: string) => Promise<string | undefined>;
  processRunner?: (
    program: string,
    args: string[],
    cwd: string,
    input: string,
    timeoutMs: number,
    env: NodeJS.ProcessEnv
  ) => Promise<CodexExecResult>;
}

function enabled(value: string | undefined): boolean {
  return /^(1|true|yes)$/i.test(value?.trim() ?? '');
}

function boundedTail(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const buffer = Buffer.from(value, 'utf8');
  return buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString('utf8');
}

function compact(value: string, max = 240): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, max);
}

function safePrompt(request: WorkerDispatchRequest): string {
  const project = request.project;
  const lines = [
    'You are a bounded implementation worker invoked by ChatGPT Web through Remote Workstation MCP.',
    'ChatGPT Web owns planning, architecture, task decomposition, review, merge/release decisions, and all authority decisions.',
    'Implement ONLY the assigned task inside the current isolated Git worktree.',
    'Do not broaden scope or choose a new task.',
    'Do not push, merge, tag, release, deploy, update production nodes, modify owner policy/security settings, or access sibling worktrees.',
    'Do not enable web search or external browsing.',
    'Do not bypass sandbox or approval controls.',
    'Run only the local build/tests needed to verify this assigned task.',
    '',
    `Objective: ${request.objective.name}`,
    `Objective detail: ${request.objective.objective}`,
    `Task: ${request.task.title}`,
    ...(request.task.description ? [`Task detail: ${request.task.description}`] : []),
    ...(project?.branch ? [`Assigned branch: ${project.branch}`] : []),
    ...(project?.commit ? [`Starting commit: ${project.commit}`] : []),
    '',
    'At the end, summarize exactly what changed and which verification commands passed or failed. Do not claim success without local evidence.'
  ];
  const prompt = lines.join('\n');
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
    throw new Error('Codex worker prompt exceeds bounded dispatch size.');
  }
  return prompt;
}

function parseRunId(stderr: string): string | undefined {
  const match = /session id:\s*([0-9a-f]{8}-[0-9a-f-]{27})/i.exec(stderr);
  return match?.[1];
}

function gitEvidence(label: string, status: EngineeringCommandResult, diff: EngineeringCommandResult): string {
  const statusText = compact(status.stdout || status.stderr, 180) || 'clean';
  const diffText = compact(diff.stdout || diff.stderr, 180) || 'no-diff-stat';
  return `${label}: status=${statusText}; diff=${diffText}`;
}

async function defaultProcessRunner(
  program: string,
  args: string[],
  cwd: string,
  input: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv
): Promise<CodexExecResult> {
  const tree = new ProcessTreeSupervisor();
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let child;
    try {
      child = spawn(program, args, {
        cwd,
        shell: false,
        windowsHide: true,
        detached: tree.spawnDetached(),
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      reject(error);
      return;
    }
    const append = (current: string, chunk: Buffer) =>
      boundedTail(current + chunk.toString('utf8'), MAX_CAPTURE_BYTES);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk as Buffer); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk as Buffer); });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    child.stdin.end(input, 'utf8');
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      void tree.terminate(child);
    }, timeoutMs);
  });
}

export class CodexWorkerProvider implements WorkerProvider {
  readonly descriptor = {
    id: PROVIDER_ID,
    kind: 'codex' as const,
    displayName: 'OpenAI Codex CLI (local)',
    worktreeAssignment: true,
    progressReporting: false,
    cancellationIntent: false
  };

  private readonly env: NodeJS.ProcessEnv;
  private readonly executableResolver: (command: string) => Promise<string | undefined>;
  private readonly processRunner: NonNullable<CodexWorkerOptions['processRunner']>;

  constructor(
    private readonly policy: PolicyEngine,
    private readonly paths: PathGuard,
    private readonly runner: RunnerLike,
    options: CodexWorkerOptions = {}
  ) {
    this.env = options.env ?? process.env;
    this.executableResolver = options.resolveExecutable ?? resolveExecutable;
    this.processRunner = options.processRunner ?? defaultProcessRunner;
  }

  private async executable(): Promise<string | undefined> {
    const override = this.env.RWMCP_CODEX_EXECUTABLE?.trim();
    if (override) {
      if (!path.isAbsolute(override)) throw new Error('RWMCP_CODEX_EXECUTABLE must be an absolute path.');
      try {
        await fs.access(override);
        return path.resolve(override);
      } catch {
        return undefined;
      }
    }
    return await this.executableResolver('codex');
  }

  async status() {
    this.policy.assertEngineeringEnabled();
    const executable = await this.executable();
    if (!executable) return { availability: 'unavailable' as const, detail: 'Codex CLI executable was not found.' };
    const cwd = process.cwd();
    const version = await this.runner.run(executable, ['--version'], cwd, 5_000);
    if (version.exitCode !== 0 || version.timedOut) {
      return { availability: 'unavailable' as const, detail: 'Codex CLI version probe failed.' };
    }
    const login = await this.runner.run(executable, ['login', 'status'], cwd, 8_000);
    const loginText = `${login.stdout}\n${login.stderr}`;
    if (login.exitCode !== 0 || login.timedOut || !/logged in/i.test(loginText)) {
      return {
        availability: 'unavailable' as const,
        detail: `${compact(version.stdout || version.stderr, 96)}; authentication unavailable`
      };
    }
    return {
      availability: 'available' as const,
      detail: `${compact(version.stdout || version.stderr, 96)}; authenticated`
    };
  }

  async dispatch(request: WorkerDispatchRequest): Promise<WorkerDispatchResult> {
    this.policy.assertEngineeringExecute();
    const project = request.project;
    if (!project?.workspace || !project.worktreePath) {
      return { status: 'blocked', summary: 'Codex worker requires an explicit isolated Work Session worktree.' };
    }
    const cwd = await this.paths.resolveExisting(project.workspace, project.worktreePath);
    try {
      await fs.access(path.join(cwd, '.git'));
    } catch {
      return { status: 'blocked', summary: 'Assigned Codex worker path is not a Git worktree.' };
    }

    const executable = await this.executable();
    if (!executable) return { status: 'blocked', summary: 'Codex CLI executable is unavailable.' };
    const git = await this.executableResolver('git');
    if (!git) return { status: 'blocked', summary: 'Git executable is unavailable for worker evidence collection.' };

    const beforeStatus = await this.runner.run(git, ['status', '--short'], cwd, 10_000);
    const beforeDiff = await this.runner.run(git, ['diff', '--stat', '--'], cwd, 10_000);
    const prompt = safePrompt(request);
    const rawTimeout = Number(this.env.RWMCP_CODEX_WORKER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    const requestedTimeout = Number.isFinite(rawTimeout) && rawTimeout >= 10_000
      ? Math.floor(rawTimeout)
      : DEFAULT_TIMEOUT_MS;
    const timeoutLimit = Math.max(10_000, Math.min(
      requestedTimeout,
      this.policy.config.engineering?.maxCommandRuntimeMs ?? DEFAULT_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    ));
    const args = [
      '-s', 'workspace-write',
      '-a', 'never',
      '-C', cwd,
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--color', 'never',
      '-'
    ];
    const childEnv = buildSafeEnvironment(this.policy.config.process.inheritEnv, this.env);
    const result = await this.processRunner(executable, args, cwd, prompt, timeoutLimit, childEnv);
    const afterStatus = await this.runner.run(git, ['status', '--short'], cwd, 10_000);
    const afterDiff = await this.runner.run(git, ['diff', '--stat', '--'], cwd, 10_000);
    const runId = parseRunId(result.stderr);
    const evidence = [
      gitEvidence('before', beforeStatus, beforeDiff),
      gitEvidence('after', afterStatus, afterDiff)
    ].join(' | ');
    const modelSummary = compact(result.stdout || result.stderr, 240);
    const summary = boundedTail(
      `exit=${result.exitCode ?? 'null'} timeout=${result.timedOut}; ${evidence}; worker=${modelSummary || 'no-summary'}`,
      MAX_EVIDENCE_BYTES
    );

    if (result.timedOut || result.exitCode !== 0) {
      return { status: 'failed', ...(runId ? { runId } : {}), summary };
    }
    if (/sandbox:\s*read-only/i.test(result.stderr) || /workspace is \*\*read-only\*\*/i.test(result.stdout)) {
      return {
        status: 'blocked',
        ...(runId ? { runId } : {}),
        summary: `Codex CLI did not honor workspace-write sandbox; ${evidence}`
      };
    }
    return { status: 'succeeded', ...(runId ? { runId } : {}), summary };
  }
}

export function registerConfiguredCodexWorker(
  registry: WorkerProviderRegistry,
  policy: PolicyEngine,
  paths: PathGuard,
  runner: RunnerLike,
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<CodexWorkerOptions, 'env'> = {}
): boolean {
  if (!enabled(env.RWMCP_CODEX_WORKER_ENABLED)) return false;
  registry.register(new CodexWorkerProvider(policy, paths, runner, { ...options, env }));
  return true;
}
