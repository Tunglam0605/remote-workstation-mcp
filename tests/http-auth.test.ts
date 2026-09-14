import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpAuthProvider, HttpAuthenticationError, loadHttpAuthFromEnv } from '../src/security/http-auth.js';

test('HTTP auth defaults to none for local compatibility', () => {
  const config = loadHttpAuthFromEnv({});
  assert.equal(config.mode, 'none');
  assert.equal(new HttpAuthProvider(config).authenticate({}), undefined);
});

test('bearer auth requires a sufficiently long token', () => {
  assert.throws(
    () => loadHttpAuthFromEnv({ RWMCP_HTTP_AUTH_MODE: 'bearer' }),
    /RWMCP_HTTP_BEARER_TOKEN is required/
  );
  assert.throws(
    () => loadHttpAuthFromEnv({ RWMCP_HTTP_AUTH_MODE: 'bearer', RWMCP_HTTP_BEARER_TOKEN: 'short' }),
    /at least 32 characters/
  );
});

test('bearer auth returns a request-scoped principal and scopes', () => {
  const token = '0123456789abcdef0123456789abcdef';
  const provider = new HttpAuthProvider(loadHttpAuthFromEnv({
    RWMCP_HTTP_AUTH_MODE: 'bearer',
    RWMCP_HTTP_BEARER_TOKEN: token,
    RWMCP_HTTP_PRINCIPAL_ID: 'chatgpt-web',
    RWMCP_HTTP_PRINCIPAL_TYPE: 'remote-mcp',
    RWMCP_HTTP_SCOPES: 'workstation.read, workstation.write,workstation.read'
  }));

  const principal = provider.authenticate({ authorization: `Bearer ${token}` });
  assert.deepEqual(principal, {
    id: 'chatgpt-web',
    type: 'remote-mcp',
    scopes: ['workstation.read', 'workstation.write'],
    authenticated: true
  });
});

test('bearer auth rejects missing and incorrect credentials', () => {
  const token = '0123456789abcdef0123456789abcdef';
  const provider = new HttpAuthProvider(loadHttpAuthFromEnv({
    RWMCP_HTTP_AUTH_MODE: 'bearer',
    RWMCP_HTTP_BEARER_TOKEN: token
  }));

  assert.throws(() => provider.authenticate({}), HttpAuthenticationError);
  assert.throws(
    () => provider.authenticate({ authorization: `Bearer ${'f'.repeat(32)}` }),
    HttpAuthenticationError
  );
});
