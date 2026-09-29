import type { CapabilityDescriptor } from './capabilities.js';

export type CapabilityReadinessState = 'supported' | 'ready' | 'degraded' | 'unavailable';

export interface CapabilityReadiness {
  state: CapabilityReadinessState;
  source: 'static-contract' | 'runtime-probe';
  checkedAt?: string;
  evidence?: Record<string, string | number | boolean>;
  blockers?: string[];
}

export interface RuntimeCapabilityDescriptor extends CapabilityDescriptor {
  readiness: CapabilityReadiness;
}

type FirmwareStatus = {
  available?: boolean;
  executableSource?: string;
  version?: string;
  diagnostic?: { code?: string; message?: string };
};

type CanStatus = {
  supported?: boolean;
  capture?: boolean;
  socketcan?: boolean;
  candump?: boolean;
  pythonFallback?: boolean;
  captureBackend?: string;
  platform?: string;
};

type ModbusStatus = {
  supported?: boolean;
  backend?: string;
  serialPortCount?: number;
};

type NetworkStatus = {
  supported?: boolean;
  interfaceInventory?: boolean;
  dnsLookup?: boolean;
  tcpReachability?: boolean;
  icmpPing?: boolean;
  routeInventory?: boolean;
  platform?: string;
};

type BrowserCapabilities = {
  availability?: { available?: boolean; executable?: string; reason?: string };
};

export interface CapabilityReadinessDependencies {
  firmwareProviderStatus(): Promise<FirmwareStatus>;
  canProviderStatus(): Promise<CanStatus>;
  modbusProviderStatus(): Promise<ModbusStatus>;
  networkProviderStatus(): Promise<NetworkStatus>;
  browserCapabilities(): BrowserCapabilities;
}

const checked = () => new Date().toISOString();

function cleanBlocker(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/\s+/g, ' ').slice(0, 512);
  return normalized || undefined;
}

async function boundedProbe<T>(operation: () => Promise<T>, timeoutMs = 2_500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('readiness probe timed out')), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function probeFailure(error: unknown): CapabilityReadiness {
  return {
    state: 'degraded',
    source: 'runtime-probe',
    checkedAt: checked(),
    blockers: [cleanBlocker(error instanceof Error ? error.message : String(error)) ?? 'runtime readiness probe failed']
  };
}

