import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppContext } from '../src/context.js';
import { requiredScopeForTool, runAsPrincipal } from '../src/security/request-principal.js';
import { buildChatGptWebStatus } from '../src/tools/chatgpt-web-tools.js';

function fakeContext(): AppContext {
  return {
    config: {
      workspaces: [
        { id: 'projects', name: 'Projects', root: 'C:/work', readOnly: false }
      ],
      multiNode: {
        enabled: true,
        controllerPrincipalId: 'openai-tunnel',
        controllerPrincipalType: 'openai-secure-mcp-tunnel',
        grants: []
      },
      legacyRemoteControl: { enabled: false }
    },
    policy: {
      effectiveMode: () => 'workspace',
      status: () => ({ mode: 'workspace' }),
      legacyRemoteControlEnabled: () => false
    },
    dataPlane: {
      status: () => ({
        transport: 'direct-http',
        maxTransferBytes: 536870912,
        directIpv4Available: true,
        tailscaleIpv4Available: true,
        privateLanIpv4Available: true,
        availableTransports: ['tailscale-http', 'private-lan-http'],
        activeOffers: [],
        recentTransfers: []
      })
    },
    controlPlaneRelay: {
      status: () => ({
        transport: 'control-plane-relay',
        supported: true,
        maxRelayBytes: 33554432,
        maxChunkBytes: 65536,
        resumable: true,
        persistentSessionState: true
      })
    },
    multiNodeAuthorization: {
      status: () => ({
        enabled: true,
        defaultDeny: true,
        secureTunnelOnly: true,
        localNodeId: 'dev_test',
        configuredGrantCount: 0,
        requiredScope: 'workstation.cross_node_transfer'
      })
    },
    processes: { list: () => [{ status: 'running' }], activeCount: () => 3 },
    engineering: {
      terminals: { list: () => [], activeCount: () => 2 },
      resources: { list: () => [], activeCount: () => 1 }
    }
  } as unknown as AppContext;
}

test('chatgpt_web_status is classified as read-only', () => {
  assert.equal(requiredScopeForTool('chatgpt_web_status'), 'workstation.read');
});

test('ChatGPT Web status does not claim an authenticated tunnel for local calls', () => {
  const status = buildChatGptWebStatus(fakeContext()) as any;
  assert.equal(status.ok, true);
  assert.equal(status.serverVersion, '0.33.2');
  assert.equal(status.channel, 'stable');
  assert.equal(status.gitCommit, null);
  assert.equal(status.chatgptWeb.authenticated, false);
  assert.equal(status.chatgptWeb.directControlPathVerified, false);
  assert.equal(status.chatgptWeb.permissions.write, false);
  assert.deepEqual(status.workspaces, [{ id: 'projects', name: 'Projects', readOnly: false }]);
  assert.equal(status.nodeHealth.state, 'reachable');
  assert.equal(status.nodeHealth.dataPlane.tailscaleIpv4Available, true);
  assert.equal(status.nodeHealth.dataPlane.controlPlaneRelay.supported, true);
  assert.equal(status.nodeHealth.dataPlane.controlPlaneRelay.maxChunkBytes, 65536);
  assert.equal(status.nodeHealth.activeSessions.processes, 3);
  assert.equal(status.nodeHealth.activeSessions.terminals, 2);
  assert.equal(status.nodeHealth.activeSessions.hardwareLeases, 1);
  assert.equal(status.nodeHealth.security.multiNode.defaultDeny, true);
  assert.equal(status.nodeHealth.security.legacyRemoteControlEnabled, false);
  assert.equal(status.chatgptWeb.permissions.crossNodeTransfer, false);
});

test('ChatGPT Web status verifies authenticated OpenAI tunnel principal and scopes', () => {
  const status = runAsPrincipal({
    id: 'openai-tunnel',
    type: 'openai-secure-mcp-tunnel',
    scopes: ['workstation.read', 'workstation.write', 'workstation.execute'],
    authenticated: true
  }, () => buildChatGptWebStatus(fakeContext())) as any;

  assert.equal(status.chatgptWeb.authenticated, true);
  assert.equal(status.chatgptWeb.secureTunnelPrincipal, true);
  assert.equal(status.chatgptWeb.directControlPathVerified, true);
  assert.equal(status.chatgptWeb.permissions.read, true);
  assert.equal(status.chatgptWeb.permissions.write, true);
  assert.equal(status.chatgptWeb.permissions.execute, true);
  assert.equal(status.chatgptWeb.permissions.fullControl, false);
  assert.equal(status.chatgptWeb.permissions.crossNodeTransfer, false);
  assert.equal(status.nodeHealth.state, 'healthy');
  assert.deepEqual(status.nodeHealth.warnings, []);
});

test('ChatGPT Web status exposes cross-node permission only for the configured controller and dedicated scope', () => {
  const status = runAsPrincipal({
    id: 'openai-tunnel',
    type: 'openai-secure-mcp-tunnel',
    scopes: ['workstation.read', 'workstation.full_control', 'workstation.cross_node_transfer'],
    authenticated: true
  }, () => buildChatGptWebStatus(fakeContext())) as any;

  assert.equal(status.chatgptWeb.permissions.fullControl, true);
  assert.equal(status.chatgptWeb.permissions.crossNodeTransfer, true);

  const wrong = runAsPrincipal({
    id: 'other-openai-client',
    type: 'openai-secure-mcp-tunnel',
    scopes: ['workstation.cross_node_transfer'],
    authenticated: true
  }, () => buildChatGptWebStatus(fakeContext())) as any;
  assert.equal(wrong.chatgptWeb.permissions.crossNodeTransfer, false);
});
