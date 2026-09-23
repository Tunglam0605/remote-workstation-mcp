import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { EngineeringCommandResult } from '../engineering/types.js';
import { PolicyEngine } from '../policy.js';
import { PathGuard } from '../security/path-guard.js';
import { buildSafeEnvironment } from '../security/env-filter.js';
import { ProcessTreeSupervisor } from '../adapters/process-tree-supervisor.js';
import { windowsCommandShim } from '../adapters/windows-command-shim.js';
import { resolveExecutable } from '../adapters/engineering/executable-resolver.js';
import type { CodexAccountBroker } from './codex-account-broker.js';
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

const MAX_AGENT_CONFIG_BYTES = 32 * 1024;
const EAS_ROLE_DESCRIPTIONS = {
  architect: 'System architecture and safety review.',
  debugger: 'Evidence-first root cause analysis and bounded remediation.',
  implementer: 'Smallest approved implementation inside the assigned scope.',
  researcher: 'Current authoritative evidence gathering when explicitly allowed.',
  reviewer: 'Independent correctness and regression review.',
  scout: 'Read-only repository discovery and call-flow mapping.',
  'test-engineer': 'Targeted verification and regression testing.'
} as const;
const EAS_AGENT_KEYS = new Set([
  'name',
  'description',
  'model',
  'model_reasoning_effort',
  'sandbox_mode',
  'developer_instructions'
]);

type EasRole = keyof typeof EAS_ROLE_DESCRIPTIONS;

interface EasProjection {
  args: string[];
  roles: EasRole[];
}

function tomlString(value: string): string {
  // Codex may resolve to a Windows .CMD shim. Keep config override values free of
  // literal spaces so cmd.exe cannot split a quoted TOML value before Codex sees it.
  // JSON string escaping is TOML-basic-string compatible for these bounded values;
  // TOML decodes \\u0020 back to the original space.
  return JSON.stringify(value).replace(/ /g, '\\u0020');
}

async function validatedEasProjection(env: NodeJS.ProcessEnv): Promise<EasProjection> {
  const override = env.RWMCP_CODEX_AGENT_DIR?.trim();
  if (override && !path.isAbsolute(override)) {
    throw new Error('RWMCP_CODEX_AGENT_DIR must be an absolute path.');
  }
  const home = env.USERPROFILE?.trim() || env.HOME?.trim();
  const root = override ? path.resolve(override) : home ? path.resolve(home, '.codex', 'agents') : undefined;
  if (!root) throw new Error('Codex EAS delegation is enabled but no user home/agent directory is available.');

  const args = [
    '-c', 'features.multi_agent=true',
    '-c', 'agents.enabled=true',
    '-c', 'agents.max_concurrent_threads_per_session=2'
  ];
  const roles = Object.keys(EAS_ROLE_DESCRIPTIONS) as EasRole[];
  for (const role of roles) {
    const file = path.resolve(root, `${role}.toml`);
    if (path.dirname(file) !== root) throw new Error(`Invalid EAS role path for ${role}.`);
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat?.isFile() || stat.size > MAX_AGENT_CONFIG_BYTES) {
      throw new Error(`EAS role config is missing or invalid: ${role}.`);
    }
    const source = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
    const seen = new Set<string>();
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('[')) throw new Error(`EAS role config contains forbidden table syntax: ${role}.`);
      const match = /^([A-Za-z0-9_-]+)\s*=/.exec(line);
      if (!match?.[1] || !EAS_AGENT_KEYS.has(match[1])) {
        throw new Error(`EAS role config contains an unsupported key: ${role}.`);
      }
      seen.add(match[1]);
    }
    const nameMatch = /^name\s*=\s*"([^"]+)"\s*$/m.exec(source);
    if (nameMatch?.[1] !== role) throw new Error(`EAS role config name mismatch: ${role}.`);
    const sandboxMatch = /^sandbox_mode\s*=\s*"([^"]+)"\s*$/m.exec(source);
    if (!sandboxMatch?.[1] || !['read-only', 'workspace-write'].includes(sandboxMatch[1])) {
      throw new Error(`EAS role config sandbox_mode is invalid: ${role}.`);
    }
    for (const required of EAS_AGENT_KEYS) {
      if (!seen.has(required)) throw new Error(`EAS role config is incomplete: ${role} missing ${required}.`);
    }
    args.push(
      '-c', `agents.${role}.description=${tomlString(EAS_ROLE_DESCRIPTIONS[role])}`,
      '-c', `agents.${role}.config_file=${tomlString(file)}`
    );
  }
  return { args, roles };
}

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
  accountBroker?: CodexAccountBroker;
  model?: string;
  agentDelegationEnabled?: boolean;
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
    'Do not spawn child agents unless the assigned Task detail explicitly authorizes delegation. If delegation is authorized, use only the projected EAS roles and keep every child inside this worktree.',
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

