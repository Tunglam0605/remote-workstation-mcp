import fs from 'node:fs/promises';
import os from 'node:os';
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

const PROVIDER_ID = 'antigravity-local';
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const STATUS_TIMEOUT_MS = 12_000;
const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_CAPTURE_BYTES = 512 * 1024;
const MAX_EVIDENCE_BYTES = 12 * 1024;

const MAX_AUTOMATION_SETTINGS_BYTES = 64 * 1024;

interface AntigravityAutomationPolicy {
  ready: boolean;
  detail: string;
}

async function antigravityAutomationPolicy(env: NodeJS.ProcessEnv): Promise<AntigravityAutomationPolicy> {
  const home = env.USERPROFILE?.trim() || env.HOME?.trim() || os.homedir();
  const settingsPath = path.resolve(home, '.gemini', 'antigravity-cli', 'settings.json');
  try {
    const stat = await fs.stat(settingsPath);
    if (!stat.isFile() || stat.size > MAX_AUTOMATION_SETTINGS_BYTES) {
      return { ready: false, detail: 'Antigravity CLI settings file is not a bounded regular file.' };
    }
    const parsed = JSON.parse((await fs.readFile(settingsPath, 'utf8')).replace(/^\uFEFF/, '')) as Record<string, unknown>;
    if (parsed.enableTerminalSandbox !== true) {
      return { ready: false, detail: 'enableTerminalSandbox=true is required for headless RWMCP dispatch.' };
    }
    if (parsed.toolPermission !== 'proceed-in-sandbox') {
      return { ready: false, detail: 'toolPermission=proceed-in-sandbox is required for headless RWMCP dispatch.' };
    }
    return { ready: true, detail: 'sandboxed headless automation policy is configured' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ready: false,
      detail: code === 'ENOENT'
        ? 'Antigravity CLI settings.json is missing.'
        : compact(error instanceof Error ? error.message : String(error), 240)
    };
  }
}
const ANTIGRAVITY_RUNTIME_ENV = [
  'HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'LANG', 'LC_ALL',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'
] as const;

interface RunnerLike {
  run(program: string, args: string[], cwd: string, timeoutMs?: number): Promise<EngineeringCommandResult>;
}

export interface AntigravityProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface AntigravityWorkerOptions {
  env?: NodeJS.ProcessEnv;
  model?: string;
  requireSandboxAutomationPolicy?: boolean;
  resolveExecutable?: (command: string) => Promise<string | undefined>;
  processRunner?: (
    program: string,
    args: string[],
    cwd: string,
    input: string,
    timeoutMs: number,
    env: NodeJS.ProcessEnv
  ) => Promise<AntigravityProcessResult>;
}

export interface AntigravityQuotaBucket {
  id?: string;
  name: string;
  window?: string;
  remainingFraction?: number;
  resetTime?: string;
}

export interface AntigravityQuotaGroup {
  name: string;
  description?: string;
  buckets: AntigravityQuotaBucket[];
}

export interface AntigravityCliStatus {
  installed: boolean;
  authenticated: boolean;
  available: boolean;
  executable?: string;
  version?: string;
  model?: {
    id?: string;
    label?: string;
    effort?: string;
  };
  quotaGroups?: AntigravityQuotaGroup[];
  detail: string;
}

interface JsonEnvelope {
  conversation_id?: unknown;
  status?: unknown;
  response?: unknown;
  error?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    thinking_tokens?: unknown;
    cache_read_tokens?: unknown;
    total_tokens?: unknown;
  };
  command?: {
    name?: unknown;
    data?: unknown;
  };
}

interface StreamResultEvent {
  event?: unknown;
  conversation_id?: unknown;
  init?: {
    permission_mode?: unknown;
  };
  step_update?: {
    tool_info?: unknown;
    subagent_info?: unknown;
  };
  result?: JsonEnvelope;
}

function antigravityEnvironment(allowNames: string[], env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return buildSafeEnvironment([...new Set([...allowNames, ...ANTIGRAVITY_RUNTIME_ENV])], env);
}

