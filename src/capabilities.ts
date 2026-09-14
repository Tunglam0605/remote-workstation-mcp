export const SERVER_VERSION = '0.6.0';

export type CapabilityStatus = 'available' | 'planned';

export interface CapabilityDescriptor {
  id: string;
  status: CapabilityStatus;
  tools: string[];
  note?: string;
}

export const CAPABILITIES: CapabilityDescriptor[] = [
  { id: 'system.inspect', status: 'available', tools: ['system_info', 'capabilities_list', 'tool_discover'] },
  { id: 'software.update.check', status: 'available', tools: ['update_check'], note: 'Read-only GitHub Releases check; install/update is owner-managed.' },
  { id: 'workspace.discover', status: 'available', tools: ['workspace_list'] },
  { id: 'filesystem.read', status: 'available', tools: ['fs_list', 'fs_read', 'fs_find', 'fs_search_text'] },
  { id: 'filesystem.write', status: 'available', tools: ['fs_write', 'fs_patch'], note: 'Workspace policy and optimistic SHA-256 checks apply.' },
  { id: 'git.inspect', status: 'available', tools: ['git_status', 'git_diff'] },
  { id: 'process.execute', status: 'available', tools: ['process_start', 'process_read', 'process_read_since', 'process_list', 'process_stop'], note: 'Executable allowlist in all modes; shell=false.' },
  { id: 'task.run', status: 'available', tools: ['task_list', 'task_run'], note: 'Owner-defined build/test profiles.' },
  { id: 'remote.ssh', status: 'available', tools: ['ssh_hosts', 'ssh_probe', 'ssh_exec'], note: 'Named owner-approved hosts, BatchMode auth, strict host keys and per-host program allowlists.' },
  { id: 'permission.elevation', status: 'available', tools: ['permission_status'], note: 'Grant/revoke is local-owner-only and never exposed as an MCP tool.' },
  { id: 'full_control.host_filesystem', status: 'available', tools: ['host_fs_list', 'host_fs_read', 'host_fs_write'], note: 'Requires full-control lease plus explicit local policy gate.' },
  { id: 'full_control.shell', status: 'available', tools: ['shell_exec'], note: 'Requires client-bound full-control lease plus explicit raw-shell policy gate.' },
  { id: 'full_control.admin', status: 'planned', tools: [], note: 'Root/admin control will use a separately isolated privileged helper; it is not exposed by the v0.6 MCP process.' },
  { id: 'engineering.debug', status: 'planned', tools: [] },
  { id: 'agent.orchestration', status: 'planned', tools: [] }
];
