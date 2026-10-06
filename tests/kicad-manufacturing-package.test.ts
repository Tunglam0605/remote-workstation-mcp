import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KicadAdapter } from '../src/adapters/engineering/kicad.js';
import type { EngineeringCommandResult } from '../src/engineering/types.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

const BOARD = `(kicad_pcb
  (version 20250101)
  (generator rwmcp-test)
  (general (thickness 1.6))
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (36 "B.SilkS" user "b.silkscreen")
    (37 "F.SilkS" user "f.silkscreen")
    (44 "Edge.Cuts" user)
  )
  (footprint "Resistor_SMD:R_0603_1608Metric"
    (layer "F.Cu")
    (at 10 10)
    (property "Reference" "R1")
    (property "Value" "10k")
    (attr smd)
    (fp_rect (start -1 -0.5) (end 1 0.5) (stroke (width 0.05) (type default)) (fill none) (layer "F.CrtYd"))
    (model "\${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step")
  )
  (footprint "Capacitor_SMD:C_0603_1608Metric"
    (layer "F.Cu")
    (at 20 10)
    (property "Reference" "C1")
    (property "Value" "100n")
    (attr smd)
    (fp_rect (start -1 -0.5) (end 1 0.5) (stroke (width 0.05) (type default)) (fill none) (layer "F.CrtYd"))
    (model "\${KICAD10_3DMODEL_DIR}/Capacitor_SMD.3dshapes/C_0603_1608Metric.step")
  )
)`;

const SCH = '(kicad_sch (version 20250101) (generator rwmcp-test))';

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
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(dir, 'kicad-cli.cmd'), '@echo off\r\nexit /b 0\r\n');
  } else {
    const file = path.join(dir, 'kicad-cli');
    await fs.writeFile(file, '#!/bin/sh\nexit 0\n');
    await fs.chmod(file, 0o755);
  }
}

function result(program: string, args: string[], cwd: string, exitCode = 0, stdout = '', stderr = ''): EngineeringCommandResult {
  return { program, args: [...args], cwd, exitCode, stdout, stderr, timedOut: false, durationMs: 1 };
}

function argAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

