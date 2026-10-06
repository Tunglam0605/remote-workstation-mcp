import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KicadAdapter } from '../src/adapters/engineering/kicad.js';
import { analyzeKicadConstraints } from '../src/adapters/engineering/kicad-constraints-review.js';
import type { EngineeringCommandResult } from '../src/engineering/types.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

const PROJECT = JSON.stringify({
  board: {
    design_settings: {
      rules: {
        min_clearance: 0.15,
        min_copper_edge_clearance: 0.25,
        min_hole_clearance: 0.2,
        min_hole_to_hole: 0.25,
        min_microvia_diameter: 0.3,
        min_microvia_drill: 0.1,
        min_track_width: 0.2,
        min_via_annular_width: 0.15,
        min_via_diameter: 0.6,
        min_through_hole_diameter: 0.3,
        min_text_height: 0.8,
        min_text_thickness: 0.12,
        use_height_for_length_calcs: true
      },
      rule_severities: {
        clearance: 'error',
        shorting_items: 'error',
        track_width: 'error',
        diff_pair_gap_out_of_range: 'ignore',
        skew_out_of_range: 'ignore'
      },
      track_widths: [0, 0.18, 0.25, 0.5],
      via_dimensions: [
        { diameter: 0, drill: 0 },
        { diameter: 0.6, drill: 0.3 }
      ],
      diff_pair_dimensions: [
        { width: 0.2, gap: 0.15, via_gap: 0.25 }
      ]
    }
  },
  net_settings: {
    classes: [
      {
        name: 'Default',
        priority: 2147483647,
        clearance: 0.15,
        track_width: 0.25,
        via_diameter: 0.6,
        via_drill: 0.3,
        microvia_diameter: 0.3,
        microvia_drill: 0.1,
        diff_pair_width: 0.2,
        diff_pair_gap: 0.15,
        diff_pair_via_gap: 0.25
      },
      {
        name: 'HS',
        priority: 1,
        track_width: 0.18,
        diff_pair_width: 0.18,
        diff_pair_gap: 0.12
      }
    ],
    netclass_assignments: {
      USB_P: ['HS'],
      USB_N: ['HS']
    },
    netclass_patterns: [{ pattern: 'PWR*', netclass: 'Power' }]
  }
});

const BOARD = `(kicad_pcb
  (version 20250101)
  (generator rwmcp-test)
  (general (thickness 1.6))
  (layers
    (0 "F.Cu" signal)
    (2 "In1.Cu" power)
    (31 "B.Cu" signal)
    (36 "B.SilkS" user "b.silkscreen")
    (37 "F.SilkS" user "f.silkscreen")
    (44 "Edge.Cuts" user)
  )
  (setup
    (stackup
      (layer "F.Cu" (type "copper") (thickness 0.035))
      (layer "dielectric 1" (type "prepreg") (thickness 0.73) (material "FR4") (epsilon_r 4.1) (loss_tangent 0.02))
      (layer "In1.Cu" (type "copper") (thickness 0.035))
      (layer "dielectric 2" (type "core") (thickness 0.765) (material "FR4") (epsilon_r 4.2) (loss_tangent 0.018))
      (layer "B.Cu" (type "copper") (thickness 0.035))
      (copper_finish "ENIG")
      (dielectric_constraints yes)
    )
  )
  (net 0 "")
  (net 1 "USB_P")
  (net 2 "USB_N")
  (net 3 "PWR")
  (segment (start 0 0) (end 10 0) (width 0.18) (layer "F.Cu") (net 1))
  (segment (start 0 1) (end 12 1) (width 0.25) (layer "F.Cu") (net 2))
  (segment (start 0 5) (end 5 5) (width 0.5) (layer "F.Cu") (net 3))
  (via (at 5 0) (size 0.5) (drill 0.2) (layers "F.Cu" "B.Cu") (net 1))
  (via micro (at 6 1) (size 0.25) (drill 0.08) (layers "F.Cu" "In1.Cu") (net 2))
  (zone
    (net 3)
    (net_name "PWR")
    (layer "F.Cu")
    (min_thickness 0.2)
    (fill yes (thermal_gap 0.3) (thermal_bridge_width 0.4))
    (polygon (pts (xy 0 0) (xy 20 0) (xy 20 20) (xy 0 20)))
  )
)`;

const DRU = `(version 1)

(rule "USB outer geometry"
  (severity error)
  (layer outer)
  (condition "A.NetClass == 'HS'")
  (constraint track_width (min 0.16mm) (opt 0.18mm) (max 0.22mm))
  (constraint diff_pair_gap (min 0.10mm) (opt 0.12mm) (max 0.16mm))
)

(rule "USB skew"
  (condition "A.NetClass == 'HS'")
  (constraint skew (max 0.5mm))
)
`;

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

