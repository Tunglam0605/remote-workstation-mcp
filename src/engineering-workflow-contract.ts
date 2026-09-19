import * as z from 'zod/v4';

export const engineeringWorkflowIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const legacyWorkflowOverridesSchema = z.object({
  artifact: z.string().optional(),
  port: z.string().optional(),
  probeSerial: z.string().optional(),
  targetConfig: z.string().optional(),
  adapterSpeedKhz: z.number().int().min(50).max(24000).optional(),
  monitorPort: z.string().optional(),
  monitorBaudRate: z.number().int().min(300).max(12_000_000).optional(),
  expectText: z.string().min(1).max(512).optional(),
  expectTimeoutMs: z.number().int().min(100).max(120_000).optional(),
  rosPackagesSelect: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/)).max(50).optional(),
  rosSymlinkInstall: z.boolean().optional(),
  rosMergeInstall: z.boolean().optional(),
  debugMaxFrames: z.number().int().min(1).max(64).optional(),
  variant: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/).optional(),
  keilProject: z.string().min(1).max(512).optional(),
  keilTarget: z.string().min(1).max(160).optional()
}).strict().default({});

export const workflowRuntimeParametersSchema = z.object({
  file: z.string().min(1).max(1024).optional(),
  fileName: z.string().min(1).max(180).regex(/^[A-Za-z0-9._-]+$/).optional(),
  artifact: z.string().optional(),
  port: z.string().optional(),
  probeSerial: z.string().optional(),
  targetConfig: z.string().optional(),
  adapterSpeedKhz: z.number().int().min(50).max(24000).optional(),
  monitorPort: z.string().optional(),
  monitorBaudRate: z.number().int().min(300).max(12_000_000).optional(),
  expectText: z.string().min(1).max(512).optional(),
  expectTimeoutMs: z.number().int().min(100).max(120_000).optional(),
  rosPackagesSelect: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/)).max(50).optional(),
  rosSymlinkInstall: z.boolean().optional(),
  rosMergeInstall: z.boolean().optional(),
  debugMaxFrames: z.number().int().min(1).max(64).optional(),
  variant: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/).optional(),
  keilProject: z.string().min(1).max(512).optional(),
  keilTarget: z.string().min(1).max(160).optional(),
  keepMonitorOpen: z.boolean().optional(),
  expectedSha256: z.string().regex(/^[A-Fa-f0-9]{64}$/).optional(),
  expectedSize: z.number().int().positive().max(512 * 1024 * 1024).optional(),
  artifactName: z.string().min(1).max(180).regex(/^[A-Za-z0-9._-]+$/).optional(),
  transferEndpoint: z.string().url().max(2048).optional(),
  transferEndpoints: z.array(z.string().url().max(2048)).min(1).max(8).optional(),
  transferTicket: z.string().min(32).max(256).regex(/^[-_A-Za-z0-9]+$/).optional(),
  transferTimeoutMs: z.number().int().min(5000).max(600000).optional(),
  relaySessionId: z.string().uuid().optional(),
  relayOffset: z.number().int().min(0).max(32 * 1024 * 1024).optional(),
  relayChunkBytes: z.number().int().min(1).max(64 * 1024).optional(),
  relayDataBase64: z.string().min(4).max(90_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).optional(),
  relayChunkSha256: z.string().regex(/^[A-Fa-f0-9]{64}$/).optional(),
  relayTtlMs: z.number().int().min(60_000).max(60 * 60 * 1000).optional(),
  transferGrantId: z.string().min(1).max(96).regex(/^[A-Za-z0-9._-]+$/).optional(),
  sourceNodeId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).optional(),
  destinationNodeId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).optional(),
  sourceWorkspace: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).optional(),
  destinationWorkspace: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).optional(),
  sourcePath: z.string().min(1).max(1024).optional(),
  destinationBasePath: z.string().min(1).max(1024).optional(),
  destinationFileName: z.string().min(1).max(180).regex(/^[A-Za-z0-9._-]+$/).optional(),
  workSessionId: z.string().uuid().optional()
}).strict().default({});

export const persistedWorkflowParametersSchema = workflowRuntimeParametersSchema.removeDefault().omit({
  workSessionId: true,
  transferTicket: true,
  relayDataBase64: true
}).default({});

export const workflowParametersSchema = z.record(z.string().min(1).max(80), z.unknown()).default({});
export const profileProjectSchema = z.object({
  workspace: z.string().min(1),
  projectPath: z.string().default('.')
});

export type WorkflowRuntimeParameters = z.infer<typeof workflowRuntimeParametersSchema>;
export type PersistedWorkflowParameters = z.infer<typeof persistedWorkflowParametersSchema>;