function boundedTail(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const buffer = Buffer.from(value, 'utf8');
  return buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString('utf8');
}

function compact(value: string, max = 240): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, max);
}

function safeString(value: unknown, max = 512): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > max || text.includes('\0')) return undefined;
  return text;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseJsonObject(text: string): JsonEnvelope | undefined {
  const trimmed = text.trim().replace(/^\uFEFF/, '');
  if (!trimmed) return undefined;
  const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(line) as JsonEnvelope;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Ignore diagnostics/non-JSON lines and continue toward earlier candidate lines.
    }
  }
  try {
    return JSON.parse(trimmed) as JsonEnvelope;
  } catch {
    return undefined;
  }
}

function parseQuotaGroups(envelope: JsonEnvelope | undefined): AntigravityQuotaGroup[] {
  const data = envelope?.command?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const groups = (data as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return [];
  const result: AntigravityQuotaGroup[] = [];
  for (const rawGroup of groups.slice(0, 16)) {
    if (!rawGroup || typeof rawGroup !== 'object' || Array.isArray(rawGroup)) continue;
    const group = rawGroup as Record<string, unknown>;
    const name = safeString(group.name, 128);
    if (!name) continue;
    const bucketsRaw = Array.isArray(group.buckets) ? group.buckets : [];
    const buckets: AntigravityQuotaBucket[] = [];
    for (const rawBucket of bucketsRaw.slice(0, 16)) {
      if (!rawBucket || typeof rawBucket !== 'object' || Array.isArray(rawBucket)) continue;
      const bucket = rawBucket as Record<string, unknown>;
      const bucketName = safeString(bucket.name, 128);
      if (!bucketName) continue;
      const remaining = safeNumber(bucket.remaining_fraction);
      buckets.push({
        ...(safeString(bucket.id, 128) ? { id: safeString(bucket.id, 128) } : {}),
        name: bucketName,
        ...(safeString(bucket.window, 32) ? { window: safeString(bucket.window, 32) } : {}),
        ...(remaining !== undefined && remaining >= 0 && remaining <= 1 ? { remainingFraction: remaining } : {}),
        ...(safeString(bucket.reset_time, 128) ? { resetTime: safeString(bucket.reset_time, 128) } : {})
      });
    }
    result.push({
      name,
      ...(safeString(group.description, 1024) ? { description: safeString(group.description, 1024) } : {}),
      buckets
    });
  }
  return result;
}

function parseModel(envelope: JsonEnvelope | undefined): AntigravityCliStatus['model'] | undefined {
  const data = envelope?.command?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const id = safeString(record.id, 128);
  const label = safeString(record.label, 256);
  const effort = safeString(record.effort, 32);
  if (!id && !label && !effort) return undefined;
  return {
    ...(id ? { id } : {}),
    ...(label ? { label } : {}),
    ...(effort ? { effort } : {})
  };
}

function usageSummary(groups: AntigravityQuotaGroup[]): string {
  const parts: string[] = [];
  for (const group of groups) {
    const weekly = group.buckets.find(bucket => bucket.window === 'weekly' && bucket.remainingFraction !== undefined);
    if (weekly?.remainingFraction !== undefined) {
      parts.push(`${group.name} weekly=${Math.round(weekly.remainingFraction * 100)}%`);
    }
  }
  return parts.join('; ');
}

function defaultKnownExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local');
    return path.join(local, 'agy', 'bin', 'agy.exe');
  }
  return path.join(home, '.local', 'bin', 'agy');
}

async function executableExists(candidate: string | undefined): Promise<string | undefined> {
  if (!candidate) return undefined;
  try {
    const resolved = path.resolve(candidate);
    await fs.access(resolved);
    return resolved;
  } catch {
    return undefined;
  }
}

