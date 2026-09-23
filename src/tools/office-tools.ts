import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import { currentOfficeCapabilityMatrix } from '../office/common/capability-matrix.js';
import { OFFICE_PACK_API_VERSION } from '../office/common/contracts.js';
import { inspectWordDocx } from '../office/word/inspector.js';
import { audited } from '../security/audit.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

const WORD_EXTENSIONS = new Set(['.docx', '.docm', '.dotx', '.dotm']);

export function registerOfficeTools(server: McpServer, ctx: AppContext): void {
  server.registerTool('office_capabilities', {
    description: 'Discover the bounded RWMCP Office capability pack, backend availability and security posture without opening or modifying a document.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'office_capabilities', undefined, async () => ({
    officeApiVersion: OFFICE_PACK_API_VERSION,
    phase: 'B-word-inspector',
    executionModel: 'deterministic-capability-pack',
    reasoningProvider: false,
    platform: os.platform(),
    domains: {
      word: { status: 'inspection-available', mutation: 'not-implemented' },
      excel: { status: 'deferred-until-word-acceptance' },
      powerpoint: { status: 'deferred-until-excel-acceptance' }
    },
    backends: currentOfficeCapabilityMatrix(os.platform()).list(),
    security: {
      macros: 'never-executed-by-inspector',
      externalContent: 'never-followed-by-inspector',
      arbitraryVba: false,
      arbitraryShell: false,
      rawComInvocation: false,
      uiAutomationImplicitFallback: false
    },
    note: 'Word inspection is read-only and OOXML-based. Mutation/native Word tools remain unavailable until their transaction and acceptance paths are implemented.'
  }))));

  server.registerTool('word_inspect', {
    description: 'Inspect an authorized Word OOXML document (.docx/.docm/.dotx/.dotm) into a bounded structural AST. This is read-only: it never runs macros, follows external relationships, starts Word, or mutates the file.',
    inputSchema: z.object({
      workspace: z.string().min(1).max(128),
      path: z.string().min(1).max(1024),
      maxParagraphs: z.number().int().min(1).max(2000).default(500),
      maxTables: z.number().int().min(1).max(200).default(100),
      maxImages: z.number().int().min(1).max(500).default(200),
      maxEquations: z.number().int().min(1).max(500).default(200),
      includeOmml: z.boolean().default(false)
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, path: documentPath, maxParagraphs, maxTables, maxImages, maxEquations, includeOmml }) =>
    result(await audited(ctx.audit, 'word_inspect', workspace, async () => {
      const extension = path.extname(documentPath).toLowerCase();
      if (!WORD_EXTENSIONS.has(extension)) {
        throw new Error('word_inspect supports only Word OOXML files: .docx, .docm, .dotx, .dotm.');
      }
      const absolutePath = await ctx.paths.resolveExisting(workspace, documentPath);
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) throw new Error('word_inspect requires a regular file.');
      if (stat.size > ctx.policy.config.filesystem.maxReadBytes) {
        throw new Error(`Word document exceeds maxReadBytes (${ctx.policy.config.filesystem.maxReadBytes}).`);
      }
      const bytes = await fs.readFile(absolutePath);
      const inspection = inspectWordDocx({
        canonicalPath: absolutePath,
        bytes,
        modifiedTimeMs: stat.mtimeMs
      });
      const equations = inspection.equations.slice(0, maxEquations).map(item =>
        includeOmml ? item : {
          id: item.id,
          locator: item.locator,
          text: item.text,
          ommlPresent: item.omml.length > 0
        }
      );
      return {
        ...inspection,
        paragraphs: inspection.paragraphs.slice(0, maxParagraphs),
        headings: inspection.headings.slice(0, maxParagraphs),
        tables: inspection.tables.slice(0, maxTables),
        images: inspection.images.slice(0, maxImages),
        equations,
        totals: {
          paragraphs: inspection.paragraphs.length,
          headings: inspection.headings.length,
          tables: inspection.tables.length,
          images: inspection.images.length,
          equations: inspection.equations.length,
          sections: inspection.sections.length
        },
        truncated: {
          paragraphs: inspection.paragraphs.length > maxParagraphs,
          headings: inspection.headings.length > maxParagraphs,
          tables: inspection.tables.length > maxTables,
          images: inspection.images.length > maxImages,
          equations: inspection.equations.length > maxEquations
        }
      };
    }))
  );
}