async function readinessFor(id: string, deps: CapabilityReadinessDependencies): Promise<CapabilityReadiness> {
  try {
    if (id === 'web.automation') {
      const status = deps.browserCapabilities().availability;
      if (status?.available) {
        return {
          state: 'ready',
          source: 'runtime-probe',
          checkedAt: checked(),
          evidence: {
            providerAvailable: true,
            ...(status.executable ? { executable: status.executable } : {})
          }
        };
      }
      return {
        state: 'unavailable',
        source: 'runtime-probe',
        checkedAt: checked(),
        evidence: { providerAvailable: false },
        blockers: [cleanBlocker(status?.reason) ?? 'Managed browser provider is unavailable on this node.']
      };
    }

    if (id === 'engineering.firmware') {
      const status = await boundedProbe(() => deps.firmwareProviderStatus());
      if (status.available) {
        return {
          state: 'ready',
          source: 'runtime-probe',
          checkedAt: checked(),
          evidence: {
            providerAvailable: true,
            ...(status.executableSource ? { executableSource: status.executableSource } : {}),
            ...(status.version ? { version: status.version } : {})
          }
        };
      }
      return {
        state: 'unavailable',
        source: 'runtime-probe',
        checkedAt: checked(),
        evidence: {
          providerAvailable: false,
          ...(status.diagnostic?.code ? { diagnosticCode: status.diagnostic.code } : {})
        },
        blockers: [cleanBlocker(status.diagnostic?.message) ?? 'Firmware provider is unavailable on this node.']
      };
    }

    if (id === 'engineering.can') {
      const status = await boundedProbe(() => deps.canProviderStatus());
      if (!status.supported) {
        return {
          state: 'unavailable',
          source: 'runtime-probe',
          checkedAt: checked(),
          evidence: {
            supported: false,
            ...(status.platform ? { platform: status.platform } : {})
          },
          blockers: ['SocketCAN diagnostics are not supported by the active node platform/provider.']
        };
      }
      const ready = Boolean(status.capture && status.socketcan);
      return {
        state: ready ? 'ready' : 'degraded',
        source: 'runtime-probe',
        checkedAt: checked(),
        evidence: {
          supported: true,
          capture: Boolean(status.capture),
          socketcan: Boolean(status.socketcan),
          candump: Boolean(status.candump),
          pythonFallback: Boolean(status.pythonFallback),
          ...(status.captureBackend ? { captureBackend: status.captureBackend } : {})
        },
        ...(!ready ? { blockers: ['SocketCAN exists, but bounded CAN capture is not fully ready.'] } : {})
      };
    }

    if (id === 'engineering.canopen') {
      const status = await boundedProbe(() => deps.canProviderStatus());
      const passiveCaptureReady = Boolean(status.supported && status.capture && status.socketcan);
      return {
        state: passiveCaptureReady ? 'ready' : 'degraded',
        source: 'runtime-probe',
        checkedAt: checked(),
        evidence: {
          edsDcfInspection: true,
          passiveCaptureReady,
          socketcanSupported: Boolean(status.supported),
          capture: Boolean(status.capture),
          socketcan: Boolean(status.socketcan),
          ...(status.platform ? { platform: status.platform } : {}),
          ...(status.captureBackend ? { captureBackend: status.captureBackend } : {})
        },
        ...(!passiveCaptureReady ? {
          blockers: ['EDS/DCF inspection remains available, but live CANopen capture requires a ready Linux SocketCAN provider.']
        } : {})
      };
    }

    if (id === 'engineering.industrial_profiles') {
      return {
        state: 'ready',
        source: 'static-contract',
        evidence: {
          providerAvailable: true,
          storage: 'owner-local-non-secret',
          readOnly: true
        }
      };
    }

    if (id === 'engineering.opcua') {
      return {
        state: 'ready',
        source: 'static-contract',
        evidence: {
          providerAvailable: true,
          backend: 'node-opcua-client',
          authentication: 'anonymous-only',
          readOnly: true
        }
      };
    }

    if (id === 'engineering.modbus_tcp') {
      return {
        state: 'ready',
        source: 'static-contract',
        evidence: {
          providerAvailable: true,
          backend: 'node:net',
          readOnly: true
        }
      };
    }

    if (id === 'engineering.modbus_rtu') {
      const status = await boundedProbe(() => deps.modbusProviderStatus());
      if (!status.supported) {
        return {
          state: 'unavailable',
          source: 'runtime-probe',
          checkedAt: checked(),
          blockers: ['Modbus RTU provider is unavailable on this node.']
        };
      }
      return {
        state: 'ready',
        source: 'runtime-probe',
        checkedAt: checked(),
        evidence: {
          providerAvailable: true,
          ...(status.backend ? { backend: status.backend } : {}),
          serialPortCount: Math.max(0, Number(status.serialPortCount ?? 0))
        }
      };
    }

    if (id === 'engineering.network') {
      const status = await boundedProbe(() => deps.networkProviderStatus());
      if (!status.supported) {
        return {
          state: 'unavailable',
          source: 'runtime-probe',
          checkedAt: checked(),
          evidence: { supported: false, ...(status.platform ? { platform: status.platform } : {}) },
          blockers: ['Typed network diagnostics are not supported on this platform.']
        };
      }
      const coreReady = Boolean(status.interfaceInventory && status.dnsLookup && status.tcpReachability);
      const optionalReady = Boolean(status.icmpPing && status.routeInventory);
      const state: CapabilityReadinessState = coreReady && optionalReady ? 'ready' : coreReady ? 'degraded' : 'unavailable';
      const blockers: string[] = [];
      if (!status.interfaceInventory) blockers.push('Interface inventory provider is unavailable.');
      if (!status.dnsLookup) blockers.push('DNS lookup provider is unavailable.');
      if (!status.tcpReachability) blockers.push('TCP reachability provider is unavailable.');
      if (!status.icmpPing) blockers.push('ICMP ping executable is unavailable.');
      if (!status.routeInventory) blockers.push('Route inventory provider is unavailable.');
      return {
        state,
        source: 'runtime-probe',
        checkedAt: checked(),
        evidence: {
          interfaceInventory: Boolean(status.interfaceInventory),
          dnsLookup: Boolean(status.dnsLookup),
          tcpReachability: Boolean(status.tcpReachability),
          icmpPing: Boolean(status.icmpPing),
          routeInventory: Boolean(status.routeInventory)
        },
        ...(blockers.length ? { blockers } : {})
      };
    }

    return { state: 'supported', source: 'static-contract' };
  } catch (error) {
    return probeFailure(error);
  }
}

export async function resolveCapabilityReadiness(
  capabilities: readonly CapabilityDescriptor[],
  deps: CapabilityReadinessDependencies
): Promise<RuntimeCapabilityDescriptor[]> {
  return await Promise.all(capabilities.map(async capability => ({
    ...capability,
    readiness: capability.status === 'planned'
      ? { state: 'unavailable', source: 'static-contract' }
      : await readinessFor(capability.id, deps)
  })));
}
