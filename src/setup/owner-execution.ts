import path from 'node:path';
import fs from 'node:fs/promises';
import { GitAdapter } from '../adapters/git.js';
import { ProcessManager } from '../adapters/process-manager.js';
import { TaskAdapter } from '../adapters/tasks.js';
import { loadPolicy } from '../config.js';
import type { DeviceIdentity } from '../device-identity.js';
import type { ProcessReadSince, ProcessSnapshot } from '../model.js';
import { loadPermissionLease } from '../permissions.js';
import { PolicyEngine } from '../policy.js';
import { AuditLogger, audited } from '../security/audit.js';
import { runWithWorkSession } from '../security/execution-context.js';
import { PathGuard } from '../security/path-guard.js';
import { runAsPrincipal } from '../security/request-principal.js';
import { readPermissionState, type PermissionState } from './permissions.js';
import { ExecutionPolicyService } from '../execution-policy.js';
import { WorkSessionStore, type WorkSession } from '../work-session.js';

export const OWNER_EXECUTION_PRINCIPAL = 'local-control-center';
export const OWNER_EXECUTION_OPERATIONS = ['session-create', 'git-status', 'task-run', 'process-read', 'process-stop'] as const;
export type OwnerExecutionOperation = typeof OWNER_EXECUTION_OPERATIONS[number];

export type OwnerExecutionRequest =
  | { op: 'session-create'; nodeId: string; workspace: string; projectPath: string }
  | { op: 'git-status'; nodeId: string; sessionId: string }
  | { op: 'task-run'; nodeId: string; sessionId: string; profile: string }
  | { op: 'process-read'; nodeId: string; sessionId: string; processId: string; stdoutCursor?: number; stderrCursor?: number }
  | { op: 'process-stop'; nodeId: string; sessionId: string; processId: string };

export type OwnerExecutionProcess = Omit<ProcessSnapshot, 'workspace' | 'program' | 'args' | 'cwd'>;

export type OwnerExecutionResponse =
  | { op: 'session-create'; session: WorkSession }
  | { op: 'git-status'; status: string }
  | { op: 'task-run'; process: OwnerExecutionProcess }
  | { op: 'process-read'; process: OwnerExecutionProcess; stdout: ProcessReadSince['stdout']; stderr: ProcessReadSince['stderr'] }
  | { op: 'process-stop'; process: OwnerExecutionProcess };

export interface OwnerExecutionCatalog {
  authority: 'owner-local-only';
  node: Pick<DeviceIdentity, 'id' | 'name'>;
  policy: ReturnType<PolicyEngine['status']>;
  workspaces: Array<{ id: string; name?: string; root: string; readOnly: boolean; projectPaths: string[] }>;
  tasks: Array<{ name: string }>;
  sessions: WorkSession[];
  executionPolicy: Awaited<ReturnType<ExecutionPolicyService['status']>>;
  sessionExecutionPolicies: Record<string, Awaited<ReturnType<ExecutionPolicyService['status']>>>;
  limits: { maxActiveProcesses: number; maxOutputBytes: number; maxResults: number };
  operations: readonly OwnerExecutionOperation[];
}

export interface OwnerExecutionBridgeOptions {
  repoRoot: string;
  policyPath?: string;
  leasePath?: string;
  sessionStoreFile: string;
  auditPath: string;
  identity: DeviceIdentity;
  maxActiveProcesses?: number;
  maxResults?: number;
  completedProcessRetentionMs?: number;
  readPermissionState?: (repoRoot: string) => Promise<PermissionState>;
  executionPolicy?: ExecutionPolicyService;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Execution request must be an object.');
  return value as Record<string, unknown>;
}

function exact(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new Error(`Unknown request field '${key}'.`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be non-empty text.`);
  return value.trim();
}

function cursor(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${field} must be a non-negative integer.`);
  return value as number;
}

