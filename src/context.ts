import path from 'node:path';
import { BuildDiagnosticsAdapter } from './adapters/build-diagnostics.js';
import { ControlPlaneRelayAdapter } from './adapters/control-plane-relay.js';
import { DataPlaneAdapter } from './adapters/data-plane.js';
import { DeviceRegistryAdapter } from './adapters/devices.js';
import { ArtifactIntegrityAdapter } from './adapters/engineering/artifact-integrity.js';
import { ArtifactTransferAdapter } from './adapters/engineering/artifact-transfer.js';
import { EngineeringCommandRunner } from './adapters/engineering/command-runner.js';
import { DebugSessionManager } from './adapters/engineering/debug-session.js';
import { DockerAdapter } from './adapters/engineering/docker.js';
import { SystemdAdapter } from './adapters/engineering/systemd.js';
import { Stm32IocAdapter } from './adapters/engineering/stm32-ioc.js';
import { FirmwareAdapter } from './adapters/engineering/firmware.js';
import { HardwareDiscoveryAdapter } from './adapters/engineering/hardware-discovery.js';
import { KicadAdapter } from './adapters/engineering/kicad.js';
import { PlatformioAdapter } from './adapters/engineering/platformio.js';
import { EngineeringProjectProfileStore } from './adapters/engineering/project-profile.js';
import { EngineeringResourceManager } from './adapters/engineering/resource-manager.js';
import { Ros2Adapter } from './adapters/engineering/ros2.js';
import { SerialSessionManager } from './adapters/engineering/serial-session.js';
import { TerminalManager } from './adapters/engineering/terminal-manager.js';
import { EngineeringWorkflowEngine } from './adapters/engineering/workflow-engine.js';
import { FilesystemAdapter } from './adapters/filesystem.js';
import { FullControlAdapter } from './adapters/full-control.js';
import { GitAdapter } from './adapters/git.js';
import { HostFilesystemAdapter } from './adapters/host-filesystem.js';
import { LspAdapter } from './adapters/lsp.js';
import { ProcessManager } from './adapters/process-manager.js';
import { SearchAdapter } from './adapters/search.js';
import { SshAdapter } from './adapters/ssh.js';
import { TaskAdapter } from './adapters/tasks.js';
import { ToolDiscoveryAdapter } from './adapters/tool-discovery.js';
import { UpdateAdapter } from './adapters/update.js';
import { SERVER_VERSION } from './capabilities.js';
import { ConcurrencyPolicy } from './concurrency-policy.js';
import { loadPolicy } from './config.js';
import { loadOrCreateDeviceIdentity } from './device-identity.js';
import { loadHosts } from './hosts.js';
import { loadPermissionLease } from './permissions.js';
import { NodeInterlockStore } from './node-interlock.js';
import { QualityObservationStore } from './quality-learning.js';
import { PairingStore } from './pairing/pairing-store.js';
import { PolicyEngine } from './policy.js';
import { AuditLogger } from './security/audit.js';
import { PathGuard } from './security/path-guard.js';
import { MultiNodeAuthorization } from './security/multi-node-authorization.js';
import { currentPrincipal } from './security/request-principal.js';
import { runWithWorkSession } from './security/execution-context.js';
import { WorkSessionStore } from './work-session.js';
import { WorkSessionLifecycleService } from './work-session-lifecycle.js';
import { EngineeringWorkflowExecutionService } from './engineering-workflow-execution.js';
import { TaskExecutionCoordinator } from './task-executor.js';
import { SchedulerAwarenessService } from './scheduler-awareness.js';
import { ObjectiveProgressService } from './objective-progress.js';
import { ExecutionTimelineService } from './execution-timeline.js';
import { ObjectiveDecompositionService } from './objective-decomposition.js';
import { ObjectiveWaveExecutionService } from './objective-wave-execution.js';
import { ProjectSessionGroupService, ProjectSessionGroupStore } from './project-session-group.js';
import { ProjectCoordinationService } from './project-coordination.js';
import { TaskAttemptStore } from './task-attempt-store.js';
import { TaskWorkflowExecutionService } from './task-workflow-execution.js';
import { DeterministicTaskScheduler, TaskGraphStore } from './task-graph.js';
import { WorkflowRunStore } from './workflow-run-store.js';
import { WorkerProviderRegistry } from './worker-provider.js';
import { WorktreeManager } from './worktree-manager.js';
import { registerConfiguredCodexWorker } from './workers/codex-worker-provider.js';
import { AntigravityWorkerProvider } from './workers/antigravity-worker-provider.js';
import { CodexAccountBroker } from './workers/codex-account-broker.js';
import { ExecutionPolicyService } from './execution-policy.js';
import { loadSetupSettings } from './setup/settings.js';
import { DesktopNotificationService } from './desktop-notification.js';
import { BrowserCore } from './web/browser-core.js';
import { PlaywrightBrowserProvider } from './web/browser-provider.js';
import { ExistingChromeBridgeClient } from './web/existing-chrome-bridge.js';
import { ExistingChromeSessionService } from './web/existing-chrome-session.js';
import { NotebookLmAdapter } from './web/adapters/notebooklm-adapter.js';

