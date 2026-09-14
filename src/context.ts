import path from 'node:path';
import { FilesystemAdapter } from './adapters/filesystem.js';
import { GitAdapter } from './adapters/git.js';
import { ProcessManager } from './adapters/process-manager.js';
import { SearchAdapter } from './adapters/search.js';
import { SshAdapter } from './adapters/ssh.js';
import { TaskAdapter } from './adapters/tasks.js';
import { ToolDiscoveryAdapter } from './adapters/tool-discovery.js';
import { UpdateAdapter } from './adapters/update.js';
import { SERVER_VERSION } from './capabilities.js';
import { loadPolicy } from './config.js';
import { loadHosts } from './hosts.js';
import { PolicyEngine } from './policy.js';
import { AuditLogger } from './security/audit.js';
import { PathGuard } from './security/path-guard.js';

export async function createContext() {
  const [config, hostsConfig] = await Promise.all([loadPolicy(), loadHosts()]);
  const policy = new PolicyEngine(config);
  const paths = new PathGuard(policy);
  const auditPath = path.resolve(process.env.RWMCP_AUDIT ?? 'runtime/audit.jsonl');
  const actor = {
    clientId: process.env.RWMCP_CLIENT_ID ?? 'unknown',
    clientType: process.env.RWMCP_CLIENT_TYPE ?? 'mcp-client'
  };
  const processes = new ProcessManager(policy, paths);
  return {
    config,
    hostsConfig,
    policy,
    paths,
    actor,
    audit: new AuditLogger(auditPath, actor),
    fs: new FilesystemAdapter(policy, paths),
    git: new GitAdapter(policy, paths),
    processes,
    search: new SearchAdapter(policy, paths),
    tools: new ToolDiscoveryAdapter(policy),
    tasks: new TaskAdapter(policy, processes),
    ssh: new SshAdapter(policy, hostsConfig),
    updates: new UpdateAdapter(SERVER_VERSION)
  };
}

export type AppContext = Awaited<ReturnType<typeof createContext>>;
