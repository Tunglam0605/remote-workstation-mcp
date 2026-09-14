import assert from 'node:assert/strict';
import test from 'node:test';
import { assertToolScope, currentPrincipal, runAsPrincipal } from '../src/security/request-principal.js';

test('local transports remain compatible when no authenticated principal exists', () => {
  assert.equal(currentPrincipal(), undefined);
  assert.doesNotThrow(() => assertToolScope('fs_write'));
});

test('read scoped principal can inspect but cannot mutate or execute', () => {
  runAsPrincipal({ id: 'reader', type: 'test', scopes: ['workstation.read'], authenticated: true }, () => {
    assert.equal(currentPrincipal()?.id, 'reader');
    assert.doesNotThrow(() => assertToolScope('fs_read'));
    assert.throws(() => assertToolScope('fs_write'), /lacks required scope 'workstation.write'/);
    assert.throws(() => assertToolScope('process_start'), /lacks required scope 'workstation.execute'/);
  });
});

test('full-control scope implies workstation read/write/execute/full-control scopes', () => {
  runAsPrincipal({ id: 'owner', type: 'test', scopes: ['workstation.full_control'], authenticated: true }, () => {
    assert.doesNotThrow(() => assertToolScope('fs_read'));
    assert.doesNotThrow(() => assertToolScope('fs_write'));
    assert.doesNotThrow(() => assertToolScope('process_start'));
    assert.doesNotThrow(() => assertToolScope('shell_exec'));
  });
});

test('authenticated principals fail closed for unclassified tools', () => {
  runAsPrincipal({ id: 'owner', type: 'test', scopes: ['*'], authenticated: true }, () => {
    assert.throws(() => assertToolScope('future_unclassified_tool'), /no registered scope classification/);
  });
});
