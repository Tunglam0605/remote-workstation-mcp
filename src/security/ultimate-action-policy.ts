import type { PolicyEngine } from '../policy.js';
import { UltimateConsentManager, type UltimateActionContext, type UltimateOperation } from './ultimate-consent.js';
import { currentPrincipal, principalHasExactScope } from './request-principal.js';

export type UltimateOperationRequest = Omit<UltimateActionContext, 'nodeId' | 'principalId'>;

const REQUIRED_SCOPE: Record<UltimateOperation, string> = {
  build: 'workstation.execute',
  test: 'workstation.execute',
  workspace_add: 'workstation.write',
  transfer: 'workstation.cross_node_transfer',
  artifact_verify: 'workstation.read'
};

export class UltimateActionPolicy {
  constructor(
    private readonly consent: UltimateConsentManager,
    private readonly policy: PolicyEngine,
    private readonly localNodeId: string
  ) {}

  async assert(action: UltimateOperationRequest): Promise<void> {
    const principal = currentPrincipal();
    if (!principal || principal.type !== 'openai-secure-mcp-tunnel') {
      throw new Error('Ultimate automated operations require an authenticated Secure MCP Tunnel principal.');
    }
    const required = REQUIRED_SCOPE[action.operation];
    if (!required) throw new Error('Unsupported Ultimate operation.');
    const hasTransportScope = required === 'workstation.cross_node_transfer'
      ? principalHasExactScope(required)
      : principalHasExactScope(required) || principalHasExactScope('workstation.full_control');
    if (!hasTransportScope) {
      throw new Error(`Ultimate operation requires authenticated scope '${required}'.`);
    }
    if (action.operation === 'workspace_add' && !principalHasExactScope('workstation.execute') &&
        !principalHasExactScope('workstation.full_control')) {
      throw new Error('Ultimate workspace handoff requires workstation.execute for engineering_workflow_run.');
    }
    this.policy.workspace(action.workspaceId);
    if (action.operation === 'build' || action.operation === 'test') {
      this.policy.assertEngineeringExecute();
      this.policy.assertWrite(action.workspaceId);
    } else if (action.operation === 'workspace_add' || action.operation === 'transfer') {
      this.policy.assertWrite(action.workspaceId);
    }
    if (action.operation === 'transfer' && !this.policy.config.multiNode?.enabled) {
      throw new Error('Ultimate transfer denied: multi-node is disabled by local policy.');
    }
    await this.consent.assertAllowed({
      ...action,
      nodeId: this.localNodeId,
      principalId: principal.id
    });
  }
}
