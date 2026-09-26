import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { audited } from '../security/audit.js';
import { currentPrincipal } from '../security/request-principal.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  structuredContent: value as Record<string, unknown>
});

export function registerNotebookLmTools(server: McpServer, ctx: AppContext) {
  const executeInSession = async <T>(
    tool: string,
    workSessionId: string,
    operation: (owner: { principalId: string; workSessionId: string }) => Promise<T> | T
  ) => result(await audited(ctx.audit, tool, undefined, () =>
    ctx.runInWorkSession(workSessionId, () =>
      operation({
        principalId: currentPrincipal()?.id ?? ctx.actor.clientId,
        workSessionId
      }))));

  server.registerTool('notebooklm_session_open', {
    description: 'Claim one already-authenticated NotebookLM tab through Existing Chrome for this principal + Work Session and verify it is a real notebook page.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      tabId: z.number().int().positive().optional()
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  }, async ({ workSessionId, tabId }) =>
    executeInSession('notebooklm_session_open', workSessionId, owner =>
      ctx.notebooklm.open(owner, tabId)));

  server.registerTool('notebooklm_session_status', {
    description: 'Read bounded NotebookLM notebook metadata for a caller-owned Existing Chrome session. Does not expose cookies, tokens or credentials.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      existingSessionId: z.string().uuid()
    }),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true
    }
  }, async ({ workSessionId, existingSessionId }) =>
    executeInSession('notebooklm_session_status', workSessionId, owner =>
      ctx.notebooklm.status(existingSessionId, owner)));

  server.registerTool('notebooklm_session_close', {
    description: 'Release the NotebookLM Work Session claim without closing the owner Chrome tab.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      existingSessionId: z.string().uuid()
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  }, async ({ workSessionId, existingSessionId }) =>
    executeInSession('notebooklm_session_close', workSessionId, owner =>
      ctx.notebooklm.close(existingSessionId, owner)));

  server.registerTool('notebooklm_sources_list', {
    description: 'List bounded source inventory observed on the current NotebookLM page and compare it with the notebook source count postcondition.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      existingSessionId: z.string().uuid()
    }),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true
    }
  }, async ({ workSessionId, existingSessionId }) =>
    executeInSession('notebooklm_sources_list', workSessionId, owner =>
      ctx.notebooklm.listSources(existingSessionId, owner)));

  server.registerTool('notebooklm_video_status', {
    description: 'Read NotebookLM Video Overview generation state and bounded READY artifact metadata from the claimed notebook tab.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      existingSessionId: z.string().uuid()
    }),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true
    }
  }, async ({ workSessionId, existingSessionId }) =>
    executeInSession('notebooklm_video_status', workSessionId, owner =>
      ctx.notebooklm.videoStatus(existingSessionId, owner)));

  server.registerTool('notebooklm_video_generate', {
    description: 'Create a NotebookLM Video Overview by command. If existingSessionId is omitted, RWMCP automatically claims an already-authenticated NotebookLM tab, runs semantic background commands without coordinate mouse/screen control, waits for STARTED/READY postconditions, then releases the claim. This mutates cloud Studio state and may consume NotebookLM AI quota.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      existingSessionId: z.string().uuid().optional(),
      tabId: z.number().int().positive().optional(),
      focus: z.string().trim().min(1).max(8_000),
      waitForReady: z.boolean().default(true),
      timeoutMs: z.number().int().min(30_000).max(1_800_000).default(900_000)
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  }, async ({ workSessionId, existingSessionId, tabId, focus, waitForReady, timeoutMs }) =>
    executeInSession('notebooklm_video_generate', workSessionId, owner =>
      existingSessionId
        ? ctx.notebooklm.videoGenerate(existingSessionId, owner, focus, waitForReady, timeoutMs)
        : ctx.notebooklm.videoGenerateCommand(owner, focus, waitForReady, timeoutMs, tabId)));

  server.registerTool('notebooklm_ask', {
    description: 'Ask one bounded question in the claimed NotebookLM notebook and wait until a changed, stable conversation postcondition is observed. This mutates cloud conversation state.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      existingSessionId: z.string().uuid(),
      question: z.string().trim().min(1).max(8_000),
      timeoutMs: z.number().int().min(5_000).max(120_000).default(60_000)
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  }, async ({ workSessionId, existingSessionId, question, timeoutMs }) =>
    executeInSession('notebooklm_ask', workSessionId, owner =>
      ctx.notebooklm.ask(existingSessionId, owner, question, timeoutMs)));
}
