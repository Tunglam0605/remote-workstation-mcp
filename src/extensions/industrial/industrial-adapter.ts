import type { PolicyEngine } from '../../policy.js';
import type { ModbusRtuAdapter } from '../../adapters/engineering/modbus-rtu.js';
import { ModbusTcpAdapter } from '../modbus-tcp/modbus-tcp-adapter.js';
import { MqttDiagnosticClient } from '../mqtt/mqtt-client.js';
import { MqttProfileStore } from '../mqtt/profile-store.js';
import { OpcUaAdapter } from '../opcua/opcua-adapter.js';
import { IndustrialProfileStore, type IndustrialProfile } from './profile-store.js';

export class IndustrialProfileAdapter {
  private readonly modbus: ModbusTcpAdapter;
  private readonly opcua: OpcUaAdapter;
  private readonly mqttProfiles = new MqttProfileStore();
  private readonly mqttClient = new MqttDiagnosticClient();

  constructor(
    private readonly store: IndustrialProfileStore,
    policy: PolicyEngine,
    private readonly modbusRtu: ModbusRtuAdapter
  ) {
    this.modbus = new ModbusTcpAdapter(policy);
    this.opcua = new OpcUaAdapter(policy);
  }

  async list() {
    const profiles = await this.store.list();
    return {
      ...(await this.store.status()),
      profiles: profiles.map(profile => this.publicProfile(profile))
    };
  }

  async inspect(id: string) {
    return this.publicProfile(await this.store.get(id));
  }

  async preflight(id: string, timeoutMs = 2_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 10_000) {
      throw new Error('Industrial profile timeoutMs must be in range 250..10000.');
    }
    const profile = await this.store.get(id);
    const startedAt = Date.now();

    if (profile.kind === 'modbus-rtu') {
      const endpoint = await this.modbusRtu.endpointStatus(profile.port);
      return {
        profile: this.publicProfile(profile),
        provider: 'modbus-rtu',
        ready: endpoint.discovered,
        durationMs: Date.now() - startedAt,
        evidence: endpoint
      };
    }

    if (profile.kind === 'modbus-tcp') {
      const endpoint = await this.modbus.endpointStatus(profile.host, {
        port: profile.port,
        timeoutMs
      });
      return {
        profile: this.publicProfile(profile),
        provider: 'modbus-tcp',
        ready: endpoint.reachable,
        durationMs: Date.now() - startedAt,
        evidence: endpoint
      };
    }

    if (profile.kind === 'opcua') {
      try {
        const described = await this.opcua.endpointDescribe(profile.endpointUrl, { timeoutMs });
        return {
          profile: this.publicProfile(profile),
          provider: 'opcua',
          ready: described.endpointCount > 0,
          durationMs: Date.now() - startedAt,
          evidence: {
            endpointCount: described.endpointCount,
            truncated: described.truncated
          }
        };
      } catch (error) {
        return {
          profile: this.publicProfile(profile),
          provider: 'opcua',
          ready: false,
          durationMs: Date.now() - startedAt,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 512)
        };
      }
    }

    try {
      const mqttProfile = await this.mqttProfiles.resolve(profile.mqttProfileId);
      const topic = `aubotagv/2.0.0/AUBOT/${profile.vehicle}/state`;
      const sample = await this.mqttClient.sample(mqttProfile, topic, {
        maxMessages: 1,
        timeoutMs,
        maxPayloadBytes: 65_536
      });
      return {
        profile: this.publicProfile(profile),
        provider: 'mqtt-agv',
        ready: true,
        durationMs: Date.now() - startedAt,
        evidence: {
          brokerConnected: true,
          subscriptionAccepted: true,
          messageObserved: sample.messageCount > 0,
          timedOutWaitingForMessage: sample.timedOut
        }
      };
    } catch (error) {
      return {
        profile: this.publicProfile(profile),
        provider: 'mqtt-agv',
        ready: false,
        durationMs: Date.now() - startedAt,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 512)
      };
    }
  }

  private publicProfile(profile: IndustrialProfile) {
    if (profile.kind === 'modbus-rtu') {
      return {
        id: profile.id,
        label: profile.label,
        kind: profile.kind,
        port: profile.port,
        unitId: profile.unitId,
        baudRate: profile.baudRate,
        dataBits: profile.dataBits,
        parity: profile.parity,
        stopBits: profile.stopBits,
        function: profile.function,
        address: profile.address
      };
    }
    if (profile.kind === 'modbus-tcp') {
      return {
        id: profile.id,
        label: profile.label,
        kind: profile.kind,
        host: profile.host,
        port: profile.port,
        unitId: profile.unitId,
        function: profile.function,
        address: profile.address
      };
    }
    if (profile.kind === 'opcua') {
      return {
        id: profile.id,
        label: profile.label,
        kind: profile.kind,
        endpointUrl: profile.endpointUrl,
        rootNodeId: profile.rootNodeId
      };
    }
    return {
      id: profile.id,
      label: profile.label,
      kind: profile.kind,
      mqttProfileId: profile.mqttProfileId,
      vehicle: profile.vehicle,
      topic: `aubotagv/2.0.0/AUBOT/${profile.vehicle}/state`
    };
  }
}
