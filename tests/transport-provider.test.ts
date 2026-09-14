import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppContext } from '../src/context.js';
import { HttpAuthProvider } from '../src/security/http-auth.js';
import { LoopbackHttpTransportProvider } from '../src/transports/http.js';
import { StdioTransportProvider } from '../src/transports/stdio.js';

const minimalContext = {
  policy: { effectiveMode: () => 'workspace' }
} as unknown as AppContext;

test('stdio transport identifies itself as local process-boundary transport', () => {
  const provider = new StdioTransportProvider();
  assert.deepEqual(provider.descriptor, {
    id: 'stdio-local',
    protocol: 'stdio',
    exposure: 'local-process',
    authentication: 'process-boundary'
  });
});

test('loopback HTTP transport exposes provider metadata without changing bind semantics', () => {
  const provider = new LoopbackHttpTransportProvider(minimalContext, {
    port: 18765,
    auth: new HttpAuthProvider({
      mode: 'bearer',
      token: '0123456789abcdef0123456789abcdef',
      principalId: 'test',
      principalType: 'test',
      scopes: ['workstation.read']
    })
  });
  assert.deepEqual(provider.descriptor, {
    id: 'http-loopback',
    protocol: 'streamable-http',
    exposure: 'loopback',
    authentication: 'bearer',
    endpoint: 'http://127.0.0.1:18765/mcp'
  });
});

test('loopback HTTP transport rejects invalid ports before listening', () => {
  assert.throws(
    () => new LoopbackHttpTransportProvider(minimalContext, { port: 0 }),
    /valid TCP port/
  );
  assert.throws(
    () => new LoopbackHttpTransportProvider(minimalContext, { port: 70000 }),
    /valid TCP port/
  );
});
