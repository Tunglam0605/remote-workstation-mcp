export const SERVER_VERSION = '0.11.0';

export type CapabilityStatus = 'available' | 'planned';

export interface CapabilityDescriptor {
  id: string;
  status: CapabilityStatus;
  tools: string[];
  note?: string;
}

export const CAPABILITIES: CapabilityDescriptor[] = [
  { id: 'chatgpt.web_control', status: 'available', tools: ['chatgpt_web_status', 'workstation_identity'], note: 'First-call end-to-end verification for ChatGPT Web plus a stable per-workstation identity for direct multi-node control.' },
  { id: 'system.inspect', status: 'available', tools: ['system_info', 'capabilities_list', 'tool_discover'] },
  { id: 'software.update.check', status: 'available', tools: ['update_check'], note: 'Read-only GitHub Releases check; install/update remains owner-controlled.' },
  { id: 'setup.local_web', status: 'available', tools: [], note: 'Owner-operated loopback-only Setup & Control Center persists non-secret workstation settings outside the repository, can protect the OpenAI runtime key with Windows DPAPI, and can start/stop/restart the user-level runtime without exposing these controls through MCP.' },
  { id: 'setup.local_tui', status: 'available', tools: [], note: 'Owner-local terminal control surface for status, access mode, MCP port, device name, tunnel binding and hidden Runtime API key rotation without exposing configuration mutation through MCP.' },
  { id: 'installation.windows_managed', status: 'available', tools: [], note: 'Checksum-verified Windows release installer uses versioned per-user runtime slots, a stable launcher, optional start-at-logon, and one-step rollback without requiring a Git checkout for production use.' },
  { id: 'transport.providers', status: 'available', tools: [], note: 'The CLI selects a provider behind a common contract. Current providers are local stdio and loopback Streamable HTTP.' },
  { id: 'connection.openai_secure_tunnel', status: 'available', tools: [], note: 'Optional outbound-only OpenAI Secure MCP Tunnel supervisor keeps the workstation MCP bound to loopback, injects an ephemeral bearer into tunnel runtime headers, and does not forward the OpenAI runtime API key into the MCP child process.' },
  { id: 'transport.auth.http', status: 'available', tools: [], note: 'Optional loopback HTTP bearer authentication establishes a request-scoped principal and workstation read/write/execute/full-control scopes.' },
  { id: 'multi_device.direct_nodes', status: 'available', tools: ['workstation_identity', 'chatgpt_web_status'], note: 'Preferred v0.8.3 topology: every workstation runs its own RWMCP and OpenAI Secure MCP Tunnel, so ChatGPT can select multiple independent apps in one prompt without an SSH hub or shared LAN.' },
  { id: 'control_center.offline_recovery', status: 'available', tools: [], note: 'v0.8.4 keeps the loopback Control Center usable when the runtime API key or tunnel is missing, expired, revoked, or disconnected, with local credential testing and Save & reconnect recovery.' },
  { id: 'multi_device.hub_gateway', status: 'available', tools: ['device_list', 'device_probe', 'device_exec'], note: 'Legacy/bootstrap topology retained for owner-approved SSH hosts. Prefer direct-node apps for routine multi-device work.' },
  { id: 'workspace.discover', status: 'available', tools: ['workspace_list'] },
  { id: 'filesystem.read', status: 'available', tools: ['fs_list', 'fs_read', 'fs_find', 'fs_search_text'] },
  { id: 'filesystem.write', status: 'available', tools: ['fs_write', 'fs_patch'], note: 'Workspace policy and optimistic SHA-256 checks apply.' },
  { id: 'git.inspect', status: 'available', tools: ['git_status', 'git_diff', 'git_log', 'git_branches', 'git_worktree_list'] },
  { id: 'git.manage', status: 'available', tools: ['git_add', 'git_commit', 'git_branch_create', 'git_branch_switch', 'git_worktree_add', 'git_worktree_remove'], note: 'Typed Git writes obey workspace write policy; worktrees are the preferred concurrency boundary.' },
  { id: 'code.semantic', status: 'available', tools: ['lsp_servers', 'lsp_definition', 'lsp_references', 'lsp_hover', 'lsp_document_symbols', 'lsp_diagnostics'], note: 'Owner-configured language servers run without a shell, are executable-allowlisted, principal-scoped and message-size/time bounded. Workspace-external definition/reference paths are redacted.' },
  { id: 'process.execute', status: 'available', tools: ['process_start', 'process_write', 'process_close_stdin', 'process_read', 'process_read_since', 'process_list', 'process_stop'], note: 'Executable allowlist in all modes; shell=false. Managed process IDs/output/stdin are isolated to the creating authenticated principal or fallback local client profile. Interactive stdin is bounded pipe I/O, not a PTY.' },
  { id: 'terminal.pty', status: 'available', tools: ['terminal_start', 'terminal_read', 'terminal_write', 'terminal_resize', 'terminal_stop'], note: 'True PTY/ConPTY sessions use node-pty, remain caller-owned and retain executable/workspace policy checks.' },
  { id: 'task.run', status: 'available', tools: ['task_list', 'task_run'], note: 'Owner-defined build/test profiles; resulting managed process sessions inherit principal ownership.' },
  { id: 'build.diagnostics', status: 'available', tools: ['build_diagnostics'], note: 'Token-efficient structured GCC/Clang/MSVC/CMake diagnostics parsed from the caller-owned managed process output.' },
  { id: 'remote.ssh', status: 'available', tools: ['ssh_hosts', 'ssh_probe', 'ssh_exec'], note: 'Named owner-approved hosts, BatchMode auth, strict host keys and per-host program allowlists.' },
  { id: 'permission.elevation', status: 'available', tools: ['permission_status'], note: 'Grant/revoke is local-owner-only and never exposed as an MCP tool. Client-bound leases use the authenticated request principal when present.' },
  { id: 'full_control.host_filesystem', status: 'available', tools: ['host_fs_list', 'host_fs_read', 'host_fs_write'], note: 'Requires full-control scope, effective Full Access and the explicit local policy gate when HTTP authentication is enabled.' },
  { id: 'full_control.shell', status: 'available', tools: ['shell_exec'], note: 'Requires full-control scope, effective Full Access and the explicit raw-shell policy gate when HTTP authentication is enabled.' },
  { id: 'full_control.admin', status: 'available', tools: ['admin_request', 'admin_request_status'], note: 'Administrator execution is owner-approved only. The MCP tool can create a pending request, but execution requires local Control Center approval; elevation then uses Windows RunAs/UAC under the machine policy through a separate privileged helper.' },
  { id: 'engineering.workflows', status: 'available', tools: ['engineering_project_inspect', 'engineering_profile_init', 'engineering_workflow_list', 'engineering_workflow_plan', 'engineering_workflow_run'], note: 'Project-local .rwmcp/project.yaml profiles collapse repeated build/flash/monitor/ROS 2 setup into typed high-level workflows without arbitrary shell recipes.' },
  { id: 'engineering.hardware', status: 'available', tools: ['hardware_list', 'hardware_inspect', 'hardware_session_status'], note: 'Cross-platform serial/debug-probe discovery plus exclusive resource leases prevent competing hardware operations.' },
  { id: 'engineering.serial', status: 'available', tools: ['serial_open', 'serial_read', 'serial_wait_for_text', 'serial_write', 'serial_close'], note: 'Caller-owned serial sessions use bounded buffers; readiness markers can be awaited without repeated chat polling; serial write is separately permission-gated.' },
  { id: 'engineering.firmware', status: 'available', tools: ['firmware_project_inspect', 'firmware_artifacts', 'firmware_provider_status', 'firmware_build', 'firmware_flash_plan', 'firmware_flash', 'firmware_verify', 'target_reset'], note: 'Typed firmware workflows auto-detect ESP-IDF/STM32/CMake/Make and use constrained provider-generated argv.' },
  { id: 'engineering.debug', status: 'available', tools: ['debug_capabilities', 'debug_session_start', 'debug_session_list', 'debug_halt', 'debug_resume', 'debug_step', 'debug_next', 'debug_stack', 'debug_registers', 'debug_variable', 'debug_breakpoint_add', 'debug_breakpoint_remove', 'debug_memory_read', 'debug_fault_snapshot', 'fault_decode', 'debug_session_stop'], note: 'Loopback-only OpenOCD + token-correlated GDB/MI with no arbitrary command, memory-write, TCL, telnet or GDB-flash surface.' },
  { id: 'engineering.ros2', status: 'available', tools: ['ros2_build', 'ros2_node_list', 'ros2_topic_list', 'ros2_topic_info', 'ros2_topic_echo', 'ros2_service_list', 'ros2_service_call', 'ros2_action_list', 'ros2_param_list', 'ros2_param_get', 'ros2_param_set', 'ros2_bag_record'], note: 'Typed colcon build plus bounded ros2cli contracts separate workspace build and read-only graph/QoS inspection from runtime mutation.' },
  { id: 'engineering.containers', status: 'available', tools: ['container_list', 'container_inspect', 'container_logs', 'container_start', 'container_stop', 'container_exec', 'image_build'], note: 'Typed Docker CLI adapter avoids shell strings; lifecycle/build/exec operations require hardware-mutation permission.' },
  { id: 'agent.orchestration', status: 'planned', tools: [], note: 'Codex/Claude/OpenHands delegation remains optional and is not on the direct GPT control path.' }
];
