import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KicadAdapter } from '../src/adapters/engineering/kicad.js';
import { analyzeKicadLayoutOptimization } from '../src/adapters/engineering/kicad-layout-optimization.js';
import type { EngineeringCommandResult } from '../src/engineering/types.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

const BOARD = `(kicad_pcb
  (version 20250101)
  (generator rwmcp-test)
  (net 0 "")
  (net 1 "VCC")
  (net 2 "SIG")
  (footprint "Package:U"
    (layer "F.Cu")
    (at 10 10 0)
    (property "Reference" "U1")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VCC"))
    (pad "2" smd rect (at 2 0) (size 1 1) (layers "F.Cu") (net 2 "SIG"))
  )
  (footprint "Package:U"
    (layer "F.Cu")
    (at 50 10 90)
    (property "Reference" "U2")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VCC"))
    (pad "2" smd rect (at 5 0) (size 1 1) (layers "F.Cu") (net 2 "SIG"))
  )
  (footprint "Capacitor:C"
    (layer "F.Cu")
    (at 30 30 0)
    (property "Reference" "C1")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VCC"))
    (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net 0 ""))
  )
  (segment (start 10 10) (end 10 40) (width 0.25) (layer "F.Cu") (net 1))
  (segment (start 10 40) (end 50 40) (width 0.25) (layer "F.Cu") (net 1))
  (segment (start 50 40) (end 50 10) (width 0.25) (layer "B.Cu") (net 1))
  (via (at 50 40) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1))
  (segment (start 12 10) (end 50 15) (width 0.20) (layer "F.Cu") (net 2))
)`;

