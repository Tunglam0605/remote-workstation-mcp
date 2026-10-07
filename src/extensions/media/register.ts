import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../../context.js';
import { WindowsSemanticUiAdapter } from '../../adapters/windows-semantic-ui.js';
import { audited } from '../../security/audit.js';
import { CapCutDraftAdapter, type CapCutEditOperation } from './capcut-draft.js';
import { CapCutExportProfileStore } from './capcut-export-profile.js';
import { CapCutNativeExportAdapter } from './capcut-native-export.js';
import { CapCutUiAdapter } from './capcut-ui.js';
import { ComfyUiArtifactImporter } from './comfyui-artifacts.js';
import { ComfyUiPresetJobs } from './comfyui-jobs.js';
import { MediaVideoAdapter, type MediaTranscodePreset } from './media-adapter.js';
import { MediaProfileStore } from './profile-store.js';
import { RemotionRenderAdapter } from './remotion-render.js';
import { RemotionPresetStore } from './remotion-store.js';
import { ComfyUiPresetStore } from './workflow-store.js';
import { mediaWorkflowContributions } from './workflows.js';

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
const comfyProfileId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const comfyPresetId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const comfyParameters = z.record(
  z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/),
  z.union([z.string().max(16_384), z.number().finite(), z.boolean()])
).superRefine((value, ctx) => {
  if (Object.keys(value).length > 64) ctx.addIssue({ code: 'custom', message: 'ComfyUI parameters are limited to 64 bindings.' });
});
const capcutProjectId = z.string().min(1).max(160).refine(value =>
  value !== '.' && value !== '..' && !value.startsWith('.') && !/[\\/\0]/.test(value),
  'CapCut projectId must be one immediate non-hidden draft-folder name.'
);
const capcutSegmentId = z.string().min(1).max(160).refine(value => !/[\\/\0]/.test(value), 'Invalid CapCut segmentId.');
const capcutSha256 = z.string().regex(/^[a-f0-9]{64}$/i);
const capcutExportProfileId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const capcutEditOperation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('trim'), segmentId: capcutSegmentId, sourceStartMs: z.number().finite().min(0).max(604_800_000), sourceDurationMs: z.number().finite().gt(0).max(604_800_000) }).strict(),
  z.object({ op: z.literal('split'), segmentId: capcutSegmentId, offsetMs: z.number().finite().gt(0).max(604_800_000) }).strict(),
  z.object({ op: z.literal('remove_segment'), segmentId: capcutSegmentId }).strict(),
  z.object({ op: z.literal('move'), segmentId: capcutSegmentId, targetStartMs: z.number().finite().min(0).max(604_800_000) }).strict(),
  z.object({ op: z.literal('set_speed'), segmentId: capcutSegmentId, speed: z.number().finite().min(0.05).max(20), preserve: z.enum(['source', 'timeline']).default('source') }).strict(),
  z.object({ op: z.literal('set_volume'), segmentId: capcutSegmentId, volume: z.number().finite().min(0).max(1) }).strict(),
  z.object({ op: z.literal('set_opacity'), segmentId: capcutSegmentId, opacity: z.number().finite().min(0).max(1) }).strict(),
  z.object({ op: z.literal('set_visibility'), segmentId: capcutSegmentId, visible: z.boolean() }).strict(),
  z.object({
    op: z.literal('set_transform'),
    segmentId: capcutSegmentId,
    x: z.number().finite().min(-10).max(10).optional(),
    y: z.number().finite().min(-10).max(10).optional(),
    scale: z.number().finite().min(0.01).max(20).optional(),
    rotationDeg: z.number().finite().min(-3600).max(3600).optional()
  }).strict().refine(value => value.x !== undefined || value.y !== undefined || value.scale !== undefined || value.rotationDeg !== undefined, 'set_transform requires at least one transform field.'),
  z.object({ op: z.literal('set_flip'), segmentId: capcutSegmentId, horizontal: z.boolean().optional(), vertical: z.boolean().optional() }).strict().refine(value => value.horizontal !== undefined || value.vertical !== undefined, 'set_flip requires horizontal or vertical.'),
  z.object({ op: z.literal('set_text'), segmentId: capcutSegmentId, text: z.string().max(10_000) }).strict(),
  z.object({ op: z.literal('add_text_from_template'), segmentId: capcutSegmentId, text: z.string().max(10_000), startMs: z.number().finite().min(0).max(604_800_000), durationMs: z.number().finite().gt(0).max(604_800_000) }).strict(),
  z.object({ op: z.literal('set_text_timing'), segmentId: capcutSegmentId, startMs: z.number().finite().min(0).max(604_800_000), durationMs: z.number().finite().gt(0).max(604_800_000) }).strict()
]);
const capcutOperations = z.array(capcutEditOperation).min(1).max(64);