export async function resolveAntigravityExecutable(
  env: NodeJS.ProcessEnv = process.env,
  resolver: (command: string) => Promise<string | undefined> = resolveExecutable
): Promise<string | undefined> {
  const override = env.RWMCP_ANTIGRAVITY_EXECUTABLE?.trim();
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('RWMCP_ANTIGRAVITY_EXECUTABLE must be an absolute path.');
    return await executableExists(override);
  }
  const known = await executableExists(defaultKnownExecutable(env));
  if (known) return known;
  return await resolver('agy');
}

async function defaultProcessRunner(
  program: string,
  args: string[],
  cwd: string,
  input: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv
): Promise<AntigravityProcessResult> {
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

export async function probeAntigravityVersion(options: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  resolveExecutable?: (command: string) => Promise<string | undefined>;
  processRunner?: NonNullable<AntigravityWorkerOptions['processRunner']>;
} = {}): Promise<{ installed: boolean; available: boolean; executable?: string; version?: string; detail: string }> {
  const env = options.env ?? process.env;
  const executable = await resolveAntigravityExecutable(env, options.resolveExecutable ?? resolveExecutable);
  if (!executable) return { installed: false, available: false, detail: 'Antigravity CLI (agy) executable was not found.' };
  const runner = options.processRunner ?? defaultProcessRunner;
  const childEnv = antigravityEnvironment([], env);
  try {
    const result = await runner(executable, ['--version'], options.cwd ?? process.cwd(), '', 5_000, childEnv);
    const version = compact(result.stdout || result.stderr, 96);
    if (result.exitCode !== 0 || result.timedOut || !version) {
      return { installed: true, available: false, executable, detail: 'Antigravity CLI version probe failed.' };
    }
    return { installed: true, available: true, executable, version, detail: `${version}; installed; authentication is verified on dispatch/status inspection` };
  } catch (error) {
    return { installed: true, available: false, executable, detail: compact(error instanceof Error ? error.message : String(error), 240) };
  }
}

export async function probeAntigravityCli(options: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  includeQuota?: boolean;
  resolveExecutable?: (command: string) => Promise<string | undefined>;
  processRunner?: NonNullable<AntigravityWorkerOptions['processRunner']>;
} = {}): Promise<AntigravityCliStatus> {
  const env = options.env ?? process.env;
  const executable = await resolveAntigravityExecutable(env, options.resolveExecutable ?? resolveExecutable);
  if (!executable) {
    return {
      installed: false,
      authenticated: false,
      available: false,
      detail: 'Antigravity CLI (agy) executable was not found.'
    };
  }
  const cwd = options.cwd ?? process.cwd();
  const runner = options.processRunner ?? defaultProcessRunner;
  const childEnv = antigravityEnvironment([], env);
  try {
    const versionResult = await runner(executable, ['--version'], cwd, '', 5_000, childEnv);
    const version = compact(versionResult.stdout || versionResult.stderr, 96);
    if (versionResult.exitCode !== 0 || versionResult.timedOut || !version) {
      return {
        installed: true,
        authenticated: false,
        available: false,
        executable,
        detail: 'Antigravity CLI version probe failed.'
      };
    }

    const modelResult = await runner(
      executable,
      ['-p', '/model', '--output-format', 'json', '--print-timeout', '15s'],
      cwd,
      '',
      STATUS_TIMEOUT_MS,
      childEnv
    );
    const modelEnvelope = parseJsonObject(modelResult.stdout);
    const authText = `${modelResult.stdout}\n${modelResult.stderr}`;
    const authRequired = /authentication required|sign[ -]?in required|not authenticated|log in/i.test(authText);
    if (modelResult.exitCode !== 0 || modelResult.timedOut || modelEnvelope?.status !== 'SUCCESS') {
      return {
        installed: true,
        authenticated: false,
        available: false,
        executable,
        version,
        detail: authRequired
          ? `${version}; authentication required`
          : `${version}; model/authentication probe failed`
      };
    }

    const model = parseModel(modelEnvelope);
    let quotaGroups: AntigravityQuotaGroup[] | undefined;
    if (options.includeQuota !== false) {
      const usageResult = await runner(
        executable,
        ['-p', '/usage', '--output-format', 'json', '--print-timeout', '20s'],
        cwd,
        '',
        20_000,
        childEnv
      );
      const usageEnvelope = parseJsonObject(usageResult.stdout);
      if (usageResult.exitCode === 0 && !usageResult.timedOut && usageEnvelope?.status === 'SUCCESS') {
        quotaGroups = parseQuotaGroups(usageEnvelope);
      }
    }
    const quotaText = quotaGroups?.length ? usageSummary(quotaGroups) : '';
    return {
      installed: true,
      authenticated: true,
      available: true,
      executable,
      version,
      ...(model ? { model } : {}),
      ...(quotaGroups ? { quotaGroups } : {}),
      detail: compact(
        `${version}; authenticated${model?.id ? `; model=${model.id}` : ''}${quotaText ? `; ${quotaText}` : ''}`,
        480
      )
    };
  } catch (error) {
    return {
      installed: true,
      authenticated: false,
      available: false,
      executable,
      detail: compact(error instanceof Error ? error.message : String(error), 240)
    };
  }
}

