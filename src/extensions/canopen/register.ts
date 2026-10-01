import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../../context.js';
import { audited } from '../../security/audit.js';
import { CanopenAdapter } from './canopen-adapter.js';
import { CanopenEds } from './eds.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

const interfaceName = z.string().min(1).max(15).regex(/^[A-Za-z0-9_.:-]+$/);
const nodeId = z.number().int().min(1).max(127);

export function registerCanopenTools(server: McpServer, ctx: AppContext): void {
  const adapter = new CanopenAdapter(ctx.engineering.can);
  const eds = new CanopenEds(ctx.paths);
  const source = { workspace: z.string().min(1).max(128), projectPath: z.string().min(1).max(1024).default('.'), edsPath: z.string().min(1).max(1024) };

  server.registerTool('canopen_provider_status', {
    description: 'Inspect CANopen Phase 2 readiness. Project-scoped EDS/DCF inspection is offline and cross-platform; live passive capture additionally requires the existing read-only Linux SocketCAN provider. No CAN frame is transmitted.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'canopen_provider_status', undefined, () => adapter.providerStatus())));

  server.registerTool('canopen_capture_decode', {
    description: 'Capture a bounded passive SocketCAN sample and decode standard 11-bit CANopen NMT, SYNC, EMCY, PDO, SDO and Heartbeat traffic. This never transmits, replays or configures CAN frames.',
    inputSchema: z.object({
      interface: interfaceName,
      count: z.number().int().min(1).max(1000).default(250),
      inactivityTimeoutMs: z.number().int().min(100).max(30_000).default(3_000),
      nodeIds: z.array(nodeId).max(32).default([])
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ interface: selected, count, inactivityTimeoutMs, nodeIds }) => result(
    await audited(ctx.audit, 'canopen_capture_decode', undefined, () => adapter.captureDecode(selected, { count, inactivityTimeoutMs, nodeIds }))
  ));

  server.registerTool('canopen_node_observe', {
    description: 'Passively observe explicit or traffic-discovered CANopen node IDs and summarize Heartbeat/NMT state, boot-up, EMCY, SDO and PDO evidence from one bounded capture. An empty nodeIds list discovers only nodes already visible in captured traffic and never scans or transmits on the bus.',
    inputSchema: z.object({
      interface: interfaceName,
      count: z.number().int().min(1).max(1000).default(250),
      inactivityTimeoutMs: z.number().int().min(100).max(30_000).default(3_000),
      nodeIds: z.array(nodeId).max(32).default([])
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ interface: selected, count, inactivityTimeoutMs, nodeIds }) => result(
    await audited(ctx.audit, 'canopen_node_observe', undefined, () => adapter.observeNodes(selected, { count, inactivityTimeoutMs, nodeIds }))
  ));

  server.registerTool('canopen_eds_inspect', {
    description: 'Inspect bounded object dictionary entries from a project-scoped EDS/DCF file and summarize communication parameters. Optional nodeId resolves $NODEID expressions; when omitted, bounded DCF commissioning NodeID metadata may be used. No CAN access.',
    inputSchema: z.object({ ...source, startIndex: z.number().int().min(0).max(0xffff).default(0), limit: z.number().int().min(1).max(128).default(64), nodeId: nodeId.optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath, edsPath, startIndex, limit, nodeId: selectedNodeId }) => result(
    await audited(ctx.audit, 'canopen_eds_inspect', workspace, async () => (await eds.load(workspace, projectPath, edsPath)).inspect(startIndex, limit, selectedNodeId))
  ));

  server.registerTool('canopen_eds_profile', {
    description: 'Summarize CANopen CiA 301 communication profile parameters from a project-scoped EDS/DCF: heartbeat, SYNC counter, default SDO server COB-IDs and PDO communication/mapping slots. Optional nodeId resolves $NODEID expressions; when omitted, bounded DCF commissioning NodeID metadata may be used. Read-only; no CAN access.',
    inputSchema: z.object({ ...source, nodeId: nodeId.optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath, edsPath, nodeId: selectedNodeId }) => result(
    await audited(ctx.audit, 'canopen_eds_profile', workspace, async () => (await eds.load(workspace, projectPath, edsPath)).communicationProfile(selectedNodeId))
  ));

  server.registerTool('canopen_object_lookup', {
    description: 'Look up one exact index and sub-index in a project-scoped EDS/DCF object dictionary.',
    inputSchema: z.object({ ...source, index: z.number().int().min(0).max(0xffff), subIndex: z.number().int().min(0).max(255).default(0) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath, edsPath, index, subIndex }) => result(
    await audited(ctx.audit, 'canopen_object_lookup', workspace, async () => ({ index, subIndex, object: (await eds.load(workspace, projectPath, edsPath)).lookup(index, subIndex) ?? null }))
  ));

  server.registerTool('canopen_capture_semantic_decode', {
    description: 'Passively capture CANopen traffic and annotate SDO/PDO values using a project-scoped EDS/DCF dictionary. No frames are transmitted.',
    inputSchema: z.object({ ...source, interface: interfaceName, count: z.number().int().min(1).max(1000).default(250),
      inactivityTimeoutMs: z.number().int().min(100).max(30_000).default(3_000), nodeIds: z.array(nodeId).max(32).default([]) }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, edsPath, interface: selected, count, inactivityTimeoutMs, nodeIds }) => result(
    await audited(ctx.audit, 'canopen_capture_semantic_decode', workspace, async () =>
      adapter.captureSemanticDecode(selected, await eds.load(workspace, projectPath, edsPath), { count, inactivityTimeoutMs, nodeIds }))
  ));
}