interface CodexStreamEvidence {
  finalMessage?: string;
  childAgentSpawns: number;
}

function parseCodexStreamEvidence(stdout: string): CodexStreamEvidence {
  let finalMessage: string | undefined;
  let childAgentSpawns = 0;
  const counted = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        item?: Record<string, unknown>;
      };
      const item = event.item;
      if (!item || typeof item !== 'object') continue;
      if (event.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') {
        const text = item.text.trim();
        if (text) finalMessage = text;
        continue;
      }
      if (event.type !== 'item.completed') continue;
      const blob = JSON.stringify(item).toLowerCase();
      if (!blob.includes('spawn_agent') && !blob.includes('collab_tool')) continue;
      const id = typeof item.id === 'string' ? item.id : `spawn-${childAgentSpawns}`;
      if (counted.has(id)) continue;
      counted.add(id);
      childAgentSpawns += 1;
    } catch {
      // Ignore non-JSON diagnostics. The CLI sandbox header remains authoritative on stderr.
    }
  }
  return { ...(finalMessage ? { finalMessage } : {}), childAgentSpawns };
}

function parseRunId(stderr: string): string | undefined {
  const match = /session id:\s*([0-9a-f]{8}-[0-9a-f-]{27})/i.exec(stderr);
  return match?.[1];
}