function request(value: unknown): OwnerExecutionRequest {
  const item = object(value);
  const op = text(item.op, 'op');
  if (!OWNER_EXECUTION_OPERATIONS.includes(op as OwnerExecutionOperation)) throw new Error(`Unsupported execution operation '${op}'.`);
  if (op === 'session-create') {
    exact(item, ['op', 'nodeId', 'workspace', 'projectPath']);
    return { op: 'session-create', nodeId: text(item.nodeId, 'nodeId'), workspace: text(item.workspace, 'workspace'), projectPath: text(item.projectPath, 'projectPath') };
  }
  if (op === 'git-status') {
    exact(item, ['op', 'nodeId', 'sessionId']);
    return { op: 'git-status', nodeId: text(item.nodeId, 'nodeId'), sessionId: text(item.sessionId, 'sessionId') };
  }
  if (op === 'task-run') {
    exact(item, ['op', 'nodeId', 'sessionId', 'profile']);
    return { op: 'task-run', nodeId: text(item.nodeId, 'nodeId'), sessionId: text(item.sessionId, 'sessionId'), profile: text(item.profile, 'profile') };
  }
  if (op === 'process-read') {
    exact(item, ['op', 'nodeId', 'sessionId', 'processId', 'stdoutCursor', 'stderrCursor']);
    return { op: 'process-read', nodeId: text(item.nodeId, 'nodeId'), sessionId: text(item.sessionId, 'sessionId'), processId: text(item.processId, 'processId'), stdoutCursor: cursor(item.stdoutCursor, 'stdoutCursor'), stderrCursor: cursor(item.stderrCursor, 'stderrCursor') };
  }
  exact(item, ['op', 'nodeId', 'sessionId', 'processId']);
  return { op: 'process-stop', nodeId: text(item.nodeId, 'nodeId'), sessionId: text(item.sessionId, 'sessionId'), processId: text(item.processId, 'processId') };
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export class OwnerExecutionBridge {
  private readonly managed = new Map<string, { manager: ProcessManager; sessionId: string; running: boolean; completedAt?: number }>();
  private readonly sessions: WorkSessionStore;
  private readonly audit: AuditLogger;
  private readonly maxActiveProcesses: number;
  private readonly maxResults: number;
  private readonly executionPolicy: ExecutionPolicyService;
  private readonly completedProcessRetentionMs: number;
  private launchTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: OwnerExecutionBridgeOptions) {
    this.sessions = new WorkSessionStore(OWNER_EXECUTION_PRINCIPAL, { file: options.sessionStoreFile });
    this.audit = new AuditLogger(options.auditPath, { clientId: OWNER_EXECUTION_PRINCIPAL, clientType: 'owner-local-control-center' });
    this.maxActiveProcesses = Math.max(1, Math.min(options.maxActiveProcesses ?? 8, 32));
    this.maxResults = Math.max(1, Math.min(options.maxResults ?? 100, 256));
    this.executionPolicy = options.executionPolicy ?? new ExecutionPolicyService();
    this.completedProcessRetentionMs = Math.max(1_000, Math.min(options.completedProcessRetentionMs ?? 5 * 60_000, 60 * 60_000));
  }

  private async refresh() {
    const [config, lease] = await Promise.all([loadPolicy(this.options.policyPath), loadPermissionLease(this.options.leasePath)]);
    const policy = new PolicyEngine(config, lease, OWNER_EXECUTION_PRINCIPAL);
    const paths = new PathGuard(policy);
    const processes = new ProcessManager(policy, paths, OWNER_EXECUTION_PRINCIPAL);
    return { policy, paths, git: new GitAdapter(policy, paths), processes, tasks: new TaskAdapter(policy, processes) };
  }

  private async asOwner<T>(operation: () => Promise<T>): Promise<T> {
    const permissions = await (this.options.readPermissionState ?? readPermissionState)(this.options.repoRoot);
    return await runAsPrincipal({ id: OWNER_EXECUTION_PRINCIPAL, type: 'owner-local-control-center', scopes: [...permissions.httpScopes], authenticated: true }, operation);
  }

  private async prune(): Promise<void> {
    const now = Date.now();
    for (const [id, item] of this.managed) {
      try {
        const snapshot = await runWithWorkSession(item.sessionId, () => item.manager.read(id));
        if (snapshot.status !== 'running' && item.running) {
          item.running = false;
          item.completedAt = now;
        }
      } catch { this.managed.delete(id); }
    }
    const completed = [...this.managed.entries()]
      .filter(([, item]) => !item.running)
      .sort((a, b) => (a[1].completedAt ?? 0) - (b[1].completedAt ?? 0));
    for (const [id, item] of completed) {
      if ((item.completedAt ?? now) + this.completedProcessRetentionMs <= now) this.managed.delete(id);
    }
    const retained = [...this.managed.entries()]
      .filter(([, item]) => !item.running)
      .sort((a, b) => (a[1].completedAt ?? 0) - (b[1].completedAt ?? 0));
    while (retained.length > this.maxResults) this.managed.delete(retained.shift()![0]);
  }

  private async launch<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.launchTail;
    let release!: () => void;
    this.launchTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private local(nodeId: string): void {
    if (nodeId !== this.options.identity.id) throw new Error('Execution is available only on this local node.');
  }

  private async session(sessionId: string): Promise<WorkSession> {
    const session = await this.sessions.inspect(sessionId, false);
    if (session.status === 'closing' || session.status === 'closed' || session.status === 'expired') throw new Error(`Work Session ${session.id} is ${session.status}.`);
    if (!session.capsule.project?.workspace || !session.capsule.project.projectPath) throw new Error('Work Session has no selected project.');
    return session;
  }

  private async project(session: WorkSession, paths: PathGuard): Promise<{ workspace: string; projectPath: string; realPath: string }> {
    const project = session.capsule.project!;
    const realPath = await paths.resolveExisting(project.workspace, project.projectPath!);
    return { workspace: project.workspace, projectPath: project.projectPath!, realPath };
  }

  private snapshot(snapshot: ProcessSnapshot): OwnerExecutionProcess {
    const { workspace: _workspace, program: _program, args: _args, cwd: _cwd, ...safe } = snapshot;
    return safe;
  }

  private async projectPaths(workspace: string, paths: PathGuard): Promise<string[]> {
    const root = await paths.resolveExisting(workspace, '.');
    const candidates = ['.'];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) candidates.push(entry.name);
    }
    const accepted: string[] = [];
    for (const candidate of candidates.slice(0, this.maxResults + 1)) {
      try {
        const real = await paths.resolveExisting(workspace, candidate);
        const gitMarker = await fs.stat(path.join(real, '.git')).catch(() => undefined);
        if (gitMarker && (gitMarker.isDirectory() || gitMarker.isFile())) accepted.push(candidate);
      } catch { /* unsafe/missing entries are not catalogued */ }
    }
    return accepted.slice(0, this.maxResults);
  }

  async catalog(): Promise<OwnerExecutionCatalog> {
    return await this.asOwner(async () => {
    const runtime = await this.refresh();
    const { policy } = runtime;
    return await audited(this.audit, 'execution_policy_status', undefined, async () => {
      const sessions = (await this.sessions.list(false)).slice(0, this.maxResults);
      const sessionExecutionPolicies = Object.fromEntries(await Promise.all(
        sessions.map(async session => [session.id, await this.executionPolicy.status(session.id)] as const)
      ));
      return {
      authority: 'owner-local-only',
      node: { id: this.options.identity.id, name: this.options.identity.name },
      policy: policy.status(),
      workspaces: await Promise.all(policy.config.workspaces.slice(0, this.maxResults).map(async item => ({
        id: item.id,
        name: item.name,
        root: item.root,
        readOnly: item.readOnly === true,
        projectPaths: await this.projectPaths(item.id, runtime.paths)
      }))),
      tasks: Object.keys(policy.config.tasks ?? {}).slice(0, this.maxResults).map(name => ({ name })),
      sessions,
      executionPolicy: await this.executionPolicy.status(),
      sessionExecutionPolicies,
      limits: { maxActiveProcesses: this.maxActiveProcesses, maxOutputBytes: policy.config.process.maxOutputBytes, maxResults: this.maxResults },
      operations: OWNER_EXECUTION_OPERATIONS
    }; });
    });
  }

  async execute(input: unknown): Promise<OwnerExecutionResponse> {
    return await this.asOwner(async () => {
    const parsed = request(input); this.local(parsed.nodeId); await this.prune();
    const runtime = await this.refresh();
    if (parsed.op === 'session-create') {
      return audited(this.audit, 'work_session_create', parsed.workspace, async () => {
        const allowed = new Set(await this.projectPaths(parsed.workspace, runtime.paths));
        if (!allowed.has(parsed.projectPath)) throw new Error('projectPath must be selected from the execution catalog.');
        await runtime.paths.resolveExisting(parsed.workspace, parsed.projectPath);
        const session = await this.sessions.create({ workspace: parsed.workspace, projectPath: parsed.projectPath });
        return { op: parsed.op, session };
      });
    }
    const session = await this.session(parsed.sessionId);
    const project = await this.project(session, runtime.paths);
    if (parsed.op === 'git-status') {
      return audited(this.audit, 'git_status', project.workspace, async () => {
        await this.sessions.touch(session.id);
        return { op: parsed.op, status: await runWithWorkSession(session.id, () => runtime.git.status(project.workspace, project.projectPath)) };
      });
    }
    if (parsed.op === 'task-run') {
      return audited(this.audit, 'task_run', project.workspace, async () => {
        await this.sessions.touch(session.id);
        const task = (runtime.policy.config.tasks ?? {})[parsed.profile];
        if (!task) throw new Error(`Unknown task profile '${parsed.profile}'.`);
        if (runtime.policy.workspace(project.workspace).readOnly) {
          throw new Error(`Workspace '${project.workspace}' is read-only.`);
        }
        const cwd = await runtime.paths.resolveExisting(project.workspace, task.cwd ?? '.');
        if (!contained(project.realPath, cwd)) throw new Error('Configured task cwd is outside the selected Work Session project.');
        return await this.launch(async () => {
          await this.prune();
          if ([...this.managed.values()].filter(item => item.running).length >= this.maxActiveProcesses) throw new Error(`Active process limit (${this.maxActiveProcesses}) reached.`);
          const process = await runWithWorkSession(session.id, () => runtime.tasks.run(project.workspace, parsed.profile));
          this.managed.set(process.id, { manager: runtime.processes, sessionId: session.id, running: true });
          return { op: parsed.op, process: this.snapshot(process) };
        });
      });
    }
    if (parsed.op === 'process-read') {
      const owner = this.managed.get(parsed.processId);
      if (!owner || owner.sessionId !== session.id) throw new Error(`Unknown process id '${parsed.processId}'.`);
      return audited(this.audit, 'process_read', project.workspace, async () => {
        await this.sessions.touch(session.id);
        const result = await runWithWorkSession(session.id, () => owner.manager.readSince(parsed.processId, parsed.stdoutCursor, parsed.stderrCursor));
        return { op: parsed.op, process: this.snapshot(result.process), stdout: result.stdout, stderr: result.stderr };
      });
    }
    const owner = this.managed.get(parsed.processId);
    if (!owner || owner.sessionId !== session.id) throw new Error(`Unknown process id '${parsed.processId}'.`);
    const process = await audited(this.audit, 'process_stop', project.workspace, async () => {
      await this.sessions.touch(session.id);
      return { op: parsed.op, process: this.snapshot(await runWithWorkSession(session.id, () => owner.manager.stop(parsed.processId)) ) };
    });
    owner.running = false;
    owner.completedAt = Date.now();
    return process;
    });
  }

  async close(): Promise<void> {
    await runAsPrincipal({ id: OWNER_EXECUTION_PRINCIPAL, type: 'owner-local-control-center', scopes: [], authenticated: true }, async () => {
      await this.prune();
      await Promise.all([...this.managed.entries()].map(async ([id, item]) => {
        if (!item.running) return;
        try {
          await runWithWorkSession(item.sessionId, () => item.manager.stop(id));
          item.running = false;
          item.completedAt = Date.now();
        } catch {
          // Shutdown is best-effort. Do not reconcile or mutate production Work Sessions.
        }
      }));
    });
  }
}