function safePrompt(request: WorkerDispatchRequest): string {
  const project = request.project;
  const lines = [
    'You are a bounded implementation worker invoked by ChatGPT Web through Remote Workstation MCP.',
    'ChatGPT Web owns planning, architecture, task decomposition, review, merge/release decisions, and all authority decisions.',
    'Implement ONLY the assigned task inside the current isolated Git worktree.',
    'Do not broaden scope or choose a new task.',
    'Do not push, merge, tag, release, deploy, update production nodes, modify owner policy/security settings, or access sibling worktrees.',
    'Do not use web search, external browsing, remote MCP servers, or network downloads unless the assigned task explicitly requires them and local policy permits them.',
    'Do not bypass sandbox or permission controls.',
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
    throw new Error('Antigravity worker prompt exceeds bounded dispatch size.');
  }
  return prompt;
}

function gitEvidence(label: string, status: EngineeringCommandResult, diff: EngineeringCommandResult): string {
  const statusText = compact(status.stdout || status.stderr, 180) || 'clean';
  const diffText = compact(diff.stdout || diff.stderr, 180) || 'no-diff-stat';
  return `${label}: status=${statusText}; diff=${diffText}`;
}

function parseStream(text: string): {
  conversationId?: string;
  permissionMode?: string;
  response?: string;
  status?: string;
  error?: string;
  totalTokens?: number;
  toolCalls: number;
  subagents: number;
} {
  let conversationId: string | undefined;
  let permissionMode: string | undefined;
  let response: string | undefined;
  let status: string | undefined;
  let error: string | undefined;
  let totalTokens: number | undefined;
  let toolCalls = 0;
  let subagents = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const event = JSON.parse(line) as StreamResultEvent;
      if (event.event === 'init') {
        conversationId = safeString(event.conversation_id, 128) ?? conversationId;
        permissionMode = safeString(event.init?.permission_mode, 64) ?? permissionMode;
      } else if (event.event === 'step_update') {
        if (event.step_update?.tool_info) toolCalls += 1;
        if (event.step_update?.subagent_info) subagents += 1;
      } else if (event.event === 'result' && event.result) {
        const result = event.result;
        conversationId = safeString(result.conversation_id, 128) ?? conversationId;
        response = safeString(result.response, MAX_EVIDENCE_BYTES) ?? response;
        status = safeString(result.status, 64) ?? status;
        error = safeString(result.error, 2048) ?? error;
        totalTokens = safeNumber(result.usage?.total_tokens) ?? totalTokens;
      }
    } catch {
      // Ignore non-JSON diagnostic lines; stderr is separately captured and summarized.
    }
  }
  return {
    ...(conversationId ? { conversationId } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(response ? { response } : {}),
    ...(status ? { status } : {}),
    ...(error ? { error } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    toolCalls,
    subagents
  };
}

function structuredAgyError(stderr: string): string | undefined {
  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('AGY_ERROR:')) continue;
    return compact(trimmed.slice('AGY_ERROR:'.length), 600);
  }
  return undefined;
}

