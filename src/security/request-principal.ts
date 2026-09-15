import { AsyncLocalStorage } from 'node:async_hooks';

export type WorkstationScope =
  | 'workstation.read'
  | 'workstation.write'
  | 'workstation.execute'
  | 'workstation.admin_request'
  | 'workstation.full_control';

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
  system_info: 'workstation.read',
  tool_discover: 'workstation.read',
  device_list: 'workstation.read',
  device_probe: 'workstation.read',
  device_exec: 'workstation.execute',
  update_check: 'workstation.read',
  workspace_list: 'workstation.read',
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
  host_fs_list: 'workstation.full_control',
  host_fs_read: 'workstation.full_control',
  host_fs_write: 'workstation.full_control',
  shell_exec: 'workstation.full_control',
  admin_request: 'workstation.admin_request',
  admin_request_status: 'workstation.admin_request'
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
