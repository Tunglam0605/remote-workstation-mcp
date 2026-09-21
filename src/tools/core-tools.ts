import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { ACTION_SCHEMA_VERSION, BUILD_CHANNEL, BUILD_COMMIT, CAPABILITIES, ENGINEERING_API_VERSION, SERVER_VERSION } from '../capabilities.js';
import { CONCURRENCY_OPERATIONS } from '../concurrency-policy.js';
import { engineeringWorkflowIdSchema, persistedWorkflowParametersSchema } from '../engineering-workflow-contract.js';
import { audited } from '../security/audit.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

const workObjectiveMutation = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add_task'),
    title: z.string().min(1).max(256),
    description: z.string().min(1).max(2048).optional(),
    priority: z.number().int().min(-1000).max(1000).default(0),
    dependencies: z.array(z.string().uuid()).max(64).default([]),
    concurrencyOperation: z.enum(CONCURRENCY_OPERATIONS).optional(),
    concurrencyKey: z.string().min(1).max(512).optional(),
    execution: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('engineering-workflow'),
        workspace: z.string().min(1).max(128),
        projectPath: z.string().min(1).max(1024).default('.'),
        workflow: engineeringWorkflowIdSchema,
        parameters: persistedWorkflowParametersSchema
      }).strict(),
      z.object({
        kind: z.literal('worker-provider'),
        providerId: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
      }).strict()
    ]).optional()
  }),
  z.object({
    action: z.literal('replace_dependencies'),
    taskId: z.string().uuid(),
    dependencies: z.array(z.string().uuid()).max(64)
  })
]);

const projectSessionGroupMutation = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add_session'), sessionId: z.string().uuid() }),
  z.object({ action: z.literal('remove_session'), sessionId: z.string().uuid() }),
  z.object({ action: z.literal('close') })
]);