const remotionPresetId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const remotionParameters = z.record(
  z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/),
  z.union([z.string().max(16_384), z.number().finite(), z.boolean()])
).superRefine((value, ctx) => {
  if (Object.keys(value).length > 64) ctx.addIssue({ code: 'custom', message: 'Remotion parameters are limited to 64 bindings.' });
});

interface MediaServices {
  profiles: MediaProfileStore;
  adapter: MediaVideoAdapter;
  capcut: CapCutDraftAdapter;
  capcutUi: CapCutUiAdapter;
  capcutExport: CapCutNativeExportAdapter;
  capcutExportProfiles: CapCutExportProfileStore;
  remotion: RemotionRenderAdapter;
  jobs: ComfyUiPresetJobs;
  artifacts: ComfyUiArtifactImporter;
}

const mediaServicesByContext = new WeakMap<AppContext, MediaServices>();

function mediaServices(ctx: AppContext): MediaServices {
  const existing = mediaServicesByContext.get(ctx);
  if (existing) return existing;
  const profiles = new MediaProfileStore();
  const jobs = new ComfyUiPresetJobs(profiles, new ComfyUiPresetStore());
  const adapter = new MediaVideoAdapter(ctx.paths, ctx.engineering.runner, profiles);
  const capcut = new CapCutDraftAdapter(ctx.engineering.runner, ctx.engineering.resources);
  const capcutUiEngine = new WindowsSemanticUiAdapter();
  const capcutUi = new CapCutUiAdapter(capcut, capcutUiEngine);
  const capcutExportProfiles = new CapCutExportProfileStore();
  const services: MediaServices = {
    profiles,
    adapter,
    capcut,
    capcutUi,
    capcutExportProfiles,
    capcutExport: new CapCutNativeExportAdapter(
      ctx.paths,
      ctx.engineering.resources,
      capcut,
      capcutUiEngine,
      capcutExportProfiles,
      adapter
    ),
    remotion: new RemotionRenderAdapter(ctx.paths, ctx.engineering.runner, new RemotionPresetStore()),
    jobs,
    artifacts: new ComfyUiArtifactImporter(ctx.paths, profiles, jobs)
  };
  mediaServicesByContext.set(ctx, services);
  return services;
}

export function initializeMediaExtension(ctx: AppContext): void {
  const { adapter, remotion, jobs, artifacts } = mediaServices(ctx);
  for (const contribution of mediaWorkflowContributions({ adapter, remotion, jobs, artifacts })) {
    ctx.engineering.workflows.registerContribution(contribution);
  }
}

