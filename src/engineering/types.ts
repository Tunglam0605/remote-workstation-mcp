export type EngineeringResourceMode = 'reading' | 'monitoring' | 'building' | 'flashing' | 'debugging' | 'resetting';

export interface EngineeringResourceLease {
  id: string;
  resourceId: string;
  mode: EngineeringResourceMode;
  ownerId: string;
  acquiredAt: string;
}

export type HardwareKind = 'serial' | 'debug-probe' | 'usb' | 'unknown';

export interface HardwareDevice {
  id: string;
  kind: HardwareKind;
  name: string;
  path?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  manufacturer?: string;
  provider: string;
  capabilities: string[];
}

export interface SerialDeviceSelector {
  deviceId?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  manufacturer?: string;
  nameContains?: string;
}

export interface SerialDeviceResolution {
  selector: SerialDeviceSelector;
  device: HardwareDevice;
  path: string;
}

export type FirmwareFamily = 'stm32' | 'esp32' | 'generic-embedded' | 'unknown';
export type FirmwareFramework = 'esp-idf' | 'stm32-cube' | 'keil-mdk' | 'cmake' | 'make' | 'unknown';

export interface FirmwareProjectTarget {
  id: string;
  projectFile: string;
  targetName: string;
  device?: string;
  outputDirectory?: string;
  outputName?: string;
  expectedArtifact?: string;
  createHexFile?: boolean;
}

export interface FirmwareProjectInfo {
  workspace: string;
  projectPath: string;
  family: FirmwareFamily;
  framework: FirmwareFramework;
  target?: string;
  board?: string;
  buildSystem?: string;
  targets?: FirmwareProjectTarget[];
  markers: string[];
  ros2: boolean;
  docker: boolean;
}

export interface FirmwareArtifact {
  path: string;
  kind: 'elf' | 'axf' | 'hex' | 'bin' | 'map';
  size: number;
  mtime: string;
}

export interface EngineeringCommandResult {
  program: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export type OpenOcdDiagnosticCode =
  | 'ok'
  | 'provider-unavailable'
  | 'backend-timeout'
  | 'probe-not-found'
  | 'probe-busy'
  | 'probe-permission-denied'
  | 'target-power-invalid'
  | 'target-connect-failed'
  | 'verify-failed'
  | 'target-config-not-found'
  | 'backend-failed';

export interface OpenOcdDiagnostic {
  code: OpenOcdDiagnosticCode;
  ok: boolean;
  retryable: boolean;
  message: string;
  hint?: string;
}

export interface FirmwareProviderStatus {
  provider: 'openocd' | 'keil';
  available: boolean;
  executable?: string;
  executableSource?: 'owner-override' | 'path' | 'known-install';
  scriptSearchPath?: string;
  version?: string;
  licenseStatus?: 'ok' | 'error' | 'unknown';
  licenseMessage?: string;
  diagnostic?: OpenOcdDiagnostic;
  capabilities: string[];
  intentionallyUnavailable: string[];
}

export interface KeilStructuredDiagnostic {
  file?: string;
  line?: number;
  column?: number;
  severity: 'fatal' | 'error' | 'warning' | 'note';
  code?: string;
  message: string;
}

export interface KeilBuildSummary {
  target: {
    projectFile: string;
    targetName: string;
    device?: string;
    outputDirectory?: string;
    outputName?: string;
    expectedArtifact?: string;
    createHexFile?: boolean;
  };
  toolchain: {
    family: 'armclang' | 'armcc' | 'unknown';
    version?: string;
  };
  provider: {
    executable: string;
    executableSource: 'owner-override' | 'path' | 'known-install';
  };
  license: {
    status: 'ok' | 'error' | 'unknown';
    message?: string;
  };
  counts: {
    errors: number;
    warnings: number;
    notes: number;
  };
  diagnostics: KeilStructuredDiagnostic[];
  diagnosticsTruncated: boolean;
  artifact: {
    expectedPath?: string;
    expectedHexPath?: string;
    exists: boolean;
    size?: number;
    mtime?: string;
  };
}

export interface FirmwareFlashPlan {
  provider: 'openocd' | 'esp-idf';
  family: FirmwareFamily;
  target?: string;
  artifact?: string;
  port?: string;
  probeSerial?: string;
  adapterSpeedKhz?: number;
  targetConfig?: string;
  program: string;
  scriptSearchPath?: string;
  args: string[];
  resourceId: string;
  destructive: true;
  notes: string[];
}

export interface DebugSessionSnapshot {
  id: string;
  workspace: string;
  resourceId: string;
  probeSerial?: string;
  symbols: string;
  targetConfig: string;
  gdbPort: number;
  status: 'starting' | 'connected' | 'stopped' | 'failed';
  startedAt: string;
  error?: string;
}

export interface SerialSessionSnapshot {
  id: string;
  resourceId: string;
  port: string;
  baudRate: number;
  status: 'open' | 'closed' | 'failed';
  startedAt: string;
  endedAt?: string;
  bytesRead: number;
  bufferedBytes: number;
  error?: string;
}

export interface SerialReadResult {
  session: SerialSessionSnapshot;
  text: string;
  nextCursor: number;
  truncated: boolean;
}

export interface TerminalSessionSnapshot {
  id: string;
  workspace: string;
  program: string;
  args: string[];
  cwd: string;
  pid: number;
  cols: number;
  rows: number;
  status: 'running' | 'exited' | 'stopped' | 'failed';
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
}

export interface TerminalReadResult {
  session: TerminalSessionSnapshot;
  text: string;
  nextCursor: number;
  truncated: boolean;
}