export class AntigravityWorkerProvider implements WorkerProvider {
  readonly descriptor = {
    id: PROVIDER_ID,
    kind: 'antigravity' as const,
    displayName: 'Google Antigravity CLI (local)',
    worktreeAssignment: true,
    progressReporting: false,
    cancellationIntent: false
  };

  private readonly env: NodeJS.ProcessEnv;
  private readonly executableResolver: (command: string) => Promise<string | undefined>;
  private readonly processRunner: NonNullable<AntigravityWorkerOptions['processRunner']>;
  private readonly model?: string;
  private readonly requireSandboxAutomationPolicy: boolean;

  constructor(
    private readonly policy: PolicyEngine,
    private readonly paths: PathGuard,
    private readonly runner: RunnerLike,
    options: AntigravityWorkerOptions = {}
  ) {
    this.env = options.env ?? process.env;
    this.executableResolver = options.resolveExecutable ?? resolveExecutable;
    this.processRunner = options.processRunner ?? defaultProcessRunner;
    this.model = options.model?.trim() || undefined;
    this.requireSandboxAutomationPolicy = options.requireSandboxAutomationPolicy === true;
  }

  async inspect(includeQuota = true): Promise<AntigravityCliStatus> {
    this.policy.assertEngineeringEnabled();
    return await probeAntigravityCli({
      env: this.env,
      cwd: process.cwd(),
      includeQuota,
      resolveExecutable: this.executableResolver,
      processRunner: this.processRunner
    });
  }

  async status() {
    this.policy.assertEngineeringEnabled();
    const status = await probeAntigravityVersion({
      env: this.env,
      cwd: process.cwd(),
      resolveExecutable: this.executableResolver,
      processRunner: this.processRunner
    });
    if (!status.available) return { availability: 'unavailable' as const, detail: status.detail };
    if (this.requireSandboxAutomationPolicy) {
      const automation = await antigravityAutomationPolicy(this.env);
      if (!automation.ready) {
        return { availability: 'unavailable' as const, detail: `ANTIGRAVITY_SANDBOX_POLICY_REQUIRED; ${automation.detail}` };
      }
      return { availability: 'available' as const, detail: `${status.detail}; ${automation.detail}` };
    }
    return { availability: 'available' as const, detail: status.detail };
  }

