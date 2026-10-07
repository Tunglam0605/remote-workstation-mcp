import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { audited } from '../security/audit.js';
import { currentPrincipal } from '../security/request-principal.js';
import { SOCIAL_PLATFORM_IDS } from '../web/domain-policy.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  structuredContent: value as Record<string, unknown>
});

const read = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };
const execute = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const platformSchema = z.enum(SOCIAL_PLATFORM_IDS);
const publishInputSchema = z.object({
  platform: platformSchema,
  mediaRootId: z.string().trim().min(1).max(64),
  path: z.string().trim().min(1).max(4096),
  title: z.string().max(500).optional(),
  description: z.string().max(8_000).optional(),
  hashtags: z.array(z.string().trim().min(1).max(128)).max(30).default([]),
  playlist: z.string().trim().min(1).max(256).optional(),
  scheduleAt: z.string().datetime({ offset: true }).optional(),
  timezone: z.string().trim().min(1).max(128).optional()
});

export function registerSocialTools(server: McpServer, ctx: AppContext) {
  const inSession = async <T>(
    tool: string,
    workSessionId: string,
    operation: (owner: { principalId: string; workSessionId: string }) => Promise<T> | T
  ) => result(await audited(ctx.audit, tool, undefined, () =>
    ctx.runInWorkSession(workSessionId, () => operation({
      principalId: currentPrincipal()?.id ?? ctx.actor.clientId,
      workSessionId
    }))
  ));

  server.registerTool('social_capabilities', {
    description: 'Inspect reusable social-publishing capabilities, owner-enabled platforms, media-root aliases, upload limits and safety boundaries.',
    inputSchema: z.object({}),
    annotations: read
  }, async () => result(await audited(ctx.audit, 'social_capabilities', undefined, async () => ctx.social.capabilities())));

  server.registerTool('social_platform_status', {
    description: 'Inspect browser/profile readiness and owner enablement for YouTube or TikTok without exposing credentials, cookies or tokens.',
    inputSchema: z.object({ platform: platformSchema }),
    annotations: read
  }, async ({ platform }) => result(await audited(ctx.audit, 'social_platform_status', undefined, () => ctx.social.platformStatus(platform))));

  server.registerTool('social_publish_plan', {
    description: 'Create a deterministic SHA-bound social video upload/scheduling plan from an owner-configured media root. Planning never publishes.',
    inputSchema: publishInputSchema,
    annotations: read
  }, async (input) => result(await audited(ctx.audit, 'social_publish_plan', undefined, () => ctx.social.publishPlan(input))));

  server.registerTool('social_session_open', {
    description: 'Open the owner-enabled YouTube/TikTok studio in a dedicated persistent browser profile. Authentication/2FA remains manual and secrets are never exposed.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      platform: platformSchema,
      mode: z.enum(['background', 'visible']).default('visible')
    }),
    annotations: execute
  }, async ({ workSessionId, platform, mode }) =>
    inSession('social_session_open', workSessionId, owner => ctx.social.openSession(platform, owner, mode)));

  server.registerTool('social_session_status', {
    description: 'Inspect a caller-owned social browser session.',
    inputSchema: z.object({ workSessionId: z.string().uuid(), sessionId: z.string().uuid() }),
    annotations: read
  }, async ({ workSessionId, sessionId }) =>
    inSession('social_session_status', workSessionId, owner => ctx.social.sessionStatus(sessionId, owner)));

  server.registerTool('social_session_close', {
    description: 'Close a caller-owned social browser session while preserving its dedicated persistent profile.',
    inputSchema: z.object({ workSessionId: z.string().uuid(), sessionId: z.string().uuid() }),
    annotations: execute
  }, async ({ workSessionId, sessionId }) =>
    inSession('social_session_close', workSessionId, owner => ctx.social.closeSession(sessionId, owner)));

  server.registerTool('social_ui_inspect', {
    description: 'Inspect bounded semantic controls in an owner-enabled YouTube/TikTok studio session and report whether manual login appears required.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      platform: platformSchema,
      sessionId: z.string().uuid(),
      tabId: z.string().uuid()
    }),
    annotations: read
  }, async ({ workSessionId, platform, sessionId, tabId }) =>
    inSession('social_ui_inspect', workSessionId, owner => ctx.social.inspect(platform, sessionId, tabId, owner)));

  server.registerTool('social_transaction_status', {
    description: 'Read one durable social publish transaction so a later chat/runtime can resume from the last verified phase without repeating cloud mutations.',
    inputSchema: z.object({ workSessionId: z.string().uuid(), transactionId: z.string().regex(/^[a-f0-9]{64}$/) }),
    annotations: read
  }, async ({ workSessionId, transactionId }) =>
    inSession('social_transaction_status', workSessionId, owner => ctx.social.transactionStatus(transactionId, owner)));

  server.registerTool('social_transaction_reconcile', {
    description: 'Resolve an interrupted social mutation after semantic/backend inspection. Explicitly record whether the remote mutation was applied before allowing a safe retry or continuation.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      transactionId: z.string().regex(/^[a-f0-9]{64}$/),
      mutation: z.enum(['upload', 'metadata', 'schedule', 'publish', 'verify']),
      outcome: z.enum(['applied', 'not-applied']),
      evidence: z.object({
        observedAt: z.string().datetime({ offset: true }),
        remoteId: z.string().trim().min(1).max(256).optional(),
        url: z.string().trim().min(1).max(2048).optional(),
        note: z.string().trim().min(1).max(1024).optional(),
        scheduleAt: z.string().trim().min(1).max(128).optional(),
        fields: z.array(z.string().trim().min(1).max(128)).max(64).optional()
      })
    }),
    annotations: write
  }, async ({ workSessionId, transactionId, mutation, outcome, evidence }) =>
    inSession('social_transaction_reconcile', workSessionId, owner =>
      ctx.social.reconcileTransaction(transactionId, mutation, outcome, evidence, owner)));

  server.registerTool('social_upload', {
    description: 'Upload one SHA-bound planned video through a semantic file input. This does not press Publish/Post/Schedule and fails closed if login or the upload control is not ready.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      sessionId: z.string().uuid(),
      tabId: z.string().uuid(),
      expectedPlanSha256: z.string().regex(/^[a-f0-9]{64}$/),
      publish: publishInputSchema
    }),
    annotations: write
  }, async ({ workSessionId, sessionId, tabId, expectedPlanSha256, publish }) =>
    inSession('social_upload', workSessionId, owner =>
      ctx.social.upload(publish, expectedPlanSha256, sessionId, tabId, owner)));
}
