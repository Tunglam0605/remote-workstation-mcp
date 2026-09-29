import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../../context.js';
import { audited } from '../../security/audit.js';
import { findLiftSensorStatus } from './agv.js';
import { MqttDiagnosticClient } from './mqtt-client.js';
import { MqttProfileStore } from './profile-store.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

const profileId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const topicFilter = z.string().min(1).max(512);
const vehicle = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);

export function registerMqttTools(server: McpServer, ctx: AppContext): void {
  const profiles = new MqttProfileStore();
  const client = new MqttDiagnosticClient();

  server.registerTool('mqtt_provider_status', {
    description: 'Inspect owner-local MQTT diagnostic profile readiness without exposing passwords or broker credentials. MQTT Phase 1 is subscribe-only and never publishes.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'mqtt_provider_status', undefined, async () => ({
    supported: true,
    protocol: 'MQTT 3.1.1',
    authority: 'read-only-subscribe',
    profiles: await profiles.status(),
    intentionallyUnavailable: ['PUBLISH', 'retained-message mutation', 'broker configuration', 'credential mutation', 'will-message publishing']
  }))));

  server.registerTool('mqtt_subscribe_sample', {
    description: 'Subscribe through one owner-local MQTT profile and collect a bounded sample of messages. Credentials stay in owner-local configuration/environment and are never accepted as MCP arguments. No message is published.',
    inputSchema: z.object({
      profileId,
      topicFilter,
      maxMessages: z.number().int().min(1).max(100).default(10),
      timeoutMs: z.number().int().min(250).max(30_000).default(5_000),
      maxPayloadBytes: z.number().int().min(256).max(262_144).default(65_536)
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ profileId: selected, topicFilter: topic, maxMessages, timeoutMs, maxPayloadBytes }) => result(
    await audited(ctx.audit, 'mqtt_subscribe_sample', undefined, async () =>
      await client.sample(await profiles.resolve(selected), topic, { maxMessages, timeoutMs, maxPayloadBytes })
    )
  ));

  server.registerTool('mqtt_agv_lift_observe', {
    description: 'Observe bounded AGV lift-sensor state from aubotagv/2.0.0/AUBOT/<vehicle>/state using an owner-local MQTT profile. Finds liftSensorStatus JSON evidence and derives up/down/between/conflict conservatively. No command is published.',
    inputSchema: z.object({
      profileId,
      vehicle,
      maxMessages: z.number().int().min(1).max(100).default(20),
      timeoutMs: z.number().int().min(250).max(30_000).default(5_000)
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ profileId: selected, vehicle: vehicleId, maxMessages, timeoutMs }) => result(
    await audited(ctx.audit, 'mqtt_agv_lift_observe', undefined, async () => {
      const topic = `aubotagv/2.0.0/AUBOT/${vehicleId}/state`;
      const sample = await client.sample(await profiles.resolve(selected), topic, {
        maxMessages,
        timeoutMs,
        maxPayloadBytes: 65_536
      });
      const matches = sample.messages.flatMap((message, index) => {
        const status = message.json === undefined ? undefined : findLiftSensorStatus(message.json);
        return status ? [{ index, topic: message.topic, ...status }] : [];
      });
      return {
        profileId: selected,
        vehicle: vehicleId,
        topic,
        messageCount: sample.messageCount,
        liftStatusCount: matches.length,
        latest: matches.at(-1) ?? null,
        observations: matches.slice(-32),
        timedOut: sample.timedOut
      };
    })
  ));
}