function commandResult(program: string, args: string[], cwd: string): EngineeringCommandResult {
  return { program, args: [...args], cwd, exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
}

test('KiCad constraints review separates hard minimum findings from net-class default deviations', () => {
  const review = analyzeKicadConstraints(
    { project: PROJECT, board: BOARD, customRules: DRU },
    { maxDetails: 20 }
  );

  assert.equal(review.projectRules.minimums.minTrackWidthMm, 0.2);
  assert.equal(review.projectRules.useHeightForLengthCalcs, true);
  assert.deepEqual(review.projectRules.ignoredDrcSeverities, ['diff_pair_gap_out_of_range', 'skew_out_of_range']);

  assert.equal(review.netClasses.classes[0]?.name, 'HS');
  assert.equal(review.netClasses.directAssignmentCount, 2);
  assert.equal(review.netClasses.patternCount, 1);
  assert.match(review.netClasses.note, /defaults\/optimal/i);

  assert.equal(review.board.stackup.declared, true);
  assert.equal(review.board.stackup.copperLayerCount, 3);
  assert.equal(review.board.stackup.dielectricLayerCount, 2);
  assert.equal(review.board.stackup.copperFinish, 'ENIG');
  assert.equal(review.board.stackup.dielectricConstraints, 'yes');
  assert.equal(review.board.stackup.missingDielectricMaterialCount, 0);
  assert.equal(review.board.stackup.missingDielectricEpsilonRCount, 0);
  assert.equal(review.board.stackup.missingDielectricLossTangentCount, 0);
  assert.ok((review.board.stackup.thicknessDeltaMm ?? 1) < 1e-6);

  assert.equal(review.board.zones.count, 1);
  assert.equal(review.board.zones.byNet.PWR, 1);
  assert.equal(review.board.zones.byLayer['F.Cu'], 1);

  assert.deepEqual(review.complianceEvidence.hardMinimumFindings.trackWidthBelowMinimum, [{
    net: 'USB_P',
    widthMm: 0.18,
    minimumMm: 0.2,
    layer: 'F.Cu'
  }]);
  assert.equal(review.complianceEvidence.hardMinimumFindings.viaDiameterBelowMinimum.length, 2);
  assert.equal(review.complianceEvidence.hardMinimumFindings.viaDrillBelowMinimum.length, 2);
  assert.equal(review.complianceEvidence.hardMinimumFindings.viaAnnularWidthBelowMinimum.length, 1);
  assert.equal(review.complianceEvidence.hardMinimumFindings.viaAnnularWidthBelowMinimum[0]?.type, 'micro');

  const usbPDeviation = review.complianceEvidence.netClassDefaultDeviations.find(item => item.net === 'USB_P');
  assert.ok(usbPDeviation);
  assert.equal(usbPDeviation.configuredDefaults.trackWidthMm, 0.18);
  assert.equal(usbPDeviation.differsFromConfiguredDefaults.trackWidth, false);
  assert.equal(usbPDeviation.differsFromConfiguredDefaults.viaDiameter, true);

  assert.equal(review.customRules.present, true);
  assert.equal(review.customRules.version, 1);
  assert.equal(review.customRules.ruleCount, 2);
  assert.equal(review.customRules.constraintTypeCounts.track_width, 1);
  assert.equal(review.customRules.constraintTypeCounts.diff_pair_gap, 1);
  assert.equal(review.customRules.constraintTypeCounts.skew, 1);
  assert.equal(review.customRules.rules[0]?.constraints[0]?.values.opt.simpleMm, 0.18);
  assert.match(review.customRules.evaluation ?? '', /DRC remains authoritative/);

  assert.equal(review.differentialPairs.detectedPairCount, 1);
  assert.equal(review.differentialPairs.pairs[0]?.positive, 'USB_P');
  assert.equal(review.differentialPairs.pairs[0]?.negative, 'USB_N');
  assert.equal(review.differentialPairs.pairs[0]?.explicitLengthSkewMm, 2);
  assert.deepEqual(review.differentialPairs.pairs[0]?.positiveClasses, ['HS']);
  assert.deepEqual(review.differentialPairs.pairs[0]?.negativeClasses, ['HS']);
  assert.equal(review.differentialPairs.pairs[0]?.configuredDiffPairDefaults.widthMm, 0.18);
  assert.equal(review.differentialPairs.pairs[0]?.configuredDiffPairDefaults.gapMm, 0.12);

  const codes = new Set(review.recommendations.map(item => item.code));
  assert.equal(codes.has('configured-hard-minimum-breach-evidence'), true);
  assert.equal(codes.has('custom-rules-present'), true);
  assert.equal(codes.has('critical-drc-severity-ignored'), true);
});

test('KiCad constraints review does not call net-class default deviations violations', () => {
  const review = analyzeKicadConstraints(
    { project: PROJECT, board: BOARD },
    { maxDetails: 20 }
  );
  assert.equal(review.customRules.present, false);
  const recommendation = review.recommendations.find(item => item.code === 'routing-differs-from-netclass-defaults');
  assert.ok(recommendation);
  assert.match(recommendation.message, /not a violation by itself/i);
  assert.match(review.differentialPairs.note, /evidence only/i);
});

test('KiCad adapter constraints review is source-read-only and can skip DRC', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-constraints-'));
  const projectFile = path.join(root, 'robot.kicad_pro');
  const boardFile = path.join(root, 'robot.kicad_pcb');
  const rulesFile = path.join(root, 'robot.kicad_dru');
  await fs.writeFile(projectFile, PROJECT);
  await fs.writeFile(boardFile, BOARD);
  await fs.writeFile(rulesFile, DRU);
  const before = await Promise.all([
    fs.readFile(projectFile, 'utf8'),
    fs.readFile(boardFile, 'utf8'),
    fs.readFile(rulesFile, 'utf8')
  ]);
  const calls: string[][] = [];
  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push([...args]);
      return commandResult(program, args, cwd);
    }
  };
  try {
    const policy = new PolicyEngine(config(root));
    const adapter = new KicadAdapter(policy, new PathGuard(policy), runner as never);
    const review = await adapter.constraintsReview(
      'w',
      '.',
      { projectFile: 'robot.kicad_pro', board: 'robot.kicad_pcb', customRules: 'robot.kicad_dru' },
      { runDrc: false, maxDetails: 10 }
    );
    assert.equal(review.drcRun, false);
    assert.equal(review.analysis.customRules.ruleCount, 2);
    assert.equal(calls.length, 0);
    assert.deepEqual(await Promise.all([
      fs.readFile(projectFile, 'utf8'),
      fs.readFile(boardFile, 'utf8'),
      fs.readFile(rulesFile, 'utf8')
    ]), before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