const NETLIST = `(export
  (version "E")
  (nets
    (net (code "1") (name "VCC")
      (node (ref "U1") (pin "1"))
      (node (ref "U2") (pin "1"))
    )
    (net (code "2") (name "SIG")
      (node (ref "U1") (pin "2"))
      (node (ref "U2") (pin "2"))
    )
    (net (code "3") (name "GND")
      (node (ref "C1") (pin "1"))
    )
    (net (code "4") (name "SENSE")
      (node (ref "R9") (pin "1"))
    )
  )
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

test('KiCad layout optimizer derives pad geometry, routing efficiency, affinity and bounded placement candidates', () => {
  const analysis = analyzeKicadLayoutOptimization(
    { board: BOARD, schematicNetlist: NETLIST },
    { maxDetails: 20, maxPlacementNetPads: 8, maxSuggestedStepMm: 5, placementGridMm: 0.5 }
  );

  assert.equal(analysis.boardConnectivity.footprintCount, 3);
  assert.equal(analysis.boardConnectivity.padCount, 6);
  assert.equal(analysis.boardConnectivity.connectedPadCount, 5);
  assert.equal(analysis.boardConnectivity.netCount, 2);

  const vcc = analysis.routingEfficiency.topDetourNets.find(item => item.name === 'VCC');
  assert.ok(vcc);
  assert.equal(vcc.viaCount, 1);
  assert.deepEqual(vcc.copperLayers, ['B.Cu', 'F.Cu']);
  assert.ok((vcc.trackToMstRatio ?? 0) > 1.5);
  assert.ok(vcc.euclideanMstMm > 50 && vcc.euclideanMstMm < 60);

  const sig = analysis.routingEfficiency.topDetourNets.find(item => item.name === 'SIG');
  assert.ok(sig);
  assert.ok(sig.euclideanMstMm > 38 && sig.euclideanMstMm < 39);
  assert.ok((sig.trackToMstRatio ?? 0) >= 0.99 && (sig.trackToMstRatio ?? 0) <= 1.01);

  const affinity = analysis.placementOptimization.affinityPairs.find(item => item.a === 'U1' && item.b === 'U2');
  assert.ok(affinity);
  assert.equal(affinity.sharedNetCount, 2);
  assert.deepEqual(affinity.sharedNets, ['SIG', 'VCC']);

  const u1 = analysis.placementOptimization.candidates.find(item => item.reference === 'U1');
  assert.ok(u1);
  assert.ok(Math.hypot(u1.suggestedTranslationMm.x, u1.suggestedTranslationMm.y) <= 5.1);
  assert.equal((u1.suggestedTranslationMm.x * 2) % 1, 0);
  assert.equal((u1.suggestedTranslationMm.y * 2) % 1, 0);

  assert.equal(analysis.schematicConnectivity?.comparedPins, 6);
  assert.equal(analysis.schematicConnectivity?.matchingPins, 4);
  assert.deepEqual(analysis.schematicConnectivity?.netMismatches, [{
    reference: 'C1',
    pin: '1',
    schematicNet: 'GND',
    boardNet: 'VCC'
  }]);
  assert.deepEqual(analysis.schematicConnectivity?.missingBoardPins, [{
    reference: 'R9',
    pin: '1',
    schematicNet: 'SENSE'
  }]);

  const codes = new Set(analysis.recommendations.map(item => item.code));
  assert.equal(codes.has('schematic-pcb-net-mismatch'), true);
  assert.equal(codes.has('schematic-pin-missing-on-board'), true);
  assert.equal(codes.has('route-detour-candidates'), true);
  assert.equal(codes.has('via-layer-transition-candidates'), true);
  assert.equal(codes.has('net-weighted-placement-candidates'), true);
});

test('KiCad layout optimizer suppresses high-fanout nets from placement pressure without dropping routing evidence', () => {
  const analysis = analyzeKicadLayoutOptimization(
    { board: BOARD },
    { maxDetails: 20, maxPlacementNetPads: 2, maxSuggestedStepMm: 3, placementGridMm: 1 }
  );
  const candidate = analysis.placementOptimization.candidates.find(item => item.reference === 'U1');
  assert.ok(candidate);
  assert.equal(candidate.ignoredHighFanoutNetCount, 1);
  assert.equal(candidate.incidentNetCount, 1);
  assert.equal(analysis.routingEfficiency.topViaNets[0]?.name, 'VCC');
});

test('KiCad adapter exports official kicadsexpr schematic netlist to temp and removes it after planning', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-layout-plan-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin);
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  const boardPath = path.join(root, 'robot.kicad_pcb');
  const schematicPath = path.join(root, 'robot.kicad_sch');
  await fs.writeFile(boardPath, BOARD);
  await fs.writeFile(schematicPath, '(kicad_sch (version 20250101))');
  const boardBefore = await fs.readFile(boardPath, 'utf8');
  const schematicBefore = await fs.readFile(schematicPath, 'utf8');
  let tempOutput: string | undefined;
  const calls: string[][] = [];

  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push([...args]);
      if (args.at(-1) === '--help') return result(program, args, cwd, 'supported\n');
      if (args[0] === 'sch' && args[1] === 'export' && args[2] === 'netlist') {
        const outputIndex = args.indexOf('--output');
        tempOutput = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
        assert.ok(tempOutput);
        await fs.writeFile(tempOutput!, NETLIST);
      }
      return result(program, args, cwd);
    }
  };

  try {
    const policy = new PolicyEngine(config(root));
    const adapter = new KicadAdapter(policy, new PathGuard(policy), runner as never);
    const planned = await adapter.layoutOptimizePlan(
      'w', '.', 'robot.kicad_pcb', 'robot.kicad_sch',
      { runRuleChecks: false, maxDetails: 10, maxPlacementNetPads: 8, maxSuggestedStepMm: 4, placementGridMm: 0.5 }
    );
    assert.equal(planned.ruleChecksRun, false);
    assert.equal(planned.analysis.schematicConnectivity?.netMismatches.length, 1);
    assert.deepEqual(planned.netlistCommand?.args.slice(0, 5), ['sch', 'export', 'netlist', '--format', 'kicadsexpr']);
    assert.ok(calls.some(args => args.includes('netlist') && args.includes('--format') && args.includes('kicadsexpr')));
    assert.ok(tempOutput);
    await assert.rejects(() => fs.stat(tempOutput!), /ENOENT/);
    assert.equal(await fs.readFile(boardPath, 'utf8'), boardBefore);
    assert.equal(await fs.readFile(schematicPath, 'utf8'), schematicBefore);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});
