import path from 'node:path';
import type { FirmwareProjectInfo } from '../../engineering/types.js';
import { PolicyEngine } from '../../policy.js';
import { FirmwareAdapter } from './firmware.js';
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
  | 'project.inspect'
  | 'firmware.build'
  | 'firmware.build_flash'
  | 'firmware.build_flash_monitor'
  | 'ros2.health';

export interface EngineeringProfileInitOptions {
  id?: string;
  name?: string;
  kind?: EngineeringProjectKind;
  firmware?: Partial<EngineeringFirmwareProfile>;
  ros2?: Partial<EngineeringRos2Profile>;
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
}

interface ProjectState {
  project: FirmwareProjectInfo;
  profileFound: boolean;
  manifestPath: string;
  profile: EngineeringProjectProfile;
}

interface StepResult {
  id: string;
  status: 'succeeded' | 'failed';
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

export class EngineeringWorkflowEngine {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly profiles: EngineeringProjectProfileStore,
    private readonly firmware: FirmwareAdapter,
    private readonly hardware: HardwareDiscoveryAdapter,
    private readonly serial: SerialSessionManager,
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
      profile.firmware = {
        buildProvider: 'auto',
        buildDir: 'build',
        flashProvider: 'openocd'
      };
    } else if (project.family === 'esp32') {
      profile.firmware = {
        buildProvider: 'esp-idf',
        buildDir: 'build',
        flashProvider: 'esp-idf',
        monitor: { baudRate: 115200 }
      };
    } else if (project.framework === 'cmake' || project.framework === 'make') {
      profile.firmware = {
        buildProvider: project.framework === 'make' ? 'make' : 'cmake',
        buildDir: 'build',
        flashProvider: 'auto'
      };
    }

