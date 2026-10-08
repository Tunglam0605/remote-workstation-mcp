import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KicadAdapter } from '../src/adapters/engineering/kicad.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

function config(root: string): PolicyConfig {
  return {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'w', root, readOnly: false }],
    filesystem: { maxReadBytes: 64 * 1024 * 1024, maxWriteBytes: 64 * 1024 * 1024 },
    process: { allowExecutables: [], inheritEnv: ['PATH', 'HOME', 'TEMP', 'TMP'], maxOutputBytes: 256 * 1024, maxRuntimeMs: 60_000 },
    engineering: { enabled: true, maxCommandRuntimeMs: 60_000, allowHardwareMutationInWorkspace: false, allowSerialWriteInWorkspace: false }
  };
}

function baseRequest() {
  return {
    outputDir: 'generated/robot',
    projectName: 'robot',
    components: [
      { reference: 'R1', symbolId: 'Device:R', footprintId: 'Resistor_SMD:R_0603_1608Metric', value: '10k' },
      { reference: 'R2', symbolId: 'Device:R', footprintId: 'Resistor_SMD:R_0603_1608Metric', value: '1k' }
    ],
    nets: [{ name: 'SIG', endpoints: [{ reference: 'R1', pinNumber: '1' }, { reference: 'R2', pinNumber: '1' }] }],
    board: { widthMm: 60, heightMm: 40, copperLayers: 2 as const },
    placement: { retrySpacingMultipliers: [1, 1.5], minSpacingMm: 3 },
    routing: { enabled: true, batchSize: 2, gridMm: 0.5 },
    reviewArtifacts: false,
    manufacturing: { enabled: true }
  };
}

function cleanValidation() {
  return {
    files: {},
    drc: { report: { counts: { active: { bySeverity: { error: 0 }, violations: 0, unconnected: 0, schematicParity: 0 } } } },
    erc: { report: { counts: { active: { bySeverity: { error: 0 } } } } }
  };
}