export function registerMediaTools(server: McpServer, ctx: AppContext): void {
  const { adapter, capcut, capcutUi, capcutExport, capcutExportProfiles, remotion, jobs, artifacts } = mediaServices(ctx);

  server.registerTool('media_provider_status', {
    description: 'Inspect typed local media-provider readiness for FFmpeg, FFprobe, Remotion launcher availability and owner-local ComfyUI profiles. No media job is started.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'media_provider_status', undefined, () => adapter.providerStatus())));

  server.registerTool('media_capcut_status', {
    description: 'Inspect local CapCut installation, draft-store readiness and Windows semantic UI Automation readiness. No draft or UI element is modified.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async () =>
    result(await audited(ctx.audit, 'media_capcut_status', undefined, async () => ({
      ...(await capcut.providerStatus()),
      uiAutomation: await capcutUi.status()
    }))));

  server.registerTool('media_capcut_ui_inspect', {
    description: 'Read a bounded semantic Windows UI Automation tree for the running CapCut desktop process. Returns names, AutomationIds, control types and supported control patterns only; it never returns screen coordinates, field values, pixels, raw selectors or performs UI actions.',
    inputSchema: z.object({
      maxDepth: z.number().int().min(0).max(12).default(6),
      maxNodes: z.number().int().min(1).max(1024).default(512)
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ maxDepth, maxNodes }) =>
    result(await audited(ctx.audit, 'media_capcut_ui_inspect', undefined, () =>
      capcutUi.inspect({ maxDepth, maxNodes })
    )));

  server.registerTool('media_capcut_export_profile_list', {
    description: 'List owner-local version-bound CapCut native export profiles. Semantic locators remain local configuration and are not exposed through MCP.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () =>
    result(await audited(ctx.audit, 'media_capcut_export_profile_list', undefined, () =>
      capcutExportProfiles.publicList()
    )));

  server.registerTool('media_capcut_export_plan', {
    description: 'Preflight a native CapCut Desktop MP4 export without clicking anything. Requires a configured version-bound semantic profile, exact active draft identity, project-scoped fail-if-exists output and a currently open matching CapCut project. Returns a deterministic plan SHA-256.',
    inputSchema: project.extend({
      capcutProjectId,
      profileId: capcutExportProfileId,
      output: relativeFile
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, capcutProjectId, profileId, output }) =>
    result(await audited(ctx.audit, 'media_capcut_export_plan', workspace, () =>
      capcutExport.plan(workspace, projectPath, capcutProjectId, profileId, output)
    )));

  server.registerTool('media_capcut_export', {
    description: 'Execute one previously reviewed native CapCut Desktop export through version-bound Windows semantic UI Automation. Requires Work Session ownership and the exact export plan SHA-256, never overwrites output, refuses login/subscription/permission/update blockers, and accepts the artifact only after stable size, FFprobe video validation and SHA-256 evidence.',
    inputSchema: project.extend({
      workSessionId: z.string().uuid(),
      capcutProjectId,
      profileId: capcutExportProfileId,
      output: relativeFile,
      expectedPlanSha256: capcutSha256,
      timeoutMs: z.number().int().min(10_000).max(900_000).default(600_000)
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId, capcutProjectId, profileId, output, expectedPlanSha256, timeoutMs }) =>
    result(await audited(ctx.audit, 'media_capcut_export', workspace, () =>
      ctx.runInWorkSession(workSessionId, () =>
        capcutExport.export(
          workspace,
          projectPath,
          capcutProjectId,
          profileId,
          output,
          expectedPlanSha256,
          timeoutMs
        )
      )
    )));

  server.registerTool('media_capcut_project_list', {
    description: 'List bounded local CapCut draft projects with safe timeline metadata and SHA-256 fingerprints. Source media paths and raw draft JSON are not returned.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async () =>
    result(await audited(ctx.audit, 'media_capcut_project_list', undefined, () => capcut.listProjects())));

  server.registerTool('media_capcut_project_inspect', {
    description: 'Inspect one local CapCut draft using a validated immediate draft-folder id. Returns typed tracks/segments, timing, transform/text summaries, mirror consistency and exact draft SHA-256 without exposing raw JSON.',
    inputSchema: z.object({ projectId: capcutProjectId }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ projectId }) =>
    result(await audited(ctx.audit, 'media_capcut_project_inspect', undefined, () => capcut.inspect(projectId))));

  server.registerTool('media_capcut_edit_plan', {
    description: 'Plan 1..64 typed CapCut draft edits against an exact draft SHA-256. Supports bounded trim, conservative split/remove, move, scalar speed, volume, opacity, visibility, transform/flip, plain single-style text, deterministic text cloning from an existing template, and text timing. Raw JSON patches are never accepted and no file is modified.',
    inputSchema: z.object({
      projectId: capcutProjectId,
      expectedSha256: capcutSha256,
      operations: capcutOperations
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ projectId, expectedSha256, operations }) =>
    result(await audited(ctx.audit, 'media_capcut_edit_plan', undefined, () =>
      capcut.editPlan(projectId, expectedSha256, operations as CapCutEditOperation[])
    )));

  server.registerTool('media_capcut_edit', {
    description: 'Apply one previously planned 1..64-operation CapCut edit transactionally. Requires explicit Work Session ownership, exact source SHA-256 and exact planned-result SHA-256, CapCut proven closed, synchronized draft mirrors, an engineering resource lease, owner-local backups, temporary-file validation, verified rollback on failure and post-write SHA acceptance. Raw draft JSON and arbitrary patches are not accepted.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      projectId: capcutProjectId,
      expectedSha256: capcutSha256,
      expectedResultSha256: capcutSha256,
      operations: capcutOperations
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ workSessionId, projectId, expectedSha256, expectedResultSha256, operations }) =>
    result(await audited(ctx.audit, 'media_capcut_edit', undefined, () =>
      ctx.runInWorkSession(workSessionId, () =>
        capcut.edit(projectId, expectedSha256, expectedResultSha256, operations as CapCutEditOperation[])
      )
    )));

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

  server.registerTool('media_remotion_preset_list', {
    description: 'List owner-local typed Remotion render presets and public scalar bindings. Entry-point filesystem paths are not returned.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () =>
    result(await audited(ctx.audit, 'media_remotion_preset_list', undefined, () => remotion.listPresets())));

  server.registerTool('media_remotion_render_plan', {
    description: 'Validate one owner-local Remotion preset, typed parameter overrides and project-scoped MP4 destination without starting a render or modifying the project.',
    inputSchema: project.extend({
      presetId: remotionPresetId,
      parameters: remotionParameters.default({}),
      output: relativeFile
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath, presetId, parameters, output }) =>
    result(await audited(ctx.audit, 'media_remotion_render_plan', workspace, () =>
      remotion.plan(workspace, projectPath, presetId, parameters, output)
    )));

  server.registerTool('media_remotion_render', {
    description: 'Render one owner-local typed Remotion preset into a project-scoped MP4. Requires Work Session ownership, project-local Remotion CLI, a local Chrome/Chromium executable, fail-if-exists output and returns SHA-256 artifact evidence.',
    inputSchema: project.extend({
      workSessionId: z.string().uuid(),
      presetId: remotionPresetId,
      parameters: remotionParameters.default({}),
      output: relativeFile,
      timeoutMs: z.number().int().min(5_000).max(3_600_000).default(900_000)
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId, presetId, parameters, output, timeoutMs }) =>
    result(await audited(ctx.audit, 'media_remotion_render', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => remotion.render(workspace, projectPath, presetId, parameters, output, timeoutMs))
    )));

  server.registerTool('media_comfyui_status', {
    description: 'Inspect one owner-local non-secret ComfyUI endpoint using only GET /system_stats and GET /queue. Returns bounded device/queue summaries and never submits workflows or downloads models.',
    inputSchema: z.object({
      profileId: comfyProfileId,
      timeoutMs: z.number().int().min(250).max(10_000).default(3_000)
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ profileId, timeoutMs }) =>
    result(await audited(ctx.audit, 'media_comfyui_status', undefined, () => adapter.comfyUiStatus(profileId, timeoutMs))));

  server.registerTool('media_comfyui_preset_list', {
    description: 'List owner-local ComfyUI workflow presets and typed public parameter bindings without returning raw workflow JSON or filesystem paths.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () =>
    result(await audited(ctx.audit, 'media_comfyui_preset_list', undefined, () => jobs.listPresets())));

  server.registerTool('media_comfyui_job_plan', {
    description: 'Validate one owner-local ComfyUI preset plus typed parameter overrides without queueing a job. Only manifest-whitelisted scalar bindings can be changed.',
    inputSchema: z.object({
      presetId: comfyPresetId,
      parameters: comfyParameters.default({})
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ presetId, parameters }) =>
    result(await audited(ctx.audit, 'media_comfyui_job_plan', undefined, () => jobs.plan(presetId, parameters))));

  server.registerTool('media_comfyui_job_submit', {
    description: 'Queue one owner-local predeclared ComfyUI preset with typed whitelisted scalar overrides. Requires Work Session ownership and never accepts arbitrary workflow JSON.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      presetId: comfyPresetId,
      parameters: comfyParameters.default({}),
      timeoutMs: z.number().int().min(500).max(30_000).default(10_000)
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ workSessionId, presetId, parameters, timeoutMs }) =>
    result(await audited(ctx.audit, 'media_comfyui_job_submit', undefined, () =>
      ctx.runInWorkSession(workSessionId, () => jobs.submit(presetId, parameters, timeoutMs))
    )));

  server.registerTool('media_comfyui_job_status', {
    description: 'Read bounded ComfyUI history status and artifact metadata for one explicit prompt ID. Raw workflow/history payloads are not returned.',
    inputSchema: z.object({
      profileId: comfyProfileId,
      promptId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
      timeoutMs: z.number().int().min(250).max(15_000).default(5_000)
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ profileId, promptId, timeoutMs }) =>
    result(await audited(ctx.audit, 'media_comfyui_job_status', undefined, () => jobs.status(profileId, promptId, timeoutMs))));


  server.registerTool('media_comfyui_artifact_plan', {
    description: 'Plan import of one completed ComfyUI artifact selected only by prompt ID plus artifact index. Source filename/subfolder come from bounded history metadata; destination must remain inside the selected project and must not already exist.',
    inputSchema: project.extend({
      profileId: comfyProfileId,
      promptId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
      artifactIndex: z.number().int().min(0).max(255),
      destination: relativeFile,
      timeoutMs: z.number().int().min(250).max(15_000).default(5_000)
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  }, async ({ workspace, projectPath, profileId, promptId, artifactIndex, destination, timeoutMs }) =>
    result(await audited(ctx.audit, 'media_comfyui_artifact_plan', workspace, () =>
      artifacts.plan(profileId, promptId, artifactIndex, workspace, projectPath, destination, timeoutMs)
    )));

  server.registerTool('media_comfyui_artifact_import', {
    description: 'Import one durable ComfyUI output artifact selected by history artifact index into the selected project. Requires Work Session ownership, fail-if-exists destination, streaming size bounds, temporary-file cleanup, atomic rename and SHA-256 evidence.',
    inputSchema: project.extend({
      workSessionId: z.string().uuid(),
      profileId: comfyProfileId,
      promptId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
      artifactIndex: z.number().int().min(0).max(255),
      destination: relativeFile,
      timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
      maxBytes: z.number().int().min(1).max(1_073_741_824).default(536_870_912)
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ workspace, projectPath, workSessionId, profileId, promptId, artifactIndex, destination, timeoutMs, maxBytes }) =>
    result(await audited(ctx.audit, 'media_comfyui_artifact_import', workspace, () =>
      ctx.runInWorkSession(workSessionId, () =>
        artifacts.importArtifact(profileId, promptId, artifactIndex, workspace, projectPath, destination, { timeoutMs, maxBytes })
      )
    )));

}
