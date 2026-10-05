import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KicadAdapter } from '../src/adapters/engineering/kicad.js';
import { analyzeKicadDesign } from '../src/adapters/engineering/kicad-design-review.js';
import type { EngineeringCommandResult } from '../src/engineering/types.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

const SCH = `(kicad_sch
  (version 20250101)
  (generator rwmcp-test)
  (symbol
    (lib_id "Device:R")
    (at 10 10 0)
    (in_bom yes)
    (on_board yes)
    (uuid 11111111-1111-4111-8111-111111111111)
    (property "Reference" "R1")
    (property "Value" "10k")
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric")
    (instances (project "demo" (path "/" (reference "R1") (unit 1))))
  )
  (symbol
    (lib_id "Device:C")
    (at 20 10 0)
    (in_bom yes)
    (on_board yes)
    (uuid 22222222-2222-4222-8222-222222222222)
    (property "Reference" "C1")
    (property "Value" "100n")
    (property "Footprint" "")
    (instances (project "demo" (path "/" (reference "C1") (unit 1))))
  )
)`;

const PCB = `(kicad_pcb
  (version 20250101)
  (generator rwmcp-test)
  (net 0 "")
  (net 1 "VCC")
  (net 2 "GND")
  (gr_rect (start 0 0) (end 100 80) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))
  (footprint "Resistor_SMD:R_0805_2012Metric"
    (layer "F.Cu")
    (at 10 10 0)
    (property "Reference" "R1")
    (property "Value" "12k")
    (attr smd)
    (model "\${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0805_2012Metric.step")
  )
  (footprint "Connector_Generic:Conn_01x02"
    (layer "F.Cu")
    (at 120 10 90)
    (property "Reference" "J1")
    (property "Value" "CONN")
    (attr through_hole)
    (model "C:/vendor/models/connector.step")
  )
  (footprint "TestPoint:TestPoint_Plated_Hole_D2.0mm"
    (layer "B.Cu")
    (at 30 30)
    (property "Reference" "TP1")
    (property "Value" "TP")
    (attr through_hole board_only)
  )
  (segment (start 10 10) (end 20 10) (width 0.25) (layer "F.Cu") (net 1))
  (segment (start 20 10) (end 20.1 10) (width 0.20) (layer "F.Cu") (net 1))
  (arc (start 20.1 10) (mid 21 11) (end 22 10) (width 0.20) (layer "B.Cu") (net 1))
  (via (at 20 10) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1))
)`;

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

async function fakeExecutable(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  if (process.platform === 'win32') await fs.writeFile(path.join(dir, 'kicad-cli.cmd'), '@echo off\r\nexit /b 0\r\n');
  else {
    const file = path.join(dir, 'kicad-cli');
    await fs.writeFile(file, '#!/bin/sh\nexit 0\n');
    await fs.chmod(file, 0o755);
  }
}

function result(program: string, args: string[], cwd: string, stdout = '', stderr = '', exitCode = 0): EngineeringCommandResult {
  return { program, args: [...args], cwd, exitCode, stdout, stderr, timedOut: false, durationMs: 1 };
}

