import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { buildOpenAiTunnelProfile, OpenAiSecureTunnelConnectionProvider } from '../src/connections/openai-secure-tunnel.js';

test('OpenAI tunnel profile keeps secrets as environment references and MCP loopback authenticated', () => {
  const runtimeDir = path.resolve('runtime-test');
  const profile = buildOpenAiTunnelProfile({
    tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
    localEndpoint: 'http://127.0.0.1:8765/mcp',
    runtimeDir
  }) as {
    control_plane: { tunnel_id: string; api_key: string };
    mcp: {
      server_urls: Array<{ channel: string; url: string }>;
      extra_headers: Record<string, string>;
      discovery_extra_headers: Record<string, string>;
    };
    cloudflared: { managed: boolean };
  };

  assert.equal(profile.control_plane.tunnel_id, 'tunnel_0123456789abcdef0123456789abcdef');
  assert.equal(profile.control_plane.api_key, 'env:CONTROL_PLANE_API_KEY');
  assert.deepEqual(profile.mcp.server_urls, [{ channel: 'main', url: 'http://127.0.0.1:8765/mcp' }]);
  assert.equal(profile.mcp.extra_headers.Authorization, 'env:RWMCP_TUNNEL_AUTH');
  assert.equal(profile.mcp.discovery_extra_headers.Authorization, 'env:RWMCP_TUNNEL_AUTH');
  assert.equal(profile.cloudflared.managed, false);

  const serialized = JSON.stringify(profile);
  assert.equal(serialized.includes('sk-test-secret'), false);
  assert.equal(serialized.includes('Bearer test-secret'), false);
});

test('OpenAI connection provider is outbound-only and points at loopback MCP', () => {
  const provider = new OpenAiSecureTunnelConnectionProvider({
    env: { RWMCP_PORT: '9876' },
    cwd: process.cwd(),
    readyTimeoutMs: 1000
  });
  assert.deepEqual(provider.descriptor, {
    id: 'openai-secure-mcp-tunnel',
    transport: 'secure-mcp-tunnel',
    exposure: 'outbound-only',
    localEndpoint: 'http://127.0.0.1:9876/mcp',
    authentication: 'bearer'
  });
});

test('OpenAI connection provider rejects invalid readiness timeout configuration', () => {
  assert.throws(() => new OpenAiSecureTunnelConnectionProvider({
    env: { RWMCP_OPENAI_TUNNEL_READY_TIMEOUT_MS: '0' }
  }), /READY_TIMEOUT_MS/);
});
