export interface HandoffNodeReadiness {
  nodeId: string;
  online: boolean;
  authorizedGrant: boolean;
  dedicatedScope: boolean;
  multiNodeEnabled: boolean;
  relayCapable: boolean;
}

export interface HandoffTransportInput {
  bytes: number;
  source: HandoffNodeReadiness;
  destination: HandoffNodeReadiness;
  grant: { id: string; maxBytes: number; transports: Array<'direct' | 'relay'> };
  verifiedDirectPeerRoute: boolean;
  receiverReady: boolean;
}

export function planHandoffTransport(input: HandoffTransportInput): {
  eligible: boolean;
  transport?: 'direct' | 'relay';
  reasons: string[];
} {
  const reasons: string[] = [];
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 1) reasons.push('Handoff archive must be a non-empty known-size file.');
  if (input.bytes > input.grant.maxBytes || input.bytes > 512 * 1024 * 1024) reasons.push('Archive exceeds owner grant or 512 MiB absolute transfer limit.');
  if (!input.source.nodeId || !input.destination.nodeId || input.source.nodeId === input.destination.nodeId) reasons.push('Two distinct verified node identities are required.');
  for (const [role, node] of [['source', input.source], ['destination', input.destination]] as const) {
    if (!node.online) reasons.push(`${role}: authenticated MCP node is offline.`);
    if (!node.multiNodeEnabled) reasons.push(`${role}: owner-local multiNode policy is disabled.`);
    if (!node.dedicatedScope) reasons.push(`${role}: dedicated workstation.cross_node_transfer scope is absent.`);
    if (!node.authorizedGrant) reasons.push(`${role}: exact bilateral grant has not been authorized locally.`);
  }
  if (reasons.length) return { eligible: false, reasons };
  if (input.grant.transports.includes('direct') && input.verifiedDirectPeerRoute && input.receiverReady) {
    return { eligible: true, transport: 'direct', reasons: [] };
  }
  if (input.grant.transports.includes('relay') && input.bytes <= 32 * 1024 * 1024 &&
      input.source.relayCapable && input.destination.relayCapable) {
    return { eligible: true, transport: 'relay', reasons: [] };
  }
  reasons.push('Direct route or receiver is not verified; establish a private reachable peer listener.');
  if (input.bytes > 32 * 1024 * 1024) reasons.push('Control-plane relay cannot carry archives over 32 MiB; use an authorized verified direct route.');
  else reasons.push('Relay must be allowed by grant and supported by both runtime nodes.');
  return { eligible: false, reasons };
}
