import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCapabilityReadiness, type CapabilityReadinessDependencies } from '../src/capability-readiness.js';
import type { CapabilityDescriptor } from '../src/capabilities.js';

function deps(overrides: Partial<CapabilityReadinessDependencies> = {}): CapabilityReadinessDependencies {
  return {
    firmwareProviderStatus: async () => ({ available: true, executableSource: 'known-install', version: 'test' }),
    canProviderStatus: async () => ({ supported: true, capture: true, socketcan: true, candump: true, pythonFallback: false, captureBackend: 'candump', platform: 'linux' }),
    modbusProviderStatus: async () => ({ supported: true, backend: 'serialport', serialPortCount: 0 }),
    networkProviderStatus: async () => ({ supported: true, interfaceInventory: true, dnsLookup: true, tcpReachability: true, icmpPing: true, routeInventory: true, platform: 'linux' }),
    browserCapabilities: () => ({ availability: { available: true, executable: '/browser' } }),
    ...overrides
  };
}

const capability = (id: string, status: CapabilityDescriptor['status'] = 'available'): CapabilityDescriptor => ({
  id,
  status,
  tools: []
});

test('readiness keeps unprobed implemented capabilities as supported', async () => {
  const [result] = await resolveCapabilityReadiness([capability('engineering.ros2')], deps());
  assert.equal(result?.readiness.state, 'supported');
  assert.equal(result?.readiness.source, 'static-contract');
});

test('firmware readiness reports provider absence without changing implementation status', async () => {
  const [result] = await resolveCapabilityReadiness([capability('engineering.firmware')], deps({
    firmwareProviderStatus: async () => ({
      available: false,
      diagnostic: { code: 'provider-unavailable', message: 'OpenOCD missing.' }
    })
  }));
  assert.equal(result?.status, 'available');
  assert.equal(result?.readiness.state, 'unavailable');
  assert.equal(result?.readiness.evidence?.diagnosticCode, 'provider-unavailable');
  assert.deepEqual(result?.readiness.blockers, ['OpenOCD missing.']);
});

test('CAN readiness is unavailable when the node platform does not support SocketCAN', async () => {
  const [result] = await resolveCapabilityReadiness([capability('engineering.can')], deps({
    canProviderStatus: async () => ({ supported: false, platform: 'win32', capture: false, socketcan: false })
  }));
  assert.equal(result?.readiness.state, 'unavailable');
  assert.equal(result?.readiness.evidence?.platform, 'win32');
});

test('network readiness is degraded when core diagnostics work but optional providers are missing', async () => {
  const [result] = await resolveCapabilityReadiness([capability('engineering.network')], deps({
    networkProviderStatus: async () => ({
      supported: true,
      interfaceInventory: true,
      dnsLookup: true,
      tcpReachability: true,
      icmpPing: false,
      routeInventory: false,
      platform: 'linux'
    })
  }));
  assert.equal(result?.readiness.state, 'degraded');
  assert.deepEqual(result?.readiness.blockers, [
    'ICMP ping executable is unavailable.',
    'Route inventory provider is unavailable.'
  ]);
});

test('Modbus readiness does not treat zero attached serial endpoints as provider failure', async () => {
  const [result] = await resolveCapabilityReadiness([capability('engineering.modbus_rtu')], deps({
    modbusProviderStatus: async () => ({ supported: true, backend: 'serialport', serialPortCount: 0 })
  }));
  assert.equal(result?.readiness.state, 'ready');
  assert.equal(result?.readiness.evidence?.serialPortCount, 0);
});

test('managed browser readiness reports unsupported node providers as unavailable', async () => {
  const [result] = await resolveCapabilityReadiness([capability('web.automation')], deps({
    browserCapabilities: () => ({ availability: { available: false, reason: 'Windows only.' } })
  }));
  assert.equal(result?.readiness.state, 'unavailable');
  assert.deepEqual(result?.readiness.blockers, ['Windows only.']);
});

test('planned capabilities remain unavailable without executing runtime probes', async () => {
  let called = false;
  const [result] = await resolveCapabilityReadiness([capability('future.domain', 'planned')], deps({
    firmwareProviderStatus: async () => {
      called = true;
      return { available: true };
    }
  }));
  assert.equal(result?.readiness.state, 'unavailable');
  assert.equal(result?.readiness.source, 'static-contract');
  assert.equal(called, false);
});