async function adapterWithStages(root: string, options: {
  failFirstBoard?: boolean;
  routeComplete?: boolean;
  routeApplyThrows?: boolean;
  validation?: ReturnType<typeof cleanValidation>;
  electricalHigh?: number;
}) {
  const policy = new PolicyEngine(config(root));
  const adapter = new KicadAdapter(policy, new PathGuard(policy), { run: async () => { throw new Error('runner should not be used'); } } as never);
  const calls: string[] = [];
  let boardAttempts = 0;
  let shaIndex = 0;
  let manufacturingCalls = 0;
  let lastRouteRequest: any;

  (adapter as any).schematicSynthesize = async () => {
    calls.push('schematic');
    return {
      outputDir: 'generated/robot',
      projectFile: 'generated/robot/robot.kicad_pro',
      schematicFile: 'generated/robot/robot.kicad_sch',
      designManifestFile: 'generated/robot/robot.rwmcp-design.json',
      designManifestSha256: '1'.repeat(64),
      generated: { componentCount: 2, netCount: 1, unusedPinCount: 2, components: [], nets: [] },
      roundTrip: { valid: true },
      ercRun: true,
      erc: { report: { counts: { active: { bySeverity: { error: 0 } } } } },
      manifest: { fileCount: 3, totalBytes: 1, files: [] }
    };
  };
  (adapter as any).semanticPlacementPlan = async (_w: string, _p: string, request: any) => {
    calls.push('placement:' + request.minSpacingMm);
    return {
      designManifest: request.designManifest,
      designManifestSha256: request.expectedDesignManifestSha256,
      plan: {
        schemaVersion: 1,
        board: { widthMm: 60, heightMm: 40 },
        componentCount: 2,
        roleCounts: { generic: 2 },
        placements: [
          { reference: 'R1', role: 'generic', xMm: 10, yMm: 20, rotationDeg: 0, side: 'front', locked: false, rationale: [] },
          { reference: 'R2', role: 'generic', xMm: 45, yMm: 20, rotationDeg: 0, side: 'front', locked: false, rationale: [] }
        ]
      }
    };
  };
  (adapter as any).boardSynthesize = async () => {
    boardAttempts += 1;
    calls.push('board:' + boardAttempts);
    if (options.failFirstBoard && boardAttempts === 1) throw new Error('courtyard overlap');
    return {
      projectFile: 'generated/robot/robot.kicad_pro',
      schematicFile: 'generated/robot/robot.kicad_sch',
      boardFile: 'generated/robot/robot.kicad_pcb',
      designManifest: 'generated/robot/robot.rwmcp-design.json',
      designManifestSha256: '2'.repeat(64),
      boardSha256: 'a'.repeat(64),
      generated: { componentCount: 2, netCount: 1, components: [], nets: [] },
      stats: {},
      drcRun: true,
      drc: { report: { counts: { active: { violations: 0, unconnected: 1, schematicParity: 0, bySeverity: { error: 0 } } } } }
    };
  };
  (adapter as any).routePlan = async (_w: string, _p: string, _board: string, request: any) => {
    calls.push('route-plan');
    lastRouteRequest = request;
    return {
      board: 'generated/robot/robot.kicad_pcb',
      boardSha256: 'a'.repeat(64),
      plan: {
        complete: options.routeComplete !== false,
        nets: { totalNamed: 1, routableCandidateCount: 1, routedCount: 1, skippedCount: options.routeComplete === false ? 1 : 0 },
        routed: [{ netName: '/SIG', padCount: 2, edges: 1, operations: 3, estimatedLengthMm: 35, viaCount: 0 }],
        skipped: options.routeComplete === false ? [{ netName: '/AUX', reason: 'no-obstacle-safe-grid-path', padCount: 2 }] : [],
        operations: [
          { kind: 'segment', netName: '/SIG', layer: 'F.Cu', start: { x: 10, y: 20 }, end: { x: 20, y: 20 }, widthMm: 0.25 },
          { kind: 'segment', netName: '/SIG', layer: 'F.Cu', start: { x: 20, y: 20 }, end: { x: 30, y: 20 }, widthMm: 0.25 },
          { kind: 'segment', netName: '/SIG', layer: 'F.Cu', start: { x: 30, y: 20 }, end: { x: 45, y: 20 }, widthMm: 0.25 }
        ],
        operationCount: 3
      }
    };
  };
  (adapter as any).routeBatchApply = async (_w: string, _p: string, request: any) => {
    calls.push('route-apply:' + request.operations.length + ':' + request.expectedBoardSha256[0]);
    if (options.routeApplyThrows) throw new Error('DRC regression');
    shaIndex += 1;
    return {
      board: request.board,
      beforeSha256: request.expectedBoardSha256,
      afterSha256: String.fromCharCode(97 + shaIndex).repeat(64),
      backup: 'backup',
      summary: { segments: request.operations.length, vias: 0, nets: ['/SIG'], layers: ['F.Cu'], totalStraightLengthMm: 1 },
      drc: { before: {}, after: {} },
      accepted: true
    };
  };
  (adapter as any).validate = async () => {
    calls.push('validate');
    return options.validation ?? cleanValidation();
  };
  (adapter as any).electricalReview = async () => {
    calls.push('electrical');
    return { board: 'generated/robot/robot.kicad_pcb', boardSha256: 'd'.repeat(64), analysis: { findings: { high: options.electricalHigh ?? 0, review: 0, info: 0 }, nets: [], limitations: [] } };
  };
  (adapter as any).constraintsReview = async () => {
    calls.push('constraints');
    return { files: {}, analysis: { recommendations: [] }, drcRun: false };
  };
  (adapter as any).designReview = async () => {
    calls.push('design-review');
    return { files: {}, analysis: { recommendations: [] }, ruleChecksRun: false };
  };
  (adapter as any).visualExport = async () => {
    calls.push('visual');
    return {};
  };
  (adapter as any).manufacturingPackage = async () => {
    manufacturingCalls += 1;
    calls.push('manufacturing');
    return {
      outputDir: 'generated/robot/manufacturing',
      reportPath: 'generated/robot/manufacturing/manufacturing-report.json',
      manifestPath: 'generated/robot/manufacturing/manifest.json',
      validation: {},
      audit: { ready: true, findings: [], assemblyConsistency: {}, footprintQuality: {} },
      manifest: { fileCount: 8, totalBytes: 1, files: [] },
      commands: []
    };
  };

  return { adapter, calls, getBoardAttempts: () => boardAttempts, getManufacturingCalls: () => manufacturingCalls, getLastRouteRequest: () => lastRouteRequest };
}

