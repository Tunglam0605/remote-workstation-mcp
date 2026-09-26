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
    description: 'Create one or a bounded batch of NotebookLM Video Overviews by command. If existingSessionId is omitted, RWMCP automatically claims one already-authenticated NotebookLM tab, runs semantic background commands without coordinate mouse/screen control, verifies STARTED/READY postconditions, and releases the claim. Batch mode reuses one claimed tab and runs jobs sequentially. This mutates cloud Studio state and may consume NotebookLM AI quota.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      existingSessionId: z.string().uuid().optional(),
      tabId: z.number().int().positive().optional(),
      focus: z.string().trim().min(1).max(8_000).optional(),
      batch: z.array(z.object({
        id: z.string().trim().min(1).max(128).optional(),
        focus: z.string().trim().min(1).max(8_000)
      }).strict()).min(1).max(25).optional(),
      waitForReady: z.boolean().default(true),
      stopOnError: z.boolean().default(true),
      timeoutMs: z.number().int().min(30_000).max(1_800_000).default(900_000)
    }).superRefine((value, issue) => {
      const modes = Number(Boolean(value.focus)) + Number(Boolean(value.batch));
      if (modes !== 1) issue.addIssue({ code: 'custom', message: 'Provide exactly one of focus or batch.' });
      if (value.batch && !value.waitForReady) issue.addIssue({ code: 'custom', message: 'Batch generation requires waitForReady=true.' });
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  }, async ({ workSessionId, existingSessionId, tabId, focus, batch, waitForReady, stopOnError, timeoutMs }) =>
    executeInSession<unknown>('notebooklm_video_generate', workSessionId, owner => {
      if (batch) {
        return existingSessionId
          ? ctx.notebooklm.videoGenerateBatch(existingSessionId, owner, batch, timeoutMs, stopOnError)
          : ctx.notebooklm.videoGenerateBatchCommand(owner, batch, timeoutMs, stopOnError, tabId);
      }
      const singleFocus = focus!;
      return existingSessionId
        ? ctx.notebooklm.videoGenerate(existingSessionId, owner, singleFocus, waitForReady, timeoutMs)
        : ctx.notebooklm.videoGenerateCommand(owner, singleFocus, waitForReady, timeoutMs, tabId);
    }));

  server.registerTool('notebooklm_content_pipeline', {
    description: 'Run a bounded NotebookLM content pipeline in one authenticated tab claim: verify source readiness, ask for stable source-grounded content, generate 1-25 Video Overviews sequentially, then return artifact inventory. This mutates NotebookLM cloud conversation/Studio state and may consume AI quota.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      existingSessionId: z.string().uuid().optional(),
      tabId: z.number().int().positive().optional(),
      question: z.string().trim().min(1).max(8_000),
      videos: z.array(z.object({
        id: z.string().trim().min(1).max(128).optional(),
        focus: z.string().trim().min(1).max(8_000)
      }).strict()).min(1).max(25),
      minSources: z.number().int().min(1).max(500).default(1),
      askTimeoutMs: z.number().int().min(5_000).max(120_000).default(60_000),
      videoTimeoutMs: z.number().int().min(30_000).max(1_800_000).default(900_000),
      stopOnError: z.boolean().default(true)
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  }, async ({ workSessionId, existingSessionId, tabId, question, videos, minSources, askTimeoutMs, videoTimeoutMs, stopOnError }) =>
    executeInSession('notebooklm_content_pipeline', workSessionId, owner => {
      const options = { question, videos, minSources, askTimeoutMs, videoTimeoutMs, stopOnError };
      return existingSessionId
        ? ctx.notebooklm.contentPipeline(existingSessionId, owner, options)
        : ctx.notebooklm.contentPipelineCommand(owner, options, tabId);
    }));

  server.registerTool('notebooklm_ask', {
    description: 'Ask one bounded NotebookLM question by semantic command and wait for a changed, stable answer postcondition. If existingSessionId is omitted, RWMCP auto-claims an authenticated NotebookLM tab and releases it after completion. This mutates cloud conversation state without coordinate mouse/screen control.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      existingSessionId: z.string().uuid().optional(),
      tabId: z.number().int().positive().optional(),
      question: z.string().trim().min(1).max(8_000),
      timeoutMs: z.number().int().min(5_000).max(120_000).default(60_000)
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  }, async ({ workSessionId, existingSessionId, tabId, question, timeoutMs }) =>
    executeInSession('notebooklm_ask', workSessionId, owner =>
      existingSessionId
        ? ctx.notebooklm.ask(existingSessionId, owner, question, timeoutMs)
        : ctx.notebooklm.askCommand(owner, question, timeoutMs, tabId)));
}
