import { AsyncLocalStorage } from 'node:async_hooks';

export type WorkstationScope =
  | 'workstation.read'
  | 'workstation.write'
  | 'workstation.execute'
  | 'workstation.admin_request'
  | 'workstation.full_control'
  | 'workstation.cross_node_transfer';

export interface RequestPrincipal {
  id: string;
  type: string;
  scopes: string[];
  authenticated: true;
}

const storage = new AsyncLocalStorage<RequestPrincipal>();

const TOOL_SCOPES: Record<string, WorkstationScope> = {
  chatgpt_web_status: 'workstation.read',
  workstation_identity: 'workstation.read',
  capabilities_list: 'workstation.read',
  browser_capabilities: 'workstation.read',
  browser_provider_status: 'workstation.read',
  browser_profile_status: 'workstation.read',
  browser_session_create: 'workstation.execute',
  browser_session_status: 'workstation.read',
  browser_session_close: 'workstation.execute',
  browser_tabs_list: 'workstation.read',
  browser_tab_open: 'workstation.execute',
  browser_tab_activate: 'workstation.execute',
  browser_tab_close: 'workstation.execute',
  browser_navigate: 'workstation.execute',
  browser_back: 'workstation.execute',
  browser_forward: 'workstation.execute',
  browser_reload: 'workstation.execute',
  browser_inspect: 'workstation.read',
  browser_find: 'workstation.read',
  browser_extract: 'workstation.read',
  browser_screenshot: 'workstation.read',
  browser_click: 'workstation.write',
  browser_fill: 'workstation.write',
  browser_type: 'workstation.write',
  browser_press: 'workstation.write',
  browser_select: 'workstation.write',
  browser_check: 'workstation.write',
  browser_wait: 'workstation.read',
  browser_upload: 'workstation.write',
  browser_download: 'workstation.write',
  browser_download_status: 'workstation.read',
  browser_existing_chrome_status: 'workstation.read',
  browser_existing_session_open: 'workstation.execute',
  browser_existing_session_status: 'workstation.read',
  browser_existing_session_close: 'workstation.execute',
  browser_existing_inspect: 'workstation.read',
  browser_existing_find: 'workstation.read',
  browser_existing_extract: 'workstation.read',
  browser_existing_click: 'workstation.write',
  browser_existing_fill: 'workstation.write',
  notebooklm_session_open: 'workstation.execute',
  notebooklm_session_status: 'workstation.read',
  notebooklm_session_close: 'workstation.execute',
  notebooklm_sources_list: 'workstation.read',
  notebooklm_ask: 'workstation.write',
  notebooklm_video_status: 'workstation.read',
  notebooklm_video_generate: 'workstation.write',
  system_info: 'workstation.read',
  tool_discover: 'workstation.read',
  office_capabilities: 'workstation.read',
  word_inspect: 'workstation.read',
  word_edit: 'workstation.write',
  excel_inspect: 'workstation.read',
  excel_edit: 'workstation.write',
  powerpoint_inspect: 'workstation.read',
  powerpoint_edit: 'workstation.write',
  device_list: 'workstation.read',
  device_probe: 'workstation.read',
  device_exec: 'workstation.execute',
  update_check: 'workstation.read',
  workspace_list: 'workstation.read',
  work_session_create: 'workstation.write',
  work_session_resume: 'workstation.read',
  work_session_list: 'workstation.read',
  work_session_lifecycle_preview: 'workstation.read',
  project_status: 'workstation.read',
  work_session_checkpoint: 'workstation.write',
  work_session_close: 'workstation.write',
  work_session_worktree_prepare: 'workstation.write',
  work_session_worktree_status: 'workstation.read',
  work_session_worktree_cleanup: 'workstation.write',
  project_session_group_create: 'workstation.write',
  project_session_group_inspect: 'workstation.read',
  project_session_group_mutate: 'workstation.write',
  codex_account_broker_status: 'workstation.read',
  antigravity_status: 'workstation.read',
  worker_provider_list: 'workstation.read',
  worker_route_plan: 'workstation.read',
  execution_policy_status: 'workstation.read',
  execution_policy_set_override: 'workstation.write',
  execution_target_set_override: 'workstation.write',
  work_objective_create: 'workstation.write',
  work_objective_inspect: 'workstation.read',
  work_objective_mutate: 'workstation.write',
  work_objective_decompose: 'workstation.write',
  work_objective_schedule: 'workstation.read',
  work_objective_summary: 'workstation.read',
  work_objective_attempts: 'workstation.read',
  work_objective_execution_timeline: 'workstation.read',
  work_objective_execute_task: 'workstation.execute',
  work_objective_execute_wave: 'workstation.execute',
  work_objective_cancel_task: 'workstation.execute',
  work_objective_retry_task: 'workstation.execute',
  fs_list: 'workstation.read',
  fs_find: 'workstation.read',
  fs_search_text: 'workstation.read',
  fs_read: 'workstation.read',
  fs_write: 'workstation.write',
  fs_patch: 'workstation.write',
  git_status: 'workstation.read',
  git_diff: 'workstation.read',
  git_log: 'workstation.read',
  git_branches: 'workstation.read',
  git_worktree_list: 'workstation.read',
  git_add: 'workstation.write',
  git_commit: 'workstation.write',
  git_branch_create: 'workstation.write',
  git_branch_switch: 'workstation.write',
  git_worktree_add: 'workstation.write',
  git_worktree_remove: 'workstation.write',
  lsp_servers: 'workstation.read',
  lsp_definition: 'workstation.read',
  lsp_references: 'workstation.read',
  lsp_hover: 'workstation.read',
  lsp_document_symbols: 'workstation.read',
  lsp_diagnostics: 'workstation.read',
  task_list: 'workstation.read',
  task_run: 'workstation.execute',
  build_diagnostics: 'workstation.read',
  process_start: 'workstation.execute',
  process_write: 'workstation.execute',
  process_close_stdin: 'workstation.execute',
  process_read: 'workstation.read',
  process_read_since: 'workstation.read',
  process_list: 'workstation.read',
  process_stop: 'workstation.execute',
  ssh_hosts: 'workstation.read',
  ssh_probe: 'workstation.read',
  ssh_exec: 'workstation.execute',
  permission_status: 'workstation.read',
  engineering_project_inspect: 'workstation.read',
  engineering_profile_init: 'workstation.write',
  engineering_workflow_list: 'workstation.read',
  engineering_workflow_plan: 'workstation.read',
  engineering_workflow_run: 'workstation.execute',
  hardware_list: 'workstation.read',
  hardware_inspect: 'workstation.read',
  hardware_session_status: 'workstation.read',
  serial_open: 'workstation.execute',
  serial_read: 'workstation.read',
  serial_wait_for_text: 'workstation.read',
  serial_write: 'workstation.execute',
  serial_close: 'workstation.execute',
  terminal_start: 'workstation.execute',
  terminal_read: 'workstation.read',
  terminal_write: 'workstation.execute',
  terminal_resize: 'workstation.execute',
  terminal_stop: 'workstation.execute',
  stm32_ioc_inspect: 'workstation.read',
  stm32_svd_inspect: 'workstation.read',
  firmware_project_inspect: 'workstation.read',
  firmware_artifacts: 'workstation.read',
  firmware_memory_report: 'workstation.read',
  firmware_provider_status: 'workstation.execute',
  firmware_build: 'workstation.execute',
  firmware_flash_plan: 'workstation.read',
  firmware_flash: 'workstation.execute',
  firmware_verify: 'workstation.execute',
  target_reset: 'workstation.execute',
  debug_capabilities: 'workstation.read',
  debug_session_start: 'workstation.execute',
  debug_session_list: 'workstation.read',
  debug_halt: 'workstation.execute',
  debug_resume: 'workstation.execute',
  debug_step: 'workstation.execute',
  debug_next: 'workstation.execute',
  debug_stack: 'workstation.read',
  debug_registers: 'workstation.read',
  debug_variable: 'workstation.read',
  debug_locals: 'workstation.read',
  debug_rtos_tasks: 'workstation.read',
  debug_disassemble: 'workstation.read',
  debug_breakpoint_add: 'workstation.execute',
  debug_breakpoint_remove: 'workstation.execute',
  debug_watchpoint_add: 'workstation.execute',
  debug_watchpoint_remove: 'workstation.execute',
  debug_memory_read: 'workstation.read',
  debug_fault_snapshot: 'workstation.read',
  debug_cortexm_exception_frame: 'workstation.read',
  fault_decode: 'workstation.read',
  debug_session_stop: 'workstation.execute',
  ros2_build: 'workstation.execute',
  ros2_topic_info: 'workstation.read',
  ros2_node_list: 'workstation.read',
  ros2_node_info: 'workstation.read',
  ros2_topic_list: 'workstation.read',
  ros2_topic_echo: 'workstation.read',
  ros2_topic_hz: 'workstation.read',
  ros2_topic_bw: 'workstation.read',
  ros2_tf_lookup: 'workstation.read',
  ros2_lifecycle_get: 'workstation.read',
  ros2_lifecycle_list: 'workstation.read',
  ros2_lifecycle_set: 'workstation.execute',
  ros2_service_list: 'workstation.read',
  ros2_service_call: 'workstation.execute',
  ros2_action_list: 'workstation.read',
  ros2_action_info: 'workstation.read',
  ros2_param_list: 'workstation.read',
  ros2_param_get: 'workstation.read',
  ros2_param_set: 'workstation.execute',
  ros2_bag_record: 'workstation.execute',
  kicad_provider_status: 'workstation.read',
  kicad_board_stats: 'workstation.read',
  kicad_drc: 'workstation.read',
  kicad_erc: 'workstation.read',
  kicad_validate: 'workstation.read',
  kicad_bom_report: 'workstation.read',
  container_list: 'workstation.read',
  container_inspect: 'workstation.read',
  container_logs: 'workstation.read',
  container_start: 'workstation.execute',
  container_stop: 'workstation.execute',
  container_exec: 'workstation.execute',
  image_build: 'workstation.execute',
  host_fs_list: 'workstation.full_control',
  host_fs_read: 'workstation.full_control',
  host_fs_write: 'workstation.full_control',
  shell_exec: 'workstation.full_control',
  admin_request: 'workstation.admin_request',
  admin_request_status: 'workstation.admin_request',
  node_reboot_request: 'workstation.admin_request'
};

export function runAsPrincipal<T>(principal: RequestPrincipal, fn: () => T): T {
  return storage.run(principal, fn);
}

export function currentPrincipal(): RequestPrincipal | undefined {
  return storage.getStore();
}

export function requiredScopeForTool(tool: string): WorkstationScope | undefined {
  return TOOL_SCOPES[tool];
}

function scopeAllows(scopes: readonly string[], required: WorkstationScope): boolean {
  if (scopes.includes('*')) return true;
  if (scopes.includes(required)) return true;
  return scopes.includes('workstation.full_control');
}

export function principalHasExactScope(scope: string): boolean {
  const principal = currentPrincipal();
  if (!principal) return false;
  return principal.scopes.includes('*') || principal.scopes.includes(scope);
}

export function assertToolScope(tool: string): void {
  const principal = currentPrincipal();
  if (!principal) return;

  const required = requiredScopeForTool(tool);
  if (!required) {
    throw new Error(`Authenticated tool '${tool}' has no registered scope classification; refusing execution.`);
  }
  if (!scopeAllows(principal.scopes, required)) {
    throw new Error(`Principal '${principal.id}' lacks required scope '${required}' for tool '${tool}'.`);
  }
}
