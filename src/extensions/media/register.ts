import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../../context.js';
import { audited } from '../../security/audit.js';
import { MediaVideoAdapter, type MediaTranscodePreset } from './media-adapter.js';
import { MediaProfileStore } from './profile-store.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

const project = z.object({
  workspace: z.string().min(1),
  projectPath: z.string().default('.')
});
const relativeFile = z.string().min(1).max(1024);
const preset = z.enum(['h264-1080p', 'h264-720p', 'h264-vertical-1080x1920', 'web-preview']);

export function registerMediaTools(server: McpServer, ctx: AppContext): void {
  const adapter = new MediaVideoAdapter(ctx.paths, ctx.engineering.runner, new MediaProfileStore());

  server.registerTool('media_provider_status', {
    description: 'Inspect typed local media-provider readiness for FFmpeg, FFprobe, Remotion launcher availability and owner-local ComfyUI profiles. No media job is started.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'media_provider_status', undefined, () => adapter.providerStatus())));

  server.registerTool('media_file_probe', {
    description: 'Inspect one project-scoped media file through a fixed bounded ffprobe command and return format/stream metadata. No file is modified.',
    inputSchema: project.extend({
      input: relativeFile,
      timeoutMs: z.number().int().min(500).max(15_000).default(5_000)
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, input, timeoutMs }) =>
    result(await audited(ctx.audit, 'media_file_probe', workspace, () => adapter.probeFile(workspace, projectPath, input, timeoutMs))));

  server.registerTool('media_transcode_plan', {
    description: 'Plan one typed project-scoped FFmpeg transcode without running FFmpeg or creating output. Output must remain inside the selected project and must not already exist.',
    inputSchema: project.extend({
      input: relativeFile,
      output: relativeFile,
      preset
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath, input, output, preset }) =>
    result(await audited(ctx.audit, 'media_transcode_plan', workspace, () => adapter.transcodePlan(workspace, projectPath, input, output, preset as MediaTranscodePreset))));

  server.registerTool('media_transcode', {
    description: 'Run one typed project-scoped FFmpeg transcode with a fixed preset. Requires Work Session ownership, never accepts raw FFmpeg arguments, never overwrites an existing output, and returns SHA-256 evidence for the new artifact.',
    inputSchema: project.extend({
      workSessionId: z.string().uuid(),
      input: relativeFile,
      output: relativeFile,
      preset,
      timeoutMs: z.number().int().min(1_000).max(900_000).default(120_000)
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId, input, output, preset, timeoutMs }) =>
    result(await audited(ctx.audit, 'media_transcode', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => adapter.transcode(workspace, projectPath, input, output, preset as MediaTranscodePreset, timeoutMs))
    )));

  server.registerTool('media_remotion_status', {
    description: 'Inspect project-local package metadata for Remotion packages and render-related scripts without executing npm/npx or modifying the project.',
    inputSchema: project.strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath }) =>
    result(await audited(ctx.audit, 'media_remotion_status', workspace, () => adapter.remotionStatus(workspace, projectPath))));

  server.registerTool('media_comfyui_status', {
    description: 'Inspect one owner-local non-secret ComfyUI endpoint using only GET /system_stats and GET /queue. Returns bounded device/queue summaries and never submits workflows or downloads models.',
    inputSchema: z.object({
      profileId: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
      timeoutMs: z.number().int().min(250).max(10_000).default(3_000)
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ profileId, timeoutMs }) =>
    result(await audited(ctx.audit, 'media_comfyui_status', undefined, () => adapter.comfyUiStatus(profileId, timeoutMs))));
}
