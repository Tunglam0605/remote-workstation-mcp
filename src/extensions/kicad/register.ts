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

  const kicadLibraryLookup = z.discriminatedUnion('mode', [
    kicadProject.extend({
      mode: z.literal('search'),
      query: z.string().min(1).max(128),
      kind: z.enum(['symbol', 'footprint', 'both']).default('both'),
      limit: z.number().int().min(1).max(50).default(10)
    }).strict(),
    kicadProject.extend({
      mode: z.literal('symbol'),
      symbolId: z.string().min(3).max(256)
    }).strict(),
    kicadProject.extend({
      mode: z.literal('footprint'),
      footprintId: z.string().min(3).max(256)
    }).strict(),
    kicadProject.extend({
      mode: z.literal('component'),
      symbolId: z.string().min(3).max(256),
      footprintId: z.string().min(3).max(256).optional()
    }).strict()
  ]);

  server.registerTool('kicad_library_lookup', {
    description: 'Search or resolve installed KiCad symbol/footprint libraries without project mutation. Resolves symbol inheritance, effective properties, pin names/numbers/electrical types/alternate functions, default footprint and footprint filters; footprint resolution reports pads, attributes and 3D-model coverage. Component mode validates the selected/default footprint against the symbol footprint filters.',
    inputSchema: kicadLibraryLookup,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async (request) =>
    result(await audited(ctx.audit, 'kicad_library_lookup', request.workspace, () => ctx.engineering.kicad.libraryLookup(request.workspace, request.projectPath, request))));

  const schematicComponent = z.object({
    reference: z.string().regex(/^[A-Za-z][A-Za-z0-9._+-]{0,31}$/),
    symbolId: z.string().min(3).max(256),
    value: z.string().max(256).optional(),
    footprintId: z.string().min(3).max(256).optional(),
    xMm: z.number().finite().min(0).max(2000).optional(),
    yMm: z.number().finite().min(0).max(2000).optional(),
    rotationDeg: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
    unit: z.number().int().min(1).max(32).optional(),
    inBom: z.boolean().optional(),
    onBoard: z.boolean().optional(),
    dnp: z.boolean().optional()
  }).strict();
  const schematicEndpoint = z.object({
    reference: z.string().regex(/^[A-Za-z][A-Za-z0-9._+-]{0,31}$/),
    pinNumber: z.string().min(1).max(32),
    expectedPinName: z.string().min(1).max(128).optional()
  }).strict();
  const schematicNet = z.object({
    name: z.string().min(1).max(128),
    endpoints: z.array(schematicEndpoint).min(1).max(128)
  }).strict();

  server.registerTool('kicad_schematic_synthesize', {
    description: 'Create a new KiCad project + schematic from typed installed-library component and net specifications. Resolves exact symbols, inherited pins/alternate functions and footprints from the installed KiCad libraries, generates deterministic label-driven connectivity, round-trips the result through official `kicad-cli sch export netlist`, optionally runs ERC, and deletes the output if parsing/connectivity/ERC acceptance fails. Requires a Work Session and a new project-relative output directory; existing files are never overwritten.',
    inputSchema: kicadProject.extend({
      workSessionId: z.string().uuid(),
      outputDir: z.string().min(1).max(1024),
      projectName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      title: z.string().max(256).optional(),
      revision: z.string().max(64).optional(),
      company: z.string().max(256).optional(),
      components: z.array(schematicComponent).min(1).max(128),
      nets: z.array(schematicNet).max(512),
      markUnusedNoConnect: z.boolean().default(true),
      allowUnconnectedPowerPins: z.boolean().default(false),
      allowFootprintFilterMismatch: z.boolean().default(false),
      runErc: z.boolean().default(true),
      requireErcClean: z.boolean().default(true)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ workSessionId, ...request }) =>
    result(await audited(ctx.audit, 'kicad_schematic_synthesize', request.workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.schematicSynthesize(request.workspace, request.projectPath, request))
    )));

  const boardMinimums = z.object({
    clearanceMm: z.number().finite().min(0.05).max(10).optional(),
    trackWidthMm: z.number().finite().min(0.05).max(20).optional(),
    viaDiameterMm: z.number().finite().min(0.1).max(20).optional(),
    viaDrillMm: z.number().finite().min(0.05).max(10).optional(),
    viaAnnularWidthMm: z.number().finite().min(0.02).max(10).optional(),
    copperEdgeClearanceMm: z.number().finite().min(0).max(20).optional()
  }).strict();
  const boardRouting = z.object({
    trackWidthMm: z.number().finite().min(0.05).max(20).optional(),
    viaDiameterMm: z.number().finite().min(0.1).max(20).optional(),
    viaDrillMm: z.number().finite().min(0.05).max(10).optional(),
    diffPairWidthMm: z.number().finite().min(0.05).max(20).optional(),
    diffPairGapMm: z.number().finite().min(0.05).max(20).optional()
  }).strict();
  const boardNetClass = z.object({
    name: z.string().min(1).max(64),
    nets: z.array(z.string().min(1).max(128)).max(512),
    clearanceMm: z.number().finite().min(0.05).max(10).optional(),
    trackWidthMm: z.number().finite().min(0.05).max(20).optional(),
    viaDiameterMm: z.number().finite().min(0.1).max(20).optional(),
    viaDrillMm: z.number().finite().min(0.05).max(10).optional(),
    diffPairWidthMm: z.number().finite().min(0.05).max(20).optional(),
    diffPairGapMm: z.number().finite().min(0.05).max(20).optional()
  }).strict();

  const placementHint = z.object({
    reference: z.string().regex(/^[A-Za-z][A-Za-z0-9._+-]{0,31}$/),
    role: z.enum(['mcu','connector','debug','power','transceiver','crystal','decoupling','sensor','driver','generic']).optional(),
    anchorRef: z.string().regex(/^[A-Za-z][A-Za-z0-9._+-]{0,31}$/).optional(),
    edge: z.enum(['top','bottom','left','right']).optional(),
    locked: z.boolean().optional()
  }).strict();

  server.registerTool('kicad_semantic_place_plan', {
    description: 'Plan professional semantic component placement from an exact synthesized-design manifest SHA without mutating files. Classifies MCU/core, connectors, debug headers, power, transceivers, crystals, decoupling, sensors and drivers; applies edge/accessibility and anchor-proximity rules, then uses connectivity-weighted centroid placement for remaining parts. Returns typed placements directly consumable by kicad_board_synthesize.',
    inputSchema: kicadProject.extend({
      designManifest: z.string().min(1).max(1024),
      expectedDesignManifestSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      widthMm: z.number().finite().min(20).max(1000),
      heightMm: z.number().finite().min(20).max(1000),
      originXmm: z.number().finite().min(0).max(1000).default(20),
      originYmm: z.number().finite().min(0).max(1000).default(20),
      gridMm: z.number().finite().gt(0).max(10).default(0.5),
      minSpacingMm: z.number().finite().min(0.5).max(50).default(3),
      edgeInsetMm: z.number().finite().min(1).max(50).default(4),
      hints: z.array(placementHint).max(256).optional()
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async (request) =>
    result(await audited(ctx.audit, 'kicad_semantic_place_plan', request.workspace, () => ctx.engineering.kicad.semanticPlacementPlan(request.workspace, request.projectPath, request))));

  server.registerTool('kicad_board_synthesize', {
    description: 'Create the PCB side of an RWMCP-synthesized KiCad design from an exact design-manifest SHA. Resolves installed footprints/symbols again, creates a bounded 2..12-layer board with physical stackup and Edge.Cuts, assigns pad nets/pin functions/path linkage to the generated schematic, updates Board Setup hard minimums and net classes, then requires official KiCad stats and optional DRC/schematic-parity acceptance. Existing boards are never overwritten; failure removes the PCB and restores project/manifest revisions.',
    inputSchema: kicadProject.extend({
      workSessionId: z.string().uuid(),
      designManifest: z.string().min(1).max(1024),
      expectedDesignManifestSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      widthMm: z.number().finite().min(10).max(1000),
      heightMm: z.number().finite().min(10).max(1000),
      copperLayers: z.union([z.literal(2), z.literal(4), z.literal(6), z.literal(8), z.literal(10), z.literal(12)]).default(2),
      thicknessMm: z.number().finite().min(0.2).max(10).default(1.6),
      originXmm: z.number().finite().min(0).max(1000).default(20),
      originYmm: z.number().finite().min(0).max(1000).default(20),
      placements: z.array(z.object({
        reference: z.string().regex(/^[A-Za-z][A-Za-z0-9._+-]{0,31}$/),
        xMm: z.number().finite().min(-1000).max(2000),
        yMm: z.number().finite().min(-1000).max(2000),
        rotationDeg: z.number().finite().min(-3600).max(3600).optional(),
        side: z.enum(['front', 'back']).optional(),
        locked: z.boolean().optional()
      }).strict()).max(128).optional(),
      minimums: boardMinimums.optional(),
      defaultRouting: boardRouting.optional(),
      netClasses: z.array(boardNetClass).max(32).optional(),
      runDrc: z.boolean().default(true),
      requireNoViolations: z.boolean().default(true)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ workSessionId, ...request }) =>
    result(await audited(ctx.audit, 'kicad_board_synthesize', request.workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.boardSynthesize(request.workspace, request.projectPath, request))
    )));

  const routePoint = z.object({
    x: z.number().finite().min(-100000).max(100000),
    y: z.number().finite().min(-100000).max(100000)
  }).strict();
  const routeOperation = z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('segment'),
      netName: z.string().min(1).max(128),
      layer: z.string().regex(/^(?:F|B|In\d+)\.Cu$/),
      start: routePoint,
      end: routePoint,
      widthMm: z.number().finite().min(0.05).max(20),
      locked: z.boolean().optional()
    }).strict(),
    z.object({
      kind: z.literal('via'),
      netName: z.string().min(1).max(128),
      position: routePoint,
      diameterMm: z.number().finite().min(0.1).max(20),
      drillMm: z.number().finite().min(0.05).max(10),
      layers: z.tuple([
        z.string().regex(/^(?:F|B|In\d+)\.Cu$/),
        z.string().regex(/^(?:F|B|In\d+)\.Cu$/)
      ]).optional(),
      locked: z.boolean().optional()
    }).strict().refine(value => value.drillMm < value.diameterMm, { message: 'drillMm must be smaller than diameterMm' })
  ]);

  server.registerTool('kicad_route_batch_apply', {
    description: 'Apply 1..256 typed straight-track/through-via routing operations to one authorized KiCad PCB in a single transaction. Requires Work Session ownership and exact board SHA, validates net/layer identity, backs up and writes atomically, runs KiCad DRC plus schematic parity before/after, and rolls the entire batch back on regression. No raw scripts, deletion, arcs, blind/micro vias or implicit autorouting.',
    inputSchema: kicadProject.extend({
      workSessionId: z.string().uuid(),
      board: z.string().min(1).max(1024),
      expectedBoardSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      operations: z.array(routeOperation).min(1).max(256),
      requireNoNewViolations: z.boolean().default(true),
      requireUnconnectedNonIncrease: z.boolean().default(true),
      requireParityNonIncrease: z.boolean().default(true)
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workSessionId, ...request }) =>
    result(await audited(ctx.audit, 'kicad_route_batch_apply', request.workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.routeBatchApply(request.workspace, request.projectPath, request))
    )));

  const electricalIntent = z.object({
    netName: z.string().min(1).max(128),
    kind: z.enum(['power', 'clock', 'differential', 'can', 'rs485', 'pwm', 'analog', 'digital', 'high_speed']),
    currentA: z.number().finite().min(0).max(1000).optional(),
    voltageV: z.number().finite().gt(0).max(2000).optional(),
    maxVoltageDropPct: z.number().finite().min(0).max(100).optional(),
    maxLengthMm: z.number().finite().gt(0).max(100000).optional(),
    maxViaCount: z.number().int().min(0).max(10000).optional(),
    targetImpedanceOhm: z.number().finite().gt(0).max(10000).optional(),
    pairWith: z.string().min(1).max(128).optional(),
    maxSkewMm: z.number().finite().min(0).max(100000).optional()
  }).strict();

  server.registerTool('kicad_electrical_review', {
    description: 'Review explicit routed nets against typed electrical design intent without source mutation. Reports route length/vias/layers/widths, copper-only 20 C DC resistance/voltage-drop/I²R estimates when stackup copper thickness and current are known, paired-net routed-length skew, and critical-net layer-transition evidence. It deliberately does not claim IPC-2152 ampacity, controlled impedance, EMI/EMC or thermal simulation; target impedance is recorded as requiring a field solver.',
    inputSchema: kicadProject.extend({
      board: z.string().min(1).max(1024),
      intents: z.array(electricalIntent).min(1).max(128)
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath, board, intents }) =>
    result(await audited(ctx.audit, 'kicad_electrical_review', workspace, () =>
      ctx.engineering.kicad.electricalReview(workspace, projectPath, board, intents)
    )));

  server.registerTool('kicad_manufacturing_package', {
    description: 'Create one new project-scoped production package from an explicit KiCad PCB and optional schematic. The package is blocked by active DRC/ERC/unconnected/schematic-parity findings by default, exports Gerber + Excellon + assembly positions plus optional BOM/IPC-2581/IPC-D-356/ODB++/STEP, audits PCB assembly intent against position/BOM outputs, and writes SHA-256 manufacturing/report manifests. Requires Work Session ownership; source KiCad files are never rewritten.',
    inputSchema: kicadProject.extend({
      workSessionId: z.string().uuid(),
      board: z.string().min(1).max(1024),
      schematic: z.string().min(1).max(1024).optional(),
      outputDir: z.string().min(1).max(1024),
      includeIpc2581: z.boolean().default(true),
      includeIpcD356: z.boolean().default(true),
      includeOdb: z.boolean().default(false),
      includeStep: z.boolean().default(true),
      requireClean: z.boolean().default(true),
      requireAssemblyConsistency: z.boolean().default(true)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ workSessionId, ...request }) =>
    result(await audited(ctx.audit, 'kicad_manufacturing_package', request.workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.manufacturingPackage(request.workspace, request.projectPath, request))
    )));

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

  server.registerTool('kicad_design_review', {
    description: 'Review one KiCad design without source mutation. Combines schematic-to-PCB consistency, placement spread/outliers, routing length/via/width evidence, 3D-model coverage and optional ERC/DRC. Recommendations are deterministic review candidates and point to existing typed edit/IPC tools; they are not an autorouter or implicit mutation.',
    inputSchema: kicadProject.extend({
      schematic: z.string().min(1).max(1024).optional(),
      board: z.string().min(1).max(1024).optional(),
      runRuleChecks: z.boolean().default(true),
      maxDetails: z.number().int().min(1).max(100).default(25),
      shortSegmentMm: z.number().finite().min(0).max(10).default(0.25)
    }).refine(value => Boolean(value.schematic || value.board), { message: 'schematic and/or board is required' }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, schematic, board, runRuleChecks, maxDetails, shortSegmentMm }) =>
    result(await audited(ctx.audit, 'kicad_design_review', workspace, () => ctx.engineering.kicad.designReview(
      workspace,
      projectPath,
      { ...(schematic ? { schematic } : {}), ...(board ? { board } : {}) },
      { runRuleChecks, maxDetails, shortSegmentMm }
    ))));

  server.registerTool('kicad_layout_optimize_plan', {
    description: 'Build a bounded read-only KiCad layout optimization plan from one explicit PCB and optional schematic. Uses official KiCad schematic netlist export, computes PCB pad/net topology, Euclidean-MST/HPWL geometric proxies, explicit route length, via/layer-transition evidence, footprint affinity and bounded net-weighted placement pull candidates. Suggested moves are geometry-only review candidates and never bypass the existing typed IPC/DRC mutation gates.',
    inputSchema: kicadProject.extend({
      board: z.string().min(1).max(1024),
      schematic: z.string().min(1).max(1024).optional(),
      runRuleChecks: z.boolean().default(true),
      maxDetails: z.number().int().min(1).max(100).default(25),
      maxPlacementNetPads: z.number().int().min(2).max(128).default(24),
      maxSuggestedStepMm: z.number().finite().gt(0).max(50).default(5),
      placementGridMm: z.number().finite().gt(0).max(10).default(0.5)
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, board, schematic, runRuleChecks, maxDetails, maxPlacementNetPads, maxSuggestedStepMm, placementGridMm }) =>
    result(await audited(ctx.audit, 'kicad_layout_optimize_plan', workspace, () => ctx.engineering.kicad.layoutOptimizePlan(
      workspace, projectPath, board, schematic,
      { runRuleChecks, maxDetails, maxPlacementNetPads, maxSuggestedStepMm, placementGridMm }
    ))));

  server.registerTool('kicad_constraints_review', {
    description: 'Review KiCad Board Setup and routing constraints without source mutation. Reads explicit .kicad_pro + .kicad_pcb and optional .kicad_dru, summarizes hard manufacturing/routing minimums, net classes/defaults, stackup, zones, differential-pair evidence and custom-rule catalog, then compares explicit routing against hard minimums. Net-class defaults are never mislabeled as DRC violations and custom-rule expressions are not re-evaluated by RWMCP; KiCad DRC remains authoritative.',
    inputSchema: kicadProject.extend({
      projectFile: z.string().min(1).max(1024),
      board: z.string().min(1).max(1024),
      customRules: z.string().min(1).max(1024).optional(),
      runDrc: z.boolean().default(true),
      maxDetails: z.number().int().min(1).max(100).default(25)
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, projectFile, board, customRules, runDrc, maxDetails }) =>
    result(await audited(ctx.audit, 'kicad_constraints_review', workspace, () => ctx.engineering.kicad.constraintsReview(
      workspace,
      projectPath,
      { projectFile, board, ...(customRules ? { customRules } : {}) },
      { runDrc, maxDetails }
    ))));

  const visualCommon = {
    workspace: z.string().min(1),
    projectPath: z.string().default('.'),
    workSessionId: z.string().uuid(),
    outputDir: z.string().min(1).max(1024)
  };
  const schematicPages = z.array(z.number().int().min(1).max(9999)).max(32).optional();
  const schematicTheme = z.string().min(1).max(128).refine(value => !/[\u0000-\u001f\u007f]/.test(value), { message: 'theme contains control characters' }).optional();
  const kicadVisualExport = z.discriminatedUnion('kind', [
    z.object({
      ...visualCommon,
      kind: z.literal('schematic_svg'),
      schematic: z.string().min(1).max(1024),
      blackAndWhite: z.boolean().optional(),
      excludeDrawingSheet: z.boolean().optional(),
      pages: schematicPages,
      theme: schematicTheme
    }).strict(),
    z.object({
      ...visualCommon,
      kind: z.literal('schematic_pdf'),
      schematic: z.string().min(1).max(1024),
      fileName: z.string().min(1).max(128).optional(),
      blackAndWhite: z.boolean().optional(),
      excludeDrawingSheet: z.boolean().optional(),
      pages: schematicPages,
      theme: schematicTheme
    }).strict(),
    z.object({
      ...visualCommon,
      kind: z.literal('pcb_3d_render'),
      board: z.string().min(1).max(1024),
      fileName: z.string().min(1).max(128).optional(),
      format: z.enum(['png', 'jpeg']).default('png'),
      width: z.number().int().min(320).max(4096).default(1600),
      height: z.number().int().min(240).max(4096).default(900),
      side: z.enum(['top', 'bottom', 'left', 'right', 'front', 'back']).default('top'),
      background: z.enum(['default', 'transparent', 'opaque']).default('default'),
      quality: z.enum(['basic', 'high']).default('high'),
      perspective: z.boolean().default(true),
      floor: z.boolean().default(true),
      useBoardStackupColors: z.boolean().default(true),
      zoom: z.number().finite().min(0.1).max(10).default(1)
    }).strict(),
    z.object({
      ...visualCommon,
      kind: z.literal('pcb_step'),
      board: z.string().min(1).max(1024),
      fileName: z.string().min(1).max(128).optional(),
      noDnp: z.boolean().default(true),
      boardOnly: z.boolean().default(false),
      substituteModels: z.boolean().default(true),
      includeTracks: z.boolean().default(false),
      includePads: z.boolean().default(false),
      includeZones: z.boolean().default(false),
      includeInnerCopper: z.boolean().default(false),
      includeSilkscreen: z.boolean().default(false),
      includeSoldermask: z.boolean().default(false),
      fuseShapes: z.boolean().default(false)
    }).strict()
  ]);

  server.registerTool('kicad_visual_export', {
    description: 'Create a new project-scoped KiCad visualization artifact without modifying source files. Typed modes export schematic SVG/PDF, render PCB 3D PNG/JPEG, or export mechanical STEP. Requires a Work Session, rejects existing output directories, blocks path escape/symlinks, uses official kicad-cli subcommands and returns a SHA-256 manifest.',
    inputSchema: kicadVisualExport,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ workSessionId, ...request }) =>
    result(await audited(ctx.audit, 'kicad_visual_export', request.workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.visualExport(request.workspace, request.projectPath, request))
    )));

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
