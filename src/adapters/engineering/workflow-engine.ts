import os from 'node:os';
import path from 'node:path';
import { ControlPlaneRelayAdapter } from '../control-plane-relay.js';
import { DataPlaneAdapter } from '../data-plane.js';
import type { FirmwareProjectInfo, SerialDeviceResolution, SerialDeviceSelector, Stm32SvdRegisterSelector, Stm32SvdResolvedRegister } from '../../engineering/types.js';
import { PolicyEngine } from '../../policy.js';
import { MultiNodeAuthorization, type CrossNodeTransferIntent } from '../../security/multi-node-authorization.js';
import { ArtifactIntegrityAdapter } from './artifact-integrity.js';
import { ArtifactTransferAdapter } from './artifact-transfer.js';
import { DebugSessionManager } from './debug-session.js';
import { DockerAdapter } from './docker.js';
import { FirmwareAdapter } from './firmware.js';
import { stm32OpenOcdTargetConfig } from './project-inspector.js';
import { HardwareDiscoveryAdapter } from './hardware-discovery.js';
import { KicadAdapter } from './kicad.js';
import { PlatformioAdapter } from './platformio.js';
import {
  EngineeringProjectProfileStore,
  type EngineeringFirmwareProfile,
  type EngineeringProjectKind,
  type EngineeringProjectProfile,
  type EngineeringRos2Profile
} from './project-profile.js';
import { Ros2Adapter, type Ros2RuntimeContext } from './ros2.js';
import { SerialSessionManager } from './serial-session.js';
import { SystemdAdapter } from './systemd.js';
import { Stm32SvdAdapter, decodeStm32SvdRegisterHex } from './stm32-svd.js';

export type EngineeringWorkflowId =
  | 'platform.transfer_prepare'
  | 'platform.transfer_receive_offer'
  | 'platform.transfer_push'
  | 'platform.relay_read_chunk'
  | 'platform.relay_begin'
  | 'platform.relay_status'
  | 'platform.relay_write_chunk'
  | 'platform.relay_finalize'
  | 'platform.relay_abort'
  | 'firmware.build'
  | 'firmware.build_flash'
  | 'firmware.build_flash_verify'
  | 'firmware.build_flash_monitor'
  | 'firmware.build_flash_monitor_expect'
  | 'firmware.artifact_prepare'
  | 'firmware.artifact_accept'
  | 'firmware.artifact_receive_offer'
  | 'firmware.artifact_push'
  | 'espidf.diagnostics'
  | 'espidf.size_analysis'
  | 'platformio.diagnostics'
  | 'stm32.debug_fault_snapshot'
  | 'stm32.deep_diagnostics'
  | 'stm32.peripheral_snapshot'
  | 'stm32.deploy_accept'
  | 'stm32.deploy_accept_diagnose'
  | 'ros2.build'
  | 'ros2.health'
  | 'ros2.diagnostics'
  | 'ros2.doctor'
  | 'ros2.test'
  | 'ros2.bag_info'
  | 'ros2.build_health'
  | 'docker.diagnostics'
  | 'docker.stats_snapshot'
  | 'docker.container_inspect'
  | 'docker.container_logs'
  | 'kicad.diagnostics'
  | 'kicad.validate'
  | 'kicad.fabrication_export'
  | 'systemd.service_diagnostics'
  | 'systemd.service_restart';

export interface EngineeringProfileInitOptions {
  id?: string;
  name?: string;
  kind?: EngineeringProjectKind;
  firmware?: Partial<EngineeringFirmwareProfile>;
  ros2?: Partial<EngineeringRos2Profile>;
  profile?: unknown;
  overwrite?: boolean;
}

export interface EngineeringWorkflowOverrides {
  file?: string;
  fileName?: string;
  artifact?: string;
  port?: string;
  probeSerial?: string;
  targetConfig?: string;
  adapterSpeedKhz?: number;
  monitorPort?: string;
  monitorBaudRate?: number;
  expectText?: string;
  expectTimeoutMs?: number;
  rosPackagesSelect?: string[];
  rosSymlinkInstall?: boolean;
  rosMergeInstall?: boolean;
  rosBagPath?: string;
  dockerContainer?: string;
  dockerLogTail?: number;
  kicadOutputDir?: string;
  systemdUnit?: string;
  systemdUser?: boolean;
  journalLines?: number;
  debugMaxFrames?: number;
  svdFile?: string;
  svdRegisters?: Stm32SvdRegisterSelector[];
  variant?: string;
  keilProject?: string;
  keilTarget?: string;
  keepMonitorOpen?: boolean;
  expectedSha256?: string;
  expectedSize?: number;
  artifactName?: string;
  transferEndpoint?: string;
  transferEndpoints?: string[];
  transferTicket?: string;
  transferTimeoutMs?: number;
  relaySessionId?: string;
  relayOffset?: number;
  relayChunkBytes?: number;
  relayDataBase64?: string;
  relayChunkSha256?: string;
  relayTtlMs?: number;
  transferGrantId?: string;
  sourceNodeId?: string;
  destinationNodeId?: string;
  sourceWorkspace?: string;
  destinationWorkspace?: string;
  sourcePath?: string;
  destinationBasePath?: string;
  destinationFileName?: string;
}

interface ProjectState {
  project: FirmwareProjectInfo;
  profileFound: boolean;
  manifestPath: string;
  profile: EngineeringProjectProfile;
}

interface StepResult {
  id: string;
  status: 'succeeded' | 'failed' | 'blocked';
  durationMs: number;
  result?: unknown;
  error?: string;
}

function safeId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'engineering-project';
}

function portableRelative(value: string): string {
  return value.split(path.sep).join('/');
}

function workspaceRelative(projectPath: string, child = '.'): string {
  if (path.isAbsolute(projectPath) || path.isAbsolute(child)) {
    throw new Error('Cross-node transfer paths must remain workspace-relative.');
  }
  const joined = path.normalize(path.join(projectPath, child));
  const segments = joined.split(/[\\/]+/);
  if (segments.includes('..')) throw new Error('Cross-node transfer paths must not escape the workspace.');
  return portableRelative(joined === '' ? '.' : joined);
}

function projectChild(projectPath: string, child = '.'): string {
  if (path.isAbsolute(child)) throw new Error('Profile paths must remain relative to the selected project root.');
  const parts = child.split(/[\\/]+/);
  if (parts.includes('..')) throw new Error('Profile paths must not escape the selected project root.');
  return path.normalize(path.join(projectPath, child));
}

function detectKind(project: FirmwareProjectInfo): EngineeringProjectKind {
  const embedded = project.framework === 'platformio'
    ? 'platformio'
    : project.family === 'stm32' ? 'stm32' : project.family === 'esp32' ? 'esp-idf' : undefined;
  if (embedded && project.ros2) return 'mixed';
  if (embedded) return embedded;
  if (project.ros2) return 'ros2';
  return 'generic';
}

function successfulCommand(result: { exitCode: number | null; timedOut: boolean }): boolean {
  return result.exitCode === 0 && !result.timedOut;
}

function successfulBuild(provider: string, result: { exitCode: number | null; timedOut: boolean }): boolean {
  if (result.timedOut || result.exitCode === null) return false;
  return provider === 'keil' ? result.exitCode <= 1 : result.exitCode === 0;
}

