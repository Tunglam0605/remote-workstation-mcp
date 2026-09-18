import path from 'node:path';
import { BuildDiagnosticsAdapter } from './adapters/build-diagnostics.js';
import { DeviceRegistryAdapter } from './adapters/devices.js';
import { ArtifactIntegrityAdapter } from './adapters/engineering/artifact-integrity.js';
import { EngineeringCommandRunner } from './adapters/engineering/command-runner.js';
import { DebugSessionManager } from './adapters/engineering/debug-session.js';
import { DockerAdapter } from './adapters/engineering/docker.js';
import { FirmwareAdapter } from './adapters/engineering/firmware.js';
import { HardwareDiscoveryAdapter } from './adapters/engineering/hardware-discovery.js';
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
import { loadPolicy } from './config.js';
import { loadOrCreateDeviceIdentity } from './device-identity.js';
import { loadHosts } from './hosts.js';
import { loadPermissionLease } from './permissions.js';
import { PairingStore } from './pairing/pairing-store.js';
import { PolicyEngine } from './policy.js';
import { AuditLogger } from './security/audit.js';
import { PathGuard } from './security/path-guard.js';
import { currentPrincipal } from './security/request-principal.js';

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
  const policy = new PolicyEngine(config, lease, currentClientId);
  const paths = new PathGuard(policy);
  const auditPath = path.resolve(process.env.RWMCP_AUDIT ?? 'runtime/audit.jsonl');
  const processes = new ProcessManager(policy, paths, currentClientId);
  const ssh = new SshAdapter(policy, hostsConfig);
  const pairing = new PairingStore();
  const engineeringResources = new EngineeringResourceManager(currentClientId);
  const engineeringRunner = new EngineeringCommandRunner(policy);
  const engineeringHardware = new HardwareDiscoveryAdapter();
  const engineeringSerial = new SerialSessionManager(policy, engineeringResources, currentClientId);
  const engineeringTerminals = new TerminalManager(policy, paths, currentClientId);
  const engineeringArtifacts = new ArtifactIntegrityAdapter(policy, paths);
  const engineeringFirmware = new FirmwareAdapter(policy, paths, engineeringRunner, engineeringResources, engineeringHardware);
  const engineeringProfiles = new EngineeringProjectProfileStore(policy, paths);
  const engineeringDebug = new DebugSessionManager(policy, paths, engineeringResources, currentClientId);
  const engineeringRos2 = new Ros2Adapter(policy, paths, engineeringRunner, processes);
  const engineeringDocker = new DockerAdapter(policy, paths, engineeringRunner);
  const engineeringWorkflows = new EngineeringWorkflowEngine(policy, engineeringProfiles, engineeringArtifacts, engineeringFirmware, engineeringHardware, engineeringSerial, engineeringDebug, engineeringRos2);
  return {
    config,
    hostsConfig,
    policy,
    paths,
    actor,
    identity,
    audit: new AuditLogger(auditPath, actor),
    fs: new FilesystemAdapter(policy, paths),
    hostFs: new HostFilesystemAdapter(policy),
    fullControl: new FullControlAdapter(policy),
    git: new GitAdapter(policy, paths),
    lsp: new LspAdapter(policy, paths, currentClientId),
    processes,
    buildDiagnostics: new BuildDiagnosticsAdapter(processes),
    search: new SearchAdapter(policy, paths),
    tools: new ToolDiscoveryAdapter(policy),
    tasks: new TaskAdapter(policy, processes),
    ssh,
    pairing,
    devices: new DeviceRegistryAdapter(ssh, pairing, identity),
    engineering: {
      resources: engineeringResources,
      runner: engineeringRunner,
      hardware: engineeringHardware,
      serial: engineeringSerial,
      terminals: engineeringTerminals,
      firmware: engineeringFirmware,
      artifacts: engineeringArtifacts,
      profiles: engineeringProfiles,
      workflows: engineeringWorkflows,
      debug: engineeringDebug,
      ros2: engineeringRos2,
      docker: engineeringDocker
    },
    updates: new UpdateAdapter(SERVER_VERSION)
  };
}

export type AppContext = Awaited<ReturnType<typeof createContext>>;
