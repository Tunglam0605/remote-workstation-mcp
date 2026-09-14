export const SERVER_VERSION = '0.3.0';

export type CapabilityStatus = 'available' | 'planned';

export interface CapabilityDescriptor {
  id: string;
  status: CapabilityStatus;
  tools: string[];
  note?: string;
}

export const CAPABILITIES: CapabilityDescriptor[] = [
  { id: 'system.inspect', status: 'available', tools: ['system_info', 'capabilities_list', 'tool_discover'] },
  { id: 'software.update.check', status: 'available', tools: ['update_check'], note: 'Read-only GitHub Releases check; install is owner-managed.' },
  { id: 'workspace.discover', status: 'available', tools: ['workspace_list'] },
  { id: 'filesystem.read', status: 'available', tools: ['fs_list', 'fs_read', 'fs_find', 'fs_search_text'] },
  { id: 'filesystem.write', status: 'available', tools: ['fs_write', 'fs_patch'], note: 'Workspace policy and optimistic SHA-256 checks apply.' },
  { id: 'git.inspect', status: 'available', tools: ['git_status', 'git_diff'] },
  { id: 'process.execute', status: 'available', tools: ['process_start', 'process_read', 'process_read_since', 'process_list', 'process_stop'], note: 'Executable allowlist; shell=false.' },
  { id: 'task.run', status: 'available', tools: ['task_list', 'task_run'], note: 'Owner-defined build/test profiles still pass executable policy.' },
  { id: 'remote.ssh', status: 'planned', tools: [] },
  { id: 'permission.elevation', status: 'planned', tools: [] },
  { id: 'engineering.debug', status: 'planned', tools: [] },
  { id: 'agent.orchestration', status: 'planned', tools: [] }
];
