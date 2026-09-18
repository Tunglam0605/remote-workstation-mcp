import path from 'node:path';
import type { FirmwareProjectInfo } from '../../engineering/types.js';
import { PolicyEngine } from '../../policy.js';
import { DebugSessionManager } from './debug-session.js';
import { FirmwareAdapter } from './firmware.js';
import { stm32OpenOcdTargetConfig } from './project-inspector.js';
import { HardwareDiscoveryAdapter } from './hardware-discovery.js';
import {
  EngineeringProjectProfileStore,
  type EngineeringFirmwareProfile,
  type EngineeringProjectKind,
  type EngineeringProjectProfile,
  type EngineeringRos2Profile
} from './project-profile.js';
import { Ros2Adapter, type Ros2RuntimeContext } from './ros2.js';
import { SerialSessionManager } from './serial-session.js';

export type EngineeringWorkflowId =
  | 'firmware.build'
  | 'firmware.build_flash'
  | 'firmware.build_flash_verify'
  | 'firmware.build_flash_monitor'
  | 'firmware.build_flash_monitor_expect'
  | 'stm32.debug_fault_snapshot'
  | 'stm32.deploy_accept'
  | 'ros2.build'
  | 'ros2.health'
  | 'ros2.build_health';

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
  debugMaxFrames?: number;
  variant?: string;
  keilProject?: string;
  keilTarget?: string;
  keepMonitorOpen?: boolean;
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

function projectChild(projectPath: string, child = '.'): string {
  if (path.isAbsolute(child)) throw new Error('Profile paths must remain relative to the selected project root.');
  const parts = child.split(/[\\/]+/);
  if (parts.includes('..')) throw new Error('Profile paths must not escape the selected project root.');
  return path.normalize(path.join(projectPath, child));
}