  async dispatch(request: WorkerDispatchRequest): Promise<WorkerDispatchResult> {
    this.policy.assertEngineeringExecute();
    const project = request.project;
    if (!project?.workspace || !project.worktreePath) {
      return { status: 'blocked', summary: 'Antigravity worker requires an explicit isolated Work Session worktree.' };
    }
    const cwd = await this.paths.resolveExisting(project.workspace, project.worktreePath);
    try {
      await fs.access(path.join(cwd, '.git'));
    } catch {
      return { status: 'blocked', summary: 'Assigned Antigravity worker path is not a Git worktree.' };
    }
    if (this.requireSandboxAutomationPolicy) {
      const automation = await antigravityAutomationPolicy(this.env);
      if (!automation.ready) {
        return { status: 'blocked', summary: `ANTIGRAVITY_SANDBOX_POLICY_REQUIRED; ${automation.detail}` };
      }
    }

    const executable = await resolveAntigravityExecutable(this.env, this.executableResolver);
    if (!executable) return { status: 'blocked', summary: 'Antigravity CLI executable is unavailable.' };
    const git = await this.executableResolver('git');
    if (!git) return { status: 'blocked', summary: 'Git executable is unavailable for worker evidence collection.' };

    const beforeStatus = await this.runner.run(git, ['status', '--short'], cwd, 10_000);
    const beforeDiff = await this.runner.run(git, ['diff', '--stat', '--'], cwd, 10_000);
    const prompt = safePrompt(request);
    const rawTimeout = Number(this.env.RWMCP_ANTIGRAVITY_WORKER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    const requestedTimeout = Number.isFinite(rawTimeout) && rawTimeout >= 10_000
      ? Math.floor(rawTimeout)
      : DEFAULT_TIMEOUT_MS;
    const timeoutLimit = Math.max(10_000, Math.min(
      requestedTimeout,
      this.policy.config.engineering?.maxCommandRuntimeMs ?? DEFAULT_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    ));
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--mode', 'accept-edits',
      '--add-dir', cwd,
      '--sandbox',
      '--print-timeout', `${Math.max(10, Math.ceil(timeoutLimit / 1000))}s`,
      ...(this.model ? ['--model', this.model] : [])
    ];
    const input = JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n';
    const childEnv = antigravityEnvironment(this.policy.config.process.inheritEnv, this.env);
    const result = await this.processRunner(executable, args, cwd, input, timeoutLimit, childEnv);
    const afterStatus = await this.runner.run(git, ['status', '--short'], cwd, 10_000);
    const afterDiff = await this.runner.run(git, ['diff', '--stat', '--'], cwd, 10_000);
    const evidence = [
      gitEvidence('before', beforeStatus, beforeDiff),
      gitEvidence('after', afterStatus, afterDiff)
    ].join(' | ');
    const stream = parseStream(result.stdout);
    const agyError = structuredAgyError(result.stderr);
    const detail = compact(stream.response || stream.error || agyError || result.stderr || 'no-summary', 480);
    const summary = boundedTail(
      `exit=${result.exitCode ?? 'null'} timeout=${result.timedOut}; ${evidence}; agyStatus=${stream.status ?? 'missing'}; permission=${stream.permissionMode ?? 'unknown'}; tools=${stream.toolCalls}; subagents=${stream.subagents}; tokens=${stream.totalTokens ?? 'unknown'}; worker=${detail}`,
      MAX_EVIDENCE_BYTES
    );

    const failureText = `${result.stdout}\n${result.stderr}\n${stream.error ?? ''}`;
    if (/authentication required|sign[ -]?in required|not authenticated|log in/i.test(failureText)) {
      return {
        status: 'blocked',
        ...(stream.conversationId ? { runId: stream.conversationId } : {}),
        summary: boundedTail(`ANTIGRAVITY_AUTH_REQUIRED; ${summary}`, MAX_EVIDENCE_BYTES)
      };
    }
    if (/\b429\b|resource[ -]?exhausted|rate[ -]?limit|usage[ -]?limit|quota|limit reached|too many requests|out of credits/i.test(failureText)) {
      return {
        status: 'blocked',
        ...(stream.conversationId ? { runId: stream.conversationId } : {}),
        summary: boundedTail(`ANTIGRAVITY_LIMIT_REACHED; ${summary}`, MAX_EVIDENCE_BYTES)
      };
    }
    if (/auto[- ]denied|headless mode cannot prompt for|required the ["']?[a-z0-9._-]+["']? permission|permission(?:\s+\w+){0,4}\s+(?:was\s+)?denied/i.test(failureText)) {
      return {
        status: 'blocked',
        ...(stream.conversationId ? { runId: stream.conversationId } : {}),
        summary: boundedTail(`ANTIGRAVITY_PERMISSION_REQUIRED; ${summary}`, MAX_EVIDENCE_BYTES)
      };
    }
    if (result.timedOut || result.exitCode !== 0 || stream.status !== 'SUCCESS') {
      return {
        status: 'failed',
        ...(stream.conversationId ? { runId: stream.conversationId } : {}),
        summary
      };
    }
    return {
      status: 'succeeded',
      ...(stream.conversationId ? { runId: stream.conversationId } : {}),
      summary
    };
  }
}

export function registerConfiguredAntigravityWorker(
  registry: WorkerProviderRegistry,
  policy: PolicyEngine,
  paths: PathGuard,
  runner: RunnerLike,
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<AntigravityWorkerOptions, 'env'> = {},
  ownerEnabled = false
): boolean {
  if (!ownerEnabled) return false;
  registry.register(new AntigravityWorkerProvider(policy, paths, runner, { ...options, env }));
  return true;
}
