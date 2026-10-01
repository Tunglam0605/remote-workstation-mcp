import type { Stm32SvdRegisterSelector } from '../../engineering/types.js';
import type {
  EngineeringFirmwareProfile,
  EngineeringPlatformioProfile,
  EngineeringProjectKind,
  EngineeringRos2Profile
} from './project-profile.js';

export const BUILTIN_ENGINEERING_WORKFLOW_IDS = [
  'platform.transfer_prepare',
  'platform.transfer_receive_offer',
  'platform.transfer_push',
  'platform.relay_read_chunk',
  'platform.relay_begin',
  'platform.relay_status',
  'platform.relay_write_chunk',
  'platform.relay_finalize',
  'platform.relay_abort',
  'firmware.build',
  'firmware.build_flash',
  'firmware.build_flash_verify',
  'firmware.build_flash_monitor',
  'firmware.build_flash_monitor_expect',
  'firmware.artifact_prepare',
  'firmware.artifact_accept',
  'firmware.artifact_receive_offer',
  'firmware.artifact_push',
  'espidf.preflight',
  'espidf.diagnostics',
  'espidf.size_analysis',
  'espidf.fullclean',
  'espidf.reconfigure',
  'platformio.diagnostics',
  'platformio.build',
  'platformio.upload',
  'stm32.debug_fault_snapshot',
  'stm32.deep_diagnostics',
  'stm32.peripheral_snapshot',
  'stm32.deploy_accept',
  'stm32.deploy_accept_diagnose',
  'ros2.build',
  'ros2.health',
  'ros2.diagnostics',
  'ros2.doctor',
  'ros2.test',
  'ros2.bag_info',
  'ros2.build_health',
  'docker.diagnostics',
  'docker.stats_snapshot',
  'docker.container_inspect',
  'docker.container_logs',
  'kicad.diagnostics',
  'kicad.validate',
  'kicad.fabrication_export',
  'systemd.service_diagnostics',
  'systemd.service_restart'
] as const;

export type EngineeringWorkflowId = typeof BUILTIN_ENGINEERING_WORKFLOW_IDS[number];

export interface EngineeringProfileInitOptions {
  id?: string;
  name?: string;
  kind?: EngineeringProjectKind;
  firmware?: Partial<EngineeringFirmwareProfile>;
  platformio?: Partial<EngineeringPlatformioProfile>;
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
  platformioEnvironment?: string;
  platformioUploadPort?: string;
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
  mediaPresetId?: string;
  mediaParameters?: Record<string, string | number | boolean>;
  mediaOutput?: string;
  mediaArtifactIndex?: number;
  mediaPollIntervalMs?: number;
  mediaCompletionTimeoutMs?: number;
  mediaOperationTimeoutMs?: number;
  mediaMaxBytes?: number;
}
