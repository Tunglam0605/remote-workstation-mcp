import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../../context.js';
import { audited } from '../../security/audit.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

export function registerKicadTools(server: McpServer, ctx: AppContext): void {
  const kicadProject = z.object({ workspace: z.string().min(1), projectPath: z.string().default('.') });
  const kicadEditSelector = {
    uuid: z.string().uuid().optional(),
    reference: z.string().regex(/^[A-Za-z][A-Za-z0-9._+-]{0,31}$/).optional()
  };
  const kicadEditOperation = z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('schematic_symbol_property'),
      ...kicadEditSelector,
      property: z.enum(['Value', 'Footprint', 'Datasheet']),
      value: z.string().max(512)
    }).strict().refine(value => Boolean(value.uuid || value.reference), { message: 'uuid or reference is required' }),
    z.object({
      kind: z.literal('schematic_symbol_flags'),
      ...kicadEditSelector,
      inBom: z.boolean().optional(),
      onBoard: z.boolean().optional()
    }).strict()
      .refine(value => Boolean(value.uuid || value.reference), { message: 'uuid or reference is required' })
      .refine(value => value.inBom !== undefined || value.onBoard !== undefined, { message: 'inBom and/or onBoard is required' }),
    z.object({
      kind: z.literal('pcb_footprint_property'),
      ...kicadEditSelector,
      property: z.enum(['Value', 'Reference']),
      value: z.string().max(512)
    }).strict().refine(value => Boolean(value.uuid || value.reference), { message: 'uuid or reference is required' }),
    z.object({
      kind: z.literal('pcb_footprint_move'),
      ...kicadEditSelector,
      x: z.number().finite().min(-100000).max(100000),
      y: z.number().finite().min(-100000).max(100000),
      rotation: z.number().finite().min(-100000).max(100000).optional()
    }).strict().refine(value => Boolean(value.uuid || value.reference), { message: 'uuid or reference is required' }),
    z.object({
      kind: z.literal('pcb_footprint_attributes'),
      ...kicadEditSelector,
      boardOnly: z.boolean().optional(),
      excludeFromBom: z.boolean().optional(),
      excludeFromPosFiles: z.boolean().optional()
    }).strict()
      .refine(value => Boolean(value.uuid || value.reference), { message: 'uuid or reference is required' })
      .refine(value => value.boardOnly !== undefined || value.excludeFromBom !== undefined || value.excludeFromPosFiles !== undefined, { message: 'at least one footprint attribute is required' }),
    z.object({
      kind: z.literal('pcb_footprint_copper'),
      ...kicadEditSelector,
      clearance: z.number().finite().min(0).max(100).optional(),
      zoneConnect: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional()
    }).strict()
      .refine(value => Boolean(value.uuid || value.reference), { message: 'uuid or reference is required' })
      .refine(value => value.clearance !== undefined || value.zoneConnect !== undefined, { message: 'clearance and/or zoneConnect is required' })
  ]);


  server.registerTool('kicad_ipc_prepare', {
    description: 'Prepare KiCad IPC on Windows in a bounded way. Detects the installed KiCad major version, requires KiCad/PCB Editor to be closed, backs up the matching kicad_common.json, and only enables api.enable_server. No other KiCad preference or Python package is modified.',
    inputSchema: kicadProject.extend({ workSessionId: z.string().uuid() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId }) =>
    result(await audited(ctx.audit, 'kicad_ipc_prepare', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.ipcPrepare(workspace, projectPath))
    )));

  server.registerTool('kicad_ipc_status', {
    description: 'Inspect readiness for the official KiCad IPC API and kicad-python (kipy) without modifying a design. Reports KiCad version support, Python/package availability, GUI-vs-headless requirements, live connection state, and whether a PCB is open.',
    inputSchema: kicadProject,
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath }) => result(await audited(ctx.audit, 'kicad_ipc_status', workspace, () => ctx.engineering.kicad.ipcStatus(workspace, projectPath))));

  server.registerTool('kicad_ipc_board_inspect', {
    description: 'Inspect the currently open KiCad PCB through the official IPC API. The live board must resolve to the explicit authorized project board path. Returns a SHA-256 fingerprint and bounded footprint UUID/reference/position/rotation metadata without modifying or saving the design.',
    inputSchema: kicadProject.extend({
      board: z.string().min(1).max(1024),
      maxItems: z.number().int().min(1).max(2000).default(500)
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, board, maxItems }) =>
    result(await audited(ctx.audit, 'kicad_ipc_board_inspect', workspace, () => ctx.engineering.kicad.ipcBoardInspect(workspace, projectPath, board, maxItems))));

  server.registerTool('kicad_ipc_footprint_move', {
    description: 'Move one footprint in the currently open KiCad PCB through the official IPC API. Requires Work Session ownership and the exact live board SHA-256 fingerprint. RWMCP groups the live edit into an undo step, runs DRC against before/after snapshots, and automatically restores the prior footprint pose if active errors, unconnected items, or schematic-parity findings regress. The board is intentionally left unsaved.',
    inputSchema: kicadProject.extend({
      workSessionId: z.string().uuid(),
      board: z.string().min(1).max(1024),
      expectedBoardSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      uuid: z.string().uuid().optional(),
      reference: z.string().regex(/^[A-Za-z][A-Za-z0-9._+-]{0,31}$/).optional(),
      xMm: z.number().finite().min(-100000).max(100000),
      yMm: z.number().finite().min(-100000).max(100000),
      rotationDeg: z.number().finite().min(-100000).max(100000).optional()
    }).refine(value => Boolean(value.uuid || value.reference), { message: 'uuid or reference is required' }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId, board, expectedBoardSha256, uuid, reference, xMm, yMm, rotationDeg }) =>
    result(await audited(ctx.audit, 'kicad_ipc_footprint_move', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.ipcFootprintMove(
        workspace,
        projectPath,
        board,
        expectedBoardSha256,
        { ...(uuid ? { uuid } : {}), ...(reference ? { reference } : {}) },
        xMm,
        yMm,
        rotationDeg
      ))
    )));

  server.registerTool('kicad_ipc_footprint_update', {
    description: 'Update one live KiCad PCB footprint through official IPC with typed production-safe fields only: Value, lock state, exclude-from-BOM, exclude-from-position-files, DNP, and not-in-schematic. Requires Work Session ownership and exact live board SHA-256; performs one undo commit, DRC before/after acceptance, rollback on regression, and never saves the board implicitly.',
    inputSchema: kicadProject.extend({
      workSessionId: z.string().uuid(),
      board: z.string().min(1).max(1024),
      expectedBoardSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      uuid: z.string().uuid().optional(),
      reference: z.string().regex(/^[A-Za-z][A-Za-z0-9._+-]{0,31}$/).optional(),
      update: z.object({
        value: z.string().max(512).optional(),
        locked: z.boolean().optional(),
        excludeFromBom: z.boolean().optional(),
        excludeFromPosFiles: z.boolean().optional(),
        doNotPopulate: z.boolean().optional(),
        notInSchematic: z.boolean().optional()
      }).strict().refine(value => Object.keys(value).length > 0, { message: 'at least one update field is required' })
    }).refine(value => Boolean(value.uuid || value.reference), { message: 'uuid or reference is required' }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId, board, expectedBoardSha256, uuid, reference, update }) =>
    result(await audited(ctx.audit, 'kicad_ipc_footprint_update', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.ipcFootprintUpdate(
        workspace,
        projectPath,
        board,
        expectedBoardSha256,
        { ...(uuid ? { uuid } : {}), ...(reference ? { reference } : {}) },
        update
      ))
    )));

  const kicadBatchPlacement = z.object({
    uuid: z.string().uuid().optional(),
    reference: z.string().regex(/^[A-Za-z][A-Za-z0-9._+-]{0,31}$/).optional(),
    xMm: z.number().finite().min(-100000).max(100000),
    yMm: z.number().finite().min(-100000).max(100000),
    rotationDeg: z.number().finite().min(-100000).max(100000).optional()
  }).strict().refine(value => Boolean(value.uuid || value.reference), { message: 'uuid or reference is required' });

  server.registerTool('kicad_ipc_batch_place', {
    description: 'Place 1-32 live KiCad PCB footprints in one official IPC commit/undo step. Requires Work Session ownership and exact live-board SHA-256, rejects duplicate or locked targets, validates DRC before/after the whole batch, restores every original pose on regression, and leaves the board unsaved.',
    inputSchema: kicadProject.extend({
      workSessionId: z.string().uuid(),
      board: z.string().min(1).max(1024),
      expectedBoardSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      placements: z.array(kicadBatchPlacement).min(1).max(32)
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId, board, expectedBoardSha256, placements }) =>
    result(await audited(ctx.audit, 'kicad_ipc_batch_place', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.ipcBatchPlace(
        workspace,
        projectPath,
        board,
        expectedBoardSha256,
        placements
      ))
    )));

  const kicadRoutingPoint = z.object({
    xMm: z.number().finite().min(-100000).max(100000),
    yMm: z.number().finite().min(-100000).max(100000)
  }).strict();
  const kicadNetName = z.string().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/.test(value), { message: 'netName contains control characters' });
  const kicadCopperLayer = z.string().regex(/^(?:F\.Cu|B\.Cu|In[1-9][0-9]?\.Cu)$/);

  server.registerTool('kicad_ipc_routing_inspect', {
    description: 'Inspect live KiCad routing through the official IPC API without modifying or saving the board. Returns exact live-board SHA-256 plus bounded nets, straight/arc tracks, vias and zones with UUIDs, geometry, widths, layers, lock state and zone fill metadata.',
    inputSchema: kicadProject.extend({
      board: z.string().min(1).max(1024),
      maxItems: z.number().int().min(1).max(2000).default(1000)
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, board, maxItems }) =>
    result(await audited(ctx.audit, 'kicad_ipc_routing_inspect', workspace, () =>
      ctx.engineering.kicad.ipcRoutingInspect(workspace, projectPath, board, maxItems)
    )));

  server.registerTool('kicad_ipc_track_add', {
    description: 'Add one straight copper track segment through official KiCad IPC. Requires Work Session ownership, exact live-board SHA-256, explicit existing net and copper layer, bounded geometry/width, per-board lease, DRC non-regression, compensating removal on rejection, and no implicit save.',
    inputSchema: kicadProject.extend({
      workSessionId: z.string().uuid(),
      board: z.string().min(1).max(1024),
      expectedBoardSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      netName: kicadNetName,
      layerName: kicadCopperLayer,
      start: kicadRoutingPoint,
      end: kicadRoutingPoint,
      widthMm: z.number().finite().min(0.01).max(20),
      locked: z.boolean().optional()
    }).refine(value => value.start.xMm !== value.end.xMm || value.start.yMm !== value.end.yMm, { message: 'track endpoints must differ' }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId, board, expectedBoardSha256, netName, layerName, start, end, widthMm, locked }) =>
    result(await audited(ctx.audit, 'kicad_ipc_track_add', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.ipcTrackAdd(
        workspace, projectPath, board, expectedBoardSha256,
        { netName, layerName, start, end, widthMm, ...(locked !== undefined ? { locked } : {}) }
      ))
    )));

  server.registerTool('kicad_ipc_track_update', {
    description: 'Update one existing straight live KiCad track by UUID. Typed fields are net, copper layer, start/end point, width and lock. Arc tracks and netless tracks are rejected. Requires Work Session ownership and exact board SHA; DRC failure/regression restores the original track and the board remains unsaved.',
    inputSchema: kicadProject.extend({
      workSessionId: z.string().uuid(),
      board: z.string().min(1).max(1024),
      expectedBoardSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      uuid: z.string().uuid(),
      update: z.object({
        netName: kicadNetName.optional(),
        layerName: kicadCopperLayer.optional(),
        start: kicadRoutingPoint.optional(),
        end: kicadRoutingPoint.optional(),
        widthMm: z.number().finite().min(0.01).max(20).optional(),
        locked: z.boolean().optional()
      }).strict().refine(value => Object.keys(value).length > 0, { message: 'at least one track update field is required' })
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId, board, expectedBoardSha256, uuid, update }) =>
    result(await audited(ctx.audit, 'kicad_ipc_track_update', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.ipcTrackUpdate(
        workspace, projectPath, board, expectedBoardSha256, { uuid, ...update }
      ))
    )));

  server.registerTool('kicad_ipc_via_add', {
    description: 'Add one through-via through official KiCad IPC. Requires an explicit existing net, position, diameter and drill with drill < diameter. Blind/buried/micro vias are intentionally not exposed. Work Session, exact SHA, board lease, DRC acceptance, compensating removal and no implicit save apply.',
    inputSchema: kicadProject.extend({
      workSessionId: z.string().uuid(),
      board: z.string().min(1).max(1024),
      expectedBoardSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      netName: kicadNetName,
      position: kicadRoutingPoint,
      diameterMm: z.number().finite().min(0.1).max(20),
      drillMm: z.number().finite().min(0.05).max(10),
      locked: z.boolean().optional()
    }).refine(value => value.drillMm < value.diameterMm, { message: 'drillMm must be smaller than diameterMm' }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId, board, expectedBoardSha256, netName, position, diameterMm, drillMm, locked }) =>
    result(await audited(ctx.audit, 'kicad_ipc_via_add', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.ipcViaAdd(
        workspace, projectPath, board, expectedBoardSha256,
        { netName, position, diameterMm, drillMm, ...(locked !== undefined ? { locked } : {}) }
      ))
    )));

  server.registerTool('kicad_ipc_via_update', {
    description: 'Update one existing through-via by UUID. Typed fields are net, position, diameter, drill and lock. Netless or non-through vias are rejected. Requires Work Session ownership and exact board SHA; DRC failure/regression restores the original via and the board remains unsaved.',
    inputSchema: kicadProject.extend({
      workSessionId: z.string().uuid(),
      board: z.string().min(1).max(1024),
      expectedBoardSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      uuid: z.string().uuid(),
      update: z.object({
        netName: kicadNetName.optional(),
        position: kicadRoutingPoint.optional(),
        diameterMm: z.number().finite().min(0.1).max(20).optional(),
        drillMm: z.number().finite().min(0.05).max(10).optional(),
        locked: z.boolean().optional()
      }).strict().refine(value => Object.keys(value).length > 0, { message: 'at least one via update field is required' })
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId, board, expectedBoardSha256, uuid, update }) =>
    result(await audited(ctx.audit, 'kicad_ipc_via_update', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.ipcViaUpdate(
        workspace, projectPath, board, expectedBoardSha256, { uuid, ...update }
      ))
    )));

  server.registerTool('kicad_provider_status', {
    description: 'Inspect the resolved KiCad CLI provider/version without modifying project files.',
    inputSchema: kicadProject,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath }) => result(await audited(ctx.audit, 'kicad_provider_status', workspace, () => ctx.engineering.kicad.version(workspace, projectPath))));

  server.registerTool('kicad_board_stats', {
    description: 'Export bounded JSON board statistics for one explicit .kicad_pcb file into a temporary report; project sources are not saved or upgraded.',
    inputSchema: kicadProject.extend({ board: z.string().min(1).max(1024) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath, board }) => result(await audited(ctx.audit, 'kicad_board_stats', workspace, () => ctx.engineering.kicad.boardStats(workspace, projectPath, board))));

  server.registerTool('kicad_drc', {
    description: 'Run KiCad PCB Design Rule Check (DRC) into a temporary JSON report and return bounded structured violations without editing the board.',
    inputSchema: kicadProject.extend({ board: z.string().min(1).max(1024) }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, board }) => result(await audited(ctx.audit, 'kicad_drc', workspace, () => ctx.engineering.kicad.drc(workspace, projectPath, board))));

  server.registerTool('kicad_erc', {
    description: 'Run KiCad schematic Electrical Rules Check (ERC) into a temporary JSON report and return bounded structured violations without editing the schematic.',
    inputSchema: kicadProject.extend({ schematic: z.string().min(1).max(1024) }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, schematic }) => result(await audited(ctx.audit, 'kicad_erc', workspace, () => ctx.engineering.kicad.erc(workspace, projectPath, schematic))));

  server.registerTool('kicad_validate', {
    description: 'Run bounded ERC and/or DRC for explicit KiCad source files in parallel without source mutation.',
    inputSchema: kicadProject.extend({ schematic: z.string().min(1).max(1024).optional(), board: z.string().min(1).max(1024).optional() }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, schematic, board }) => {
    if (!schematic && !board) throw new Error('kicad_validate requires schematic and/or board.');
    return result(await audited(ctx.audit, 'kicad_validate', workspace, () => ctx.engineering.kicad.validate(workspace, projectPath, { ...(schematic ? { schematic } : {}), ...(board ? { board } : {}), jobsets: [] })));
  });

  server.registerTool('kicad_bom_report', {
    description: 'Export a bounded temporary schematic BOM with a fixed field contract (Refs, Value, Footprint, Qty, DNP) and return a typed report. No BOM plugin or arbitrary script is executed.',
    inputSchema: kicadProject.extend({ schematic: z.string().min(1).max(1024), maxRows: z.number().int().min(1).max(5000).default(500) }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, schematic, maxRows }) => result(await audited(ctx.audit, 'kicad_bom_report', workspace, () => ctx.engineering.kicad.bomReport(workspace, projectPath, schematic, maxRows))));

  server.registerTool('kicad_edit_inspect', {
    description: 'Inspect one explicit KiCad schematic/board as an editing target. Returns SHA-256 optimistic-concurrency identity plus bounded symbol/footprint UUID, reference, value and placement metadata without modifying the file.',
    inputSchema: kicadProject.extend({
      file: z.string().min(1).max(1024),
      maxItems: z.number().int().min(1).max(2000).default(500)
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath, file, maxItems }) =>
    result(await audited(ctx.audit, 'kicad_edit_inspect', workspace, () => ctx.engineering.kicad.inspectEditable(workspace, projectPath, file, maxItems))));

  server.registerTool('kicad_edit', {
    description: 'Apply 1-32 typed KiCad Phase-1 edits transactionally. Requires an exact expected SHA-256, holds a file lease, patches only supported schematic symbol properties or PCB footprint properties/placement, validates a project-scoped working copy with ERC/DRC against the pre-edit baseline, then commits atomically with a backup only when acceptance passes. Arbitrary S-expression, net/track/via/zone edits and scripts are not accepted.',
    inputSchema: kicadProject.extend({
      workSessionId: z.string().uuid(),
      file: z.string().min(1).max(1024),
      expectedSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      operations: z.array(kicadEditOperation).min(1).max(32)
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId, file, expectedSha256, operations }) =>
    result(await audited(ctx.audit, 'kicad_edit', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.transactionalEdit(workspace, projectPath, file, expectedSha256, operations))
    )));

}
