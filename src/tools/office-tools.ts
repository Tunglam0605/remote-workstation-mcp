import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { currentOfficeCapabilityMatrix } from '../office/common/capability-matrix.js';
import { OFFICE_PACK_API_VERSION } from '../office/common/contracts.js';
import { OfficeResourceManager } from '../office/common/resource-manager.js';
import { officeFileResourceKey } from '../office/common/resource-keys.js';
import type { WordEditOperation } from '../office/word/editor.js';
import { wordLinearTextToOmml } from '../office/word/equation.js';
import { inspectWordDocx } from '../office/word/inspector.js';
import { rollbackWordTransaction, transactionalWordEdit } from '../office/word/transactional-edit.js';
import { audited } from '../security/audit.js';
import { currentPrincipal, principalHasExactScope } from '../security/request-principal.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

const WORD_INSPECTION_EXTENSIONS = new Set(['.docx', '.docm', '.dotx', '.dotm']);
const locatorSchema = z.object({
  stableId: z.string().regex(/^w14:paraId:[0-9A-Fa-f]{8}$/).optional(),
  paraId: z.string().regex(/^[0-9A-Fa-f]{8}$/).optional(),
  bookmark: z.string().min(1).max(128).optional(),
  textHash: z.string().regex(/^[0-9a-f]{16}$/).optional(),
  structuralPath: z.string().min(1).max(256).optional()
});

const equationSourceSchema = z.object({
  format: z.enum(['word-linear', 'omml']),
  value: z.string().min(1).max(100_000)
});

const wordOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('replace_paragraph_text'), locator: locatorSchema, text: z.string().max(1_000_000) }),
  z.object({ type: z.literal('set_paragraph_style'), locator: locatorSchema, styleId: z.string().min(1).max(128) }),
  z.object({
    type: z.literal('set_paragraph_format'),
    locator: locatorSchema,
    alignment: z.enum(['left', 'center', 'right', 'both']).optional(),
    leftIndentTwips: z.number().int().min(-100_000).max(100_000).optional(),
    firstLineTwips: z.number().int().min(-100_000).max(100_000).optional(),
    spaceBeforeTwips: z.number().int().min(0).max(100_000).optional(),
    spaceAfterTwips: z.number().int().min(0).max(100_000).optional()
  }),
  z.object({
    type: z.literal('set_table_cell_text'), tableIndex: z.number().int().min(1).max(10_000),
    row: z.number().int().min(1).max(100_000), column: z.number().int().min(1).max(10_000), text: z.string().max(1_000_000)
  }),
  z.object({ type: z.literal('remove_image'), relationshipId: z.string().regex(/^rId[A-Za-z0-9_.-]{1,128}$/) }),
  z.object({ type: z.literal('insert_equation'), locator: locatorSchema, equation: equationSourceSchema, mode: z.enum(['append', 'replace-content']).default('append') }),
  z.object({ type: z.literal('replace_equation'), equationIndex: z.number().int().min(1).max(100_000), equation: equationSourceSchema }),
  z.object({
    type: z.literal('set_section_page_size'), sectionIndex: z.number().int().min(1).max(10_000),
    widthTwips: z.number().int().min(1000).max(100_000), heightTwips: z.number().int().min(1000).max(100_000),
    orientation: z.enum(['portrait', 'landscape']).optional()
  })
]);

type ToolWordOperation = z.infer<typeof wordOperationSchema>;

function normalizeEquation(source: z.infer<typeof equationSourceSchema>): string {
  return source.format === 'omml' ? source.value : wordLinearTextToOmml(source.value);
}

function normalizeOperations(operations: ToolWordOperation[]): WordEditOperation[] {
  return operations.map(operation => {
    switch (operation.type) {
      case 'insert_equation':
        return { type: 'insert_omml', locator: operation.locator, omml: normalizeEquation(operation.equation), mode: operation.mode };
      case 'replace_equation':
        return { type: 'replace_equation_omml', equationIndex: operation.equationIndex, omml: normalizeEquation(operation.equation) };
      default:
        return operation;
    }
  });
}

