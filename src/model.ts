export type PermissionMode = 'read_only' | 'workspace' | 'elevated' | 'full_control';

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
  };
  tasks?: Record<string, TaskProfileConfig>;
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
