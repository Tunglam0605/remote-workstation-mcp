import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OpcUaAdapter,
  sanitizeOpcUaValue,
  validateOpcUaEndpointUrl,
  validateOpcUaNodeId
} from '../src/extensions/opcua/opcua-adapter.js';

test('OPC UA endpoint validation accepts explicit opc.tcp endpoints only', () => {
  assert.equal(
    validateOpcUaEndpointUrl('opc.tcp://127.0.0.1:4840/UA/Server'),
    'opc.tcp://127.0.0.1:4840/UA/Server'
  );
  assert.equal(
    validateOpcUaEndpointUrl('opc.tcp://plc.local:4840'),
    'opc.tcp://plc.local:4840'
  );
  assert.throws(() => validateOpcUaEndpointUrl('http://127.0.0.1:4840'), /only opc\.tcp/i);
  assert.throws(() => validateOpcUaEndpointUrl('opc.tcp://127.0.0.1'), /explicit TCP port/i);
  assert.throws(() => validateOpcUaEndpointUrl('opc.tcp://user:pass@127.0.0.1:4840'), /credentials/i);
  assert.throws(() => validateOpcUaEndpointUrl('opc.tcp://127.0.0.1:4840/path?q=1'), /query strings/i);
});

test('OPC UA NodeId validation resolves standard aliases and rejects malformed identifiers', () => {
  assert.equal(validateOpcUaNodeId('RootFolder'), 'ns=0;i=84');
  assert.equal(validateOpcUaNodeId('ns=2;s=Machine.Speed'), 'ns=2;s=Machine.Speed');
  assert.throws(() => validateOpcUaNodeId('not a valid node id'), /Invalid OPC UA NodeId/i);
});

test('OPC UA value sanitizer bounds strings, arrays, buffers and nested objects', () => {
  const text = sanitizeOpcUaValue('x'.repeat(5000));
  assert.equal(typeof text, 'string');
  assert.equal((text as string).length, 4096);

  const array = sanitizeOpcUaValue(Array.from({ length: 100 }, (_, index) => index)) as any;
  assert.equal(array.length, 100);
  assert.equal(array.truncated, true);
  assert.equal(array.value.length, 64);

  const buffer = sanitizeOpcUaValue(Buffer.alloc(3000, 0xab)) as any;
  assert.equal(buffer.encoding, 'hex');
  assert.equal(buffer.bytes, 3000);
  assert.equal(buffer.truncated, true);
  assert.equal(buffer.value.length, 4096);

  const nested = sanitizeOpcUaValue({ a: { b: { c: { d: { e: 1 } } } } }) as any;
  assert.equal(nested.a.b.c.d, '[depth-limit]');
});

test('OPC UA provider status is anonymous, read-only and uses in-memory certificate storage', async () => {
  let policyChecks = 0;
  const adapter = new OpcUaAdapter({
    assertEngineeringExecute() { policyChecks += 1; }
  } as never);
  const status = await adapter.providerStatus();
  assert.equal(policyChecks, 0);
  assert.equal(status.supported, true);
  assert.equal(status.authentication, 'anonymous-only');
  assert.equal(status.securityMode, 'None');
  assert.equal(status.authority, 'read-only-services');
  assert.equal(status.localCertificateStorage, 'in-memory-only');
  assert.deepEqual(status.availableServices, ['GetEndpoints', 'Browse', 'Read']);
  assert.ok(status.intentionallyUnavailable.includes('Write'));
  assert.ok(status.intentionallyUnavailable.includes('Call'));
});

test('OPC UA Phase 1 source does not expose write, call or subscription MCP tools', async () => {
  const fs = await import('node:fs/promises');
  const register = await fs.readFile(new URL('../src/extensions/opcua/register.ts', import.meta.url), 'utf8');
  const adapter = await fs.readFile(new URL('../src/extensions/opcua/opcua-adapter.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(register, /registerTool\('opcua_(write|call|subscribe|monitor)/);
  assert.doesNotMatch(adapter, /session\.(write|call|createSubscription2?|createMonitoredItems?)\s*\(/);
  assert.match(adapter, /InMemoryCertificateKeyPairProvider/);
  assert.doesNotMatch(adapter, /OPCUACertificateManager|certificateFile|privateKeyFile/);
});