function principalCanExecuteNativeOffice(): boolean {
  if (!currentPrincipal()) return true;
  return principalHasExactScope('workstation.execute') || principalHasExactScope('workstation.full_control');
}

export function officePlatformSupported(platform: NodeJS.Platform | string = process.platform): boolean {
  return platform === 'win32';
}

export function registerOfficeTools(server: McpServer, ctx: AppContext): void {
  if (!officePlatformSupported()) throw new Error('RWMCP Office Capability Pack is supported only on Windows hosts.');
  const currentClientId = () => currentPrincipal()?.id ?? ctx.actor.clientId;
  const resources = new OfficeResourceManager(currentClientId);

  server.registerTool('office_capabilities', {
    description: 'Discover the bounded RWMCP Office capability pack, backend availability and security posture without opening or modifying a document.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'office_capabilities', undefined, async () => ({
    officeApiVersion: OFFICE_PACK_API_VERSION,
    phase: 'E-word-transactional-acceptance',
    executionModel: 'deterministic-capability-pack',
    reasoningProvider: false,
    platform: os.platform(),
    domains: {
      word: { status: 'transactional-edit-available', mutation: 'typed-and-transactional' },
      excel: { status: 'deferred-until-word-acceptance' },
      powerpoint: { status: 'deferred-until-excel-acceptance' }
    },
    backends: currentOfficeCapabilityMatrix(os.platform()).list(),
    security: {
      macros: 'never-executed-and-mutation-blocked',
      externalContent: 'never-followed',
      embeddedOle: 'mutation-blocked-v1',
      activeX: 'mutation-blocked-v1',
      arbitraryVba: false,
      arbitraryShell: false,
      rawComInvocation: false,
      uiAutomationImplicitFallback: false
    },
    mutation: {
      workSessionRequired: true,
      optimisticConcurrency: 'sha256',
      backup: true,
      workingCopy: true,
      nativeAcceptance: 'Windows-only; native Word acceptance is enabled by default and may be explicitly disabled only for bounded OOXML-only operations',
      rollback: 'same word_edit tool, action=rollback'
    }
  }))));

  server.registerTool('word_inspect', {
    description: 'Inspect an authorized Word OOXML document into a bounded structural AST. Read-only: never runs macros, follows external relationships, starts Word, or mutates the file.',
    inputSchema: z.object({
      workspace: z.string().min(1).max(128),
      path: z.string().min(1).max(1024),
      workSessionId: z.string().uuid().optional(),
      maxParagraphs: z.number().int().min(1).max(2000).default(500),
      maxTables: z.number().int().min(1).max(200).default(100),
      maxImages: z.number().int().min(1).max(500).default(200),
      maxEquations: z.number().int().min(1).max(500).default(200),
      includeOmml: z.boolean().default(false)
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, path: documentPath, workSessionId, maxParagraphs, maxTables, maxImages, maxEquations, includeOmml }) =>
    result(await audited(ctx.audit, 'word_inspect', workspace, async () => ctx.runInWorkSession(workSessionId, async () => {
      const extension = path.extname(documentPath).toLowerCase();
      if (!WORD_INSPECTION_EXTENSIONS.has(extension)) throw new Error('word_inspect supports only .docx, .docm, .dotx, .dotm.');
      const absolutePath = await ctx.paths.resolveExisting(workspace, documentPath);
      return await resources.withLease(officeFileResourceKey(absolutePath), 'read', async () => {
        const stat = await fs.stat(absolutePath);
        if (!stat.isFile()) throw new Error('word_inspect requires a regular file.');
        if (stat.size > ctx.policy.config.filesystem.maxReadBytes) throw new Error(`Word document exceeds maxReadBytes (${ctx.policy.config.filesystem.maxReadBytes}).`);
        const bytes = await fs.readFile(absolutePath);
        const inspection = inspectWordDocx({ canonicalPath: absolutePath, bytes, modifiedTimeMs: stat.mtimeMs });
        const equations = inspection.equations.slice(0, maxEquations).map(item => includeOmml ? item : {
          id: item.id, locator: item.locator, text: item.text, ommlPresent: item.omml.length > 0
        });
        return {
          ...inspection,
          paragraphs: inspection.paragraphs.slice(0, maxParagraphs),
          headings: inspection.headings.slice(0, maxParagraphs),
          tables: inspection.tables.slice(0, maxTables),
          images: inspection.images.slice(0, maxImages),
          equations,
          totals: {
            paragraphs: inspection.paragraphs.length, headings: inspection.headings.length, tables: inspection.tables.length,
            images: inspection.images.length, equations: inspection.equations.length, sections: inspection.sections.length
          },
          truncated: {
            paragraphs: inspection.paragraphs.length > maxParagraphs, headings: inspection.headings.length > maxParagraphs,
            tables: inspection.tables.length > maxTables, images: inspection.images.length > maxImages,
            equations: inspection.equations.length > maxEquations
          }
        };
      });
    }))));

  server.registerTool('word_edit', {
    description: 'Apply or roll back bounded typed Word edits transactionally. Apply requires an explicit Work Session, file lease, backup/working copy, SHA-256 conflict check and structural acceptance; native Word open/PDF/OMath acceptance can be required on Windows.',
    inputSchema: z.discriminatedUnion('action', [
      z.object({
        action: z.literal('apply'), workspace: z.string().min(1).max(128), path: z.string().min(1).max(1024),
        workSessionId: z.string().uuid(), expectedSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        operations: z.array(wordOperationSchema).min(1).max(100),
        acceptance: z.object({
          nativeWord: z.boolean().optional(), exportPdf: z.boolean().default(true),
          minEquationCount: z.number().int().min(0).max(100_000).optional(),
          removedImageRelationshipIds: z.array(z.string().regex(/^rId[A-Za-z0-9_.-]{1,128}$/)).max(500).default([]),
          preserveHeadingTexts: z.array(z.string().max(10_000)).max(500).default([])
        }).default({ exportPdf: true, removedImageRelationshipIds: [], preserveHeadingTexts: [] })
      }),
      z.object({
        action: z.literal('rollback'), workspace: z.string().min(1).max(128), path: z.string().min(1).max(1024),
        workSessionId: z.string().uuid(), transactionId: z.string().uuid()
      })
    ]),
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false }
  }, async (input) => result(await audited(ctx.audit, 'word_edit', input.workspace, async () => {
    ctx.policy.assertWrite(input.workspace);
    return await ctx.runInWorkSession(input.workSessionId, async () => {
      const absolutePath = await ctx.paths.resolveExisting(input.workspace, input.path);
      return await resources.withLease(officeFileResourceKey(absolutePath), 'write', async () => {
        if (input.action === 'rollback') {
          return await rollbackWordTransaction({ canonicalPath: absolutePath, transactionId: input.transactionId, principalId: currentClientId(), workSessionId: input.workSessionId });
        }
        const nativeWord = input.acceptance.nativeWord ?? process.platform === 'win32';
        if (nativeWord && !principalCanExecuteNativeOffice()) {
          throw new Error('word_edit native acceptance requires workstation.execute (or workstation.full_control) in addition to write authority.');
        }
        const stat = await fs.stat(absolutePath);
        if (!stat.isFile()) throw new Error('word_edit requires a regular file.');
        if (stat.size > ctx.policy.config.filesystem.maxReadBytes) throw new Error(`Word document exceeds maxReadBytes (${ctx.policy.config.filesystem.maxReadBytes}).`);
        return await transactionalWordEdit({
          canonicalPath: absolutePath,
          principalId: currentClientId(),
          workSessionId: input.workSessionId,
          operations: normalizeOperations(input.operations),
          expectedSha256: input.expectedSha256,
          maxWriteBytes: ctx.policy.config.filesystem.maxWriteBytes,
          acceptance: {
            nativeWord,
            exportPdf: input.acceptance.exportPdf,
            minEquationCount: input.acceptance.minEquationCount,
            removedImageRelationshipIds: input.acceptance.removedImageRelationshipIds,
            preserveHeadingTexts: input.acceptance.preserveHeadingTexts
          }
        });
      });
    });
  })));
}