export function registerCoreTools(server: McpServer, ctx: AppContext): void {
  server.registerTool('capabilities_list', {
    description: 'Discover workstation capabilities exposed by this MCP server and their implementation status.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'capabilities_list', undefined, async () => ({
    server: 'remote-workstation-mcp', version: SERVER_VERSION, channel: BUILD_CHANNEL, gitCommit: BUILD_COMMIT ?? null, protocol: 'MCP', vendorNeutral: true,
    actionSchemaVersion: ACTION_SCHEMA_VERSION,
    engineeringApiVersion: ENGINEERING_API_VERSION,
    actorTag: ctx.actor,
    identityNote: 'Authenticated HTTP principals are request-scoped. RWMCP client tags remain fallback observability metadata for local transports; local owner policy and leases remain the authority.',
    capabilities: CAPABILITIES
  }))));

  server.registerTool('system_info', {
    description: 'Return non-secret host OS, CPU, memory and uptime information.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'system_info', undefined, async () => ({
    serverVersion: SERVER_VERSION,
    channel: BUILD_CHANNEL,
    gitCommit: BUILD_COMMIT ?? null,
    device: ctx.identity,
    platform: os.platform(), release: os.release(), arch: os.arch(), hostname: os.hostname(),
    cpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(), uptimeSeconds: os.uptime(),
    node: process.version,
    permission: ctx.policy.status()
  }))));

  server.registerTool('tool_discover', {
    description: 'Discover common development/debug executables installed on the workstation and whether local policy allows executing them.',
    inputSchema: z.object({ extra: z.array(z.string().min(1)).max(50).default([]) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ extra }) => result({ tools: await audited(ctx.audit, 'tool_discover', undefined, () => ctx.tools.discover(extra)) }));

  server.registerTool('update_check', {
    description: 'Check the official GitHub Releases feed for a newer Remote Workstation MCP version. This never installs an update.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  }, async () => result(await audited(ctx.audit, 'update_check', undefined, () => ctx.updates.check())));

  server.registerTool('workspace_list', {
    description: 'List workspace roots authorized by the local owner policy.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'workspace_list', undefined, async () => ctx.config.workspaces.map(ws => ({ id: ws.id, name: ws.name ?? ws.id, root: ws.root, readOnly: ws.readOnly ?? false })))));

  server.registerTool('work_session_create', {
    description: 'Create a durable Work Session owned by the current authenticated principal. A Work Session can restrict/isolate resources but never grants permissions beyond principal scopes and local owner policy.',
    inputSchema: z.object({
      name: z.string().min(1).max(128).optional(),
      workspace: z.string().min(1).max(128).optional(),
      projectPath: z.string().min(1).max(1024).optional(),
      objective: z.string().min(1).max(2048).optional(),
      role: z.string().min(1).max(256).optional(),
      idleAfterMinutes: z.number().int().min(1).max(43200).optional(),
      expireAfterMinutes: z.number().int().min(1).max(43200).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ name, workspace, projectPath, objective, role, idleAfterMinutes, expireAfterMinutes }) => result(await audited(ctx.audit, 'work_session_create', workspace, async () => {
    if (workspace) {
      ctx.policy.workspace(workspace);
      if (projectPath) await ctx.paths.resolveExisting(workspace, projectPath);
    } else if (projectPath) {
      throw new Error('projectPath requires workspace.');
    }
    return {
      session: await ctx.workSessions.create({ name, workspace, projectPath, objective, role, idleAfterMinutes, expireAfterMinutes }),
      permissionModel: 'session permissions are always a subset of authenticated principal scopes and local owner policy'
    };
  })));

  server.registerTool('work_session_resume', {
    description: 'Resume one durable caller-owned Work Session as a read-only handoff package containing its compact Context Capsule, current session-owned runtime resources and same-project coordination snapshot when available. The session id identifies state; it is not an authorization credential.',
    inputSchema: z.object({ sessionId: z.string().uuid() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ sessionId }) => result(await audited(ctx.audit, 'work_session_resume', undefined, async () => {
    const session = await ctx.workSessions.inspect(sessionId, true);
    const runtime = await ctx.scopeWorkSession(sessionId, async () => ({
      processes: ctx.processes.list(),
      terminals: ctx.engineering.terminals.list(),
      serial: ctx.engineering.serial.list(),
      debug: ctx.engineering.debug.list(),
      hardwareLeases: ctx.engineering.resources.listOwned(),
      workflowRuns: await ctx.workflowRuns.list(20),
      taskAttempts: await ctx.taskAttempts.list({ limit: 20 }),
      qualityObservations: await ctx.qualityObservations.list(20).catch(error => ({
        available: false,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 512)
      })),
      nodeInterlocks: await ctx.nodeInterlocks.listOwned(),
      worktree: await ctx.worktreeManager.status(sessionId)
    }));
    const project = session.capsule.project;
    const projectStatus = project?.workspace && project.projectPath
      ? await ctx.projectCoordination.status(project.workspace, project.projectPath, { includeClosed: false, maxSessions: 32 })
      : undefined;
    return {
      session,
      runtime,
      ...(projectStatus ? { projectStatus } : {}),
      handoff: {
        mode: 'read-only',
        workSessionId: session.id,
        currentTask: session.capsule.currentTask ?? null,
        role: session.capsule.role ?? null,
        note: 'A new ChatGPT Web conversation may continue by passing this explicit workSessionId on session-aware operations. RWMCP does not choose strategy, claim work, or activate the session during resume.'
      },
      usage: 'Pass workSessionId on session-aware operations. Omit it only for the backward-compatible implicit session.'
    };
  })));

  server.registerTool('work_session_list', {
    description: 'List durable Work Sessions owned by the current principal. Other principals are never disclosed.',
    inputSchema: z.object({ includeClosed: z.boolean().default(false) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ includeClosed }) => result(await audited(ctx.audit, 'work_session_list', undefined, async () => ({
    sessions: await ctx.workSessions.list(includeClosed)
  }))));

  server.registerTool('work_session_lifecycle_preview', {
    description: 'Return a read-only mechanical preview of Work Session lifecycle state, active owned resources, worktree cleanliness, and whether explicit close or worktree cleanup is currently eligible. It never closes, cleans, stops, releases, or activates anything.',
    inputSchema: z.object({ sessionId: z.string().uuid() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ sessionId }) => result(
    await audited(ctx.audit, 'work_session_lifecycle_preview', undefined, () =>
      ctx.workSessionLifecycle.preview(sessionId)
    )
  ));

  server.registerTool('project_status', {
    description: 'Return a bounded read-only coordination snapshot for caller-owned Work Sessions on one project, including current task labels, worktree state, mechanical worktree conflicts and duplicate-task-label overlap signals. It never claims tasks, activates sessions or grants authority.',
    inputSchema: z.object({
      workspace: z.string().min(1).max(128),
      projectPath: z.string().min(1).max(1024),
      includeClosed: z.boolean().default(false),
      maxSessions: z.number().int().min(1).max(128).default(32)
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath, includeClosed, maxSessions }) => result(
    await audited(ctx.audit, 'project_status', workspace, async () => {
      ctx.policy.workspace(workspace);
      await ctx.paths.resolveExisting(workspace, projectPath);
      return ctx.projectCoordination.status(workspace, projectPath, { includeClosed, maxSessions });
    })
  ));

  server.registerTool('work_session_checkpoint', {
    description: 'Persist a compact bounded Context Capsule checkpoint for a caller-owned Work Session. currentTask is a human/controller-managed coordination label and may be set to null to release it. Do not store secrets, raw logs, transcripts or duplicated source.',
    inputSchema: z.object({
      sessionId: z.string().uuid(),
      currentObjective: z.string().min(1).max(2048).optional(),
      role: z.string().min(1).max(256).optional(),
      validatedFacts: z.array(z.string().min(1).max(512)).max(32).optional(),
      selectedProvider: z.string().min(1).max(256).optional(),
      selectedToolchain: z.string().min(1).max(256).optional(),
      selectedVariant: z.string().min(1).max(256).optional(),
      completedTasks: z.array(z.string().min(1).max(512)).max(64).optional(),
      currentTask: z.string().min(1).max(512).nullable().optional(),
      lastSuccessfulBuild: z.string().min(1).max(1024).optional(),
      lastSuccessfulDeploy: z.string().min(1).max(1024).optional(),
      lastAcceptance: z.string().min(1).max(1024).optional(),
      blockers: z.array(z.string().min(1).max(512)).max(32).optional(),
      decisions: z.array(z.string().min(1).max(512)).max(32).optional(),
      resourceState: z.array(z.string().min(1).max(512)).max(32).optional(),
      pendingActions: z.array(z.string().min(1).max(512)).max(32).optional(),
      nextRecommendedEngineeringAction: z.string().min(1).max(1024).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ sessionId, ...checkpoint }) => result(await audited(ctx.audit, 'work_session_checkpoint', undefined, async () => ({
    session: await ctx.workSessions.checkpoint(sessionId, checkpoint)
  }))));

  server.registerTool('work_session_close', {
    description: 'Close a caller-owned Work Session only after fail-closed runtime-resource and worktree checks. Close never deletes source, removes a worktree, stops runtime resources or force-cleans dirty work.',
    inputSchema: z.object({ sessionId: z.string().uuid() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ sessionId }) => result(
    await audited(ctx.audit, 'work_session_close', undefined, () =>
      ctx.workSessionLifecycle.close(sessionId)
    )
  ));

  server.registerTool('work_session_worktree_prepare', {
    description: 'Create or reuse the caller-owned isolated Git worktree for a writable Work Session. RWMCP never widens workspace scope automatically.',
    inputSchema: z.object({
      sessionId: z.string().uuid(),
      workspace: z.string().min(1),
      repoPath: z.string().min(1).max(1024).optional(),
      startPoint: z.string().min(1).max(256).default('HEAD')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ sessionId, workspace, repoPath, startPoint }) => result(
    await audited(ctx.audit, 'work_session_worktree_prepare', workspace, () =>
      ctx.worktreeManager.prepare(sessionId, { workspace, repoPath, startPoint })
    )
  ));

  server.registerTool('work_session_worktree_status', {
    description: 'Inspect the caller-owned Work Session worktree and report whether it is dirty.',
    inputSchema: z.object({ sessionId: z.string().uuid() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ sessionId }) => result(
    await audited(ctx.audit, 'work_session_worktree_status', undefined, () =>
      ctx.worktreeManager.status(sessionId)
    )
  ));

  server.registerTool('work_session_worktree_cleanup', {
    description: 'Safely remove a clean caller-owned Work Session worktree. Dirty worktrees are never force-removed and return NEEDS_OWNER_OR_EXPLICIT_ACTION.',
    inputSchema: z.object({ sessionId: z.string().uuid() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ sessionId }) => result(
    await audited(ctx.audit, 'work_session_worktree_cleanup', undefined, () =>
      ctx.worktreeManager.cleanup(sessionId)
    )
  ));

  server.registerTool('project_session_group_create', {
    description: 'Create a bounded coordination-only Project Session Group from caller-owned Work Sessions that already belong to the same project. Group identity never grants authority or execution rights.',
    inputSchema: z.object({
      name: z.string().min(1).max(128).optional(),
      sessionIds: z.array(z.string().uuid()).min(1).max(16)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ name, sessionIds }) => result(await audited(ctx.audit, 'project_session_group_create', undefined, async () => ({
    group: await ctx.projectSessionGroups.create({ name, sessionIds }),
    permissionModel: 'coordination metadata only; member Work Sessions retain their original principal, policy and resource boundaries'
  }))));

  server.registerTool('project_session_group_inspect', {
    description: 'Inspect caller-owned Project Session Groups. The view is coordination-only and does not activate Work Sessions or grant cross-session execution authority.',
    inputSchema: z.object({
      groupId: z.string().uuid().optional(),
      includeClosed: z.boolean().default(false)
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ groupId, includeClosed }) => result(await audited(ctx.audit, 'project_session_group_inspect', undefined, async () =>
    groupId
      ? { group: await ctx.projectSessionGroups.get(groupId) }
      : { groups: await ctx.projectSessionGroups.list(includeClosed) }
  )));

  server.registerTool('project_session_group_mutate', {
    description: 'Mutate Project Session Group membership or close the group. This only changes coordination metadata; it never closes Work Sessions, removes worktrees, executes tasks, acquires resources or changes permissions.',
    inputSchema: z.object({
      groupId: z.string().uuid(),
      mutation: projectSessionGroupMutation
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ groupId, mutation }) => result(await audited(ctx.audit, 'project_session_group_mutate', undefined, async () => {
    if (mutation.action === 'add_session') {
      return { group: await ctx.projectSessionGroups.addSession(groupId, mutation.sessionId) };
    }
    if (mutation.action === 'remove_session') {
      return { group: await ctx.projectSessionGroups.removeSession(groupId, mutation.sessionId) };
    }
    return { group: await ctx.projectSessionGroups.close(groupId) };
  })));

  server.registerTool('execution_policy_status', {
    description: 'Read the owner-managed execution policy and effective mode. With workSessionId, includes that Work Session override and Codex task counters. This tool never changes owner settings or activates Codex.',
    inputSchema: z.object({
      workSessionId: z.string().uuid().optional()
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workSessionId }) => result(await audited(ctx.audit, 'execution_policy_status', undefined, () =>
    ctx.runInWorkSession(workSessionId, () => ctx.executionPolicy.status(workSessionId))
  )));

  server.registerTool('execution_policy_set_override', {
    description: 'Set or clear the execution mode override for one caller-owned Work Session when the local owner has enabled chat overrides in Control Center. It cannot enable Codex globally, clear fallback, change budgets or mutate owner defaults.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      mode: z.enum(['rwmcp-only', 'codex-only', 'both']).nullable()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ workSessionId, mode }) => result(await audited(ctx.audit, 'execution_policy_set_override', undefined, () =>
    ctx.runInWorkSession(workSessionId, () => ctx.executionPolicy.setSessionOverride(workSessionId, mode))
  )));

  server.registerTool('codex_account_broker_status', {
    description: 'Read safe Codex account-broker status. Reports masked Cockpit account metadata and local API-pool readiness without exposing access tokens, refresh tokens, API keys or encrypted credential payloads.',
    inputSchema: z.object({ probe: z.boolean().default(true) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ probe }) => result(await audited(ctx.audit, 'codex_account_broker_status', undefined, () =>
    ctx.codexAccountBroker.status({ probe })
  )));

  server.registerTool('antigravity_status', {
    description: 'Read safe local Google Antigravity CLI status, current model and model-quota summary. This tool never exposes Google OAuth/keyring credentials and never starts an agent turn.',
    inputSchema: z.object({ includeQuota: z.boolean().default(true) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ includeQuota }) => result(await audited(ctx.audit, 'antigravity_status', undefined, () =>
    ctx.antigravityWorker.inspect(includeQuota)
  )));

  server.registerTool('worker_provider_list', {
    description: 'List bounded status for optional worker-provider adapters registered by the local runtime. Registration and authority remain local/runtime-owned; this read-only tool cannot dispatch providers.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'worker_provider_list', undefined, async () => {
    const providers = await ctx.workerProviders.listStatus();
    return {
      providers,
      executionPolicy: await ctx.executionPolicy.status(),
      executionActive: providers.some(provider => provider.executionActive),
      authority: 'registry-only',
      note: 'Dispatch-capable providers may be used only through persisted worker-provider task bindings and work_objective_execute_task. Provider registration is not exposed through MCP; direct MCP control remains independent of worker availability.'
    };
  })));

  server.registerTool('work_objective_create', {
    description: 'Create a durable Work Objective inside one explicit caller-owned Work Session. Objective/task identity never grants authority beyond the authenticated principal and local owner policy.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      name: z.string().min(1).max(128),
      objective: z.string().min(1).max(2048)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ workSessionId, name, objective }) => result(await audited(ctx.audit, 'work_objective_create', undefined, () =>
    ctx.runInWorkSession(workSessionId, async () => ({
      objective: await ctx.taskGraphs.create({ name, objective }),
      permissionModel: 'objective/task ids are state identifiers, not authorization credentials'
    }))
  )));

  server.registerTool('work_objective_inspect', {
    description: 'Inspect durable Work Objectives owned by one explicit Work Session. Omitting objectiveId lists that session objectives only.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      objectiveId: z.string().uuid().optional()
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workSessionId, objectiveId }) => result(await audited(ctx.audit, 'work_objective_inspect', undefined, () =>
    ctx.runInWorkSession(workSessionId, async () => objectiveId
      ? { objective: await ctx.taskGraphs.get(objectiveId) }
      : { objectives: await ctx.taskGraphs.list() }
    )
  )));

  server.registerTool('work_objective_attempts', {
    description: 'Inspect bounded durable Task Attempt history for the caller-owned Work Session. Attempts are execution evidence, not authority grants.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      objectiveId: z.string().uuid().optional(),
      taskId: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(500).default(100)
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workSessionId, objectiveId, taskId, limit }) => result(await audited(ctx.audit, 'work_objective_attempts', undefined, () =>
    ctx.runInWorkSession(workSessionId, async () => ({
      attempts: await ctx.taskAttempts.list({ objectiveId, taskId, limit })
    }))
  )));

  server.registerTool('work_objective_mutate', {
    description: 'Edit Task Graph structure only. This tool may add a task or replace task dependencies; it cannot mark work running/succeeded/failed and cannot acquire permissions, leases or interlocks.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      objectiveId: z.string().uuid(),
      mutation: workObjectiveMutation
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ workSessionId, objectiveId, mutation }) => result(await audited(ctx.audit, 'work_objective_mutate', undefined, () =>
    ctx.runInWorkSession(workSessionId, async () => {
      if (mutation.action === 'add_task') {
        return {
          task: await ctx.taskGraphs.addTask(objectiveId, {
            title: mutation.title,
            description: mutation.description,
            priority: mutation.priority,
            dependencies: mutation.dependencies,
            concurrency: {
              ...(mutation.concurrencyOperation ? { operation: mutation.concurrencyOperation } : {}),
              ...(mutation.concurrencyKey ? { key: mutation.concurrencyKey } : {})
            },
            ...(mutation.execution ? { execution: mutation.execution } : {})
          })
        };
      }
      return {
        task: await ctx.taskGraphs.replaceDependencies(objectiveId, mutation.taskId, mutation.dependencies)
      };
    })
  )));

  server.registerTool('work_objective_summary', {
    description: 'Return a compact read-only Objective progress summary derived from Task Graph, Task Attempts and Scheduler Awareness. It reports state/progress/blockers/resources/latest failure/next mechanically actionable tasks without raw logs or engineering strategy.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      objectiveId: z.string().uuid(),
      taskLimit: z.number().int().min(1).max(128).default(64),
      blockerLimit: z.number().int().min(1).max(32).default(16),
      actionableLimit: z.number().int().min(1).max(32).default(16)
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workSessionId, objectiveId, taskLimit, blockerLimit, actionableLimit }) => result(await audited(ctx.audit, 'work_objective_summary', undefined, () =>
    ctx.runInWorkSession(workSessionId, () =>
      ctx.objectiveProgress.summary(objectiveId, { taskLimit, blockerLimit, actionableLimit })
    )
  )));

  server.registerTool('work_objective_schedule', {
    description: 'Return a deterministic read-only plan enriched with live Work Session/resource/node awareness. Awareness can classify READY work as waiting, but it never grants authority or acquires leases/interlocks.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      objectiveId: z.string().uuid(),
      limit: z.number().int().min(1).max(128).default(32)
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workSessionId, objectiveId, limit }) => result(await audited(ctx.audit, 'work_objective_schedule', undefined, () =>
    ctx.runInWorkSession(workSessionId, async () => ({
      ...(await ctx.schedulerAwareness.snapshot(objectiveId, limit)),
      authority: 'planning-only',
      executionActive: false,
      note: 'Scheduler awareness reports live contention and session/worktree state. It is not permission to execute; policy, typed workflow validation, resource leases and node interlocks remain authoritative at execution time.'
    }))
  )));

  server.registerTool('work_objective_execute_task', {
    description: 'Execute one READY task through its persisted engineering-workflow or worker-provider binding. The call accepts identifiers only; Work Session ownership, scheduler concurrency, resource leases, node interlocks, Task Attempts and local policy remain authoritative. Worker providers must already be registered by the local runtime and cannot be registered or granted authority through MCP.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      objectiveId: z.string().uuid(),
      taskId: z.string().uuid()
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workSessionId, objectiveId, taskId }) => result(await audited(ctx.audit, 'work_objective_execute_task', undefined, () =>
    ctx.runInWorkSession(workSessionId, () =>
      ctx.taskWorkflowExecution.execute(objectiveId, taskId)
    )
  )));

  server.registerTool('work_objective_cancel_task', {
    description: 'Cancel one task safely. Pending/READY work is cancelled before dispatch; RUNNING work records a cancellation request but does not falsely claim generic provider preemption.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      objectiveId: z.string().uuid(),
      taskId: z.string().uuid()
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workSessionId, objectiveId, taskId }) => result(await audited(ctx.audit, 'work_objective_cancel_task', undefined, () =>
    ctx.runInWorkSession(workSessionId, () =>
      ctx.taskWorkflowExecution.cancel(objectiveId, taskId)
    )
  )));

  server.registerTool('work_objective_retry_task', {
    description: 'Create a new explicit execution generation for one failed or cancelled task. Previous generations are immutable execution history and are never rerun implicitly.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      objectiveId: z.string().uuid(),
      taskId: z.string().uuid()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ workSessionId, objectiveId, taskId }) => result(await audited(ctx.audit, 'work_objective_retry_task', undefined, () =>
    ctx.runInWorkSession(workSessionId, () =>
      ctx.taskWorkflowExecution.retry(objectiveId, taskId)
    )
  )));

  server.registerTool('fs_list', {
    description: 'List a directory inside an authorized workspace. Paths are workspace-relative.',
    inputSchema: z.object({ workspace: z.string(), path: z.string().default('.') }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, path }) => result(await audited(ctx.audit, 'fs_list', workspace, () => ctx.fs.list(workspace, path))));

  server.registerTool('fs_find', {
    description: 'Find files by path/name substring within an authorized workspace. Search is bounded and skips symlinks, .git and node_modules.',
    inputSchema: z.object({ workspace: z.string(), query: z.string().min(1), path: z.string().default('.'), maxResults: z.number().int().positive().max(1000).optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, query, path, maxResults }) => result({ matches: await audited(ctx.audit, 'fs_find', workspace, () => ctx.search.findFiles(workspace, query, path, maxResults)) }));

  server.registerTool('fs_search_text', {
    description: 'Search UTF-8 text files within an authorized workspace and return bounded line matches.',
    inputSchema: z.object({ workspace: z.string(), query: z.string().min(1), path: z.string().default('.'), caseSensitive: z.boolean().default(false), maxResults: z.number().int().positive().max(1000).optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, query, path, caseSensitive, maxResults }) => result({ matches: await audited(ctx.audit, 'fs_search_text', workspace, () => ctx.search.searchText(workspace, query, path, caseSensitive, maxResults)) }));

  server.registerTool('fs_read', {
    description: 'Read a UTF-8 text file inside an authorized workspace and return its SHA-256 for optimistic concurrency.',
    inputSchema: z.object({ workspace: z.string(), path: z.string().min(1) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, path }) => result(await audited(ctx.audit, 'fs_read', workspace, () => ctx.fs.read(workspace, path))));

  server.registerTool('fs_write', {
    description: 'Create or overwrite a UTF-8 file. Supply expectedSha256 when overwriting a file previously read to prevent lost updates from concurrent agents.',
    inputSchema: z.object({ workspace: z.string(), path: z.string().min(1), content: z.string(), overwrite: z.boolean().default(false), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, path, content, overwrite, expectedSha256 }) => result(await audited(ctx.audit, 'fs_write', workspace, () => ctx.fs.write(workspace, path, content, overwrite, expectedSha256))));

  server.registerTool('fs_patch', {
    description: 'Deterministically replace exact text in a file. Supply the SHA-256 from fs_read to detect concurrent modification.',
    inputSchema: z.object({ workspace: z.string(), path: z.string().min(1), find: z.string().min(1), replace: z.string(), expectedOccurrences: z.number().int().positive().default(1), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, path, find, replace, expectedOccurrences, expectedSha256 }) => result(await audited(ctx.audit, 'fs_patch', workspace, () => ctx.fs.patch(workspace, path, find, replace, expectedOccurrences, expectedSha256))));

  server.registerTool('git_status', {
    description: 'Run read-only git status in a repository inside an authorized workspace.',
    inputSchema: z.object({ workspace: z.string(), repoPath: z.string().default('.') }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, repoPath }) => result({ output: await audited(ctx.audit, 'git_status', workspace, () => ctx.git.status(workspace, repoPath)) }));

  server.registerTool('git_diff', {
    description: 'Run read-only git diff in a repository inside an authorized workspace.',
    inputSchema: z.object({ workspace: z.string(), staged: z.boolean().default(false), repoPath: z.string().default('.') }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, staged, repoPath }) => result({ output: await audited(ctx.audit, 'git_diff', workspace, () => ctx.git.diff(workspace, staged, repoPath)) }));

  server.registerTool('git_log', {
    description: 'Return bounded structured Git history without sending raw log formatting to the model.',
    inputSchema: z.object({ workspace: z.string(), repoPath: z.string().default('.'), maxEntries: z.number().int().positive().max(200).default(20) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, repoPath, maxEntries }) => result({ commits: await audited(ctx.audit, 'git_log', workspace, () => ctx.git.log(workspace, maxEntries, repoPath)) }));

  server.registerTool('git_branches', {
    description: 'List local Git branches and identify the current branch.',
    inputSchema: z.object({ workspace: z.string(), repoPath: z.string().default('.') }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, repoPath }) => result({ branches: await audited(ctx.audit, 'git_branches', workspace, () => ctx.git.branches(workspace, repoPath)) }));

  server.registerTool('git_add', {
    description: 'Stage explicitly named existing paths. Paths remain constrained to the authorized workspace and no shell is used.',
    inputSchema: z.object({ workspace: z.string(), repoPath: z.string().default('.'), files: z.array(z.string().min(1)).min(1).max(200) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, repoPath, files }) => result(await audited(ctx.audit, 'git_add', workspace, () => ctx.git.add(workspace, files, repoPath))));

  server.registerTool('git_commit', {
    description: 'Create a Git commit from the current index. This is blocked for read-only workspaces.',
    inputSchema: z.object({ workspace: z.string(), repoPath: z.string().default('.'), message: z.string().min(1).max(5000) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, repoPath, message }) => result(await audited(ctx.audit, 'git_commit', workspace, () => ctx.git.commit(workspace, message, repoPath))));

  server.registerTool('git_branch_create', {
    description: 'Create a local branch from a start point using Git ref validation.',
    inputSchema: z.object({ workspace: z.string(), repoPath: z.string().default('.'), branch: z.string().min(1), startPoint: z.string().default('HEAD') }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, repoPath, branch, startPoint }) => result(await audited(ctx.audit, 'git_branch_create', workspace, () => ctx.git.createBranch(workspace, branch, startPoint, repoPath))));

  server.registerTool('git_branch_switch', {
    description: 'Switch the source repository to an existing local branch. Prefer worktrees for concurrent engineering sessions.',
    inputSchema: z.object({ workspace: z.string(), repoPath: z.string().default('.'), branch: z.string().min(1) }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, repoPath, branch }) => result(await audited(ctx.audit, 'git_branch_switch', workspace, () => ctx.git.switchBranch(workspace, branch, repoPath))));

  server.registerTool('git_worktree_list', {
    description: 'List linked Git worktrees for a repository.',
    inputSchema: z.object({ workspace: z.string(), repoPath: z.string().default('.') }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, repoPath }) => result({ worktrees: await audited(ctx.audit, 'git_worktree_list', workspace, () => ctx.git.worktrees(workspace, repoPath)) }));

  server.registerTool('git_worktree_add', {
    description: 'Create an isolated sibling worktree inside the authorized workspace. The destination must be outside the source repository.',
    inputSchema: z.object({
      workspace: z.string(), repoPath: z.string().default('.'), worktreePath: z.string().min(1), branch: z.string().min(1),
      createBranch: z.boolean().default(true), startPoint: z.string().default('HEAD')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, repoPath, worktreePath, branch, createBranch, startPoint }) => result(await audited(ctx.audit, 'git_worktree_add', workspace, () => ctx.git.addWorktree(workspace, worktreePath, branch, { repoPath, createBranch, startPoint }))));

  server.registerTool('git_worktree_remove', {
    description: 'Remove a linked worktree. force=false is the safe default and refuses dirty worktrees.',
    inputSchema: z.object({ workspace: z.string(), repoPath: z.string().default('.'), worktreePath: z.string().min(1), force: z.boolean().default(false) }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, repoPath, worktreePath, force }) => result(await audited(ctx.audit, 'git_worktree_remove', workspace, () => ctx.git.removeWorktree(workspace, worktreePath, force, repoPath))));

  server.registerTool('task_list', {
    description: 'List owner-defined build/test task profiles from local policy.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result({ tasks: await audited(ctx.audit, 'task_list', undefined, async () => ctx.tasks.list()) }));

  server.registerTool('task_run', {
    description: 'Run an owner-defined task profile in an authorized workspace. Program execution remains subject to current permission policy.',
    inputSchema: z.object({ workspace: z.string(), task: z.string().min(1), extraArgs: z.array(z.string()).max(100).default([]), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, task, extraArgs, workSessionId }) => result(await audited(ctx.audit, 'task_run', workspace, () => ctx.runInWorkSession(workSessionId, () => ctx.tasks.run(workspace, task, extraArgs)))));

  server.registerTool('build_diagnostics', {
    description: 'Parse bounded GCC/Clang/MSVC/CMake diagnostics from a managed build/test process into compact structured errors and warnings.',
    inputSchema: z.object({ id: z.string().uuid(), maxDiagnostics: z.number().int().positive().max(200).default(50), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, maxDiagnostics, workSessionId }) => result(await audited(ctx.audit, 'build_diagnostics', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.buildDiagnostics.report(id, maxDiagnostics)))));

  server.registerTool('process_start', {
    description: 'Start an executable without a shell. Normal modes require the executable allowlist; full-control owner lease may lift that allowlist.',
    inputSchema: z.object({ workspace: z.string(), program: z.string().min(1), args: z.array(z.string()).max(500).default([]), cwd: z.string().default('.'), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, program, args, cwd, workSessionId }) => result(await audited(ctx.audit, 'process_start', workspace, () =>
    ctx.runInWorkSession(workSessionId, () => ctx.processes.start(workspace, program, args, cwd))
  )));

  server.registerTool('process_read', {
    description: 'Read current state and current bounded stdout/stderr buffers of a managed process.',
    inputSchema: z.object({ id: z.string().uuid(), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, workSessionId }) => result(await audited(ctx.audit, 'process_read', undefined, () =>
    ctx.runInWorkSession(workSessionId, () => ctx.processes.read(id))
  )));

  server.registerTool('process_read_since', {
    description: 'Read only process output produced since caller-provided cursors. Returns next cursors and whether older output was truncated.',
    inputSchema: z.object({ id: z.string().uuid(), stdoutCursor: z.number().int().nonnegative().default(0), stderrCursor: z.number().int().nonnegative().default(0), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, stdoutCursor, stderrCursor, workSessionId }) => result(await audited(ctx.audit, 'process_read_since', undefined, () =>
    ctx.runInWorkSession(workSessionId, () => ctx.processes.readSince(id, stdoutCursor, stderrCursor))
  )));

  server.registerTool('process_list', {
    description: 'List processes started through this MCP agent.',
    inputSchema: z.object({ workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workSessionId }) => result({ processes: await audited(ctx.audit, 'process_list', undefined, () =>
    ctx.runInWorkSession(workSessionId, () => ctx.processes.list())
  ) }));

  server.registerTool('process_stop', {
    description: 'Stop a managed process with SIGTERM.',
    inputSchema: z.object({ id: z.string().uuid(), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, workSessionId }) => result(await audited(ctx.audit, 'process_stop', undefined, () =>
    ctx.runInWorkSession(workSessionId, () => ctx.processes.stop(id))
  )));
}