test('KiCad manufacturing package emits clean production artifacts and leaves sources unchanged', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-mfg-package-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin);
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;

  const boardPath = path.join(root, 'robot.kicad_pcb');
  const schPath = path.join(root, 'robot.kicad_sch');
  await fs.writeFile(boardPath, BOARD);
  await fs.writeFile(schPath, SCH);
  const boardBefore = await fs.readFile(boardPath, 'utf8');
  const schBefore = await fs.readFile(schPath, 'utf8');
  const calls: string[][] = [];

  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push([...args]);
      const output = argAfter(args, '--output');
      if (args.includes('drc') && output) {
        await fs.writeFile(output, JSON.stringify({ violations: [], unconnected_items: [], schematic_parity: [], ignored_checks: [] }));
      } else if (args.includes('erc') && output) {
        await fs.writeFile(output, JSON.stringify({ sheets: [{ path: '/', violations: [] }] }));
      } else if (args.includes('gerbers') && output) {
        await fs.mkdir(output, { recursive: true });
        await fs.writeFile(path.join(output, 'robot-F_Cu.gbr'), 'G04 F.Cu*\nM02*\n');
        await fs.writeFile(path.join(output, 'robot-B_Cu.gbr'), 'G04 B.Cu*\nM02*\n');
      } else if (args.includes('drill') && output) {
        await fs.mkdir(output, { recursive: true });
        await fs.writeFile(path.join(output, 'robot-PTH.drl'), 'M48\nM30\n');
        const report = argAfter(args, '--report-path');
        if (report) await fs.writeFile(report, 'Drill report\n');
      } else if (args.includes('pos') && output) {
        await fs.writeFile(output, 'Ref,Val,Package,PosX,PosY,Rot,Side\nR1,10k,R_0603,10,10,0,top\nC1,100n,C_0603,20,10,0,top\n');
      } else if (args.includes('bom') && output) {
        await fs.writeFile(output, 'Refs,Value,Footprint,Qty,DNP\nR1,10k,R_0603,1,\nC1,100n,C_0603,1,\n');
      } else if (args.includes('ipc2581') && output) {
        await fs.writeFile(output, '<IPC-2581 revision="C"/>\n');
      } else if (args.includes('ipcd356') && output) {
        await fs.writeFile(output, 'IPC-D-356A\n');
      } else if (args.includes('odb') && output) {
        await fs.writeFile(output, Buffer.from('PK\u0003\u0004'));
      } else if (args.includes('step') && output) {
        await fs.writeFile(output, 'ISO-10303-21;\nEND-ISO-10303-21;\n');
      }
      return result(program, args, cwd);
    }
  };

  try {
    const policy = new PolicyEngine(config(root));
    const adapter = new KicadAdapter(policy, new PathGuard(policy), runner as never);
    const packaged = await adapter.manufacturingPackage('w', '.', {
      board: 'robot.kicad_pcb',
      schematic: 'robot.kicad_sch',
      outputDir: 'release/manufacturing',
      includeIpc2581: true,
      includeIpcD356: true,
      includeOdb: true,
      includeStep: true,
      requireClean: true,
      requireAssemblyConsistency: true
    });

    assert.equal(packaged.audit.ready, true);
    assert.equal(packaged.audit.assemblyConsistency.missingPositionRefs.length, 0);
    assert.equal(packaged.audit.assemblyConsistency.missingBomRefs.length, 0);
    assert.equal(packaged.audit.footprintQuality.missingCourtyardRefs.length, 0);
    assert.equal(packaged.audit.footprintQuality.missing3dModelRefs.length, 0);
    assert.ok(packaged.manifest.fileCount >= 10);
    assert.ok(packaged.manifest.files.every(item => /^[0-9a-f]{64}$/.test(item.sha256)));
    assert.equal(packaged.outputDir, 'release/manufacturing');
    assert.equal(await fs.readFile(boardPath, 'utf8'), boardBefore);
    assert.equal(await fs.readFile(schPath, 'utf8'), schBefore);

    const commandIds = packaged.commands.map(item => item.id);
    assert.deepEqual(commandIds, ['gerbers', 'drill', 'positions', 'bom', 'ipc2581', 'ipcd356', 'odb', 'step']);
    assert.equal(await fs.stat(path.join(root, 'release', 'manufacturing', 'manufacturing-report.json')).then(stat => stat.isFile()), true);
    assert.equal(await fs.stat(path.join(root, 'release', 'manufacturing', 'manifest.json')).then(stat => stat.isFile()), true);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('KiCad manufacturing package blocks dirty validation before creating output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-mfg-dirty-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin);
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  await fs.writeFile(path.join(root, 'robot.kicad_pcb'), BOARD);
  await fs.writeFile(path.join(root, 'robot.kicad_sch'), SCH);

  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      const output = argAfter(args, '--output');
      if (args.includes('drc') && output) {
        await fs.writeFile(output, JSON.stringify({
          violations: [{ severity: 'error', description: 'clearance', items: [] }],
          unconnected_items: [],
          schematic_parity: [],
          ignored_checks: []
        }));
      } else if (args.includes('erc') && output) {
        await fs.writeFile(output, JSON.stringify({ sheets: [{ path: '/', violations: [] }] }));
      }
      return result(program, args, cwd);
    }
  };

  try {
    const policy = new PolicyEngine(config(root));
    const adapter = new KicadAdapter(policy, new PathGuard(policy), runner as never);
    await assert.rejects(
      () => adapter.manufacturingPackage('w', '.', {
        board: 'robot.kicad_pcb',
        schematic: 'robot.kicad_sch',
        outputDir: 'release/blocked',
        requireClean: true
      }),
      /blocked by active validation findings/
    );
    await assert.rejects(() => fs.stat(path.join(root, 'release', 'blocked')), /ENOENT/);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});
