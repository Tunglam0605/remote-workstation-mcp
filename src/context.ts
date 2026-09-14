import path from 'node:path';
import { FilesystemAdapter } from './adapters/filesystem.js';
import { GitAdapter } from './adapters/git.js';
import { ProcessManager } from './adapters/process-manager.js';
import { loadPolicy } from './config.js';
import { PolicyEngine } from './policy.js';
import { AuditLogger } from './security/audit.js';
import { PathGuard } from './security/path-guard.js';

export async function createContext() {
  const config = await loadPolicy();
  const policy = new PolicyEngine(config);
  const paths = new PathGuard(policy);
  const auditPath = path.resolve(process.env.RWMCP_AUDIT ?? 'runtime/audit.jsonl');
  const actor = {
    clientId: process.env.RWMCP_CLIENT_ID ?? 'unknown',
    clientType: process.env.RWMCP_CLIENT_TYPE ?? 'mcp-client'
  };
  return {
    config,
    policy,
    paths,
    actor,
    audit: new AuditLogger(auditPath, actor),
    fs: new FilesystemAdapter(policy, paths),
    git: new GitAdapter(policy, paths),
    processes: new ProcessManager(policy, paths)
  };
}

export type AppContext = Awaited<ReturnType<typeof createContext>>;