    if (project.ros2) {
      profile.ros2 = { cwd: '.' };
    }
    return profile;
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
    const base = state.profile;
    const firmware = options.firmware
      ? { ...(base.firmware ?? {}), ...options.firmware, monitor: options.firmware.monitor ? { ...(base.firmware?.monitor ?? {}), ...options.firmware.monitor } : base.firmware?.monitor }
      : base.firmware;
    const ros2 = options.ros2 ? { ...(base.ros2 ?? {}), ...options.ros2 } : base.ros2;
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
    }
    if (state.project.ros2 || state.profile.ros2) ids.push('ros2.health');
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
        destructive: id === 'firmware.build_flash' || id === 'firmware.build_flash_monitor',
        description: {
          'project.inspect': 'Inspect project markers, artifacts, configured profile and attached engineering hardware.',
          'firmware.build': 'Build the firmware project using the profile/default typed provider.',
          'firmware.build_flash': 'Build and then flash/verify the selected target using a hardware lease.',
          'firmware.build_flash_monitor': 'Build, flash/verify, then open the configured serial monitor session.',
          'ros2.health': 'Bootstrap the configured ROS 2 environment once and collect node/topic/service/action health.'
        }[id]
      }))
    };
  }

  async plan(workspace: string, projectPath: string, workflow: EngineeringWorkflowId, overrides: EngineeringWorkflowOverrides = {}) {
    const state = await this.state(workspace, projectPath);
    if (!this.workflowIds(state).includes(workflow)) throw new Error(`Workflow '${workflow}' is not available for this project.`);
    const fw = state.profile.firmware ?? {};
    const flashProvider = fw.flashProvider ?? (state.project.family === 'esp32' ? 'esp-idf' : 'auto');
    const port = overrides.port ?? fw.port;
    const monitorPort = overrides.monitorPort ?? fw.monitor?.port ?? port;
    const ros = state.profile.ros2;

    if ((workflow === 'firmware.build_flash' || workflow === 'firmware.build_flash_monitor') && flashProvider === 'esp-idf' && !port) {
      throw new Error('ESP-IDF flash workflow requires firmware.port in .rwmcp/project.yaml or an explicit port override.');
    }
    if (workflow === 'firmware.build_flash_monitor' && !monitorPort) {
      throw new Error('Serial monitor workflow requires firmware.monitor.port, firmware.port, or monitorPort override.');
    }

    const steps: string[] = [];
    if (workflow === 'project.inspect') steps.push('project.inspect', 'firmware.artifacts', 'hardware.list');
    if (workflow.startsWith('firmware.')) {
      steps.push('firmware.build');
      if (workflow !== 'firmware.build') steps.push('firmware.flash');
      if (workflow === 'firmware.build_flash_monitor') steps.push('serial.open');
    }
    if (workflow === 'ros2.health') {
      steps.push('ros2.environment.bootstrap', 'ros2.node.list', 'ros2.topic.list', 'ros2.service.list', 'ros2.action.list');
    }

    return {
      workflow,
      profileFound: state.profileFound,
      manifestPath: state.manifestPath,
      project: state.project,
      profile: state.profile,
      steps,
      resolved: {
        firmware: workflow.startsWith('firmware.') ? {
          buildProvider: fw.buildProvider ?? 'auto',
          buildDir: fw.buildDir ?? 'build',
          flashProvider,
          artifact: overrides.artifact ?? fw.artifact,
          port,
          probeSerial: overrides.probeSerial ?? fw.probeSerial,
          targetConfig: overrides.targetConfig ?? fw.targetConfig,
          adapterSpeedKhz: overrides.adapterSpeedKhz ?? fw.adapterSpeedKhz,
          monitorPort,
          monitorBaudRate: overrides.monitorBaudRate ?? fw.monitor?.baudRate ?? 115200
        } : undefined,
        ros2: workflow === 'ros2.health' ? ros : undefined
      }
    };
  }

  async run(workspace: string, projectPath: string, workflow: EngineeringWorkflowId, overrides: EngineeringWorkflowOverrides = {}) {
    this.policy.assertEngineeringExecute();
    const plan = await this.plan(workspace, projectPath, workflow, overrides);
    const state = await this.state(workspace, projectPath);
    const steps: StepResult[] = [];

    const capture = async <T>(id: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
      const started = Date.now();
      try {
        const value = await fn();
        steps.push({ id, status: 'succeeded', durationMs: Date.now() - started, result: value });
        return { ok: true, value };
      } catch (error) {
        steps.push({ id, status: 'failed', durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
        return { ok: false };
      }
    };


    if (workflow.startsWith('firmware.')) {
      const fw = state.profile.firmware ?? {};
      const build = await capture('firmware.build', () => this.firmware.build(
        workspace,
        projectPath,
        fw.buildProvider ?? 'auto',
        fw.buildDir ?? 'build'
      ));
      if (!build.ok) return { workflow, status: 'failed', plan, steps };
      if (!successfulCommand(build.value.result)) {
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
      if (workflow === 'firmware.build_flash') return { workflow, status: 'succeeded', plan, steps };

      const monitorPort = overrides.monitorPort ?? fw.monitor?.port ?? overrides.port ?? fw.port;
      if (!monitorPort) throw new Error('Serial monitor port was not resolved.');
      const monitor = await capture('serial.open', () => this.serial.open(
        monitorPort,
        overrides.monitorBaudRate ?? fw.monitor?.baudRate ?? 115200
      ));
      return {
        workflow,
        status: monitor.ok ? 'succeeded' : 'failed',
        plan,
        steps,
        ...(monitor.ok ? { outputs: { serialSession: monitor.value } } : {})
      };
    }

    const ros = state.profile.ros2 ?? {};
    const cwd = projectChild(projectPath, ros.cwd ?? '.');
    const workspaceSetup = ros.workspaceSetup ? projectChild(projectPath, ros.workspaceSetup) : undefined;
    const runtime: Ros2RuntimeContext | undefined = (ros.distro || workspaceSetup || ros.domainId !== undefined)
      ? { distro: ros.distro, workspaceSetup, domainId: ros.domainId }
      : undefined;
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