function parseSandboxMode(stderr: string): string | undefined {
  for (const line of stderr.split(/\r?\n/)) {
    const match = /^\s*sandbox:\s*([a-z0-9-]+)/i.exec(line);
    if (match?.[1]) return match[1].toLowerCase();
  }
  return undefined;
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
  const invocation = windowsCommandShim(program, args, env);
  return await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let child;
    try {
      child = spawn(invocation.program, invocation.args, {
        cwd,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
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
  private readonly accountBroker?: CodexAccountBroker;
  private readonly model?: string;
  private readonly agentDelegationEnabled: boolean;

  constructor(
    private readonly policy: PolicyEngine,
    private readonly paths: PathGuard,
    private readonly runner: RunnerLike,
    options: CodexWorkerOptions = {}
  ) {
    this.env = options.env ?? process.env;
    this.executableResolver = options.resolveExecutable ?? resolveExecutable;
    this.processRunner = options.processRunner ?? defaultProcessRunner;
    this.accountBroker = options.accountBroker;
    this.model = options.model?.trim() || undefined;
    this.agentDelegationEnabled = options.agentDelegationEnabled === true;
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
    const childEnv = buildSafeEnvironment(this.policy.config.process.inheritEnv, this.env);
    try {
      const version = await this.processRunner(executable, ['--version'], cwd, '', 5_000, childEnv);
      if (version.exitCode !== 0 || version.timedOut) {
        return { availability: 'unavailable' as const, detail: 'Codex CLI version probe failed.' };
      }
      const versionText = compact(version.stdout || version.stderr, 96);
      if (this.accountBroker) {
        const broker = await this.accountBroker.status({ probe: true });
        if (broker.requestedMode === 'cockpit-api-pool') {
          if (broker.effectiveBackend !== 'cockpit-api-pool') {
            return {
              availability: 'unavailable' as const,
              detail: `${versionText}; Cockpit API pool unavailable: ${compact(broker.pool.detail, 180)}`
            };
          }
          return {
            availability: 'available' as const,
            detail: `${versionText}; Cockpit API pool healthy; accounts=${broker.pool.accountIds.length}; routing=${broker.pool.routingStrategy ?? 'unknown'}`
          };
        }
      }
      const login = await this.processRunner(executable, ['login', 'status'], cwd, '', 8_000, childEnv);
      const loginText = `${login.stdout}\n${login.stderr}`;
      if (login.exitCode !== 0 || login.timedOut || !/logged in/i.test(loginText)) {
        return {
          availability: 'unavailable' as const,
          detail: `${versionText}; authentication unavailable`
        };
      }
      return {
        availability: 'available' as const,
        detail: `${versionText}; authenticated; backend=native`
      };
    } catch (error) {
      return {
        availability: 'unavailable' as const,
        detail: compact(error instanceof Error ? error.message : String(error), 160)
      };
    }
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
    let brokerArgs: string[] = [];
    let brokerEnv: Record<string, string> = {};
    if (this.accountBroker) {
      const broker = await this.accountBroker.status({ probe: true });
      if (broker.requestedMode === 'cockpit-api-pool') {
        if (broker.effectiveBackend !== 'cockpit-api-pool') {
          return { status: 'blocked', summary: `CODEX_ACCOUNT_POOL_UNAVAILABLE; ${compact(broker.pool.detail, 300)}` };
        }
        try {
          const launch = await this.accountBroker.poolLaunch();
          brokerArgs = launch.args;
          brokerEnv = launch.env;
        } catch (error) {
          return {
            status: 'blocked',
            summary: `CODEX_ACCOUNT_POOL_UNAVAILABLE; ${compact(error instanceof Error ? error.message : String(error), 300)}`
          };
        }
      }
    }
    let agentArgs: string[] = [];
    let projectedRoles: EasRole[] = [];
    if (this.agentDelegationEnabled) {
      try {
        const projection = await validatedEasProjection(this.env);
        agentArgs = projection.args;
        projectedRoles = projection.roles;
      } catch (error) {
        return {
          status: 'blocked',
          summary: `CODEX_EAS_CONFIG_INVALID; ${compact(error instanceof Error ? error.message : String(error), 400)}`
        };
      }
    }
    const args = [
      ...brokerArgs,
      ...(this.model ? ['-c', `model=${tomlString(this.model)}`] : []),
      ...agentArgs,
      ...(process.platform === 'win32'
        ? ['-c', 'windows.sandbox=unelevated']
        : []),
      '-s', 'workspace-write',
      '-a', 'never',
      '-C', cwd,
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--json',
      '--color', 'never',
      '-'
    ];
    const childEnv = {
      ...buildSafeEnvironment(this.policy.config.process.inheritEnv, this.env),
      ...brokerEnv
    };
    const result = await this.processRunner(executable, args, cwd, prompt, timeoutLimit, childEnv);
    const afterStatus = await this.runner.run(git, ['status', '--short'], cwd, 10_000);
    const afterDiff = await this.runner.run(git, ['diff', '--stat', '--'], cwd, 10_000);
    const runId = parseRunId(result.stderr);
    const evidence = [
      gitEvidence('before', beforeStatus, beforeDiff),
      gitEvidence('after', afterStatus, afterDiff)
    ].join(' | ');
    const stream = parseCodexStreamEvidence(result.stdout);
    const workerDetail = result.exitCode === 0 && !result.timedOut
      ? compact(stream.finalMessage || result.stdout || result.stderr, 480)
      : compact(boundedTail(result.stderr || result.stdout, 2400), 1200);
    const summary = boundedTail(
      `exit=${result.exitCode ?? 'null'} timeout=${result.timedOut}; ${evidence}; model=${this.model ?? 'default'}; easRoles=${projectedRoles.length}; codexSubagents=${stream.childAgentSpawns}; worker=${workerDetail || 'no-summary'}`,
      MAX_EVIDENCE_BYTES
    );

    if (result.timedOut || result.exitCode !== 0) {
      const failureText = `${result.stdout}\n${result.stderr}`;
      if (/\b401\b|unauthorized|incorrect api key|authentication required|not authenticated|log[ -]?in required/i.test(failureText)) {
        return {
          status: 'blocked',
          ...(runId ? { runId } : {}),
          summary: boundedTail(`CODEX_AUTH_REQUIRED; ${summary}`, MAX_EVIDENCE_BYTES)
        };
      }
      if (/\b429\b|rate[ -]?limit|usage[ -]?limit|quota|limit reached|reached (?:your|the) .*limit|too many requests|usage cap/i.test(failureText)) {
        return {
          status: 'blocked',
          ...(runId ? { runId } : {}),
          summary: boundedTail(`CODEX_LIMIT_REACHED; ${summary}`, MAX_EVIDENCE_BYTES)
        };
      }
      return { status: 'failed', ...(runId ? { runId } : {}), summary };
    }
    const sandboxMode = parseSandboxMode(result.stderr);
    if (sandboxMode !== 'workspace-write') {
      return {
        status: 'blocked',
        ...(runId ? { runId } : {}),
        summary: `Codex CLI did not confirm workspace-write sandbox (reported=${sandboxMode ?? 'missing'}); ${evidence}`
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
  options: Omit<CodexWorkerOptions, 'env'> = {},
  ownerEnabled = false
): boolean {
  if (!ownerEnabled) return false;
  registry.register(new CodexWorkerProvider(policy, paths, runner, { ...options, env }));
  return true;
}
