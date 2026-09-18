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
      ]
    },
    policy: {
      effectiveMode: () => 'workspace',
      status: () => ({ mode: 'workspace' })
    },
    dataPlane: {
      status: () => ({
        transport: 'tailscale-http',
        maxTransferBytes: 536870912,
        tailscaleIpv4Available: true,
        activeOffers: [],
        recentTransfers: []
      })
    },
    processes: { list: () => [{ status: 'running' }] },
    engineering: {
      terminals: { list: () => [] },
      resources: { list: () => [] }
    }
  } as unknown as AppContext;
}

test('chatgpt_web_status is classified as read-only', () => {
  assert.equal(requiredScopeForTool('chatgpt_web_status'), 'workstation.read');
});

test('ChatGPT Web status does not claim an authenticated tunnel for local calls', () => {
  const status = buildChatGptWebStatus(fakeContext()) as any;
  assert.equal(status.ok, true);
  assert.equal(status.chatgptWeb.authenticated, false);
  assert.equal(status.chatgptWeb.directControlPathVerified, false);
  assert.equal(status.chatgptWeb.permissions.write, false);
  assert.deepEqual(status.workspaces, [{ id: 'projects', name: 'Projects', readOnly: false }]);
  assert.equal(status.nodeHealth.state, 'reachable');
  assert.equal(status.nodeHealth.dataPlane.tailscaleIpv4Available, true);
  assert.equal(status.nodeHealth.activeSessions.processes, 1);
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
  assert.equal(status.nodeHealth.state, 'healthy');
  assert.deepEqual(status.nodeHealth.warnings, []);
});
