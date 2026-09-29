import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../../context.js';
import { audited } from '../../security/audit.js';
import { CameraDiagnosticsAdapter } from './camera-adapter.js';
import { CameraProfileStore } from './profile-store.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

const profileId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

export function registerCameraTools(server: McpServer, ctx: AppContext): void {
  const adapter = new CameraDiagnosticsAdapter(new CameraProfileStore(), ctx.engineering.runner);

  server.registerTool('camera_provider_status', {
    description: 'Inspect camera diagnostics readiness, including bounded RTSP/ffprobe observation and owner-local ONVIF PTZ readiness.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'camera_provider_status', undefined, () => adapter.providerStatus())));

  server.registerTool('camera_profile_list', {
    description: 'List bounded owner-local camera profiles. PTZ credential references remain owner-local and are redacted from tool output.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'camera_profile_list', undefined, () => adapter.listProfiles())));

  server.registerTool('camera_profile_inspect', {
    description: 'Inspect one owner-local camera profile without opening the stream or disclosing PTZ credentials.',
    inputSchema: z.object({ profileId }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ profileId: selected }) => result(await audited(ctx.audit, 'camera_profile_inspect', undefined, () => adapter.inspectProfile(selected))));

  server.registerTool('camera_rtsp_probe', {
    description: 'Send one bounded read-only RTSP DESCRIBE request to an explicit owner-local camera profile. Reports reachability, auth requirement, server metadata and SDP tracks without credentials or configuration mutation.',
    inputSchema: z.object({
      profileId,
      timeoutMs: z.number().int().min(250).max(10_000).default(3_000)
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ profileId: selected, timeoutMs }) => result(await audited(ctx.audit, 'camera_rtsp_probe', undefined, () => adapter.probe(selected, timeoutMs))));

  server.registerTool('camera_stream_metadata', {
    description: 'Run bounded ffprobe metadata inspection for an anonymous owner-local RTSP camera profile. This executes a fixed local ffprobe argv but does not modify the camera or create output artifacts.',
    inputSchema: z.object({
      profileId,
      timeoutMs: z.number().int().min(500).max(15_000).default(5_000)
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ profileId: selected, timeoutMs }) => result(await audited(ctx.audit, 'camera_stream_metadata', undefined, () => adapter.metadata(selected, timeoutMs))));

  server.registerTool('camera_ptz_status', {
    description: 'Read bounded ONVIF PTZ position/move status for one owner-local camera profile. Credentials stay owner-local and are never accepted as MCP arguments.',
    inputSchema: z.object({
      profileId,
      timeoutMs: z.number().int().min(250).max(10_000).default(3_000)
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ profileId: selected, timeoutMs }) => result(
    await audited(ctx.audit, 'camera_ptz_status', undefined, () => adapter.ptzStatus(selected, timeoutMs))
  ));

  server.registerTool('camera_ptz_move', {
    description: 'Perform one bounded ONVIF PTZ continuous move with normalized pan/tilt/zoom axes in [-1,1]. Movement duration is capped at 2000 ms and the tool always sends Stop afterward. No raw SOAP/XML or arbitrary endpoint is accepted.',
    inputSchema: z.object({
      profileId,
      pan: z.number().min(-1).max(1).default(0),
      tilt: z.number().min(-1).max(1).default(0),
      zoom: z.number().min(-1).max(1).default(0),
      durationMs: z.number().int().min(50).max(2_000).default(250),
      timeoutMs: z.number().int().min(250).max(10_000).default(3_000)
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ profileId: selected, pan, tilt, zoom, durationMs, timeoutMs }) => result(
    await audited(ctx.audit, 'camera_ptz_move', undefined, () =>
      adapter.ptzMove(selected, { pan, tilt, zoom }, durationMs, timeoutMs)
    )
  ));

  server.registerTool('camera_ptz_stop', {
    description: 'Send a bounded ONVIF PTZ Stop for pan/tilt and zoom on one owner-local camera profile. No raw SOAP/XML or arbitrary endpoint is accepted.',
    inputSchema: z.object({
      profileId,
      timeoutMs: z.number().int().min(250).max(10_000).default(3_000)
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ profileId: selected, timeoutMs }) => result(
    await audited(ctx.audit, 'camera_ptz_stop', undefined, () => adapter.ptzStop(selected, timeoutMs))
  ));

  server.registerTool('camera_fleet_probe', {
    description: 'Probe up to 32 owner-local camera profiles concurrently using bounded RTSP DESCRIBE requests. Aggregates health, auth-required state, media-track evidence and p50/p95 latency without mutating cameras.',
    inputSchema: z.object({
      profileIds: z.array(profileId).max(32).default([]),
      concurrency: z.number().int().min(1).max(8).default(4),
      timeoutMs: z.number().int().min(250).max(10_000).default(3_000)
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ profileIds, concurrency, timeoutMs }) => result(
    await audited(ctx.audit, 'camera_fleet_probe', undefined, () =>
      adapter.fleetProbe({ profileIds, concurrency, timeoutMs })
    )
  ));
}