test('design agent retries semantic spacing, chains route-batch SHA and emits manufacturing only after clean gates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-agent-complete-'));
  try {
    const fixture = await adapterWithStages(root, { failFirstBoard: true });
    const result = await fixture.adapter.designAgentRun('w', '.', baseRequest());
    assert.equal(result.status, 'complete');
    assert.equal(fixture.getBoardAttempts(), 2);
    assert.ok(fixture.calls.includes('placement:3'));
    assert.ok(fixture.calls.includes('placement:4.5'));
    assert.deepEqual(fixture.calls.filter(item => item.startsWith('route-apply:')), ['route-apply:2:a', 'route-apply:1:b']);
    assert.equal(result.routing.appliedBatchCount, 2);
    assert.equal(result.outputs.boardSha256, 'c'.repeat(64));
    assert.equal(fixture.getManufacturingCalls(), 1);
    assert.equal(result.validation.clean, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('design agent derives route priority and geometry from electrical intent/net classes while explicit route styles win', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-agent-routing-policy-'));
  try {
    const fixture = await adapterWithStages(root, {});
    const request = {
      ...baseRequest(),
      board: {
        ...baseRequest().board,
        minimums: { clearanceMm: 0.25 },
        defaultRouting: { trackWidthMm: 0.3, viaDiameterMm: 0.7, viaDrillMm: 0.35 },
        netClasses: [{ name: 'POWER', nets: ['SIG'], trackWidthMm: 1.2, clearanceMm: 0.5 }]
      },
      routing: { enabled: true, batchSize: 2, gridMm: 0.5, styles: [{ netName: 'SIG', widthMm: 0.9, priority: 950 }] },
      electricalIntents: [{ netName: 'SIG', kind: 'power' as const, currentA: 2 }]
    };
    await fixture.adapter.designAgentRun('w', '.', request);
    const route = fixture.getLastRouteRequest();
    assert.equal(route.defaultWidthMm, 0.3);
    assert.equal(route.defaultClearanceMm, 0.25);
    assert.equal(route.viaDiameterMm, 0.7);
    assert.equal(route.viaDrillMm, 0.35);
    assert.deepEqual(route.styles, [{ netName: 'SIG', widthMm: 0.9, priority: 950, clearanceMm: 0.5, preferredLayer: 'F.Cu' }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('design agent gives typed ground routing precedence and opposite-layer bias on two-layer boards', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-agent-ground-policy-'));
  try {
    const fixture = await adapterWithStages(root, {});
    const request = {
      ...baseRequest(),
      electricalIntents: [
        { netName: 'GND', kind: 'ground' as const },
        { netName: 'SIG', kind: 'power' as const }
      ]
    };
    await fixture.adapter.designAgentRun('w', '.', request);
    const styles = fixture.getLastRouteRequest().styles;
    assert.deepEqual(styles, [
      { netName: 'GND', priority: 800, preferredLayer: 'B.Cu' },
      { netName: 'SIG', priority: 700, preferredLayer: 'F.Cu' }
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('design agent stops at specialized review for differential/high-speed intent and skips manufacturing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-agent-specialized-'));
  try {
    const fixture = await adapterWithStages(root, {});
    const request = {
      ...baseRequest(),
      electricalIntents: [{ netName: 'SIG', kind: 'differential' as const, targetImpedanceOhm: 90, maxSkewMm: 0.5 }]
    };
    const result = await fixture.adapter.designAgentRun('w', '.', request);
    assert.equal(result.status, 'needs-specialized-review');
    assert.deepEqual(result.specializedReviewReasons, ['SIG:differential:90ohm']);
    assert.equal(fixture.getManufacturingCalls(), 0);
    assert.equal(result.stages.find(stage => stage.stage === 'manufacturing-package')?.status, 'skipped');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('design agent blocks professional schematic synthesis until programmable-device pin planning passes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-agent-intent-gate-'));
  try {
    const fixture = await adapterWithStages(root, {});
    const request = {
      ...baseRequest(),
      components: [
        ...baseRequest().components,
        { reference: 'U1', symbolId: 'MCU_ST_STM32F4:STM32F407VGT6', footprintId: 'Package_QFP:LQFP-100_14x14mm_P0.5mm' }
      ],
      nets: [
        ...baseRequest().nets,
        { name: '3V3', endpoints: [] },
        { name: 'GND', endpoints: [] },
        { name: 'CAN1_TX', endpoints: [] },
        { name: 'CAN1_RX', endpoints: [] }
      ],
      designIntent: {
        schemaVersion: 1 as const,
        name: 'MCU Controller',
        rails: [
          { name: 'GND', nominalVoltageV: 0, source: 'derived' as const, isGround: true },
          { name: '3V3', nominalVoltageV: 3.3, source: 'regulator' as const }
        ],
        devices: [{
          reference: 'U1', role: 'mcu' as const, partNumber: 'STM32F407VGT6', package: 'LQFP100',
          supplyRails: ['3V3', 'GND'], requiredSignals: ['CAN1_TX', 'CAN1_RX']
        }]
      }
    };
    await assert.rejects(() => fixture.adapter.designAgentRun('w', '.', request), /KICAD_DESIGN_INTENT_BLOCKED/);
    assert.equal(fixture.calls.includes('schematic'), false);

    const accepted = await fixture.adapter.designAgentRun('w', '.', {
      ...request,
      pinPlans: [{
        deviceRef: 'U1', partNumber: 'STM32F407VGT6', package: 'LQFP100', source: 'stm32-cubemx' as const,
        assignments: [
          { logicalSignal: 'CAN1_TX', peripheralSignal: 'CAN1_TX', physicalPin: 'PA12', packagePosition: '69' },
          { logicalSignal: 'CAN1_RX', peripheralSignal: 'CAN1_RX', physicalPin: 'PA11', packagePosition: '68' }
        ]
      }]
    });
    assert.equal(accepted.designIntent?.gates.pinPlanReady, true);
    assert.equal(accepted.routingPolicy?.ready, true);
    assert.ok(accepted.routingPolicy?.netClasses.some((item: any) => item.name === 'POWER_3V3'));
    assert.equal(accepted.stages.find((stage: any) => stage.stage === 'design-intent-preflight')?.status, 'passed');
    assert.equal(accepted.stages.find((stage: any) => stage.stage === 'routing-policy-preflight')?.status, 'warning');
    assert.ok(accepted.specializedReviewReasons.includes('3V3:power-ampacity-review-required'));
    assert.equal(fixture.calls.includes('schematic'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('design agent preserves accepted work and returns needs-review when routing regresses or validation remains unconnected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-agent-review-'));
  try {
    const dirty = cleanValidation();
    dirty.drc.report.counts.active.unconnected = 1;
    const fixture = await adapterWithStages(root, { routeApplyThrows: true, routeComplete: false, validation: dirty });
    const result = await fixture.adapter.designAgentRun('w', '.', baseRequest());
    assert.equal(result.status, 'needs-review');
    assert.match((result.routing as any).applyError, /DRC regression/);
    assert.equal(result.validation.unconnected, 1);
    assert.equal(fixture.getManufacturingCalls(), 0);
    assert.equal(result.outputs.boardFile, 'generated/robot/robot.kicad_pcb');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
