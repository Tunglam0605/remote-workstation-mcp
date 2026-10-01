import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../../context.js';
import { audited } from '../../security/audit.js';
import { findJsonObservations, type JsonScalar } from './json-observer.js';
import { MqttDiagnosticClient } from './mqtt-client.js';
import { MqttProfileStore } from './profile-store.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

const profileId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const topicFilter = z.string().min(1).max(512);

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

  server.registerTool('mqtt_json_observe', {
    description: 'Subscribe through one owner-local MQTT profile, find bounded JSON objects containing a requested property, optionally require an exact scalar value, and return only selected scalar fields plus JSON paths. This is protocol-generic, read-only and never publishes.',
    inputSchema: z.object({
      profileId,
      topicFilter,
      matchField: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
      matchEquals: z.union([z.string().max(512), z.number().finite(), z.boolean(), z.null()]).optional(),
      selectFields: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/)).max(32).default([]),
      maxMessages: z.number().int().min(1).max(100).default(20),
      timeoutMs: z.number().int().min(250).max(30_000).default(5_000),
      maxDepth: z.number().int().min(0).max(8).default(5),
      maxVisited: z.number().int().min(1).max(1024).default(256),
      maxMatches: z.number().int().min(1).max(128).default(32)
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ profileId: selected, topicFilter: topic, matchField, matchEquals, selectFields, maxMessages, timeoutMs, maxDepth, maxVisited, maxMatches }) => result(
    await audited(ctx.audit, 'mqtt_json_observe', undefined, async () => {
      const sample = await client.sample(await profiles.resolve(selected), topic, {
        maxMessages,
        timeoutMs,
        maxPayloadBytes: 65_536
      });
      const observations = sample.messages.flatMap((message, messageIndex) => {
        if (message.json === undefined) return [];
        return findJsonObservations(message.json, {
          matchField,
          ...(matchEquals !== undefined ? { matchEquals: matchEquals as JsonScalar } : {}),
          selectFields,
          maxDepth,
          maxVisited,
          maxMatches
        }).map(observation => ({
          messageIndex,
          topic: message.topic,
          ...observation
        }));
      }).slice(0, maxMatches);
      return {
        profileId: selected,
        topicFilter: topic,
        messageCount: sample.messageCount,
        jsonMessageCount: sample.messages.filter(message => message.json !== undefined).length,
        observationCount: observations.length,
        latest: observations.at(-1) ?? null,
        observations,
        timedOut: sample.timedOut
      };
    })
  ));

}
