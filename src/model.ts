export type PermissionMode = 'read_only' | 'workspace' | 'elevated' | 'full_control';

export interface PermissionLease {
  mode: 'elevated' | 'full_control';
  issuedAt: string;
  expiresAt: string;
  reason?: string;
  clientId?: string;
}

export interface WorkspaceConfig {
  id: string;
  name?: string;
  root: string;
  readOnly?: boolean;
}

export interface TaskProfileConfig {
  program: string;
  args?: string[];
  cwd?: string;
}

export interface LspServerConfig {
  program: string;
  args?: string[];
  languages: Record<string, string>;
  initializationOptions?: Record<string, unknown>;
}

export interface LspConfig {
  servers: Record<string, LspServerConfig>;
  requestTimeoutMs: number;
  maxMessageBytes: number;
  diagnosticsSettleMs: number;
}

export interface PolicyConfig {
  version: 1;
  mode: PermissionMode;
  workspaces: WorkspaceConfig[];
  filesystem: {
    maxReadBytes: number;
    maxWriteBytes: number;
  };
  search?: {
    maxResults: number;
    maxFiles: number;
    maxFileBytes: number;
  };
  process: {
    allowExecutables: string[];
    inheritEnv: string[];
    maxOutputBytes: number;
    maxRuntimeMs: number;
    maxInputBytes?: number;
  };
  tasks?: Record<string, TaskProfileConfig>;
  lsp?: LspConfig;
  fullControl?: {
    allowRawShell: boolean;
    allowHostFilesystem: boolean;
  };
  privileged?: {
    allowSudo: boolean;
    maxRuntimeMs: number;
  };
  engineering?: {
    enabled: boolean;
    maxCommandRuntimeMs: number;
    allowHardwareMutationInWorkspace: boolean;
    allowSerialWriteInWorkspace: boolean;
  };
}

export type SshAuthMode = 'agent' | 'identity_file';

export interface SshHostConfig {
  id: string;
  name?: string;
  hostname: string;
  port: number;
  user: string;
  auth: SshAuthMode;
  identityFile?: string;
  strictHostKeyChecking: 'yes' | 'accept-new';
  remoteRoot?: string;
  allowPrograms: string[];
  maxRuntimeMs: number;
}

export interface HostsConfig {
  version: 1;
  hosts: SshHostConfig[];
}

export interface ProcessSnapshot {
  id: string;
  pid?: number;
  workspace: string;
  program: string;
  args: string[];
  cwd: string;
  status: 'running' | 'exited' | 'stopped' | 'failed';
  stdout: string;
  stderr: string;
  stdinOpen: boolean;
  exitCode: number | null;
  startedAt: string;
  endedAt?: string;
}

export interface ProcessInputResult {
  id: string;
  acceptedBytes: number;
  stdinOpen: boolean;
}

export interface OutputChunk {
  text: string;
  nextCursor: number;
  truncated: boolean;
}

export interface ProcessReadSince {
  process: ProcessSnapshot;
  stdout: OutputChunk;
  stderr: OutputChunk;
}
