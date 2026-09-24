import { McpServer } from '@modelcontextprotocol/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { audited } from '../security/audit.js';
import { currentPrincipal } from '../security/request-principal.js';
import { SEMANTIC_ROLES } from '../web/browser-provider.js';

const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> });
const ownerSchema = { workSessionId: z.string().uuid(), sessionId: z.string().uuid() };
const tabSchema = { ...ownerSchema, tabId: z.string().uuid() };
const elementSchema = { ...tabSchema, elementId: z.string().regex(/^el_\d+_\d+$/) };
const read = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };
const execute = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const roleSchema = z.enum(SEMANTIC_ROLES);
const pressKeySchema = z.enum([
  'Enter', 'Tab', 'Escape', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Backspace', 'Delete',
  'Control+A', 'Meta+A'
]);
const uploadFileSchema = z.object({
  workspace: z.string().min(1).max(128),
  path: z.string().min(1).max(4096)
});

function mimeForUpload(filename: string): string {
  const known: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp'
  };
  return known[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

const waitConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(512), state: z.enum(['visible', 'hidden']) }),
  z.object({ kind: z.literal('url'), value: z.url().max(2048), match: z.enum(['exact', 'prefix']).default('exact') }),
  z.object({ kind: z.literal('element'), role: roleSchema, name: z.string().min(1).max(256), state: z.enum(['visible', 'hidden', 'enabled', 'disabled']) }),
  z.object({ kind: z.literal('load'), state: z.enum(['domcontentloaded', 'load', 'networkidle']) })
]);

