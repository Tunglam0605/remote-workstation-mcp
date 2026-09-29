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
    description: 'Inspect read-only camera diagnostics readiness, including the built-in RTSP probe backend and optional ffprobe metadata backend.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'camera_provider_status', undefined, () => adapter.providerStatus())));

  server.registerTool('camera_profile_list', {
    description: 'List bounded owner-local non-secret anonymous RTSP camera profiles. Phase 1 profiles never contain credentials, query tokens, PTZ or talk configuration.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'camera_profile_list', undefined, () => adapter.listProfiles())));

  server.registerTool('camera_profile_inspect', {
    description: 'Inspect one owner-local non-secret camera profile without opening the stream.',
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
    description: 'Run bounded ffprobe metadata inspection for an anonymous owner-local RTSP camera profile. This executes a fixed local ffprobe argv but does not modify the camera, start PTZ/talk or create output artifacts.',
    inputSchema: z.object({
      profileId,
      timeoutMs: z.number().int().min(500).max(15_000).default(5_000)
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ profileId: selected, timeoutMs }) => result(await audited(ctx.audit, 'camera_stream_metadata', undefined, () => adapter.metadata(selected, timeoutMs))));
}