test('KiCad design review correlates schematic, placement, routing and 3D evidence', () => {
  const review = analyzeKicadDesign({ schematic: SCH, board: PCB }, { maxDetails: 20, shortSegmentMm: 0.25 });

  assert.equal(review.schematic?.symbolCount, 2);
  assert.deepEqual(review.schematic?.missingFootprintAssignments, ['C1']);
  assert.deepEqual(review.consistency?.missingOnBoard, ['C1']);
  assert.deepEqual(review.consistency?.unexpectedOnBoard, ['J1']);
  assert.deepEqual(review.consistency?.boardOnlyDeclared, ['TP1']);
  assert.deepEqual(review.consistency?.valueMismatches, [{ reference: 'R1', schematic: '10k', board: '12k' }]);
  assert.deepEqual(review.consistency?.footprintMismatches, [{
    reference: 'R1',
    schematic: 'Resistor_SMD:R_0603_1608Metric',
    board: 'Resistor_SMD:R_0805_2012Metric'
  }]);

  assert.equal(review.placement?.footprintCount, 3);
  assert.deepEqual(review.placement?.outsideEdgeBoundsApprox, [{ reference: 'J1', x: 120, y: 10 }]);
  assert.equal(review.routing?.segmentCount, 2);
  assert.equal(review.routing?.arcCount, 1);
  assert.equal(review.routing?.viaCount, 1);
  assert.equal(review.routing?.shortSegmentCount, 1);
  assert.equal(review.routing?.topViaNets[0]?.name, 'VCC');
  assert.deepEqual(review.routing?.topLongestNets[0]?.widthsMm, [0.2, 0.25]);

  assert.equal(review.models3d?.footprintWithModelCount, 2);
  assert.equal(review.models3d?.footprintWithoutModelCount, 1);
  assert.deepEqual(review.models3d?.footprintsWithoutModels, ['TP1']);
  assert.equal(review.models3d?.pathKinds.absolute, 1);
  assert.equal(review.models3d?.pathKinds.variable, 1);

  const codes = new Set(review.recommendations.map(item => item.code));
  for (const code of [
    'missing-footprint-assignment',
    'schematic-symbol-missing-on-board',
    'unexpected-board-footprint',
    'value-mismatch',
    'footprint-mismatch',
    'footprint-origin-outside-edge-bounds',
    'missing-3d-model',
    'absolute-3d-model-path',
    'short-track-segments',
    'via-heavy-net-ranking',
    'longest-routed-net-ranking'
  ]) assert.equal(codes.has(code), true, `missing recommendation ${code}`);
});

test('KiCad adapter design review optionally combines ERC/DRC without mutating sources', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-design-review-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin);
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  await fs.writeFile(path.join(root, 'robot.kicad_sch'), SCH);
  await fs.writeFile(path.join(root, 'robot.kicad_pcb'), PCB);
  const schematicBefore = await fs.readFile(path.join(root, 'robot.kicad_sch'), 'utf8');
  const boardBefore = await fs.readFile(path.join(root, 'robot.kicad_pcb'), 'utf8');

  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      const outputIndex = args.indexOf('--output');
      const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
      if (args.includes('drc') && output) {
        await fs.writeFile(output, JSON.stringify({
          violations: [{ severity: 'error', description: 'clearance', items: [] }],
          unconnected_items: [{ severity: 'error', description: 'unconnected', items: [] }],
          schematic_parity: [],
          ignored_checks: []
        }));
      } else if (args.includes('erc') && output) {
        await fs.writeFile(output, JSON.stringify({ sheets: [{ path: '/', violations: [{ severity: 'error', description: 'power pin', items: [] }] }] }));
      }
      return result(program, args, cwd);
    }
  };

  try {
    const policy = new PolicyEngine(config(root));
    const adapter = new KicadAdapter(policy, new PathGuard(policy), runner as never);
    const review = await adapter.designReview(
      'w',
      '.',
      { schematic: 'robot.kicad_sch', board: 'robot.kicad_pcb' },
      { runRuleChecks: true, maxDetails: 10 }
    );
    assert.equal(review.ruleChecksRun, true);
    assert.equal(review.validation.drc?.report.counts.active.bySeverity.error, 2);
    assert.equal(review.validation.erc?.report.counts.active.bySeverity.error, 1);
    assert.equal(review.analysis.recommendations[0]?.code, 'active-erc-findings');
    assert.equal(review.analysis.recommendations[1]?.code, 'active-drc-findings');
    assert.equal(await fs.readFile(path.join(root, 'robot.kicad_sch'), 'utf8'), schematicBefore);
    assert.equal(await fs.readFile(path.join(root, 'robot.kicad_pcb'), 'utf8'), boardBefore);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});
