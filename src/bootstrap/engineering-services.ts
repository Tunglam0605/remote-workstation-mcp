import { ArtifactIntegrityAdapter } from '../adapters/engineering/artifact-integrity.js';
import { ArtifactTransferAdapter } from '../adapters/engineering/artifact-transfer.js';
import type { EngineeringCommandRunner } from '../adapters/engineering/command-runner.js';
import { DebugSessionManager } from '../adapters/engineering/debug-session.js';
import { DockerAdapter } from '../adapters/engineering/docker.js';
import { CanAdapter } from '../adapters/engineering/can.js';
import { ModbusRtuAdapter } from '../adapters/engineering/modbus-rtu.js';
import { NetworkDiagnosticsAdapter } from '../adapters/engineering/network-diagnostics.js';
import { SystemdAdapter } from '../adapters/engineering/systemd.js';
import { Stm32IocAdapter } from '../adapters/engineering/stm32-ioc.js';
import { Stm32SvdAdapter } from '../adapters/engineering/stm32-svd.js';
import { FirmwareAdapter } from '../adapters/engineering/firmware.js';
import { HardwareDiscoveryAdapter } from '../adapters/engineering/hardware-discovery.js';
import { KicadAdapter } from '../adapters/engineering/kicad.js';
import { PlatformioAdapter } from '../adapters/engineering/platformio.js';
import { EngineeringProjectProfileStore } from '../adapters/engineering/project-profile.js';
import type { EngineeringResourceManager } from '../adapters/engineering/resource-manager.js';
import { Ros2Adapter } from '../adapters/engineering/ros2.js';
import { SerialSessionManager } from '../adapters/engineering/serial-session.js';
import { TerminalManager } from '../adapters/engineering/terminal-manager.js';
import { EngineeringWorkflowEngine } from '../adapters/engineering/workflow-engine.js';
import type { ControlPlaneRelayAdapter } from '../adapters/control-plane-relay.js';
import type { DataPlaneAdapter } from '../adapters/data-plane.js';
import type { ProcessManager } from '../adapters/process-manager.js';
import type { PolicyEngine } from '../policy.js';
import type { PathGuard } from '../security/path-guard.js';
import type { MultiNodeAuthorization } from '../security/multi-node-authorization.js';

export interface EngineeringServicesDependencies {
  policy: PolicyEngine;
  paths: PathGuard;
  currentClientId: () => string;
  processes: ProcessManager;
  dataPlane: DataPlaneAdapter;
  controlPlaneRelay: ControlPlaneRelayAdapter;
  multiNodeAuthorization: MultiNodeAuthorization;
  resources: EngineeringResourceManager;
  runner: EngineeringCommandRunner;
}

export function createEngineeringServices(deps: EngineeringServicesDependencies) {
  const {
    policy,
    paths,
    currentClientId,
    processes,
    dataPlane,
    controlPlaneRelay,
    multiNodeAuthorization,
    resources,
    runner
  } = deps;

  const hardware = new HardwareDiscoveryAdapter();
  const serial = new SerialSessionManager(policy, resources, currentClientId);
  const terminals = new TerminalManager(policy, paths, currentClientId);
  const artifacts = new ArtifactIntegrityAdapter(policy, paths);
  const artifactTransfer = new ArtifactTransferAdapter(policy, paths, artifacts);
  const firmware = new FirmwareAdapter(policy, paths, runner, resources, hardware);
  const stm32Ioc = new Stm32IocAdapter(paths);
  const stm32Svd = new Stm32SvdAdapter(paths);
  const profiles = new EngineeringProjectProfileStore(policy, paths);
  const debug = new DebugSessionManager(policy, paths, resources, currentClientId);
  const can = new CanAdapter(policy, runner);
  const modbusRtu = new ModbusRtuAdapter(policy, resources);
  const network = new NetworkDiagnosticsAdapter(policy, runner);
  const ros2 = new Ros2Adapter(policy, paths, runner, processes);
  const docker = new DockerAdapter(policy, paths, runner);
  const systemd = new SystemdAdapter(policy, paths, runner);
  const kicad = new KicadAdapter(policy, paths, runner, resources);
  const platformio = new PlatformioAdapter(policy, paths, runner, resources);
  const workflows = new EngineeringWorkflowEngine(
    policy,
    profiles,
    dataPlane,
    controlPlaneRelay,
    multiNodeAuthorization,
    artifacts,
    artifactTransfer,
    firmware,
    hardware,
    serial,
    debug,
    ros2,
    docker,
    systemd,
    kicad,
    platformio,
    stm32Svd
  );

  return {
    resources,
    runner,
    hardware,
    serial,
    terminals,
    firmware,
    stm32Ioc,
    stm32Svd,
    artifacts,
    artifactTransfer,
    profiles,
    workflows,
    debug,
    can,
    modbusRtu,
    network,
    ros2,
    docker,
    systemd,
    kicad,
    platformio
  };
}

export type EngineeringServices = ReturnType<typeof createEngineeringServices>;
