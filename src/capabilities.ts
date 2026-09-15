export const SERVER_VERSION = '0.7.7';

export type CapabilityStatus = 'available' | 'planned';

export interface CapabilityDescriptor {
  id: string;
  status: CapabilityStatus;
  tools: string[];
  note?: string;
}

export const CAPABILITIES: CapabilityDescriptor[] = [
  { id: 'chatgpt.web_control', status: 'available', tools: ['chatgpt_web_status'], note: 'First-call end-to-end verification for ChatGPT Web. Reports only non-secret host identity, authenticated principal/scopes, effective permissions, policy mode and authorized workspace names.' },
  { id: 'system.inspect', status: 'available', tools: ['system_info', 'capabilities_list', 'tool_discover'] },
  { id: 'software.update.check', status: 'available', tools: ['update_check'], note: 'Read-only GitHub Releases check; install/update remains owner-controlled.' },
  { id: 'setup.local_web', status: 'available', tools: [], note: 'Owner-operated loopback-only Setup & Control Center persists non-secret workstation settings outside the repository, can protect the OpenAI runtime key with Windows DPAPI, and can start/stop/restart the user-level runtime without exposing these controls through MCP.' },
  { id: 'installation.windows_managed', status: 'available', tools: [], note: 'Checksum-verified Windows release installer uses versioned per-user runtime slots, a stable launcher, optional start-at-logon, and one-step rollback without requiring a Git checkout for production use.' },
  { id: 'transport.providers', status: 'available', tools: [], note: 'The CLI selects a provider behind a common contract. Current providers are local stdio and loopback Streamable HTTP.' },
  { id: 'connection.openai_secure_tunnel', status: 'available', tools: [], note: 'Optional outbound-only OpenAI Secure MCP Tunnel supervisor keeps the workstation MCP bound to loopback, injects an ephemeral bearer into tunnel runtime headers, and does not forward the OpenAI runtime API key into the MCP child process.' },
  { id: 'transport.auth.http', status: 'available', tools: [], note: 'Optional loopback HTTP bearer authentication establishes a request-scoped principal and workstation read/write/execute/full-control scopes.' },
  { id: 'workspace.discover', status: 'available', tools: ['workspace_list'] },
  { id: 'filesystem.read', status: 'available', tools: ['fs_list', 'fs_read', 'fs_find', 'fs_search_text'] },
  { id: 'filesystem.write', status: 'available', tools: ['fs_write', 'fs_patch'], note: 'Workspace policy and optimistic SHA-256 checks apply.' },
  { id: 'git.inspect', status: 'available', tools: ['git_status', 'git_diff', 'git_log', 'git_branches', 'git_worktree_list'] },
  { id: 'git.manage', status: 'available', tools: ['git_add', 'git_commit', 'git_branch_create', 'git_branch_switch', 'git_worktree_add', 'git_worktree_remove'], note: 'Typed Git writes obey workspace write policy; worktrees are the preferred concurrency boundary.' },
  { id: 'code.semantic', status: 'available', tools: ['lsp_servers', 'lsp_definition', 'lsp_references', 'lsp_hover', 'lsp_document_symbols', 'lsp_diagnostics'], note: 'Owner-configured language servers run without a shell, are executable-allowlisted, principal-scoped and message-size/time bounded. Workspace-external definition/reference paths are redacted.' },
  { id: 'process.execute', status: 'available', tools: ['process_start', 'process_write', 'process_close_stdin', 'process_read', 'process_read_since', 'process_list', 'process_stop'], note: 'Executable allowlist in all modes; shell=false. Managed process IDs/output/stdin are isolated to the creating authenticated principal or fallback local client profile. Interactive stdin is bounded pipe I/O, not a PTY.' },
  { id: 'terminal.pty', status: 'planned', tools: [], note: 'A true pseudo-terminal/conpty adapter remains separate so pipe-backed process interaction is not misrepresented as terminal emulation.' },
  { id: 'task.run', status: 'available', tools: ['task_list', 'task_run'], note: 'Owner-defined build/test profiles; resulting managed process sessions inherit principal ownership.' },
  { id: 'build.diagnostics', status: 'available', tools: ['build_diagnostics'], note: 'Token-efficient structured GCC/Clang/MSVC/CMake diagnostics parsed from the caller-owned managed process output.' },
  { id: 'remote.ssh', status: 'available', tools: ['ssh_hosts', 'ssh_probe', 'ssh_exec'], note: 'Named owner-approved hosts, BatchMode auth, strict host keys and per-host program allowlists.' },
  { id: 'permission.elevation', status: 'available', tools: ['permission_status'], note: 'Grant/revoke is local-owner-only and never exposed as an MCP tool. Client-bound leases use the authenticated request principal when present.' },
  { id: 'full_control.host_filesystem', status: 'available', tools: ['host_fs_list', 'host_fs_read', 'host_fs_write'], note: 'Requires full-control scope, effective Full Access and the explicit local policy gate when HTTP authentication is enabled.' },
  { id: 'full_control.shell', status: 'available', tools: ['shell_exec'], note: 'Requires full-control scope, effective Full Access and the explicit raw-shell policy gate when HTTP authentication is enabled.' },
  { id: 'full_control.admin', status: 'available', tools: ['admin_request', 'admin_request_status'], note: 'Administrator execution is owner-approved only. The MCP tool can create a pending request, but execution requires local Control Center approval; elevation then uses Windows RunAs/UAC under the machine policy through a separate privileged helper.' },
  { id: 'engineering.debug', status: 'planned', tools: [], note: 'DAP/GDB and probe adapters remain separate from the core process/terminal layer.' },
  { id: 'agent.orchestration', status: 'planned', tools: [], note: 'Codex/Claude/OpenHands delegation remains optional and is not on the direct GPT control path.' }
];
