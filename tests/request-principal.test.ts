import assert from 'node:assert/strict';
import test from 'node:test';
import { assertToolScope, currentPrincipal, runAsPrincipal } from '../src/security/request-principal.js';

test('local transports remain compatible when no authenticated principal exists', () => {
  assert.equal(currentPrincipal(), undefined);
  assert.doesNotThrow(() => assertToolScope('fs_write'));
});

test('read scoped principal can inspect semantic code but cannot mutate or execute', () => {
  runAsPrincipal({ id: 'reader', type: 'test', scopes: ['workstation.read'], authenticated: true }, () => {
    assert.equal(currentPrincipal()?.id, 'reader');
    assert.doesNotThrow(() => assertToolScope('fs_read'));
    assert.doesNotThrow(() => assertToolScope('lsp_definition'));
    assert.doesNotThrow(() => assertToolScope('lsp_diagnostics'));
    assert.throws(() => assertToolScope('fs_write'), /lacks required scope 'workstation.write'/);
    assert.throws(() => assertToolScope('process_start'), /lacks required scope 'workstation.execute'/);
    assert.throws(() => assertToolScope('process_write'), /lacks required scope 'workstation.execute'/);
    assert.throws(() => assertToolScope('process_close_stdin'), /lacks required scope 'workstation.execute'/);
  });
});

test('device tools preserve workstation read/execute scope boundaries', () => {
  runAsPrincipal({ id: 'reader', type: 'test', scopes: ['workstation.read'], authenticated: true }, () => {
    assert.doesNotThrow(() => assertToolScope('device_list'));
    assert.doesNotThrow(() => assertToolScope('device_probe'));
    assert.throws(() => assertToolScope('device_exec'), /lacks required scope 'workstation.execute'/);
  });
  runAsPrincipal({ id: 'runner', type: 'test', scopes: ['workstation.execute'], authenticated: true }, () => {
    assert.doesNotThrow(() => assertToolScope('device_exec'));
  });
});

test('execute scoped principal can start and interact with managed processes', () => {
  runAsPrincipal({ id: 'runner', type: 'test', scopes: ['workstation.execute'], authenticated: true }, () => {
    assert.doesNotThrow(() => assertToolScope('process_start'));
    assert.doesNotThrow(() => assertToolScope('process_write'));
    assert.doesNotThrow(() => assertToolScope('process_close_stdin'));
    assert.doesNotThrow(() => assertToolScope('process_stop'));
    assert.throws(() => assertToolScope('fs_write'), /lacks required scope 'workstation.write'/);
  });
});

test('admin-request scope can request elevation but cannot directly use full-control tools', () => {
  runAsPrincipal({ id: 'requester', type: 'test', scopes: ['workstation.admin_request'], authenticated: true }, () => {
    assert.doesNotThrow(() => assertToolScope('admin_request'));
    assert.doesNotThrow(() => assertToolScope('admin_request_status'));
    assert.throws(() => assertToolScope('shell_exec'), /lacks required scope 'workstation.full_control'/);
  });
});

test('full-control scope implies workstation read/write/execute/full-control scopes', () => {
  runAsPrincipal({ id: 'owner', type: 'test', scopes: ['workstation.full_control'], authenticated: true }, () => {
    assert.doesNotThrow(() => assertToolScope('fs_read'));
    assert.doesNotThrow(() => assertToolScope('fs_write'));
    assert.doesNotThrow(() => assertToolScope('process_start'));
    assert.doesNotThrow(() => assertToolScope('process_write'));
    assert.doesNotThrow(() => assertToolScope('shell_exec'));
    assert.doesNotThrow(() => assertToolScope('admin_request'));
  });
});

test('authenticated principals fail closed for unclassified tools', () => {
  runAsPrincipal({ id: 'owner', type: 'test', scopes: ['*'], authenticated: true }, () => {
    assert.throws(() => assertToolScope('future_unclassified_tool'), /no registered scope classification/);
  });
});