export async function createContext() {
  const actor = {
    clientId: process.env.RWMCP_CLIENT_ID ?? 'unknown',
    clientType: process.env.RWMCP_CLIENT_TYPE ?? 'mcp-client'
  };
  const [config, hostsConfig, lease, identity] = await Promise.all([
    loadPolicy(),
    loadHosts(),
    loadPermissionLease(),
    loadOrCreateDeviceIdentity()
  ]);
  const currentClientId = () => currentPrincipal()?.id ?? actor.clientId;
  const workSessions = new WorkSessionStore(currentClientId);
  const reconciledWorkSessions = await workSessions.reconcileLifecycle();
  const garbageCollectedWorkSessions = await workSessions.garbageCollect();
  const projectSessionGroupStore = new ProjectSessionGroupStore(currentClientId);
  let garbageCollectedProjectSessionGroups = 0;
  let projectSessionGroupMaintenanceFailures = 0;
  try {
    garbageCollectedProjectSessionGroups = await projectSessionGroupStore.garbageCollect();
  } catch {
    // Project Session Group metadata is optional coordination state. Corruption must not block direct workstation control.
    projectSessionGroupMaintenanceFailures += 1;
  }
  const projectSessionGroups = new ProjectSessionGroupService(projectSessionGroupStore, workSessions);
  const workerProviders = new WorkerProviderRegistry();
  const executionPolicy = new ExecutionPolicyService();
  const desktopNotifications = new DesktopNotificationService(SERVER_VERSION);
  const setupSettings = await loadSetupSettings();
  const codexAccountBroker = new CodexAccountBroker(setupSettings.execution.codexAccountBroker);
  const workflowRuns = new WorkflowRunStore(currentClientId);
  const qualityObservations = new QualityObservationStore(currentClientId);
  const interruptedWorkflowRuns = await workflowRuns.reconcileInterruptedRecords();
  let qualityObservationReconciliationFailures = 0;
  for (const run of interruptedWorkflowRuns) {
    try {
      await qualityObservations.observe(run, {
        completionSource: 'runtime-reconciliation',
        explicitOutcome: true
      });
    } catch {
      // Quality telemetry is advisory. It must never prevent the control plane from starting.
      qualityObservationReconciliationFailures += 1;
    }
  }
  const reconciledWorkflowRuns = interruptedWorkflowRuns.length;
  const nodeInterlocks = new NodeInterlockStore(currentClientId);
  const reconciledNodeInterlocks = await nodeInterlocks.reconcileStale();
  const taskAttempts = new TaskAttemptStore(currentClientId);
  const reconciledTaskAttempts = (await taskAttempts.reconcileInterrupted()).length;
  const taskGraphs = new TaskGraphStore(currentClientId);
  const reconciledWorkTasks = (await taskGraphs.reconcileInterrupted()).length;
  const scopeWorkSession = async <T>(workSessionId: string | undefined, operation: () => T | Promise<T>): Promise<T> =>
    await runWithWorkSession(workSessionId, operation);
  const runInWorkSession = async <T>(workSessionId: string | undefined, operation: () => T | Promise<T>): Promise<T> => {
    if (workSessionId?.trim()) await workSessions.touch(workSessionId);
    return await scopeWorkSession(workSessionId, operation);
  };
  const policy = new PolicyEngine(config, lease, currentClientId);
  const paths = new PathGuard(policy);
  const git = new GitAdapter(policy, paths);
  const worktreeManager = new WorktreeManager(git, workSessions);
  const projectCoordination = new ProjectCoordinationService(workSessions, worktreeManager);
  const concurrencyPolicy = new ConcurrencyPolicy();
  const taskScheduler = new DeterministicTaskScheduler(taskGraphs, concurrencyPolicy);
  const auditPath = path.resolve(process.env.RWMCP_AUDIT ?? 'runtime/audit.jsonl');
  const audit = new AuditLogger(auditPath, actor);
  const multiNodeAuthorization = new MultiNodeAuthorization(policy, identity, audit);
  const processes = new ProcessManager(policy, paths, currentClientId);
  const ssh = new SshAdapter(policy, hostsConfig);
  const pairing = new PairingStore();
  const dataPlane = new DataPlaneAdapter(policy, paths);
  const controlPlaneRelay = new ControlPlaneRelayAdapter(policy, paths, dataPlane);
  const engineeringResources = new EngineeringResourceManager(currentClientId);
  const engineeringRunner = new EngineeringCommandRunner(policy);
  registerConfiguredCodexWorker(
    workerProviders,
    policy,
    paths,
    engineeringRunner,
    process.env,
    {
      accountBroker: codexAccountBroker,
      model: setupSettings.execution.codexModel,
      agentDelegationEnabled: setupSettings.execution.codexAgentsEnabled,
      skillSharingEnabled: setupSettings.execution.codexSkillsEnabled
    },
    setupSettings.execution.codexEnabled
  );
  const antigravityWorker = new AntigravityWorkerProvider(policy, paths, engineeringRunner, {
    env: process.env,
    model: setupSettings.execution.antigravityModel,
    requireSandboxAutomationPolicy: true
  });
  if (setupSettings.execution.antigravityEnabled) workerProviders.register(antigravityWorker);
  const engineeringHardware = new HardwareDiscoveryAdapter();
  const engineeringSerial = new SerialSessionManager(policy, engineeringResources, currentClientId);
  const engineeringTerminals = new TerminalManager(policy, paths, currentClientId);
  const engineeringArtifacts = new ArtifactIntegrityAdapter(policy, paths);
  const engineeringArtifactTransfer = new ArtifactTransferAdapter(policy, paths, engineeringArtifacts);
  const engineeringFirmware = new FirmwareAdapter(policy, paths, engineeringRunner, engineeringResources, engineeringHardware);
  const engineeringStm32Ioc = new Stm32IocAdapter(paths);
  const engineeringProfiles = new EngineeringProjectProfileStore(policy, paths);
  const engineeringDebug = new DebugSessionManager(policy, paths, engineeringResources, currentClientId);
  const browser = new BrowserCore(new PlaywrightBrowserProvider());
  const existingChrome = new ExistingChromeSessionService(new ExistingChromeBridgeClient());
  const notebooklm = new NotebookLmAdapter(existingChrome);
  const workSessionLifecycle = new WorkSessionLifecycleService(
    workSessions,
    worktreeManager,
    async (sessionId) => runWithWorkSession(sessionId, async () => ({
      processes: processes.list().length,
      terminals: engineeringTerminals.list().length,
      serialSessions: engineeringSerial.list().length,
      debugSessions: engineeringDebug.list().length,
      hardwareLeases: engineeringResources.listOwned().length,
      nodeInterlocks: (await nodeInterlocks.listOwned()).length,
      browserSessions: browser.countOwned(currentClientId(), sessionId),
      existingChromeSessions: existingChrome.countOwned(currentClientId(), sessionId)
    }))
  );
  const schedulerAwareness = new SchedulerAwarenessService(
    taskScheduler,
    taskGraphs,
    workSessions,
    taskAttempts,
    engineeringResources,
    nodeInterlocks,
    engineeringSerial,
    engineeringDebug,
    workerProviders
  );
  const objectiveProgress = new ObjectiveProgressService(
    taskGraphs,
    taskAttempts,
    schedulerAwareness,
    workSessions
  );
  const executionTimeline = new ExecutionTimelineService(taskGraphs, taskAttempts);
  const objectiveDecomposition = new ObjectiveDecompositionService(taskGraphs, executionPolicy, workerProviders, workSessions);

  const taskExecutor = new TaskExecutionCoordinator(
    taskGraphs,
    taskScheduler,
    engineeringResources,
    nodeInterlocks,
    schedulerAwareness
  );
  const engineeringRos2 = new Ros2Adapter(policy, paths, engineeringRunner, processes);
  const engineeringDocker = new DockerAdapter(policy, paths, engineeringRunner);
  const engineeringSystemd = new SystemdAdapter(policy, paths, engineeringRunner);
  const engineeringKicad = new KicadAdapter(policy, paths, engineeringRunner);
  const engineeringPlatformio = new PlatformioAdapter(policy, paths, engineeringRunner);
  const engineeringWorkflows = new EngineeringWorkflowEngine(policy, engineeringProfiles, dataPlane, controlPlaneRelay, multiNodeAuthorization, engineeringArtifacts, engineeringArtifactTransfer, engineeringFirmware, engineeringHardware, engineeringSerial, engineeringDebug, engineeringRos2, engineeringDocker, engineeringSystemd, engineeringKicad, engineeringPlatformio);
  const engineeringWorkflowExecution = new EngineeringWorkflowExecutionService(engineeringWorkflows, workflowRuns, qualityObservations, nodeInterlocks);
  const taskWorkflowExecution = new TaskWorkflowExecutionService(taskGraphs, taskExecutor, engineeringWorkflowExecution, taskAttempts, workerProviders, workSessions, worktreeManager, executionPolicy, desktopNotifications);
  const objectiveWaveExecution = new ObjectiveWaveExecutionService(schedulerAwareness, taskWorkflowExecution, taskGraphs);
  process.once('beforeExit', () => {
    void browser.closeAll();
    existingChrome.closeAll();
  });
  return {
    config,
    hostsConfig,
    policy,
    paths,
    actor,
    identity,
    audit,
    browser,
    existingChrome,
    notebooklm,
    multiNodeAuthorization,
    workSessions,
    workSessionLifecycle,
    reconciledWorkSessions,
    garbageCollectedWorkSessions,
    projectSessionGroups,
    projectCoordination,
    garbageCollectedProjectSessionGroups,
    projectSessionGroupMaintenanceFailures,
    workerProviders,
    executionPolicy,
    codexAccountBroker,
    antigravityWorker,
    desktopNotifications,
    workflowRuns,
    qualityObservations,
    reconciledWorkflowRuns,
    qualityObservationReconciliationFailures,
    nodeInterlocks,
    reconciledNodeInterlocks,
    taskAttempts,
    reconciledTaskAttempts,
    taskGraphs,
    taskScheduler,
    schedulerAwareness,
    objectiveProgress,
    executionTimeline,
    objectiveDecomposition,
    taskExecutor,
    taskWorkflowExecution,
    objectiveWaveExecution,
    reconciledWorkTasks,
    scopeWorkSession,
    runInWorkSession,
    worktreeManager,
    concurrencyPolicy,
    fs: new FilesystemAdapter(policy, paths),
    hostFs: new HostFilesystemAdapter(policy),
    fullControl: new FullControlAdapter(policy),
    git,
    lsp: new LspAdapter(policy, paths, currentClientId),
    processes,
    buildDiagnostics: new BuildDiagnosticsAdapter(processes),
    search: new SearchAdapter(policy, paths),
    tools: new ToolDiscoveryAdapter(policy),
    tasks: new TaskAdapter(policy, processes),
    ssh,
    pairing,
    devices: new DeviceRegistryAdapter(ssh, pairing, identity),
    dataPlane,
    controlPlaneRelay,
    engineering: {
      resources: engineeringResources,
      runner: engineeringRunner,
      hardware: engineeringHardware,
      serial: engineeringSerial,
      terminals: engineeringTerminals,
      firmware: engineeringFirmware,
      stm32Ioc: engineeringStm32Ioc,
      artifacts: engineeringArtifacts,
      artifactTransfer: engineeringArtifactTransfer,
      profiles: engineeringProfiles,
      workflows: engineeringWorkflows,
      execution: engineeringWorkflowExecution,
      debug: engineeringDebug,
      ros2: engineeringRos2,
      docker: engineeringDocker,
      systemd: engineeringSystemd,
      kicad: engineeringKicad,
      platformio: engineeringPlatformio
    },
    updates: new UpdateAdapter(SERVER_VERSION)
  };
}

export type AppContext = Awaited<ReturnType<typeof createContext>>;