export function registerBrowserTools(server: McpServer, ctx: AppContext) {
  const executeInSession = async <T>(tool: string, workSessionId: string, operation: (owner: { principalId: string; workSessionId: string }) => Promise<T> | T) =>
    result(await audited(ctx.audit, tool, undefined, () => ctx.runInWorkSession(workSessionId, () => operation({ principalId: currentPrincipal()?.id ?? ctx.actor.clientId, workSessionId }))));

  server.registerTool('browser_capabilities', { description: 'Managed browser provider capabilities and availability; production navigation is default-deny.', inputSchema: z.object({}), annotations: read },
    async () => result(await audited(ctx.audit, 'browser_capabilities', undefined, async () => ctx.browser.capabilities())));
  server.registerTool('browser_provider_status', { description: 'Check managed Chrome/Edge availability without starting a browser.', inputSchema: z.object({}), annotations: read },
    async () => result(await audited(ctx.audit, 'browser_provider_status', undefined, async () => ctx.browser.capabilities().availability)));
  server.registerTool('browser_profile_status', {
    description: 'Inspect existence and active ownership state for one dedicated RWMCP managed-browser profile. Cookies, storage and credentials are never returned.',
    inputSchema: z.object({ profile: z.string().trim().min(1).max(64) }),
    annotations: read
  }, async ({ profile }) => result(await audited(ctx.audit, 'browser_profile_status', undefined, () => ctx.browser.profileStatus(profile))));

  server.registerTool('browser_session_create', {
    description: 'Launch a caller-owned managed browser under an explicit Work Session. Supplying profile uses a dedicated persistent RWMCP browser profile; omitting it creates an ephemeral isolated session.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      mode: z.enum(['background', 'visible']).default('background'),
      profile: z.string().trim().min(1).max(64).optional()
    }),
    annotations: execute
  }, async ({ workSessionId, mode, profile }) =>
    executeInSession('browser_session_create', workSessionId, owner => ctx.browser.create(owner, mode, profile)));
  server.registerTool('browser_session_status', { description: 'Inspect a caller-owned managed browser session.', inputSchema: z.object(ownerSchema), annotations: read },
    async ({ workSessionId, sessionId }) => executeInSession('browser_session_status', workSessionId, owner => ctx.browser.status(sessionId, owner)));
  server.registerTool('browser_session_close', { description: 'Close a managed browser session.', inputSchema: z.object(ownerSchema), annotations: execute },
    async ({ workSessionId, sessionId }) => executeInSession('browser_session_close', workSessionId, owner => ctx.browser.close(sessionId, owner)));
  server.registerTool('browser_tabs_list', { description: 'List tabs of a caller-owned browser.', inputSchema: z.object(ownerSchema), annotations: read },
    async ({ workSessionId, sessionId }) => executeInSession('browser_tabs_list', workSessionId, owner => ctx.browser.tabs(sessionId, owner)));
  server.registerTool('browser_tab_open', { description: 'Open an empty managed tab.', inputSchema: z.object(ownerSchema), annotations: execute },
    async ({ workSessionId, sessionId }) => executeInSession('browser_tab_open', workSessionId, owner => ctx.browser.openTab(sessionId, owner)));
  server.registerTool('browser_tab_activate', { description: 'Set the active managed tab.', inputSchema: z.object(tabSchema), annotations: execute },
    async ({ workSessionId, sessionId, tabId }) => executeInSession('browser_tab_activate', workSessionId, owner => ctx.browser.activateTab(sessionId, tabId, owner)));
  server.registerTool('browser_tab_close', { description: 'Close a managed tab.', inputSchema: z.object(tabSchema), annotations: execute },
    async ({ workSessionId, sessionId, tabId }) => executeInSession('browser_tab_close', workSessionId, owner => ctx.browser.closeTab(sessionId, tabId, owner)));
  server.registerTool('browser_navigate', { description: 'Navigate to an allowlisted HTTP(S) URL; redirects are checked by policy.', inputSchema: z.object({ ...tabSchema, url: z.url().max(2048) }), annotations: execute },
    async ({ workSessionId, sessionId, tabId, url }) => executeInSession('browser_navigate', workSessionId, owner => ctx.browser.navigate(sessionId, tabId, owner, 'goto', url)));
  for (const action of ['back', 'forward', 'reload'] as const) {
    server.registerTool(`browser_${action}`, { description: `${action} in a managed tab, with domain policy enforced.`, inputSchema: z.object(tabSchema), annotations: execute },
      async ({ workSessionId, sessionId, tabId }) => executeInSession(`browser_${action}`, workSessionId, owner => ctx.browser.navigate(sessionId, tabId, owner, action)));
  }
  server.registerTool('browser_inspect', { description: 'Bounded semantic page inspection that returns short-lived element references; no raw DOM or selectors.', inputSchema: z.object({ ...tabSchema, maxItems: z.number().int().min(1).max(50).default(30) }), annotations: read },
    async ({ workSessionId, sessionId, tabId, maxItems }) => executeInSession('browser_inspect', workSessionId, owner => ctx.browser.inspect(sessionId, tabId, owner, maxItems)));
  server.registerTool('browser_find', { description: 'Find exact accessible role and name and return short-lived semantic references.', inputSchema: z.object({ ...tabSchema, role: roleSchema, name: z.string().min(1).max(256), maxItems: z.number().int().min(1).max(50).default(20) }), annotations: read },
    async ({ workSessionId, sessionId, tabId, role, name, maxItems }) => executeInSession('browser_find', workSessionId, owner => ctx.browser.find(sessionId, tabId, owner, role, name, maxItems)));
  server.registerTool('browser_extract', { description: 'Extract bounded visible page text.', inputSchema: z.object({ ...tabSchema, maxChars: z.number().int().min(1).max(16_000).default(8_000) }), annotations: read },
    async ({ workSessionId, sessionId, tabId, maxChars }) => executeInSession('browser_extract', workSessionId, owner => ctx.browser.extract(sessionId, tabId, owner, maxChars)));
  server.registerTool('browser_screenshot', { description: 'Capture viewport to controlled RWMCP artifact state; return metadata only.', inputSchema: z.object(tabSchema), annotations: read },
    async ({ workSessionId, sessionId, tabId }) => executeInSession('browser_screenshot', workSessionId, owner => ctx.browser.screenshot(sessionId, tabId, owner)));

  server.registerTool('browser_click', { description: 'Activate one short-lived semantic element reference using Playwright actionability checks; no coordinates or force-click.', inputSchema: z.object(elementSchema), annotations: write },
    async ({ workSessionId, sessionId, tabId, elementId }) => executeInSession('browser_click', workSessionId, owner => ctx.browser.interact(sessionId, tabId, owner, elementId, { kind: 'click' })));
  server.registerTool('browser_fill', { description: 'Replace the value of a semantic form control with bounded text.', inputSchema: z.object({ ...elementSchema, value: z.string().max(8_000) }), annotations: write },
    async ({ workSessionId, sessionId, tabId, elementId, value }) => executeInSession('browser_fill', workSessionId, owner => ctx.browser.interact(sessionId, tabId, owner, elementId, { kind: 'fill', value })));
  server.registerTool('browser_type', { description: 'Type bounded text sequentially into a semantic form control.', inputSchema: z.object({ ...elementSchema, text: z.string().max(8_000), delayMs: z.number().int().min(0).max(100).default(0) }), annotations: write },
    async ({ workSessionId, sessionId, tabId, elementId, text, delayMs }) => executeInSession('browser_type', workSessionId, owner => ctx.browser.interact(sessionId, tabId, owner, elementId, { kind: 'type', text, delayMs })));
  server.registerTool('browser_press', { description: 'Press one bounded browser-control key on a semantic element; OS/global shortcuts are not exposed.', inputSchema: z.object({ ...elementSchema, key: pressKeySchema }), annotations: write },
    async ({ workSessionId, sessionId, tabId, elementId, key }) => executeInSession('browser_press', workSessionId, owner => ctx.browser.interact(sessionId, tabId, owner, elementId, { kind: 'press', key })));
  server.registerTool('browser_select', { description: 'Select one bounded option value on a semantic combobox/select control.', inputSchema: z.object({ ...elementSchema, value: z.string().max(256) }), annotations: write },
    async ({ workSessionId, sessionId, tabId, elementId, value }) => executeInSession('browser_select', workSessionId, owner => ctx.browser.interact(sessionId, tabId, owner, elementId, { kind: 'select', value })));
  server.registerTool('browser_check', { description: 'Set the checked state of a semantic checkbox/radio control.', inputSchema: z.object({ ...elementSchema, checked: z.boolean() }), annotations: write },
    async ({ workSessionId, sessionId, tabId, elementId, checked }) => executeInSession('browser_check', workSessionId, owner => ctx.browser.interact(sessionId, tabId, owner, elementId, { kind: 'check', checked })));
  server.registerTool('browser_wait', { description: 'Wait for one bounded semantic condition instead of using fixed sleeps.', inputSchema: z.object({ ...tabSchema, condition: waitConditionSchema, timeoutMs: z.number().int().min(100).max(30_000).default(10_000) }), annotations: read },
    async ({ workSessionId, sessionId, tabId, condition, timeoutMs }) => executeInSession('browser_wait', workSessionId, owner => ctx.browser.wait(sessionId, tabId, owner, condition, timeoutMs)));

  server.registerTool('browser_upload', {
    description: 'Upload 1-8 existing workspace files into a semantic file input. Paths are resolved through the RWMCP workspace PathGuard; physical drag/drop is not used.',
    inputSchema: z.object({ ...elementSchema, files: z.array(uploadFileSchema).min(1).max(8) }),
    annotations: write
  }, async ({ workSessionId, sessionId, tabId, elementId, files }) => executeInSession('browser_upload', workSessionId, async owner => {
    const resolved = [];
    let totalBytes = 0;
    for (const file of files) {
      const absolutePath = await ctx.paths.resolveExisting(file.workspace, file.path);
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) throw new Error('Browser upload source must be a regular workspace file.');
      if (stat.size > 32 * 1024 * 1024) throw new Error('Browser upload source exceeds 32 MiB.');
      totalBytes += stat.size;
      if (totalBytes > 64 * 1024 * 1024) throw new Error('Browser upload batch exceeds 64 MiB.');
      resolved.push({
        absolutePath,
        name: path.basename(absolutePath).slice(0, 256),
        bytes: stat.size,
        mimeType: mimeForUpload(absolutePath)
      });
    }
    return ctx.browser.upload(sessionId, tabId, owner, elementId, resolved);
  }));

  server.registerTool('browser_download', {
    description: 'Activate one semantic element and capture the resulting browser download into a controlled RWMCP artifact directory with SHA-256 metadata.',
    inputSchema: z.object({ ...elementSchema, timeoutMs: z.number().int().min(500).max(30_000).default(15_000) }),
    annotations: write
  }, async ({ workSessionId, sessionId, tabId, elementId, timeoutMs }) =>
    executeInSession('browser_download', workSessionId, owner => ctx.browser.download(sessionId, tabId, owner, elementId, timeoutMs)));

  server.registerTool('browser_download_status', {
    description: 'Inspect metadata for a completed caller-owned browser download.',
    inputSchema: z.object({ ...ownerSchema, downloadId: z.string().uuid() }),
    annotations: read
  }, async ({ workSessionId, sessionId, downloadId }) =>
    executeInSession('browser_download_status', workSessionId, owner => ctx.browser.downloadStatus(sessionId, owner, downloadId)));

  server.registerTool('browser_existing_chrome_status', {
    description: 'Inspect the owner-installed Existing Chrome Bridge and bounded NotebookLM tab inventory. Requires an explicit Work Session and never returns cookies, tokens, passwords or browser storage.',
    inputSchema: z.object({ workSessionId: z.string().uuid() }),
    annotations: read
  }, async ({ workSessionId }) =>
    executeInSession('browser_existing_chrome_status', workSessionId, () => ctx.existingChrome.bridgeStatus()));

  server.registerTool('browser_existing_session_open', {
    description: 'Claim one existing authenticated NotebookLM tab as an exclusive Existing Chrome resource for this principal + Work Session. No browser login or navigation is automated.',
    inputSchema: z.object({ workSessionId: z.string().uuid(), tabId: z.number().int().positive().optional() }),
    annotations: execute
  }, async ({ workSessionId, tabId }) =>
    executeInSession('browser_existing_session_open', workSessionId, owner => ctx.existingChrome.open(owner, tabId)));

  server.registerTool('browser_existing_session_status', {
    description: 'Inspect caller-owned Existing Chrome session metadata.',
    inputSchema: z.object({ workSessionId: z.string().uuid(), existingSessionId: z.string().uuid() }),
    annotations: read
  }, async ({ workSessionId, existingSessionId }) =>
    executeInSession('browser_existing_session_status', workSessionId, owner => ctx.existingChrome.status(existingSessionId, owner)));

  server.registerTool('browser_existing_session_close', {
    description: 'Release the caller-owned Existing Chrome Work Session claim without closing the user Chrome tab.',
    inputSchema: z.object({ workSessionId: z.string().uuid(), existingSessionId: z.string().uuid() }),
    annotations: execute
  }, async ({ workSessionId, existingSessionId }) =>
    executeInSession('browser_existing_session_close', workSessionId, owner => ctx.existingChrome.close(existingSessionId, owner)));

  server.registerTool('browser_existing_inspect', {
    description: 'Inspect semantic controls in the claimed NotebookLM tab through the owner-installed extension. Password inputs are excluded by the content bridge.',
    inputSchema: z.object({ workSessionId: z.string().uuid(), existingSessionId: z.string().uuid(), maxItems: z.number().int().min(1).max(50).default(30) }),
    annotations: read
  }, async ({ workSessionId, existingSessionId, maxItems }) =>
    executeInSession('browser_existing_inspect', workSessionId, owner => ctx.existingChrome.inspect(existingSessionId, owner, maxItems)));

  server.registerTool('browser_existing_find', {
    description: 'Find exact semantic role/name controls in the claimed NotebookLM tab.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      existingSessionId: z.string().uuid(),
      role: z.enum(['heading', 'link', 'button', 'textbox', 'checkbox', 'radio', 'combobox']),
      name: z.string().min(1).max(256),
      maxItems: z.number().int().min(1).max(50).default(20)
    }),
    annotations: read
  }, async ({ workSessionId, existingSessionId, role, name, maxItems }) =>
    executeInSession('browser_existing_find', workSessionId, owner => ctx.existingChrome.find(existingSessionId, owner, role, name, maxItems)));

  server.registerTool('browser_existing_extract', {
    description: 'Extract bounded visible text from the claimed NotebookLM tab; no cookie/storage/token APIs are exposed.',
    inputSchema: z.object({ workSessionId: z.string().uuid(), existingSessionId: z.string().uuid(), maxChars: z.number().int().min(1).max(16000).default(8000) }),
    annotations: read
  }, async ({ workSessionId, existingSessionId, maxChars }) =>
    executeInSession('browser_existing_extract', workSessionId, owner => ctx.existingChrome.extract(existingSessionId, owner, maxChars)));

  server.registerTool('browser_existing_click', {
    description: 'Click one short-lived semantic control in the claimed NotebookLM tab. No coordinate input or raw selector is accepted.',
    inputSchema: z.object({ workSessionId: z.string().uuid(), existingSessionId: z.string().uuid(), elementId: z.string().regex(/^xc_\d+_\d+$/) }),
    annotations: write
  }, async ({ workSessionId, existingSessionId, elementId }) =>
    executeInSession('browser_existing_click', workSessionId, owner => ctx.existingChrome.click(existingSessionId, owner, elementId)));

  server.registerTool('browser_existing_fill', {
    description: 'Fill one semantic textbox in the claimed NotebookLM tab. Password fields are excluded and cannot be targeted.',
    inputSchema: z.object({
      workSessionId: z.string().uuid(),
      existingSessionId: z.string().uuid(),
      elementId: z.string().regex(/^xc_\d+_\d+$/),
      value: z.string().max(8000)
    }),
    annotations: write
  }, async ({ workSessionId, existingSessionId, elementId, value }) =>
    executeInSession('browser_existing_fill', workSessionId, owner => ctx.existingChrome.fill(existingSessionId, owner, elementId, value)));

}