function detectKind(project: FirmwareProjectInfo): EngineeringProjectKind {
  const embedded = project.family === 'stm32' ? 'stm32' : project.family === 'esp32' ? 'esp-idf' : undefined;
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
    private readonly firmware: FirmwareAdapter,
    private readonly hardware: HardwareDiscoveryAdapter,
    private readonly serial: SerialSessionManager,
    private readonly debug: DebugSessionManager,
    private readonly ros2: Ros2Adapter
  ) {}

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
    } else if (project.family === 'esp32') {
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
    const ids: EngineeringWorkflowId[] = [];
    const firmwareCapable = state.project.family !== 'unknown' || Boolean(state.profile.firmware);
    if (firmwareCapable) {
      ids.push('firmware.build', 'firmware.build_flash', 'firmware.build_flash_monitor');
      if (state.project.family === 'stm32' || state.profile.kind === 'stm32') {
        ids.push('firmware.build_flash_verify', 'stm32.debug_fault_snapshot', 'stm32.deploy_accept');
      }
      if (
        state.project.family === 'esp32' ||
        state.profile.kind === 'esp-idf' ||
        Boolean(state.profile.firmware?.monitor?.expectText)
      ) {
        ids.push('firmware.build_flash_monitor_expect');
      }
    }
    if (state.project.ros2 || state.profile.ros2) {
      ids.push('ros2.build', 'ros2.health', 'ros2.build_health');
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
        destructive: id.startsWith('firmware.build_flash') || id === 'stm32.debug_fault_snapshot' || id === 'stm32.deploy_accept',
        description: {
          'firmware.build': 'Build the firmware project using the profile/default typed provider.',
          'firmware.build_flash': 'Build and flash the selected target using a hardware lease.',
          'firmware.build_flash_verify': 'Build, flash and independently verify the STM32 artifact through constrained OpenOCD.',
          'firmware.build_flash_monitor': 'Build, flash, then open the configured serial monitor session.',
          'firmware.build_flash_monitor_expect': 'Build, flash, open serial and wait for a configured boot/readiness marker.',
          'stm32.debug_fault_snapshot': 'Open a constrained STM32 debug session, halt the target, decode Cortex-M fault state, capture stack frames, then release the probe.',
          'stm32.deploy_accept': 'Preflight hardware, build, open serial, atomically flash/verify/reset through one ST-Link lease, then require a readiness marker and release resources.',
          'ros2.build': 'Build the ROS 2 workspace through typed colcon options and profile-managed distro bootstrap.',
          'ros2.health': 'Bootstrap the configured ROS 2 environment once and collect node/topic/service/action health.',
          'ros2.build_health': 'Build the ROS 2 workspace, then inspect the configured runtime graph health.'
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
    const state = await this.state(workspace, projectPath);
    if (!this.workflowIds(state).includes(workflow)) throw new Error(`Workflow '${workflow}' is not available for this project.`);

    const effective = this.effectiveFirmware(state.profile.firmware, overrides);
    const fw = effective.config;
    const flashProvider = fw.flashProvider ?? (state.project.family === 'esp32' ? 'esp-idf' : 'auto');
    const port = overrides.port ?? fw.port;
    const monitorPort = overrides.monitorPort ?? fw.monitor?.port ?? port;
    const expectedText = overrides.expectText ?? fw.monitor?.expectText;
    const ros = state.profile.ros2;
    const rosBuild = ros?.build ?? {};
    const rosSymlinkInstall = overrides.rosSymlinkInstall ?? rosBuild.symlinkInstall ?? true;
    const rosMergeInstall = overrides.rosMergeInstall ?? rosBuild.mergeInstall ?? false;
    if (workflow.startsWith('ros2.') && rosSymlinkInstall && rosMergeInstall) {
      throw new Error('ROS 2 build cannot combine symlinkInstall=true with mergeInstall=true.');
    }

    if (workflow.startsWith('firmware.build_flash') && flashProvider === 'esp-idf' && !port) {
      throw new Error('ESP-IDF flash workflow requires firmware.port in .rwmcp/project.yaml or an explicit port override.');
    }
    if (
      (workflow === 'firmware.build_flash_monitor' || workflow === 'firmware.build_flash_monitor_expect') &&
      !monitorPort
    ) {
      throw new Error('Serial monitor workflow requires firmware.monitor.port, firmware.port, or monitorPort override.');
    }
    if (workflow === 'firmware.build_flash_monitor_expect' && !expectedText) {
      throw new Error('Monitor-expect workflow requires firmware.monitor.expectText or an expectText override.');
    }
    if (workflow === 'stm32.deploy_accept') {
      if (flashProvider === 'esp-idf') throw new Error('stm32.deploy_accept requires the constrained OpenOCD flash provider.');
      if (!monitorPort) throw new Error('stm32.deploy_accept requires firmware.monitor.port, firmware.port, or parameters.monitorPort.');
      if (!expectedText) throw new Error('stm32.deploy_accept requires firmware.monitor.expectText or parameters.expectText.');
    }

    const deploymentPreflight = workflow === 'stm32.deploy_accept'
      ? await this.firmware.stm32DeploymentPreflight({
          probeSerial: overrides.probeSerial ?? fw.probeSerial,
          monitorPort
        })
      : undefined;

    const steps: string[] = [];
    if (workflow === 'stm32.debug_fault_snapshot') {
      steps.push('debug.session.start', 'debug.halt', 'debug.fault_snapshot', 'debug.stack', 'debug.session.stop');
    }
    if (workflow === 'stm32.deploy_accept') {
      steps.push('preflight.stm32_deploy', 'firmware.build', 'serial.open', 'firmware.flash_verify_reset', 'serial.wait_for_text');
      if (!overrides.keepMonitorOpen) steps.push('serial.close');
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
    if (workflow === 'ros2.health' || workflow === 'ros2.build_health') {
      steps.push('ros2.environment.bootstrap', 'ros2.node.list', 'ros2.topic.list', 'ros2.service.list', 'ros2.action.list');
    }

    return {
      workflow,
      profileFound: state.profileFound,
      manifestPath: state.manifestPath,
      project: state.project,
      profile: state.profile,
      steps,
      ...(deploymentPreflight ? { preflight: deploymentPreflight } : {}),
      resolved: {
        firmware: (workflow.startsWith('firmware.') || workflow === 'stm32.debug_fault_snapshot' || workflow === 'stm32.deploy_accept') ? {
          variant: effective.variant,
          buildProvider: fw.buildProvider ?? 'auto',
          buildDir: fw.buildDir ?? 'build',
          keilProject: fw.keilProject,
          keilTarget: fw.keilTarget,
          flashProvider,
          artifact: overrides.artifact ?? fw.artifact,
          port,
          probeSerial: overrides.probeSerial ?? fw.probeSerial,
          targetConfig: overrides.targetConfig ?? fw.targetConfig,
          adapterSpeedKhz: overrides.adapterSpeedKhz ?? fw.adapterSpeedKhz,
          monitorPort,
          monitorBaudRate: overrides.monitorBaudRate ?? fw.monitor?.baudRate ?? 115200,
          expectText: expectedText,
          expectTimeoutMs: overrides.expectTimeoutMs ?? fw.monitor?.expectTimeoutMs ?? 10_000,
          debugMaxFrames: overrides.debugMaxFrames ?? 16,
          keepMonitorOpen: overrides.keepMonitorOpen ?? false
        } : undefined,
        ros2: workflow.startsWith('ros2.') ? {
          ...ros,
          build: {
            symlinkInstall: overrides.rosSymlinkInstall ?? rosBuild.symlinkInstall ?? true,
            mergeInstall: overrides.rosMergeInstall ?? rosBuild.mergeInstall ?? false,
            packagesSelect: overrides.rosPackagesSelect ?? rosBuild.packagesSelect ?? []
          }
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
  ) {
    this.policy.assertEngineeringExecute();
    const plan = await this.plan(workspace, projectPath, workflow, overrides);
    const state = await this.state(workspace, projectPath);
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

    if (workflow === 'stm32.deploy_accept') {
      const fw = this.effectiveFirmware(state.profile.firmware, overrides).config;
      const monitorPort = overrides.monitorPort ?? fw.monitor?.port ?? overrides.port ?? fw.port;
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

      const flash = await capture('firmware.flash', () => this.firmware.flash({
        workspace,
        projectPath,
        artifact: overrides.artifact ?? fw.artifact,
        provider: fw.flashProvider ?? 'auto',
        port: overrides.port ?? fw.port,
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

      const monitorPort = overrides.monitorPort ?? fw.monitor?.port ?? overrides.port ?? fw.port;
      if (!monitorPort) throw new Error('Serial monitor port was not resolved.');
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

    const health = await capture('ros2.health', () => this.ros2.health(workspace, cwd, runtime));
    return {
      workflow,
      status: health.ok ? 'succeeded' : 'failed',
      plan,
      steps,
      ...(health.ok ? { outputs: { health: health.value } } : {})
    };
  }
}
