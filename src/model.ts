export type PermissionMode = 'read_only' | 'workspace' | 'elevated' | 'full_control';

export interface WorkspaceConfig {
  id: string;
  name?: string;
  root: string;
  readOnly?: boolean;
}

export interface PolicyConfig {
  version: 1;
  mode: PermissionMode;
  workspaces: WorkspaceConfig[];
  filesystem: {
    maxReadBytes: number;
    maxWriteBytes: number;
  };
  process: {
    allowExecutables: string[];
    inheritEnv: string[];
    maxOutputBytes: number;
    maxRuntimeMs: number;
  };
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
  exitCode: number | null;
  startedAt: string;
  endedAt?: string;
}
