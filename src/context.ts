import path from 'node:path';
import { BuildDiagnosticsAdapter } from './adapters/build-diagnostics.js';
import { DeviceRegistryAdapter } from './adapters/devices.js';
import { FilesystemAdapter } from './adapters/filesystem.js';
import { FullControlAdapter } from './adapters/full-control.js';
import { GitAdapter } from './adapters/git.js';
import { HostFilesystemAdapter } from './adapters/host-filesystem.js';
import { LspAdapter } from './adapters/lsp.js';
import { ProcessManager } from './adapters/process-manager.js';
import { SearchAdapter } from './adapters/search.js';
import { SshAdapter } from './adapters/ssh.js';
import { TaskAdapter } from './adapters/tasks.js';
import { ToolDiscoveryAdapter } from './adapters/tool-discovery.js';
import { UpdateAdapter } from './adapters/update.js';
import { SERVER_VERSION } from './capabilities.js';
import { loadPolicy } from './config.js';
import { loadHosts } from './hosts.js';
import { loadPermissionLease } from './permissions.js';
import { PairingStore } from './pairing/pairing-store.js';
import { PolicyEngine } from './policy.js';
import { AuditLogger } from './security/audit.js';
import { PathGuard } from './security/path-guard.js';
import { currentPrincipal } from './security/request-principal.js';

export async function createContext() {
  const actor = {
    clientId: process.env.RWMCP_CLIENT_ID ?? 'unknown',
    clientType: process.env.RWMCP_CLIENT_TYPE ?? 'mcp-client'
  };
  const [config, hostsConfig, lease] = await Promise.all([loadPolicy(), loadHosts(), loadPermissionLease()]);
  const currentClientId = () => currentPrincipal()?.id ?? actor.clientId;
  const policy = new PolicyEngine(config, lease, currentClientId);
  const paths = new PathGuard(policy);
  const auditPath = path.resolve(process.env.RWMCP_AUDIT ?? 'runtime/audit.jsonl');
  const processes = new ProcessManager(policy, paths, currentClientId);
  const ssh = new SshAdapter(policy, hostsConfig);
  const pairing = new PairingStore();
  return {
    config,
    hostsConfig,
    policy,
    paths,
    actor,
    audit: new AuditLogger(auditPath, actor),
    fs: new FilesystemAdapter(policy, paths),
    hostFs: new HostFilesystemAdapter(policy),
    fullControl: new FullControlAdapter(policy),
    git: new GitAdapter(policy, paths),
    lsp: new LspAdapter(policy, paths, currentClientId),
    processes,
    buildDiagnostics: new BuildDiagnosticsAdapter(processes),
    search: new SearchAdapter(policy, paths),
    tools: new ToolDiscoveryAdapter(policy),
    tasks: new TaskAdapter(policy, processes),
    ssh,
    pairing,
    devices: new DeviceRegistryAdapter(ssh, pairing),
    updates: new UpdateAdapter(SERVER_VERSION)
  };
}

export type AppContext = Awaited<ReturnType<typeof createContext>>;