export class EngineeringWorkflowEngine {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly profiles: EngineeringProjectProfileStore,
    private readonly dataPlane: DataPlaneAdapter,
    private readonly controlPlaneRelay: ControlPlaneRelayAdapter,
    private readonly multiNodeAuthorization: MultiNodeAuthorization,
    private readonly artifacts: ArtifactIntegrityAdapter,
    private readonly artifactTransfer: ArtifactTransferAdapter,
    private readonly firmware: FirmwareAdapter,
    private readonly hardware: HardwareDiscoveryAdapter,
    private readonly serial: SerialSessionManager,
    private readonly debug: DebugSessionManager,
    private readonly ros2: Ros2Adapter,
    private readonly docker?: DockerAdapter,
    private readonly systemd?: SystemdAdapter,
    private readonly kicad?: KicadAdapter,
    private readonly platformio?: PlatformioAdapter,
    private readonly stm32Svd?: Stm32SvdAdapter
  ) {}

  private transferIntent(
    role: 'source' | 'destination',
    workspace: string,
    projectPath: string,
    overrides: EngineeringWorkflowOverrides,
    details: {
      sourceFile?: string;
      destinationFileName?: string;
      size: number;
      sha256?: string;
      transport: 'direct' | 'relay';
    }
  ): CrossNodeTransferIntent {
    const grantId = overrides.transferGrantId?.trim();
    const sourceNodeId = overrides.sourceNodeId?.trim();
    const destinationNodeId = overrides.destinationNodeId?.trim();
    if (!grantId || !sourceNodeId || !destinationNodeId) {
      throw new Error('Cross-node transfer requires transferGrantId, sourceNodeId and destinationNodeId.');
    }

    const sourceWorkspace = role === 'source'
      ? workspace
      : overrides.sourceWorkspace?.trim();
    const destinationWorkspace = role === 'destination'
      ? workspace
      : overrides.destinationWorkspace?.trim();
    if (!sourceWorkspace || !destinationWorkspace) {
      throw new Error('Cross-node transfer requires explicit sourceWorkspace and destinationWorkspace context.');
    }
    if (overrides.sourceWorkspace && role === 'source' && overrides.sourceWorkspace.trim() !== workspace) {
      throw new Error('parameters.sourceWorkspace does not match the selected source workspace.');
    }
    if (overrides.destinationWorkspace && role === 'destination' && overrides.destinationWorkspace.trim() !== workspace) {
      throw new Error('parameters.destinationWorkspace does not match the selected destination workspace.');
    }

    const sourcePath = role === 'source'
      ? workspaceRelative(projectPath, details.sourceFile ?? '.')
      : overrides.sourcePath?.trim();
    const destinationBasePath = role === 'destination'
      ? workspaceRelative(projectPath, '.')
      : overrides.destinationBasePath?.trim();
    const destinationFileName = details.destinationFileName ?? overrides.destinationFileName?.trim();
    if (!sourcePath || !destinationBasePath || !destinationFileName) {
      throw new Error('Cross-node transfer requires sourcePath, destinationBasePath and destinationFileName.');
    }

    return {
      grantId,
      sourceNodeId,
      destinationNodeId,
      sourceWorkspace,
      destinationWorkspace,
      sourcePath,
      destinationBasePath,
      destinationFileName,
      size: details.size,
      sha256: details.sha256,
      transport: details.transport
    };
  }

  private async authorizeSourceTransfer(intent: CrossNodeTransferIntent) {
    return await this.multiNodeAuthorization.authorizeSource(intent);
  }

  private async authorizeDestinationTransfer(intent: CrossNodeTransferIntent) {
    return await this.multiNodeAuthorization.authorizeDestination(intent);
  }

  private suggestedProfile(workspace: string, projectPath: string, project: FirmwareProjectInfo): EngineeringProjectProfile {
    const label = projectPath === '.' ? (project.target ?? workspace) : path.basename(projectPath);
    const kind = detectKind(project);
    const profile: EngineeringProjectProfile = {
      version: 1,
      id: safeId(label),
      kind
    };

    if (project.family === 'stm32') {
      if (project.framework === 'keil-mdk' && project.targets?.length) {
        const variants = Object.fromEntries(project.targets.map(item => [item.id, {
          ...(item.outputDirectory ? { buildDir: item.outputDirectory } : {}),
          ...(item.expectedArtifact ? { artifact: item.expectedArtifact } : {}),
          keilProject: item.projectFile,
          keilTarget: item.targetName,
          ...(stm32OpenOcdTargetConfig(item.device) ? { targetConfig: stm32OpenOcdTargetConfig(item.device) } : {})
        }]));
        profile.firmware = {
          buildProvider: 'keil',
          buildDir: project.targets[0]?.outputDirectory ?? 'build',
          flashProvider: 'openocd',
          variants,
          ...(project.targets.length === 1 ? { defaultVariant: project.targets[0]!.id } : {})
        };
      } else {
        profile.firmware = {
          buildProvider: 'auto',
          buildDir: 'build',
          flashProvider: 'openocd'
        };
      }
    } else if (project.family === 'esp32' && project.framework !== 'platformio') {
      profile.firmware = {
        buildProvider: 'esp-idf',
        buildDir: 'build',
        flashProvider: 'esp-idf',
        monitor: { baudRate: 115200, expectTimeoutMs: 10_000 }
      };
    } else if (project.framework === 'cmake' || project.framework === 'make') {
      profile.firmware = {
        buildProvider: project.framework === 'make' ? 'make' : 'cmake',
        buildDir: 'build',
        flashProvider: 'auto'
      };
    }

    if (project.ros2) {
      profile.ros2 = {
        cwd: '.',
        build: { symlinkInstall: true, mergeInstall: false }
      };
    }
    return profile;
  }

  private async resolveSerialPort(
    explicitPort: string | undefined,
    selector: SerialDeviceSelector | undefined,
    legacyPort: string | undefined,
    fallbackPort?: string
  ): Promise<{ port?: string; source: 'override' | 'stable-selector' | 'legacy-port' | 'fallback' | 'unconfigured'; resolution?: SerialDeviceResolution }> {
    if (explicitPort) return { port: explicitPort, source: 'override' };
    if (selector) {
      const resolution = await this.hardware.resolveSerial(selector);
      return { port: resolution.path, source: 'stable-selector', resolution };
    }
    if (legacyPort) return { port: legacyPort, source: 'legacy-port' };
    if (fallbackPort) return { port: fallbackPort, source: 'fallback' };
    return { source: 'unconfigured' };
  }

  private effectiveFirmware(
    profile: EngineeringFirmwareProfile | undefined,
    overrides: EngineeringWorkflowOverrides = {}
  ): { config: EngineeringFirmwareProfile; variant?: string } {
    const base = profile ?? {};
    const requestedVariant = overrides.variant ?? base.defaultVariant;
    if (requestedVariant && !/^[A-Za-z0-9._-]{1,80}$/.test(requestedVariant)) {
      throw new Error('variant must match /^[A-Za-z0-9._-]{1,80}$/.');
    }
    const selected = requestedVariant ? base.variants?.[requestedVariant] : undefined;
    if (requestedVariant && !selected) {
      throw new Error(`Firmware variant '${requestedVariant}' does not exist in the project profile.`);
    }
    if (base.buildProvider === 'keil' && base.variants && Object.keys(base.variants).length > 1 && !requestedVariant) {
      throw new Error('This Keil project has multiple firmware variants; set firmware.defaultVariant or pass parameters.variant before build/flash/debug.');
    }
    return {
      variant: requestedVariant,
      config: {
        ...base,
        ...(selected ?? {}),
        ...(overrides.keilProject ? { keilProject: overrides.keilProject } : {}),
        ...(overrides.keilTarget ? { keilTarget: overrides.keilTarget } : {})
      }
    };
  }

  private async resolveSvdRegisterSet(
    workspace: string,
    projectPath: string,
    fw: EngineeringFirmwareProfile,
    overrides: EngineeringWorkflowOverrides,
    required = false
  ) {
    const svdFile = overrides.svdFile ?? fw.svdFile;
    const selectors = overrides.svdRegisters ?? fw.liveRegisters ?? [];
    if (!svdFile && selectors.length === 0) {
      if (required) throw new Error('STM32 peripheral snapshot requires firmware.svdFile plus firmware.liveRegisters, or parameters.svdFile plus parameters.svdRegisters.');
      return undefined;
    }
    if (!svdFile || selectors.length === 0) {
      throw new Error('SVD live-register configuration must provide both svdFile and at least one semantic peripheral/register selector.');
    }
    if (!this.stm32Svd) throw new Error('CMSIS-SVD adapter is unavailable in this runtime.');

    const resolved = [];
    for (const selector of selectors) {
      const item = await this.stm32Svd.resolveRegister(workspace, projectPath, svdFile, selector.peripheral, selector.register);
      if (!item.safeToRead) {
        throw new Error(`SVD live read blocked for ${item.selector}: ${item.safetyCode}: ${item.safetyReason}`);
      }
      resolved.push(item);
    }
    return { svdFile, selectors, resolved };
  }

  private async readResolvedSvdRegisters(sessionId: string, resolved: Stm32SvdResolvedRegister[]) {
    const snapshots = [];
    for (const item of resolved) {
      if (!item.safeToRead) throw new Error(`Unsafe SVD register read refused for ${item.selector}: ${item.safetyReason}`);
      const memory = await this.debug.memoryRead(sessionId, item.address, item.byteLength);
      snapshots.push(decodeStm32SvdRegisterHex(item, memory.hex));
    }
    return snapshots;
  }

  private async state(workspace: string, projectPath = '.'): Promise<ProjectState> {
    this.policy.assertEngineeringEnabled();
    const project = await this.firmware.inspect(workspace, projectPath);
    const stored = await this.profiles.load(workspace, projectPath);
    return {
      project,
      profileFound: stored.found,
      manifestPath: stored.manifestPath,
      profile: stored.profile ?? this.suggestedProfile(workspace, projectPath, project)
    };
  }

  async inspect(workspace: string, projectPath = '.') {
    const state = await this.state(workspace, projectPath);
    const [artifacts, devices] = await Promise.all([
      this.firmware.listArtifacts(workspace, projectPath),
      this.hardware.list()
    ]);
    return {
      ...state,
      artifacts,
      devices,
      workflows: this.workflowIds(state)
    };
  }

  async initProfile(workspace: string, projectPath: string, options: EngineeringProfileInitOptions = {}) {
    const state = await this.state(workspace, projectPath);
    const base = options.profile !== undefined
      ? this.profiles.validate(options.profile)
      : state.profile;
    const firmware = options.firmware
      ? {
          ...(base.firmware ?? {}),
          ...options.firmware,
          monitor: options.firmware.monitor
            ? { ...(base.firmware?.monitor ?? {}), ...options.firmware.monitor }
            : base.firmware?.monitor
        }
      : base.firmware;
    const ros2 = options.ros2
      ? {
          ...(base.ros2 ?? {}),
          ...options.ros2,
          build: options.ros2.build
            ? { ...(base.ros2?.build ?? {}), ...options.ros2.build }
            : base.ros2?.build
        }
      : base.ros2;
    const profile: EngineeringProjectProfile = {
      ...base,
      ...(options.id ? { id: safeId(options.id) } : {}),
      ...(options.name ? { name: options.name } : {}),
      ...(options.kind ? { kind: options.kind } : {}),
      ...(firmware ? { firmware } : {}),
      ...(ros2 ? { ros2 } : {})
    };
    return this.profiles.write(workspace, projectPath, profile, options.overwrite ?? false);
  }

  private workflowIds(state: ProjectState): EngineeringWorkflowId[] {
    const ids: EngineeringWorkflowId[] = [
      'platform.transfer_prepare',
      'platform.transfer_receive_offer',
      'platform.transfer_push',
      'platform.relay_read_chunk',
      'platform.relay_begin',
      'platform.relay_status',
      'platform.relay_write_chunk',
      'platform.relay_finalize',
      'platform.relay_abort'
    ];
    const firmwareCapable = state.project.framework !== 'platformio' && (state.project.family !== 'unknown' || Boolean(state.profile.firmware));
    if (firmwareCapable) {
      ids.push('firmware.artifact_prepare', 'firmware.artifact_accept', 'firmware.build', 'firmware.build_flash', 'firmware.build_flash_monitor');
      if (state.project.family === 'stm32' || state.profile.kind === 'stm32') {
        ids.push('firmware.build_flash_verify', 'stm32.debug_fault_snapshot', 'stm32.deep_diagnostics', 'stm32.peripheral_snapshot', 'stm32.deploy_accept', 'stm32.deploy_accept_diagnose');
      }
      if (
        state.project.family === 'esp32' ||
        state.profile.kind === 'esp-idf' ||
        Boolean(state.profile.firmware?.monitor?.expectText)
      ) {
        ids.push('firmware.build_flash_monitor_expect');
      }
      if (state.project.family === 'esp32' || state.profile.kind === 'esp-idf') {
        ids.push('espidf.diagnostics');
        if (state.project.framework === 'esp-idf' || state.profile.kind === 'esp-idf') ids.push('espidf.size_analysis');
      }
    }
    if (state.project.framework === 'platformio' && this.platformio) ids.push('platformio.diagnostics');
    if (state.project.ros2 || state.profile.ros2) {
      ids.push('ros2.build', 'ros2.health', 'ros2.diagnostics', 'ros2.doctor', 'ros2.test', 'ros2.bag_info', 'ros2.build_health');
    }
    if (state.project.docker && this.docker) ids.push('docker.diagnostics', 'docker.stats_snapshot', 'docker.container_inspect', 'docker.container_logs');
    if (state.project.kicad && this.kicad) ids.push('kicad.diagnostics', 'kicad.validate', ...(state.project.kicad.board ? ['kicad.fabrication_export' as EngineeringWorkflowId] : []));
    if (os.platform() === 'linux' && this.systemd) {
      ids.push('systemd.service_diagnostics', 'systemd.service_restart');
    }
    return ids;
  }

  async list(workspace: string, projectPath = '.') {
    const state = await this.state(workspace, projectPath);
    return {
      profileFound: state.profileFound,
      manifestPath: state.manifestPath,
      project: state.project,
      profile: state.profile,
      workflows: this.workflowIds(state).map(id => ({
        id,
        destructive: id === 'platform.transfer_receive_offer' ||
          id === 'platform.transfer_push' ||
          id === 'platform.relay_begin' ||
          id === 'platform.relay_write_chunk' ||
          id === 'platform.relay_finalize' ||
          id === 'platform.relay_abort' ||
          id.startsWith('firmware.build_flash') ||
          id === 'stm32.debug_fault_snapshot' ||
          id === 'stm32.deep_diagnostics' ||
          id === 'stm32.peripheral_snapshot' ||
          id === 'stm32.deploy_accept' ||
          id === 'stm32.deploy_accept_diagnose' ||
          id === 'kicad.fabrication_export' ||
          id === 'systemd.service_restart',
        description: {
          'platform.transfer_prepare': 'Hash any regular workspace file and emit a generic SHA-256/size manifest without moving or modifying it.',
          'platform.transfer_receive_offer': 'Create one short-lived receive offer on approved direct IPv4 interfaces and atomically accept only matching bytes.',
          'platform.transfer_push': 'Stream one verified workspace file directly to a peer Direct Node over approved direct endpoints with integrity verification.',
          'platform.relay_read_chunk': 'Read one bounded source-file chunk for control-plane relay. Intended for orchestration that pipes the result directly into the destination write workflow without printing payload data.',
          'platform.relay_begin': 'Create a persistent bounded destination relay session for an exact file name, SHA-256 and size.',
          'platform.relay_status': 'Read resumable destination relay session state and the next required byte offset.',
          'platform.relay_write_chunk': 'Append one integrity-checked bounded binary chunk at the exact next relay offset.',
          'platform.relay_finalize': 'Verify the completed relay payload against full-file SHA-256/size and atomically promote it into the generic verified transfer store.',
          'platform.relay_abort': 'Delete one incomplete control-plane relay session and its staging payload.',
          'firmware.artifact_prepare': 'Hash a firmware artifact and emit a canonical SHA-256/size manifest without modifying the artifact.',
          'firmware.artifact_accept': 'Verify a staged firmware artifact against an expected SHA-256/size and atomically promote it into the project verified store.',
          'firmware.artifact_receive_offer': 'Create one short-lived, one-shot Tailscale receive ticket for a known SHA-256/size and atomically accept only matching bytes.',
          'firmware.artifact_push': 'Stream one verified local firmware artifact directly to a Tailscale peer receive ticket without routing payload bytes through ChatGPT.',
          'espidf.diagnostics': 'Inspect ESP-IDF provider/version, project metadata, firmware artifacts and discovered serial ports without flashing.',
          'espidf.size_analysis': 'Collect official ESP-IDF JSON size, component and file memory analysis without flashing or changing project configuration.',
          'platformio.diagnostics': 'Inspect PlatformIO Core version, project metadata, computed-config lint, system info and serial device inventory through official JSON outputs without build/upload mutation.',
          'firmware.build': 'Build the firmware project using the profile/default typed provider.',
          'firmware.build_flash': 'Build and flash the selected target using a hardware lease.',
          'firmware.build_flash_verify': 'Build, flash and independently verify the STM32 artifact through constrained OpenOCD.',
          'firmware.build_flash_monitor': 'Build, flash, then open the configured serial monitor session.',
          'firmware.build_flash_monitor_expect': 'Build, flash, open serial and wait for a configured boot/readiness marker.',
          'stm32.debug_fault_snapshot': 'Open a constrained STM32 debug session, halt the target, decode Cortex-M fault state, capture stack frames, then release the probe.',
          'stm32.deep_diagnostics': 'Run one bounded STM32 diagnostic chain: open debug with RTOS auto-awareness, halt, collect fault/register/stack evidence, best-effort Cortex-M exception frame, RTOS task inventory, disassembly and configured safe CMSIS-SVD peripheral snapshots, then always release the probe.',
          'stm32.peripheral_snapshot': 'Resolve configured peripheral/register names through project-scoped CMSIS-SVD metadata, reject unsafe or side-effecting reads, halt under the existing constrained debug session, read only resolved bounded addresses, decode fields, then release the probe.',
          'stm32.deploy_accept': 'Preflight hardware, build, open serial, atomically flash/verify/reset through one ST-Link lease, then require a readiness marker and release resources.',
          'stm32.deploy_accept_diagnose': 'Run the deployment acceptance workflow and, only when flash/verify/reset succeeded but readiness acceptance failed, automatically collect bounded deep-diagnostic evidence before returning the failed acceptance.',
          'ros2.build': 'Build the ROS 2 workspace through typed colcon options and profile-managed distro bootstrap.',
          'ros2.health': 'Bootstrap the configured ROS 2 environment once and collect node/topic/service/action health.',
          'ros2.diagnostics': 'Collect ROS 2 graph health plus installed package inventory through the configured runtime environment.',
          'ros2.doctor': 'Run the upstream ROS 2 doctor report as bounded opaque diagnostic text without treating human output as a stable structured API.',
          'ros2.test': 'Run colcon test for the selected packages and require colcon test-result to report success.',
          'ros2.bag_info': 'Inspect one project-local rosbag through ros2 bag info without recording or playback.',
          'ros2.build_health': 'Build the ROS 2 workspace, then inspect the configured runtime graph health.',
          'docker.diagnostics': 'Inspect Docker daemon risk and summarize local container runtime state without mutation.',
          'docker.stats_snapshot': 'Capture one non-streaming JSON Docker resource-usage snapshot without lifecycle mutation.',
          'docker.container_inspect': 'Inspect one explicit container and return Docker metadata plus RWMCP risk classification without mutation.',
          'docker.container_logs': 'Read a bounded tail from one explicit container without lifecycle or exec mutation.',
          'kicad.diagnostics': 'Inspect KiCad CLI/version, project file inventory and board statistics through JSON output without modifying design sources.',
          'kicad.validate': 'Run KiCad ERC/DRC into temporary JSON reports outside the project and return bounded validation findings without saving or upgrading design sources.',
          'kicad.fabrication_export': 'Run ERC/DRC preflight, then export Gerbers, drill files and optional BOM into a new project-local output directory with a SHA-256 manifest; source design files are never saved or upgraded.',
          'systemd.service_diagnostics': 'Read one explicit systemd unit state and bounded journal tail on Linux.',
          'systemd.service_restart': 'Restart one exact owner-allowlisted systemd unit, then collect post-restart diagnostics.'
        }[id]
      }))
    };
  }

  async plan(
    workspace: string,
    projectPath: string,
    workflow: EngineeringWorkflowId,
    overrides: EngineeringWorkflowOverrides = {}
  ) {
    const platformWorkflow = workflow === 'platform.transfer_prepare' ||
      workflow === 'platform.transfer_receive_offer' ||
      workflow === 'platform.transfer_push' ||
      workflow === 'platform.relay_read_chunk' ||
      workflow === 'platform.relay_begin' ||
      workflow === 'platform.relay_status' ||
      workflow === 'platform.relay_write_chunk' ||
      workflow === 'platform.relay_finalize' ||
      workflow === 'platform.relay_abort';

    if (platformWorkflow) {
      const scope = { workspace, basePath: projectPath };

      if (workflow === 'platform.transfer_prepare') {
        const file = overrides.file?.trim();
        if (!file) throw new Error('platform.transfer_prepare requires parameters.file.');
        const manifest = await this.dataPlane.prepare(workspace, projectPath, file);
        return {
          workflow,
          scope,
          steps: ['transfer.hash', 'transfer.manifest'],
          dataPlane: {
            ready: true,
            transport: 'direct-http',
            source: manifest,
            blockers: []
          },
          resolved: { dataPlane: { file } }
        };
      }

      if (workflow === 'platform.relay_read_chunk') {
        const file = overrides.file?.trim();
        const offset = overrides.relayOffset ?? 0;
        const chunkBytes = overrides.relayChunkBytes ?? 64 * 1024;
        if (!file) throw new Error('platform.relay_read_chunk requires parameters.file.');
        if (!Number.isSafeInteger(offset) || offset < 0) {
          throw new Error('parameters.relayOffset must be a non-negative safe integer.');
        }
        if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > 64 * 1024) {
          throw new Error('parameters.relayChunkBytes must be between 1 and 65536.');
        }
        const source = await this.dataPlane.inspectSource(workspace, projectPath, file);
        const intent = this.transferIntent('source', workspace, projectPath, overrides, {
          sourceFile: file,
          destinationFileName: overrides.destinationFileName,
          size: source.size,
          sha256: overrides.expectedSha256,
          transport: 'relay'
        });
        const authorization = await this.authorizeSourceTransfer(intent);
        return {
          workflow,
          scope,
          steps: ['transfer.authorization', 'relay.read_chunk'],
          relay: {
            ready: true,
            transport: 'control-plane-relay',
            file,
            offset,
            chunkBytes,
            source,
            authorization,
            blockers: []
          },
          resolved: { relay: { file, offset, chunkBytes, authorization } }
        };
      }

      if (workflow === 'platform.relay_begin') {
        const fileName = overrides.fileName?.trim();
        const expectedSha256 = overrides.expectedSha256?.trim().toLowerCase();
        const expectedSize = overrides.expectedSize;
        const relayTtlMs = overrides.relayTtlMs ?? 30 * 60 * 1000;
        if (!fileName) throw new Error('platform.relay_begin requires parameters.fileName.');
        if (!expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
          throw new Error('platform.relay_begin requires parameters.expectedSha256 as 64 hexadecimal characters.');
        }
        if (!Number.isSafeInteger(expectedSize) || (expectedSize ?? 0) <= 0 || (expectedSize ?? 0) > 32 * 1024 * 1024) {
          throw new Error('platform.relay_begin requires parameters.expectedSize between 1 and 33554432.');
        }
        if (!Number.isSafeInteger(relayTtlMs) || relayTtlMs < 60_000 || relayTtlMs > 60 * 60 * 1000) {
          throw new Error('parameters.relayTtlMs must be between 60000 and 3600000.');
        }
        const intent = this.transferIntent('destination', workspace, projectPath, overrides, {
          destinationFileName: fileName,
          size: expectedSize!,
          sha256: expectedSha256,
          transport: 'relay'
        });
        const authorization = await this.authorizeDestinationTransfer(intent);
        return {
          workflow,
          scope,
          steps: ['transfer.authorization', 'relay.begin'],
          relay: {
            ready: true,
            transport: 'control-plane-relay',
            fileName,
            expectedSha256,
            expectedSize,
            relayTtlMs,
            authorization,
            blockers: []
          },
          resolved: { relay: { fileName, expectedSha256, expectedSize, relayTtlMs, authorization } }
        };
      }

      if (
        workflow === 'platform.relay_status' ||
        workflow === 'platform.relay_write_chunk' ||
        workflow === 'platform.relay_finalize' ||
        workflow === 'platform.relay_abort'
      ) {
        const relaySessionId = overrides.relaySessionId?.trim();
        if (!relaySessionId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(relaySessionId)) {
          throw new Error(`${workflow} requires parameters.relaySessionId as a UUID.`);
        }
        const state = await this.controlPlaneRelay.sessionStatus({
          workspace,
          basePath: projectPath,
          sessionId: relaySessionId
        });
        const authorization = await this.authorizeDestinationTransfer(state.authorization);

        if (workflow === 'platform.relay_status') {
          return {
            workflow,
            scope,
            steps: ['relay.status'],
            relay: { ready: true, transport: 'control-plane-relay', state, authorization, blockers: [] },
            resolved: { relay: { relaySessionId, authorization } }
          };
        }

        if (workflow === 'platform.relay_write_chunk') {
          const offset = overrides.relayOffset;
          const chunkSha256 = overrides.relayChunkSha256?.trim().toLowerCase();
          if (!Number.isSafeInteger(offset) || (offset ?? -1) < 0) {
            throw new Error('platform.relay_write_chunk requires parameters.relayOffset as a non-negative safe integer.');
          }
          if (!chunkSha256 || !/^[a-f0-9]{64}$/.test(chunkSha256)) {
            throw new Error('platform.relay_write_chunk requires parameters.relayChunkSha256 as 64 hexadecimal characters.');
          }
          if (!overrides.relayDataBase64) {
            throw new Error('platform.relay_write_chunk requires parameters.relayDataBase64.');
          }
          const blockers = offset === state.nextOffset
            ? []
            : [`Offset mismatch: destination expects ${state.nextOffset}, got ${offset}.`];
          return {
            workflow,
            scope,
            steps: ['relay.chunk_preflight', 'relay.write_chunk'],
            relay: {
              ready: blockers.length === 0,
              transport: 'control-plane-relay',
              state,
              offset,
              chunkSha256,
              dataPresent: true,
              authorization,
              blockers
            },
            resolved: { relay: { relaySessionId, offset, chunkSha256, dataPresent: true, authorization } }
          };
        }

        if (workflow === 'platform.relay_finalize') {
          const blockers = state.nextOffset === state.expectedSize
            ? []
            : [`Relay session incomplete: ${state.nextOffset}/${state.expectedSize} bytes.`];
          return {
            workflow,
            scope,
            steps: ['relay.final_preflight', 'relay.verify_accept'],
            relay: { ready: blockers.length === 0, transport: 'control-plane-relay', state, authorization, blockers },
            resolved: { relay: { relaySessionId, authorization } }
          };
        }

        return {
          workflow,
          scope,
          steps: ['relay.abort'],
          relay: { ready: true, transport: 'control-plane-relay', state, authorization, blockers: [] },
          resolved: { relay: { relaySessionId, authorization } }
        };
      }

      if (workflow === 'platform.transfer_receive_offer') {
        const fileName = overrides.fileName?.trim();
        const expectedSha256 = overrides.expectedSha256?.trim().toLowerCase();
        const expectedSize = overrides.expectedSize;
        const transferTimeoutMs = overrides.transferTimeoutMs ?? 120_000;
        if (!fileName) throw new Error('platform.transfer_receive_offer requires parameters.fileName.');
        if (!expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
          throw new Error('platform.transfer_receive_offer requires parameters.expectedSha256 as 64 hexadecimal characters.');
        }
        if (!Number.isSafeInteger(expectedSize) || (expectedSize ?? 0) <= 0 || (expectedSize ?? 0) > 512 * 1024 * 1024) {
          throw new Error('platform.transfer_receive_offer requires parameters.expectedSize between 1 and 536870912.');
        }
        if (!Number.isSafeInteger(transferTimeoutMs) || transferTimeoutMs < 10_000 || transferTimeoutMs > 600_000) {
          throw new Error('parameters.transferTimeoutMs must be between 10000 and 600000.');
        }
        const intent = this.transferIntent('destination', workspace, projectPath, overrides, {
          destinationFileName: fileName,
          size: expectedSize!,
          sha256: expectedSha256,
          transport: 'direct'
        });
        const authorization = await this.authorizeDestinationTransfer(intent);
        const status = this.dataPlane.status();
        const blockers = status.directIpv4Available ? [] : ['No approved local Tailscale or private-LAN IPv4 interface is available for the native data plane.'];
        return {
          workflow,
          scope,
          steps: ['transfer.authorization', 'transfer.receive_offer'],
          dataPlane: {
            ready: blockers.length === 0,
            transport: 'direct-http',
            availableTransports: status.availableTransports,
            fileName,
            expectedSha256,
            expectedSize,
            transferTimeoutMs,
            authorization,
            blockers
          },
          resolved: {
            dataPlane: { fileName, expectedSha256, expectedSize, transferTimeoutMs, authorization }
          }
        };
      }

      const file = overrides.file?.trim();
      const endpoints = [
        ...(overrides.transferEndpoints ?? []),
        ...(overrides.transferEndpoint?.trim() ? [overrides.transferEndpoint.trim()] : [])
      ].filter(Boolean);
      const expectedSha256 = overrides.expectedSha256?.trim().toLowerCase();
      const expectedSize = overrides.expectedSize;
      if (!file) throw new Error('platform.transfer_push requires parameters.file.');
      if (!endpoints.length) throw new Error('platform.transfer_push requires parameters.transferEndpoints or parameters.transferEndpoint.');
      if (!overrides.transferTicket) throw new Error('platform.transfer_push requires parameters.transferTicket.');
      if (!expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
        throw new Error('platform.transfer_push requires parameters.expectedSha256 as 64 hexadecimal characters.');
      }
      if (!Number.isSafeInteger(expectedSize) || (expectedSize ?? 0) <= 0 || (expectedSize ?? 0) > 512 * 1024 * 1024) {
        throw new Error('platform.transfer_push requires parameters.expectedSize between 1 and 536870912.');
      }
      const source = await this.dataPlane.prepare(workspace, projectPath, file);
      const intent = this.transferIntent('source', workspace, projectPath, overrides, {
        sourceFile: file,
        destinationFileName: overrides.destinationFileName,
        size: source.size,
        sha256: source.sha256,
        transport: 'direct'
      });
      const authorization = await this.authorizeSourceTransfer(intent);
      const blockers = [
        ...(source.sha256 !== expectedSha256 ? [`SHA-256 mismatch: expected ${expectedSha256}, got ${source.sha256}.`] : []),
        ...(source.size !== expectedSize ? [`Size mismatch: expected ${expectedSize}, got ${source.size}.`] : [])
      ];
      return {
        workflow,
        scope,
        steps: ['transfer.authorization', 'transfer.source_preflight', 'transfer.peer_push', 'transfer.peer_receipt'],
        dataPlane: {
          ready: blockers.length === 0,
          transport: 'direct-http',
          source,
          endpoints,
          expectedSha256,
          expectedSize,
          authorization,
          blockers
        },
        resolved: {
          dataPlane: {
            file,
            endpoints,
            expectedSha256,
            expectedSize,
            transferTimeoutMs: overrides.transferTimeoutMs ?? 120_000,
            ticketPresent: true,
            authorization
          }
        }
      };
    }

    const state = await this.state(workspace, projectPath);
    if (!this.workflowIds(state).includes(workflow)) throw new Error(`Workflow '${workflow}' is not available for this project.`);

    if (workflow === 'espidf.diagnostics' || workflow === 'espidf.size_analysis') {
      return {
        workflow,
        profileFound: state.profileFound,
        manifestPath: state.manifestPath,
        project: state.project,
        profile: state.profile,
        steps: workflow === 'espidf.size_analysis'
          ? ['espidf.size.json', 'espidf.size-components.json', 'espidf.size-files.json']
          : ['espidf.project.inspect', 'espidf.provider.version', 'espidf.targets.list', 'espidf.build_metadata.read', 'espidf.artifacts.list', 'hardware.serial.list'],
        resolved: { firmware: { provider: 'esp-idf', buildDir: state.profile.firmware?.buildDir ?? 'build' } }
      };
    }

    if (workflow === 'platformio.diagnostics') {
      return {
        workflow,
        profileFound: state.profileFound,
        manifestPath: state.manifestPath,
        project: state.project,
        profile: state.profile,
        steps: ['platformio.version', 'platformio.project.metadata.json', 'platformio.project.config_lint.json', 'platformio.system.info.json', 'platformio.device.list.json']
      };
    }

    if (workflow === 'docker.diagnostics' || workflow === 'docker.stats_snapshot' || workflow === 'docker.container_inspect' || workflow === 'docker.container_logs') {
      if ((workflow === 'docker.container_inspect' || workflow === 'docker.container_logs') && !overrides.dockerContainer?.trim()) {
        throw new Error(`${workflow} requires parameters.dockerContainer.`);
      }
      return {
        workflow,
        profileFound: state.profileFound,
        manifestPath: state.manifestPath,
        project: state.project,
        profile: state.profile,
        steps: workflow === 'docker.stats_snapshot'
          ? ['docker.daemon.inspect', 'docker.stats.snapshot']
          : workflow === 'docker.container_inspect'
            ? ['docker.container.inspect', 'docker.container.risk']
            : workflow === 'docker.container_logs'
              ? ['docker.container.logs']
              : ['docker.daemon.inspect', 'docker.container.list'],
        ...(workflow === 'docker.container_inspect' || workflow === 'docker.container_logs'
          ? {
              resolved: {
                docker: {
                  container: overrides.dockerContainer?.trim(),
                  ...(workflow === 'docker.container_logs' ? { tail: overrides.dockerLogTail ?? 200 } : {})
                }
              }
            }
          : {})
      };
    }

    if (workflow === 'kicad.diagnostics' || workflow === 'kicad.validate' || workflow === 'kicad.fabrication_export') {
      const kicad = state.project.kicad;
      if (!kicad) throw new Error(`${workflow} requires a detected KiCad project.`);
      let kicadOutputDir: string | undefined;
      if (workflow === 'kicad.fabrication_export') {
        kicadOutputDir = overrides.kicadOutputDir?.trim();
        if (!kicadOutputDir) throw new Error('kicad.fabrication_export requires parameters.kicadOutputDir.');
        projectChild(projectPath, kicadOutputDir);
        if (kicadOutputDir.split(/[\\/]+/).includes('.git')) throw new Error('kicadOutputDir must not target .git.');
      }
      const steps = workflow === 'kicad.validate'
        ? [...(kicad.schematic ? ['kicad.erc.json'] : []), ...(kicad.board ? ['kicad.drc.json'] : [])]
        : workflow === 'kicad.fabrication_export'
          ? [...(kicad.schematic ? ['kicad.erc.json'] : []), 'kicad.drc.json', 'kicad.export.gerbers', 'kicad.export.drill', ...(kicad.schematic ? ['kicad.export.bom'] : []), 'kicad.fabrication.manifest.sha256']
          : ['kicad.version', 'kicad.project.files', ...(kicad.board ? ['kicad.board.stats.json'] : [])];
      return {
        workflow,
        profileFound: state.profileFound,
        manifestPath: state.manifestPath,
        project: state.project,
        profile: state.profile,
        steps,
        resolved: { kicad, ...(kicadOutputDir ? { outputDir: kicadOutputDir } : {}) }
      };
    }

    if (workflow === 'systemd.service_diagnostics' || workflow === 'systemd.service_restart') {
      const unit = overrides.systemdUnit?.trim();
      if (!unit) throw new Error(`${workflow} requires parameters.systemdUnit.`);
      return {
        workflow,
        profileFound: state.profileFound,
        manifestPath: state.manifestPath,
        project: state.project,
        profile: state.profile,
        steps: workflow === 'systemd.service_restart'
          ? ['systemd.unit.restart', 'systemd.unit.show', 'systemd.journal.tail']
          : ['systemd.unit.show', 'systemd.journal.tail'],
        resolved: {
          systemd: {
            unit,
            user: overrides.systemdUser ?? false,
            journalLines: overrides.journalLines ?? 100
          }
        }
      };
    }

    if (workflow === 'firmware.artifact_prepare' || workflow === 'firmware.artifact_accept') {
      const artifact = overrides.artifact ?? state.profile.firmware?.artifact;
      if (!artifact) throw new Error(`${workflow} requires parameters.artifact or firmware.artifact in the project profile.`);
      const actual = await this.artifacts.prepare(workspace, projectPath, artifact);
      const expectedSha256 = overrides.expectedSha256?.trim().toLowerCase();
      const expectedSize = overrides.expectedSize;
      if (workflow === 'firmware.artifact_accept') {
        if (!expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
          throw new Error('firmware.artifact_accept requires parameters.expectedSha256 as 64 hexadecimal characters.');
        }
        if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize <= 0)) {
          throw new Error('parameters.expectedSize must be a positive safe integer when provided.');
        }
      }
      const ready = workflow === 'firmware.artifact_prepare'
        ? true
        : actual.sha256 === expectedSha256 && (expectedSize === undefined || actual.size === expectedSize);
      return {
        workflow,
        profileFound: state.profileFound,
        manifestPath: state.manifestPath,
        project: state.project,
        profile: state.profile,
        steps: workflow === 'firmware.artifact_prepare'
          ? ['artifact.hash', 'artifact.manifest']
          : ['artifact.preflight', 'artifact.atomic_accept'],
        preflight: undefined,
        artifactIntegrity: {
          ready,
          actual,
          ...(expectedSha256 ? { expectedSha256 } : {}),
          ...(expectedSize !== undefined ? { expectedSize } : {}),
          ...(ready ? { blockers: [] } : {
            blockers: [
              ...(actual.sha256 !== expectedSha256 ? [`SHA-256 mismatch: expected ${expectedSha256}, got ${actual.sha256}.`] : []),
              ...(expectedSize !== undefined && actual.size !== expectedSize ? [`Size mismatch: expected ${expectedSize}, got ${actual.size}.`] : [])
            ]
          })
        },
        resolved: {
          artifactIntegrity: {
            artifact,
            expectedSha256,
            expectedSize
          }
        }
      };
    }

    if (workflow === 'firmware.artifact_receive_offer') {
      const artifactName = overrides.artifactName?.trim();
      const expectedSha256 = overrides.expectedSha256?.trim().toLowerCase();
      const expectedSize = overrides.expectedSize;
      if (!artifactName) throw new Error('firmware.artifact_receive_offer requires parameters.artifactName.');
      if (!expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
        throw new Error('firmware.artifact_receive_offer requires parameters.expectedSha256 as 64 hexadecimal characters.');
      }
      if (!Number.isSafeInteger(expectedSize) || (expectedSize ?? 0) <= 0 || (expectedSize ?? 0) > 128 * 1024 * 1024) {
        throw new Error('firmware.artifact_receive_offer requires parameters.expectedSize between 1 and 134217728.');
      }
      const transferTimeoutMs = overrides.transferTimeoutMs ?? 120_000;
      if (!Number.isSafeInteger(transferTimeoutMs) || transferTimeoutMs < 10_000 || transferTimeoutMs > 600_000) {
        throw new Error('parameters.transferTimeoutMs must be between 10000 and 600000.');
      }
      return {
        workflow,
        profileFound: state.profileFound,
        manifestPath: state.manifestPath,
        project: state.project,
        profile: state.profile,
        steps: ['artifact.peer.offer'],
        preflight: undefined,
        artifactIntegrity: undefined,
        artifactTransfer: {
          ready: true,
          transport: 'tailscale-http',
          artifactName,
          expectedSha256,
          expectedSize,
          transferTimeoutMs,
          blockers: []
        },
        resolved: {
          artifactTransfer: {
            artifactName,
            expectedSha256,
            expectedSize,
            transferTimeoutMs
          }
        }
      };
    }

    if (workflow === 'firmware.artifact_push') {
      const artifact = overrides.artifact ?? state.profile.firmware?.artifact;
      const endpoint = overrides.transferEndpoint?.trim();
      const expectedSha256 = overrides.expectedSha256?.trim().toLowerCase();
      const expectedSize = overrides.expectedSize;
      if (!artifact) throw new Error('firmware.artifact_push requires parameters.artifact or firmware.artifact.');
      if (!endpoint) throw new Error('firmware.artifact_push requires parameters.transferEndpoint.');
      if (!overrides.transferTicket) throw new Error('firmware.artifact_push requires parameters.transferTicket.');
      if (!expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
        throw new Error('firmware.artifact_push requires parameters.expectedSha256 as 64 hexadecimal characters.');
      }
      if (!Number.isSafeInteger(expectedSize) || (expectedSize ?? 0) <= 0 || (expectedSize ?? 0) > 128 * 1024 * 1024) {
        throw new Error('firmware.artifact_push requires parameters.expectedSize between 1 and 134217728.');
      }
      const source = await this.artifacts.prepare(workspace, projectPath, artifact);
      const blockers = [
        ...(source.sha256 !== expectedSha256 ? [`SHA-256 mismatch: expected ${expectedSha256}, got ${source.sha256}.`] : []),
        ...(source.size !== expectedSize ? [`Size mismatch: expected ${expectedSize}, got ${source.size}.`] : [])
      ];
      return {
        workflow,
        profileFound: state.profileFound,
        manifestPath: state.manifestPath,
        project: state.project,
        profile: state.profile,
        steps: ['artifact.source_preflight', 'artifact.peer.push', 'artifact.peer.receipt'],
        preflight: undefined,
        artifactIntegrity: undefined,
        artifactTransfer: {
          ready: blockers.length === 0,
          transport: 'tailscale-http',
          source,
          endpoint,
          expectedSha256,
          expectedSize,
          blockers
        },
        resolved: {
          artifactTransfer: {
            artifact,
            endpoint,
            expectedSha256,
            expectedSize,
            transferTimeoutMs: overrides.transferTimeoutMs ?? 120_000,
            ticketPresent: true
          }
        }
      };
    }

    const effective = this.effectiveFirmware(state.profile.firmware, overrides);
    const fw = effective.config;
    const svdRegisterSet = (workflow === 'stm32.deep_diagnostics' || workflow === 'stm32.peripheral_snapshot')
      ? await this.resolveSvdRegisterSet(workspace, projectPath, fw, overrides, workflow === 'stm32.peripheral_snapshot')
      : undefined;
    const flashProvider = fw.flashProvider ?? (state.project.family === 'esp32' ? 'esp-idf' : 'auto');
    const needsMonitorPort = workflow === 'firmware.build_flash_monitor'
      || workflow === 'firmware.build_flash_monitor_expect'
      || workflow === 'stm32.deploy_accept'
      || workflow === 'stm32.deploy_accept_diagnose';
    const needsFlashPort = workflow.startsWith('firmware.build_flash') && flashProvider === 'esp-idf';
    const portResolution = (needsFlashPort || needsMonitorPort)
      ? await this.resolveSerialPort(overrides.port, fw.portSelector, fw.port)
      : { source: 'unconfigured' as const };
    const port = portResolution.port;
    const monitorResolution = needsMonitorPort
      ? await this.resolveSerialPort(
          overrides.monitorPort,
          fw.monitor?.selector,
          fw.monitor?.port,
          port
        )
      : { source: 'unconfigured' as const };
    const monitorPort = monitorResolution.port;
    const expectedText = overrides.expectText ?? fw.monitor?.expectText;
    const ros = state.profile.ros2;
    const rosBuild = ros?.build ?? {};
    const rosSymlinkInstall = overrides.rosSymlinkInstall ?? rosBuild.symlinkInstall ?? true;
    const rosMergeInstall = overrides.rosMergeInstall ?? rosBuild.mergeInstall ?? false;
    if (workflow.startsWith('ros2.') && rosSymlinkInstall && rosMergeInstall) {
      throw new Error('ROS 2 build cannot combine symlinkInstall=true with mergeInstall=true.');
    }
    if (workflow === 'ros2.bag_info' && !overrides.rosBagPath?.trim()) {
      throw new Error('ros2.bag_info requires parameters.rosBagPath.');
    }

    if (workflow.startsWith('firmware.build_flash') && flashProvider === 'esp-idf' && !port) {
      throw new Error('ESP-IDF flash workflow requires firmware.portSelector, legacy firmware.port, or an explicit port override.');
    }
    if (
      (workflow === 'firmware.build_flash_monitor' || workflow === 'firmware.build_flash_monitor_expect') &&
      !monitorPort
    ) {
      throw new Error('Serial monitor workflow requires firmware.monitor.selector, legacy monitor/firmware port, or monitorPort override.');
    }
    if (workflow === 'firmware.build_flash_monitor_expect' && !expectedText) {
      throw new Error('Monitor-expect workflow requires firmware.monitor.expectText or an expectText override.');
    }
    if (workflow === 'stm32.deploy_accept' || workflow === 'stm32.deploy_accept_diagnose') {
      const label = workflow === 'stm32.deploy_accept' ? 'stm32.deploy_accept' : 'stm32.deploy_accept_diagnose';
      if (flashProvider === 'esp-idf') throw new Error(`${label} requires the constrained OpenOCD flash provider.`);
      if (!monitorPort) throw new Error(`${label} requires firmware.monitor.selector, a legacy monitor/firmware port, or parameters.monitorPort.`);
      if (!expectedText) throw new Error(`${label} requires firmware.monitor.expectText or parameters.expectText.`);
      if (workflow === 'stm32.deploy_accept_diagnose' && overrides.keepMonitorOpen) {
        throw new Error('stm32.deploy_accept_diagnose requires keepMonitorOpen=false so the serial resource is released before automatic debug diagnostics.');
      }
    }

    const deploymentPreflight = (workflow === 'stm32.deploy_accept' || workflow === 'stm32.deploy_accept_diagnose')
      ? await this.firmware.stm32DeploymentPreflight({
          probeSerial: overrides.probeSerial ?? fw.probeSerial,
          monitorPort,
          adapterSpeedKhz: overrides.adapterSpeedKhz ?? fw.adapterSpeedKhz
        })
      : undefined;

    const steps: string[] = [];
    if (workflow === 'stm32.debug_fault_snapshot') {
      steps.push('debug.session.start', 'debug.halt', 'debug.fault_snapshot', 'debug.stack', 'debug.session.stop');
    }
    if (workflow === 'stm32.deep_diagnostics') {
      steps.push('debug.session.start', 'debug.halt', 'debug.registers', 'debug.fault_snapshot', 'debug.exception_frame', 'debug.rtos_tasks', 'debug.stack');
      if (svdRegisterSet) steps.push('debug.svd_registers');
      steps.push('debug.disassemble', 'debug.session.stop');
    }
    if (workflow === 'stm32.peripheral_snapshot') {
      steps.push('debug.session.start', 'debug.halt', 'debug.svd_registers', 'debug.session.stop');
    }
    if (workflow === 'stm32.deploy_accept' || workflow === 'stm32.deploy_accept_diagnose') {
      steps.push('preflight.stm32_deploy', 'firmware.build', 'serial.open', 'firmware.flash_verify_reset', 'serial.wait_for_text');
      if (!overrides.keepMonitorOpen) steps.push('serial.close');
      if (workflow === 'stm32.deploy_accept_diagnose') steps.push('diagnostics.on_readiness_failure');
    }
    if (workflow.startsWith('firmware.')) {
      steps.push('firmware.build');
      if (workflow !== 'firmware.build') steps.push('firmware.flash');
      if (workflow === 'firmware.build_flash_verify') steps.push('firmware.verify');
      if (workflow === 'firmware.build_flash_monitor' || workflow === 'firmware.build_flash_monitor_expect') {
        steps.push('serial.open');
      }
      if (workflow === 'firmware.build_flash_monitor_expect') steps.push('serial.wait_for_text');
    }
    if (workflow === 'ros2.build' || workflow === 'ros2.build_health') steps.push('ros2.colcon.build');
    if (workflow === 'ros2.health' || workflow === 'ros2.diagnostics' || workflow === 'ros2.build_health') {
      steps.push('ros2.environment.bootstrap', 'ros2.node.list', 'ros2.topic.list', 'ros2.service.list', 'ros2.action.list');
      if (workflow === 'ros2.diagnostics') steps.push('ros2.pkg.list');
    }
    if (workflow === 'ros2.doctor') steps.push('ros2.environment.bootstrap', 'ros2.doctor.report');
    if (workflow === 'ros2.test') steps.push('ros2.colcon.test', 'ros2.colcon.test-result');
    if (workflow === 'ros2.bag_info') steps.push('ros2.environment.bootstrap', 'ros2.bag.info');

    return {
      workflow,
      profileFound: state.profileFound,
      manifestPath: state.manifestPath,
      project: state.project,
      profile: state.profile,
      steps,
      preflight: deploymentPreflight,
      artifactIntegrity: undefined,
      resolved: {
        firmware: (workflow.startsWith('firmware.') || workflow === 'stm32.debug_fault_snapshot' || workflow === 'stm32.deep_diagnostics' || workflow === 'stm32.peripheral_snapshot' || workflow === 'stm32.deploy_accept' || workflow === 'stm32.deploy_accept_diagnose') ? {
          variant: effective.variant,
          buildProvider: fw.buildProvider ?? 'auto',
          buildDir: fw.buildDir ?? 'build',
          keilProject: fw.keilProject,
          keilTarget: fw.keilTarget,
          flashProvider,
          artifact: overrides.artifact ?? fw.artifact,
          port,
          portResolution,
          probeSerial: overrides.probeSerial ?? fw.probeSerial,
          targetConfig: overrides.targetConfig ?? fw.targetConfig,
          adapterSpeedKhz: overrides.adapterSpeedKhz ?? fw.adapterSpeedKhz,
          monitorPort,
          monitorResolution,
          monitorBaudRate: overrides.monitorBaudRate ?? fw.monitor?.baudRate ?? 115200,
          expectText: expectedText,
          expectTimeoutMs: overrides.expectTimeoutMs ?? fw.monitor?.expectTimeoutMs ?? 10_000,
          debugMaxFrames: overrides.debugMaxFrames ?? 16,
          ...(svdRegisterSet ? {
            svdFile: svdRegisterSet.svdFile,
            liveRegisters: svdRegisterSet.resolved.map(item => ({
              selector: item.selector,
              addressHex: `0x${item.address.toString(16)}`,
              sizeBits: item.sizeBits,
              safetyCode: item.safetyCode
            }))
          } : {}),
          keepMonitorOpen: overrides.keepMonitorOpen ?? false
        } : undefined,
        ros2: workflow.startsWith('ros2.') ? {
          ...ros,
          build: {
            symlinkInstall: overrides.rosSymlinkInstall ?? rosBuild.symlinkInstall ?? true,
            mergeInstall: overrides.rosMergeInstall ?? rosBuild.mergeInstall ?? false,
            packagesSelect: overrides.rosPackagesSelect ?? rosBuild.packagesSelect ?? []
          },
          ...(overrides.rosBagPath ? { bagPath: overrides.rosBagPath } : {})
        } : undefined
      }
    };
  }

  private async resolveVerifyArtifact(
    workspace: string,
    projectPath: string,
    explicit: string | undefined
  ): Promise<string> {
    if (explicit) return explicit;
    const candidates = (await this.firmware.listArtifacts(workspace, projectPath))
      .filter(item => ['elf', 'axf', 'hex'].includes(item.kind));
    if (candidates.length !== 1) {
      throw new Error(`STM32 verify workflow requires one unambiguous ELF/AXF/HEX artifact; discovery found ${candidates.length}.`);
    }
    return candidates[0]!.path;
  }

  private async resolveDebugSymbols(
    workspace: string,
    projectPath: string,
    explicit: string | undefined
  ): Promise<string> {
    if (explicit) {
      const ext = path.extname(explicit).toLowerCase();
      if (!['.elf', '.axf'].includes(ext)) {
        throw new Error('STM32 debug fault workflow requires an ELF or AXF symbols artifact.');
      }
      return explicit;
    }
    const candidates = (await this.firmware.listArtifacts(workspace, projectPath))
      .filter(item => ['elf', 'axf'].includes(item.kind));
    if (candidates.length !== 1) {
      throw new Error(`STM32 debug fault workflow requires one unambiguous ELF/AXF artifact; discovery found ${candidates.length}.`);
    }
    return candidates[0]!.path;
  }

  async run(
    workspace: string,
    projectPath: string,
    workflow: EngineeringWorkflowId,
    overrides: EngineeringWorkflowOverrides = {}
  ): Promise<EngineeringWorkflowRunResult> {
    const steps: StepResult[] = [];

    const capture = async <T>(
      id: string,
      fn: () => Promise<T>
    ): Promise<{ ok: true; value: T } | { ok: false }> => {
      const started = Date.now();
      try {
        const value = await fn();
        steps.push({ id, status: 'succeeded', durationMs: Date.now() - started, result: value });
        return { ok: true, value };
      } catch (error) {
        steps.push({
          id,
          status: 'failed',
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error)
        });
        return { ok: false };
      }
    };

    const captureOptional = async <T>(
      id: string,
      fn: () => Promise<T>
    ): Promise<T | undefined> => {
      const started = Date.now();
      try {
        const value = await fn();
        steps.push({ id, status: 'succeeded', durationMs: Date.now() - started, result: value });
        return value;
      } catch (error) {
        steps.push({
          id,
          status: 'blocked',
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error)
        });
        return undefined;
      }
    };

    const platformWorkflow = workflow === 'platform.transfer_prepare' ||
      workflow === 'platform.transfer_receive_offer' ||
      workflow === 'platform.transfer_push' ||
      workflow === 'platform.relay_read_chunk' ||
      workflow === 'platform.relay_begin' ||
      workflow === 'platform.relay_status' ||
      workflow === 'platform.relay_write_chunk' ||
      workflow === 'platform.relay_finalize' ||
      workflow === 'platform.relay_abort';

    if (platformWorkflow) {
      const plan = await this.plan(workspace, projectPath, workflow, overrides);

      if (workflow === 'platform.transfer_prepare') {
        const file = overrides.file?.trim();
        if (!file) throw new Error('platform.transfer_prepare requires parameters.file.');
        const prepared = await capture('transfer.hash', () => this.dataPlane.prepare(workspace, projectPath, file));
        if (!prepared.ok) return { workflow, status: 'failed', plan, steps };
        steps.push({ id: 'transfer.manifest', status: 'succeeded', durationMs: 0, result: prepared.value });
        return { workflow, status: 'succeeded', plan, steps, outputs: { manifest: prepared.value } };
      }

      if (workflow === 'platform.relay_read_chunk') {
        const file = overrides.file?.trim();
        const offset = overrides.relayOffset ?? 0;
        const chunkBytes = overrides.relayChunkBytes ?? 64 * 1024;
        if (!file) throw new Error('platform.relay_read_chunk requires parameters.file.');
        const started = Date.now();
        try {
          const chunk = await this.controlPlaneRelay.readChunk({
            workspace,
            basePath: projectPath,
            file,
            offset,
            chunkBytes
          });
          steps.push({
            id: 'relay.read_chunk',
            status: 'succeeded',
            durationMs: Date.now() - started,
            result: {
              transport: chunk.transport,
              file: chunk.file,
              offset: chunk.offset,
              length: chunk.length,
              nextOffset: chunk.nextOffset,
              totalSize: chunk.totalSize,
              eof: chunk.eof,
              sha256: chunk.sha256,
              dataPresent: chunk.dataBase64.length > 0
            }
          });
          return { workflow, status: 'succeeded', plan, steps, outputs: { chunk } };
        } catch (error) {
          steps.push({
            id: 'relay.read_chunk',
            status: 'failed',
            durationMs: Date.now() - started,
            error: error instanceof Error ? error.message : String(error)
          });
          return { workflow, status: 'failed', plan, steps };
        }
      }

      if (workflow === 'platform.relay_begin') {
        const fileName = overrides.fileName?.trim();
        const expectedSha256 = overrides.expectedSha256?.trim().toLowerCase();
        const expectedSize = overrides.expectedSize;
        if (!fileName || !expectedSha256 || expectedSize === undefined) {
          throw new Error('platform.relay_begin requires fileName, expectedSha256 and expectedSize.');
        }
        const intent = this.transferIntent('destination', workspace, projectPath, overrides, {
          destinationFileName: fileName,
          size: expectedSize,
          sha256: expectedSha256,
          transport: 'relay'
        });
        const begun = await capture('relay.begin', () => this.controlPlaneRelay.begin({
          workspace,
          basePath: projectPath,
          fileName,
          expectedSha256,
          expectedSize,
          ttlMs: overrides.relayTtlMs,
          authorization: intent
        }));
        if (!begun.ok) return { workflow, status: 'failed', plan, steps };
        return { workflow, status: 'succeeded', plan, steps, outputs: { session: begun.value } };
      }

      if (workflow === 'platform.relay_status') {
        const relaySessionId = overrides.relaySessionId?.trim();
        if (!relaySessionId) throw new Error('platform.relay_status requires parameters.relaySessionId.');
        const status = await capture('relay.status', () => this.controlPlaneRelay.sessionStatus({
          workspace,
          basePath: projectPath,
          sessionId: relaySessionId
        }));
        if (!status.ok) return { workflow, status: 'failed', plan, steps };
        return { workflow, status: 'succeeded', plan, steps, outputs: { session: status.value } };
      }

      if (workflow === 'platform.relay_write_chunk') {
        const relay = plan.relay;
        if (!relay) throw new Error('platform.relay_write_chunk plan did not produce relay preflight data.');
        steps.push({
          id: 'relay.chunk_preflight',
          status: relay.ready ? 'succeeded' : 'blocked',
          durationMs: 0,
          result: relay,
          ...(!relay.ready ? { error: relay.blockers.join(' ') } : {})
        });
        if (!relay.ready) return { workflow, status: 'blocked', plan, steps, outputs: { relay } };

        const relaySessionId = overrides.relaySessionId?.trim();
        const offset = overrides.relayOffset;
        const dataBase64 = overrides.relayDataBase64;
        const chunkSha256 = overrides.relayChunkSha256?.trim().toLowerCase();
        if (!relaySessionId || offset === undefined || !dataBase64 || !chunkSha256) {
          throw new Error('platform.relay_write_chunk requires relaySessionId, relayOffset, relayDataBase64 and relayChunkSha256.');
        }
        const written = await capture('relay.write_chunk', () => this.controlPlaneRelay.writeChunk({
          workspace,
          basePath: projectPath,
          sessionId: relaySessionId,
          offset,
          dataBase64,
          chunkSha256
        }));
        if (!written.ok) return { workflow, status: 'failed', plan, steps };
        return { workflow, status: 'succeeded', plan, steps, outputs: { relay: written.value } };
      }

      if (workflow === 'platform.relay_finalize') {
        const relay = plan.relay;
        if (!relay) throw new Error('platform.relay_finalize plan did not produce relay preflight data.');
        steps.push({
          id: 'relay.final_preflight',
          status: relay.ready ? 'succeeded' : 'blocked',
          durationMs: 0,
          result: relay,
          ...(!relay.ready ? { error: relay.blockers.join(' ') } : {})
        });
        if (!relay.ready) return { workflow, status: 'blocked', plan, steps, outputs: { relay } };

        const relaySessionId = overrides.relaySessionId?.trim();
        if (!relaySessionId) throw new Error('platform.relay_finalize requires parameters.relaySessionId.');
        const finalized = await capture('relay.verify_accept', () => this.controlPlaneRelay.finalize({
          workspace,
          basePath: projectPath,
          sessionId: relaySessionId
        }));
        if (!finalized.ok) return { workflow, status: 'failed', plan, steps };
        return { workflow, status: 'succeeded', plan, steps, outputs: { receipt: finalized.value } };
      }

      if (workflow === 'platform.relay_abort') {
        const relaySessionId = overrides.relaySessionId?.trim();
        if (!relaySessionId) throw new Error('platform.relay_abort requires parameters.relaySessionId.');
        const aborted = await capture('relay.abort', () => this.controlPlaneRelay.abort({
          workspace,
          basePath: projectPath,
          sessionId: relaySessionId
        }));
        if (!aborted.ok) return { workflow, status: 'failed', plan, steps };
        return { workflow, status: 'succeeded', plan, steps, outputs: { relay: aborted.value } };
      }

      if (workflow === 'platform.transfer_receive_offer') {
        const transfer = plan.dataPlane;
        if (!transfer) throw new Error('platform.transfer_receive_offer plan did not produce data-plane preflight data.');
        steps.push({
          id: 'transfer.preflight',
          status: transfer.ready ? 'succeeded' : 'blocked',
          durationMs: 0,
          result: transfer,
          ...(!transfer.ready ? { error: transfer.blockers.join(' ') } : {})
        });
        if (!transfer.ready) return { workflow, status: 'blocked', plan, steps, outputs: { transfer } };

        const fileName = overrides.fileName?.trim();
        const expectedSha256 = overrides.expectedSha256?.trim().toLowerCase();
        const expectedSize = overrides.expectedSize;
        if (!fileName || !expectedSha256 || expectedSize === undefined) {
          throw new Error('platform.transfer_receive_offer requires fileName, expectedSha256 and expectedSize.');
        }
        const intent = this.transferIntent('destination', workspace, projectPath, overrides, {
          destinationFileName: fileName,
          size: expectedSize,
          sha256: expectedSha256,
          transport: 'direct'
        });
        const offered = await capture('transfer.receive_offer', () => this.dataPlane.createReceiveOffer({
          workspace,
          basePath: projectPath,
          fileName,
          expectedSha256,
          expectedSize,
          ttlMs: overrides.transferTimeoutMs,
          authorization: intent
        }));
        if (!offered.ok) return { workflow, status: 'failed', plan, steps };
        return { workflow, status: 'succeeded', plan, steps, outputs: { offer: offered.value } };
      }

      const transfer = plan.dataPlane;
      if (!transfer) throw new Error('platform.transfer_push plan did not produce data-plane preflight data.');
      steps.push({
        id: 'transfer.source_preflight',
        status: transfer.ready ? 'succeeded' : 'blocked',
        durationMs: 0,
        result: transfer,
        ...(!transfer.ready ? { error: transfer.blockers.join(' ') } : {})
      });
      if (!transfer.ready) return { workflow, status: 'blocked', plan, steps, outputs: { transfer } };

      const file = overrides.file?.trim();
      const endpoints = [
        ...(overrides.transferEndpoints ?? []),
        ...(overrides.transferEndpoint?.trim() ? [overrides.transferEndpoint.trim()] : [])
      ].filter(Boolean);
      const ticket = overrides.transferTicket;
      const expectedSha256 = overrides.expectedSha256?.trim().toLowerCase();
      const expectedSize = overrides.expectedSize;
      if (!file || !endpoints.length || !ticket || !expectedSha256 || expectedSize === undefined) {
        throw new Error('platform.transfer_push requires file, transferEndpoints/transferEndpoint, transferTicket, expectedSha256 and expectedSize.');
      }
      const intent = this.transferIntent('source', workspace, projectPath, overrides, {
        sourceFile: file,
        destinationFileName: overrides.destinationFileName,
        size: expectedSize,
        sha256: expectedSha256,
        transport: 'direct'
      });
      const pushed = await capture('transfer.peer_push', () => this.dataPlane.push({
        workspace,
        basePath: projectPath,
        file,
        endpoints,
        ticket,
        expectedSha256,
        expectedSize,
        timeoutMs: overrides.transferTimeoutMs,
        authorization: intent
      }));
      if (!pushed.ok) return { workflow, status: 'failed', plan, steps };
      steps.push({ id: 'transfer.peer_receipt', status: 'succeeded', durationMs: 0, result: pushed.value.accepted });
      return { workflow, status: 'succeeded', plan, steps, outputs: { receipt: pushed.value } };
    }

    this.policy.assertEngineeringExecute();
    const plan = await this.plan(workspace, projectPath, workflow, overrides);
    const state = await this.state(workspace, projectPath);

    if (workflow === 'espidf.diagnostics' || workflow === 'espidf.size_analysis') {
      const diagnostics = await capture<unknown>(
        workflow,
        () => workflow === 'espidf.size_analysis'
          ? this.firmware.espIdfSizeAnalysis(workspace, projectPath)
          : this.firmware.espIdfDiagnostics(workspace, projectPath, state.profile.firmware?.buildDir ?? 'build')
      );
      return {
        workflow,
        status: diagnostics.ok ? 'succeeded' : 'failed',
        plan,
        steps,
        ...(diagnostics.ok ? { outputs: { diagnostics: diagnostics.value } } : {})
      };
    }

    if (workflow === 'platformio.diagnostics') {
      if (!this.platformio) throw new Error('PlatformIO diagnostics adapter is unavailable.');
      const diagnostics = await capture('platformio.diagnostics', () => this.platformio!.diagnostics(workspace, projectPath));
      return {
        workflow,
        status: diagnostics.ok ? 'succeeded' : 'failed',
        plan,
        steps,
        ...(diagnostics.ok ? { outputs: { diagnostics: diagnostics.value } } : {})
      };
    }

    if (workflow === 'docker.diagnostics' || workflow === 'docker.stats_snapshot' || workflow === 'docker.container_inspect' || workflow === 'docker.container_logs') {
      if (!this.docker) throw new Error('Docker diagnostics adapter is unavailable.');
      const diagnostics = await capture<unknown>(
        workflow,
        () => workflow === 'docker.stats_snapshot'
          ? this.docker!.statsSnapshot(workspace, projectPath)
          : workflow === 'docker.container_inspect'
            ? this.docker!.inspect(workspace, overrides.dockerContainer!, projectPath)
            : workflow === 'docker.container_logs'
              ? this.docker!.logs(workspace, overrides.dockerContainer!, overrides.dockerLogTail ?? 200, projectPath)
              : this.docker!.diagnostics(workspace, projectPath)
      );
      return {
        workflow,
        status: diagnostics.ok ? 'succeeded' : 'failed',
        plan,
        steps,
        ...(diagnostics.ok ? { outputs: { diagnostics: diagnostics.value } } : {})
      };
    }

    if (workflow === 'kicad.diagnostics' || workflow === 'kicad.validate' || workflow === 'kicad.fabrication_export') {
      if (!this.kicad) throw new Error('KiCad adapter is unavailable.');
      const kicad = state.project.kicad;
      if (!kicad) throw new Error(`${workflow} requires a detected KiCad project.`);
      const result = await capture<unknown>(
        workflow,
        () => workflow === 'kicad.validate'
          ? this.kicad!.validate(workspace, projectPath, kicad)
          : workflow === 'kicad.fabrication_export'
            ? this.kicad!.fabricationExport(workspace, projectPath, kicad, overrides.kicadOutputDir!)
            : this.kicad!.diagnostics(workspace, projectPath, kicad)
      );
      return {
        workflow,
        status: result.ok ? 'succeeded' : 'failed',
        plan,
        steps,
        ...(result.ok ? { outputs: { diagnostics: result.value } } : {})
      };
    }

    if (workflow === 'systemd.service_diagnostics' || workflow === 'systemd.service_restart') {
      if (!this.systemd) throw new Error('systemd adapter is unavailable.');
      const unit = overrides.systemdUnit?.trim();
      if (!unit) throw new Error(`${workflow} requires parameters.systemdUnit.`);
      const user = overrides.systemdUser ?? false;
      const journalLines = overrides.journalLines ?? 100;
      const diagnostics = await capture<unknown>(
        workflow === 'systemd.service_restart' ? 'systemd.service.restart' : 'systemd.service.diagnostics',
        () => workflow === 'systemd.service_restart'
          ? this.systemd!.restart(workspace, unit, projectPath, user, journalLines)
          : this.systemd!.diagnostics(workspace, unit, projectPath, user, journalLines)
      );
      return {
        workflow,
        status: diagnostics.ok ? 'succeeded' : 'failed',
        plan,
        steps,
        ...(diagnostics.ok ? { outputs: { diagnostics: diagnostics.value } } : {})
      };
    }

    if (workflow === 'firmware.artifact_receive_offer') {
      const artifactName = overrides.artifactName?.trim();
      const expectedSha256 = overrides.expectedSha256?.trim().toLowerCase();
      const expectedSize = overrides.expectedSize;
      if (!artifactName || !expectedSha256 || expectedSize === undefined) {
        throw new Error('firmware.artifact_receive_offer requires artifactName, expectedSha256 and expectedSize.');
      }
      const offered = await capture('artifact.peer.offer', () => this.artifactTransfer.createReceiveOffer({
        workspace,
        projectPath,
        artifactName,
        expectedSha256,
        expectedSize,
        ttlMs: overrides.transferTimeoutMs
      }));
      if (!offered.ok) return { workflow, status: 'failed', plan, steps };
      return {
        workflow,
        status: 'succeeded',
        plan,
        steps,
        outputs: { offer: offered.value }
      };
    }

    if (workflow === 'firmware.artifact_push') {
      const artifact = overrides.artifact ?? state.profile.firmware?.artifact;
      const endpoint = overrides.transferEndpoint?.trim();
      const ticket = overrides.transferTicket;
      const expectedSha256 = overrides.expectedSha256?.trim().toLowerCase();
      const expectedSize = overrides.expectedSize;
      if (!artifact || !endpoint || !ticket || !expectedSha256 || expectedSize === undefined) {
        throw new Error('firmware.artifact_push requires artifact, transferEndpoint, transferTicket, expectedSha256 and expectedSize.');
      }
      const transfer = plan.artifactTransfer;
      if (!transfer) throw new Error('firmware.artifact_push plan did not produce transfer preflight data.');
      steps.push({
        id: 'artifact.source_preflight',
        status: transfer.ready ? 'succeeded' : 'blocked',
        durationMs: 0,
        result: transfer,
        ...(!transfer.ready ? { error: transfer.blockers.join(' ') } : {})
      });
      if (!transfer.ready) {
        return { workflow, status: 'blocked', plan, steps, outputs: { transfer } };
      }
      const pushed = await capture('artifact.peer.push', () => this.artifactTransfer.push({
        workspace,
        projectPath,
        artifact,
        endpoint,
        ticket,
        expectedSha256,
        expectedSize,
        timeoutMs: overrides.transferTimeoutMs
      }));
      if (!pushed.ok) return { workflow, status: 'failed', plan, steps };
      steps.push({ id: 'artifact.peer.receipt', status: 'succeeded', durationMs: 0, result: pushed.value.accepted });
      return {
        workflow,
        status: 'succeeded',
        plan,
        steps,
        outputs: { receipt: pushed.value }
      };
    }

    if (workflow === 'firmware.artifact_prepare') {
      const artifact = overrides.artifact ?? state.profile.firmware?.artifact;
      if (!artifact) throw new Error('firmware.artifact_prepare requires parameters.artifact or firmware.artifact.');
      const prepared = await capture('artifact.hash', () => this.artifacts.prepare(workspace, projectPath, artifact));
      if (!prepared.ok) return { workflow, status: 'failed', plan, steps };
      steps.push({ id: 'artifact.manifest', status: 'succeeded', durationMs: 0, result: prepared.value });
      return {
        workflow,
        status: 'succeeded',
        plan,
        steps,
        outputs: { manifest: prepared.value }
      };
    }

    if (workflow === 'firmware.artifact_accept') {
      const artifact = overrides.artifact ?? state.profile.firmware?.artifact;
      const expectedSha256 = overrides.expectedSha256?.trim().toLowerCase();
      if (!artifact || !expectedSha256) {
        throw new Error('firmware.artifact_accept requires parameters.artifact and parameters.expectedSha256.');
      }
      const integrity = plan.artifactIntegrity;
      if (!integrity) throw new Error('firmware.artifact_accept plan did not produce integrity preflight data.');
      steps.push({
        id: 'artifact.preflight',
        status: integrity.ready ? 'succeeded' : 'blocked',
        durationMs: 0,
        result: integrity,
        ...(!integrity.ready ? { error: integrity.blockers.join(' ') } : {})
      });
      if (!integrity.ready) {
        return { workflow, status: 'blocked', plan, steps, outputs: { integrity } };
      }
      const accepted = await capture('artifact.atomic_accept', () => this.artifacts.accept({
        workspace,
        projectPath,
        artifact,
        expectedSha256,
        expectedSize: overrides.expectedSize
      }));
      if (!accepted.ok) return { workflow, status: 'failed', plan, steps };
      return {
        workflow,
        status: 'succeeded',
        plan,
        steps,
        outputs: { integrity, accepted: accepted.value }
      };
    }

    if (workflow === 'stm32.deploy_accept_diagnose') {
      const deployment = await this.run(workspace, projectPath, 'stm32.deploy_accept', {
        ...overrides,
        keepMonitorOpen: false
      });
      for (const step of deployment.steps) {
        steps.push({ ...step, id: `deploy.${step.id}` });
      }

      if (deployment.status === 'succeeded') {
        return {
          workflow,
          status: 'succeeded',
          plan,
          steps,
          outputs: {
            deployment,
            diagnosticsAttempted: false,
            diagnosticsTrigger: 'not-needed'
          }
        };
      }

      const flashed = deployment.steps.some(step => step.id === 'firmware.flash_verify_reset' && step.status === 'succeeded');
      const readinessFailed = deployment.steps.some(step => step.id === 'serial.wait_for_text' && step.status === 'failed');
      if (!flashed || !readinessFailed) {
        return {
          workflow,
          status: deployment.status,
          plan,
          steps,
          outputs: {
            deployment,
            diagnosticsAttempted: false,
            diagnosticsTrigger: !flashed ? 'deployment-not-confirmed' : 'readiness-did-not-fail'
          }
        };
      }

      const diagnostics = await this.run(workspace, projectPath, 'stm32.deep_diagnostics', {
        ...overrides,
        keepMonitorOpen: false
      });
      for (const step of diagnostics.steps) {
        steps.push({ ...step, id: `diagnostics.${step.id}` });
      }
      return {
        workflow,
        status: 'failed',
        plan,
        steps,
        outputs: {
          deployment,
          diagnostics,
          diagnosticsAttempted: true,
          diagnosticsTrigger: 'post-flash-readiness-failure',
          diagnosticEvidenceQuality: diagnostics.outputs && typeof diagnostics.outputs === 'object' && 'evidenceQuality' in diagnostics.outputs
            ? diagnostics.outputs.evidenceQuality
            : undefined
        }
      };
    }

    if (workflow === 'stm32.deploy_accept') {
      const fw = this.effectiveFirmware(state.profile.firmware, overrides).config;
      const basePortResolution = await this.resolveSerialPort(overrides.port, fw.portSelector, fw.port);
      const monitorPortResolution = await this.resolveSerialPort(
        overrides.monitorPort,
        fw.monitor?.selector,
        fw.monitor?.port,
        basePortResolution.port
      );
      const monitorPort = monitorPortResolution.port;
      const expectedText = overrides.expectText ?? fw.monitor?.expectText;
      if (!monitorPort || !expectedText) {
        throw new Error('stm32.deploy_accept requires a configured serial monitor port and readiness marker.');
      }

      const preflight = plan.preflight;
      if (!preflight) throw new Error('stm32.deploy_accept plan did not produce deployment preflight data.');
      steps.push({
        id: 'preflight.stm32_deploy',
        status: preflight.ready ? 'succeeded' : 'blocked',
        durationMs: 0,
        result: preflight,
        ...(!preflight.ready ? { error: preflight.blockers.join(' ') } : {})
      });
      if (!preflight.ready) {
        return {
          workflow,
          status: 'blocked',
          plan,
          steps,
          outputs: { preflight }
        };
      }
      const build = await capture('firmware.build', () => this.firmware.build(
        workspace,
        projectPath,
        fw.buildProvider ?? 'auto',
        fw.buildDir ?? 'build',
        fw.keilProject,
        fw.keilTarget
      ));
      if (!build.ok) return { workflow, status: 'failed', plan, steps };
      if (!successfulBuild(build.value.provider, build.value.result)) {
        steps[steps.length - 1] = {
          ...steps[steps.length - 1]!,
          status: 'failed',
          error: `Build exited with code ${build.value.result.exitCode ?? 'null'}${build.value.result.timedOut ? ' after timeout' : ''}.`
        };
        return { workflow, status: 'failed', plan, steps };
      }

      const artifact = await this.resolveVerifyArtifact(workspace, projectPath, overrides.artifact ?? fw.artifact);
      const monitor = await capture('serial.open', () => this.serial.open(
        monitorPort,
        overrides.monitorBaudRate ?? fw.monitor?.baudRate ?? 115200
      ));
      if (!monitor.ok) return { workflow, status: 'failed', plan, steps };

      let deployment: Awaited<ReturnType<FirmwareAdapter['deployVerifyReset']>> | undefined;
      let expectation: Awaited<ReturnType<SerialSessionManager['waitForText']>> | undefined;
      let finalSession = monitor.value;
      let failed = false;
      try {
        const deployed = await capture('firmware.flash_verify_reset', () => this.firmware.deployVerifyReset({
          workspace,
          projectPath,
          artifact,
          probeSerial: overrides.probeSerial ?? fw.probeSerial,
          targetConfig: overrides.targetConfig ?? fw.targetConfig,
          adapterSpeedKhz: overrides.adapterSpeedKhz ?? fw.adapterSpeedKhz
        }));
        if (!deployed.ok) {
          failed = true;
        } else if (!successfulCommand(deployed.value.result)) {
          steps[steps.length - 1] = {
            ...steps[steps.length - 1]!,
            status: 'failed',
            error: `STM32 deploy transaction exited with code ${deployed.value.result.exitCode ?? 'null'}${deployed.value.result.timedOut ? ' after timeout' : ''}.`
          };
          failed = true;
        } else {
          deployment = deployed.value;
          const waited = await capture('serial.wait_for_text', () => this.serial.waitForText(
            monitor.value.id,
            expectedText,
            overrides.expectTimeoutMs ?? fw.monitor?.expectTimeoutMs ?? 10_000,
            0
          ));
          if (!waited.ok) {
            failed = true;
          } else {
            expectation = waited.value;
            if (!waited.value.matched) {
              steps[steps.length - 1] = {
                ...steps[steps.length - 1]!,
                status: 'failed',
                error: `Serial output did not contain expected readiness marker within ${waited.value.elapsedMs} ms.`
              };
              failed = true;
            }
          }
        }
      } finally {
        if (!(overrides.keepMonitorOpen ?? false)) {
          const closed = await capture('serial.close', () => this.serial.close(monitor.value.id));
          if (closed.ok) finalSession = closed.value;
          else failed = true;
        }
      }

      return {
        workflow,
        status: failed ? 'failed' : 'succeeded',
        plan,
        steps,
        outputs: {
          preflight,
          artifact,
          deployment,
          expectation,
          serialSession: finalSession
        }
      };
    }
    if (workflow === 'stm32.peripheral_snapshot') {
      const fw = this.effectiveFirmware(state.profile.firmware, overrides).config;
      const live = await this.resolveSvdRegisterSet(workspace, projectPath, fw, overrides, true);
      const symbols = await this.resolveDebugSymbols(workspace, projectPath, overrides.artifact ?? fw.artifact);
      const probeSerial = overrides.probeSerial ?? fw.probeSerial;
      if (!probeSerial) {
        throw new Error('STM32 peripheral snapshot requires firmware.probeSerial or a probeSerial override.');
      }

      const started = await capture('debug.session.start', () => this.debug.start({
        workspace,
        projectPath,
        symbols,
        probeSerial,
        targetConfig: overrides.targetConfig ?? fw.targetConfig,
        adapterSpeedKhz: overrides.adapterSpeedKhz ?? fw.adapterSpeedKhz,
        rtosAwareness: 'none'
      }));
      if (!started.ok) return { workflow, status: 'failed', plan, steps };

      let snapshots: unknown;
      let failed = false;
      try {
        const halted = await capture('debug.halt', () => this.debug.halt(started.value.id));
        if (!halted.ok) failed = true;
        if (!failed) {
          const read = await capture('debug.svd_registers', () => this.readResolvedSvdRegisters(started.value.id, live!.resolved));
          if (read.ok) snapshots = read.value;
          else failed = true;
        }
      } finally {
        const stopped = await capture('debug.session.stop', () => this.debug.stop(started.value.id));
        if (!stopped.ok) failed = true;
      }

      return {
        workflow,
        status: failed ? 'failed' : 'succeeded',
        plan,
        steps,
        outputs: { symbols, svdFile: live!.svdFile, peripheralRegisters: snapshots }
      };
    }
    if (workflow === 'stm32.deep_diagnostics') {
      const fw = this.effectiveFirmware(state.profile.firmware, overrides).config;
      const live = await this.resolveSvdRegisterSet(workspace, projectPath, fw, overrides, false);
      const symbols = await this.resolveDebugSymbols(workspace, projectPath, overrides.artifact ?? fw.artifact);
      const probeSerial = overrides.probeSerial ?? fw.probeSerial;
      if (!probeSerial) {
        throw new Error('STM32 deep diagnostics requires firmware.probeSerial or a probeSerial override.');
      }

      const started = await capture('debug.session.start', () => this.debug.start({
        workspace,
        projectPath,
        symbols,
        probeSerial,
        targetConfig: overrides.targetConfig ?? fw.targetConfig,
        adapterSpeedKhz: overrides.adapterSpeedKhz ?? fw.adapterSpeedKhz,
        rtosAwareness: 'auto'
      }));
      if (!started.ok) return { workflow, status: 'failed', plan, steps };

      let registers: unknown;
      let fault: unknown;
      let exceptionFrame: unknown;
      let rtosTasks: unknown;
      let stack: unknown;
      let peripheralRegisters: unknown;
      let disassembly: unknown;
      let failed = false;
      try {
        const halted = await capture('debug.halt', () => this.debug.halt(started.value.id));
        if (!halted.ok) failed = true;
        if (!failed) {
          const registerResult = await capture('debug.registers', () => this.debug.registers(started.value.id));
          if (registerResult.ok) registers = registerResult.value;
          else failed = true;
        }
        if (!failed) {
          const snapshot = await capture('debug.fault_snapshot', () => this.debug.faultSnapshot(started.value.id));
          if (snapshot.ok) fault = snapshot.value;
          else failed = true;
        }
        if (!failed) {
          exceptionFrame = await captureOptional('debug.exception_frame', () => this.debug.exceptionFrame(started.value.id));
          rtosTasks = await captureOptional('debug.rtos_tasks', () => this.debug.rtosTasks(started.value.id, 128));
          const stackResult = await capture('debug.stack', () => this.debug.stack(started.value.id, overrides.debugMaxFrames ?? 24));
          if (stackResult.ok) stack = stackResult.value;
          else failed = true;
        }
        if (!failed && live) {
          peripheralRegisters = await captureOptional('debug.svd_registers', () => this.readResolvedSvdRegisters(started.value.id, live.resolved));
        }
        if (!failed) {
          disassembly = await captureOptional('debug.disassemble', () => this.debug.disassemble(started.value.id, { beforeBytes: 32, afterBytes: 96, maxInstructions: 96 }));
        }
      } finally {
        const stopped = await capture('debug.session.stop', () => this.debug.stop(started.value.id));
        if (!stopped.ok) failed = true;
      }

      const degradedEvidence = steps.filter(step => step.status === 'blocked').map(step => ({ id: step.id, reason: step.error }));
      return {
        workflow,
        status: failed ? 'failed' : 'succeeded',
        plan,
        steps,
        outputs: {
          symbols,
          registers,
          fault,
          exceptionFrame,
          rtosTasks,
          stack,
          ...(live ? { svdFile: live.svdFile, peripheralRegisters } : {}),
          disassembly,
          evidenceQuality: degradedEvidence.length === 0 ? 'complete' : 'degraded',
          degradedEvidence
        }
      };
    }

    if (workflow === 'stm32.debug_fault_snapshot') {
      const fw = this.effectiveFirmware(state.profile.firmware, overrides).config;
      const symbols = await this.resolveDebugSymbols(workspace, projectPath, overrides.artifact ?? fw.artifact);
      const probeSerial = overrides.probeSerial ?? fw.probeSerial;
      if (!probeSerial) {
        throw new Error('STM32 debug fault workflow requires firmware.probeSerial or a probeSerial override.');
      }

      const started = await capture('debug.session.start', () => this.debug.start({
        workspace,
        projectPath,
        symbols,
        probeSerial,
        targetConfig: overrides.targetConfig ?? fw.targetConfig,
        adapterSpeedKhz: overrides.adapterSpeedKhz ?? fw.adapterSpeedKhz
      }));
      if (!started.ok) return { workflow, status: 'failed', plan, steps };

      let fault: unknown;
      let stack: unknown;
      let failed = false;
      try {
        const halted = await capture('debug.halt', () => this.debug.halt(started.value.id));
        if (!halted.ok) failed = true;
        if (!failed) {
          const snapshot = await capture('debug.fault_snapshot', () => this.debug.faultSnapshot(started.value.id));
          if (snapshot.ok) fault = snapshot.value;
          else failed = true;
        }
        if (!failed) {
          const stackResult = await capture('debug.stack', () => this.debug.stack(started.value.id, overrides.debugMaxFrames ?? 16));
          if (stackResult.ok) stack = stackResult.value;
          else failed = true;
        }
      } finally {
        const stopped = await capture('debug.session.stop', () => this.debug.stop(started.value.id));
        if (!stopped.ok) failed = true;
      }

      return { workflow, status: failed ? 'failed' : 'succeeded', plan, steps, outputs: { symbols, fault, stack } };
    }

    if (workflow.startsWith('firmware.')) {
      const fw = this.effectiveFirmware(state.profile.firmware, overrides).config;
      const effectiveFlashProvider = fw.flashProvider ?? (state.project.family === 'esp32' ? 'esp-idf' : 'auto');
      const needsMonitorPort = workflow === 'firmware.build_flash_monitor' || workflow === 'firmware.build_flash_monitor_expect';
      const build = await capture('firmware.build', () => this.firmware.build(
        workspace,
        projectPath,
        fw.buildProvider ?? 'auto',
        fw.buildDir ?? 'build',
        fw.keilProject,
        fw.keilTarget
      ));
      if (!build.ok) return { workflow, status: 'failed', plan, steps };
      if (!successfulBuild(build.value.provider, build.value.result)) {
        steps[steps.length - 1] = {
          ...steps[steps.length - 1]!,
          status: 'failed',
          error: `Build exited with code ${build.value.result.exitCode ?? 'null'}${build.value.result.timedOut ? ' after timeout' : ''}.`
        };
        return { workflow, status: 'failed', plan, steps };
      }
      if (workflow === 'firmware.build') return { workflow, status: 'succeeded', plan, steps };

      const portResolution = (effectiveFlashProvider === 'esp-idf' || needsMonitorPort)
        ? await this.resolveSerialPort(overrides.port, fw.portSelector, fw.port)
        : { source: 'unconfigured' as const };
      const monitorPortResolution = needsMonitorPort
        ? await this.resolveSerialPort(
            overrides.monitorPort,
            fw.monitor?.selector,
            fw.monitor?.port,
            portResolution.port
          )
        : { source: 'unconfigured' as const };

      const flash = await capture('firmware.flash', () => this.firmware.flash({
        workspace,
        projectPath,
        artifact: overrides.artifact ?? fw.artifact,
        provider: fw.flashProvider ?? 'auto',
        port: portResolution.port,
        probeSerial: overrides.probeSerial ?? fw.probeSerial,
        targetConfig: overrides.targetConfig ?? fw.targetConfig,
        adapterSpeedKhz: overrides.adapterSpeedKhz ?? fw.adapterSpeedKhz
      }));
      if (!flash.ok) return { workflow, status: 'failed', plan, steps };
      if (!successfulCommand(flash.value.result)) {
        steps[steps.length - 1] = {
          ...steps[steps.length - 1]!,
          status: 'failed',
          error: `Flash exited with code ${flash.value.result.exitCode ?? 'null'}${flash.value.result.timedOut ? ' after timeout' : ''}.`
        };
        return { workflow, status: 'failed', plan, steps };
      }

      if (workflow === 'firmware.build_flash') {
        return { workflow, status: 'succeeded', plan, steps };
      }

      if (workflow === 'firmware.build_flash_verify') {
        const artifact = await this.resolveVerifyArtifact(workspace, projectPath, overrides.artifact ?? fw.artifact);
        const verify = await capture('firmware.verify', () => this.firmware.verify({
          workspace,
          projectPath,
          artifact,
          probeSerial: overrides.probeSerial ?? fw.probeSerial,
          targetConfig: overrides.targetConfig ?? fw.targetConfig,
          adapterSpeedKhz: overrides.adapterSpeedKhz ?? fw.adapterSpeedKhz
        }));
        if (!verify.ok) return { workflow, status: 'failed', plan, steps };
        return {
          workflow,
          status: successfulCommand(verify.value.result) ? 'succeeded' : 'failed',
          plan,
          steps,
          outputs: { artifact, verify: verify.value }
        };
      }

      const monitorPort = monitorPortResolution.port;
      if (!monitorPort) throw new Error('Serial monitor port was not resolved from selector, legacy profile port, or explicit override.');
      const monitor = await capture('serial.open', () => this.serial.open(
        monitorPort,
        overrides.monitorBaudRate ?? fw.monitor?.baudRate ?? 115200
      ));
      if (!monitor.ok) return { workflow, status: 'failed', plan, steps };

      if (workflow === 'firmware.build_flash_monitor') {
        return {
          workflow,
          status: 'succeeded',
          plan,
          steps,
          outputs: { serialSession: monitor.value }
        };
      }

      const expectedText = overrides.expectText ?? fw.monitor?.expectText;
      if (!expectedText) throw new Error('Serial readiness marker was not resolved.');
      const expectation = await capture('serial.wait_for_text', () => this.serial.waitForText(
        monitor.value.id,
        expectedText,
        overrides.expectTimeoutMs ?? fw.monitor?.expectTimeoutMs ?? 10_000,
        0
      ));
      if (!expectation.ok) {
        return {
          workflow,
          status: 'failed',
          plan,
          steps,
          outputs: { serialSession: monitor.value }
        };
      }
      if (!expectation.value.matched) {
        steps[steps.length - 1] = {
          ...steps[steps.length - 1]!,
          status: 'failed',
          error: `Serial output did not contain expected readiness marker within ${expectation.value.elapsedMs} ms.`
        };
      }
      return {
        workflow,
        status: expectation.value.matched ? 'succeeded' : 'failed',
        plan,
        steps,
        outputs: {
          serialSession: monitor.value,
          expectation: expectation.value
        }
      };
    }

    const ros = state.profile.ros2 ?? {};
    const cwd = projectChild(projectPath, ros.cwd ?? '.');
    const workspaceSetup = ros.workspaceSetup ? projectChild(projectPath, ros.workspaceSetup) : undefined;
    const runtime: Ros2RuntimeContext | undefined = (ros.distro || workspaceSetup || ros.domainId !== undefined)
      ? { distro: ros.distro, workspaceSetup, domainId: ros.domainId }
      : undefined;
    const rosBuild = ros.build ?? {};

    if (workflow === 'ros2.build' || workflow === 'ros2.build_health') {
      const build = await capture('ros2.colcon.build', () => this.ros2.build(workspace, cwd, runtime, {
        symlinkInstall: overrides.rosSymlinkInstall ?? rosBuild.symlinkInstall ?? true,
        mergeInstall: overrides.rosMergeInstall ?? rosBuild.mergeInstall ?? false,
        packagesSelect: overrides.rosPackagesSelect ?? rosBuild.packagesSelect ?? []
      }));
      if (!build.ok) return { workflow, status: 'failed', plan, steps };
      if (workflow === 'ros2.build') {
        return {
          workflow,
          status: 'succeeded',
          plan,
          steps,
          outputs: { build: build.value }
        };
      }
    }

    if (workflow === 'ros2.doctor') {
      const doctor = await capture('ros2.doctor', () => this.ros2.doctor(workspace, cwd, runtime));
      return {
        workflow,
        status: doctor.ok ? 'succeeded' : 'failed',
        plan,
        steps,
        ...(doctor.ok ? { outputs: { doctor: doctor.value } } : {})
      };
    }

    if (workflow === 'ros2.test') {
      const testResult = await capture('ros2.test', () => this.ros2.test(workspace, cwd, runtime, {
        packagesSelect: overrides.rosPackagesSelect ?? rosBuild.packagesSelect ?? []
      }));
      return {
        workflow,
        status: testResult.ok ? 'succeeded' : 'failed',
        plan,
        steps,
        ...(testResult.ok ? { outputs: { test: testResult.value } } : {})
      };
    }

    if (workflow === 'ros2.bag_info') {
      const bag = await capture('ros2.bag_info', () => this.ros2.bagInfo(workspace, overrides.rosBagPath!, cwd, runtime));
      return {
        workflow,
        status: bag.ok ? 'succeeded' : 'failed',
        plan,
        steps,
        ...(bag.ok ? { outputs: { bag: bag.value } } : {})
      };
    }

    const health = workflow === 'ros2.diagnostics'
      ? await capture('ros2.diagnostics', () => this.ros2.diagnostics(workspace, cwd, runtime))
      : await capture('ros2.health', () => this.ros2.health(workspace, cwd, runtime));
    return {
      workflow,
      status: health.ok ? 'succeeded' : 'failed',
      plan,
      steps,
      ...(health.ok ? { outputs: workflow === 'ros2.diagnostics' ? { diagnostics: health.value } : { health: health.value } } : {})
    };
  }
}

export interface EngineeringWorkflowRunResult {
  workflow: EngineeringWorkflowId;
  status: 'succeeded' | 'failed' | 'blocked';
  plan: Awaited<ReturnType<EngineeringWorkflowEngine['plan']>>;
  steps: StepResult[];
  outputs?: Record<string, unknown>;
}
