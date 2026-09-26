export type EngineeringResourceMode = 'reading' | 'monitoring' | 'building' | 'flashing' | 'debugging' | 'resetting' | 'orchestrating';

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
export type FirmwareFramework = 'esp-idf' | 'platformio' | 'stm32-cube' | 'keil-mdk' | 'cmake' | 'make' | 'unknown';

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

export interface KicadProjectFiles {
  project?: string;
  schematic?: string;
  board?: string;
  jobsets: string[];
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
  kicad?: KicadProjectFiles;
}


export interface Stm32SvdArray {
  count: number;
  increment: number;
  indexes?: string[];
}

export interface Stm32SvdField {
  name: string;
  description?: string;
  bitOffset: number;
  bitWidth: number;
  access?: string;
  readAction?: string;
}

export interface Stm32SvdRegister {
  name: string;
  description?: string;
  addressOffset: number;
  absoluteAddress: number;
  sizeBits?: number;
  access?: string;
  readAction?: string;
  resetValue?: number;
  derivedFrom?: string;
  clusterPath?: string;
  array?: Stm32SvdArray;
  fields: Stm32SvdField[];
  fieldsTruncated: boolean;
}

export interface Stm32SvdPeripheral {
  name: string;
  description?: string;
  groupName?: string;
  baseAddress: number;
  derivedFrom?: string;
  registers: Stm32SvdRegister[];
  registersTruncated: boolean;
}

export interface Stm32SvdInspection {
  file: string;
  size: number;
  device: {
    name?: string;
    version?: string;
    description?: string;
    addressUnitBits?: number;
    width?: number;
    cpu?: {
      name?: string;
      revision?: string;
      endian?: string;
      mpuPresent?: boolean;
      fpuPresent?: boolean;
      nvicPrioBits?: number;
    };
  };
  peripherals: Stm32SvdPeripheral[];
  counts: {
    peripherals: number;
    registers: number;
    fields: number;
  };
  truncated: boolean;
  inheritance: {
    derivedFromPresent: boolean;
    resolved: boolean;
    note?: string;
  };
  warnings: string[];
}

export type Stm32SvdReadSafetyCode =
  | 'safe'
  | 'inheritance-unresolved'
  | 'register-derived'
  | 'array-selector-required'
  | 'unsupported-width'
  | 'access-not-readable'
  | 'register-read-side-effect'
  | 'field-read-side-effect'
  | 'field-metadata-truncated'
  | 'field-layout-invalid';

export interface Stm32SvdRegisterSelector {
  peripheral: string;
  register: string;
}

export interface Stm32SvdResolvedRegister {
  peripheral: string;
  register: string;
  selector: string;
  address: number;
  sizeBits: number;
  byteLength: number;
  access?: string;
  readAction?: string;
  fields: Stm32SvdField[];
  safeToRead: boolean;
  safetyCode: Stm32SvdReadSafetyCode;
  safetyReason: string;
}

export interface Stm32IocPin {
  pin: string;
  kind: 'physical' | 'virtual';
  signal?: string;
  label?: string;
  mode?: string;
  pull?: string;
  speed?: string;
  locked?: boolean;
}

export interface Stm32IocPeripheral {
  instance: string;
  parameterCount: number;
  parameters: Record<string, string>;
  parametersTruncated: boolean;
}

export interface Stm32IocInspection {
  file: string;
  size: number;
  formatVersion?: string;
  mcu: {
    name?: string;
    family?: string;
    package?: string;
    partNumber?: string;
  };
  board?: string;
  project: {
    name?: string;
    toolchain?: string;
    targetToolchain?: string;
    firmwarePackage?: string;
  };
  clocks: {
    frequenciesHz: Record<string, number>;
    frequenciesTruncated: boolean;
  };
  pins: Stm32IocPin[];
  peripherals: Stm32IocPeripheral[];
  counts: {
    declaredPins?: number;
    parsedPins: number;
    declaredPeripherals?: number;
    parsedPeripherals: number;
  };
  warnings: string[];
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
  provenance?: {
    status: 'release' | 'development' | 'dirty-development' | 'unknown';
    warning?: string;
  };
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
  rtosAwareness?: 'none' | 'auto' | 'freertos';
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
