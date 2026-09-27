import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KicadAdapter } from '../src/adapters/engineering/kicad.js';
import { inspectKicadDocument, patchKicadDocument, sha256Text } from '../src/adapters/engineering/kicad-edit.js';
import { EngineeringResourceManager } from '../src/adapters/engineering/resource-manager.js';
import type { EngineeringCommandResult } from '../src/engineering/types.js';
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

async function fakeExecutable(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  if (process.platform === 'win32') await fs.writeFile(path.join(dir, 'kicad-cli.cmd'), '@echo off\r\nexit /b 0\r\n');
  else {
    const file = path.join(dir, 'kicad-cli');
    await fs.writeFile(file, '#!/bin/sh\nexit 0\n');
    await fs.chmod(file, 0o755);
  }
}

function cmd(program: string, args: string[], cwd: string, stdout = '', stderr = '', exitCode = 0): EngineeringCommandResult {
  return { program, args: [...args], cwd, exitCode, stdout, stderr, timedOut: false, durationMs: 1 };
}

const SCH = '(kicad_sch\n  (version 20240108)\n  (generator rwmcp-test)\n  (symbol\n    (lib_id "Device:R")\n    (at 10 20 90)\n    (in_bom yes)\n    (on_board yes)\n    (uuid 11111111-1111-4111-8111-111111111111)\n    (property "Reference" "R1" (at 10 18 90))\n    (property "Value" "10k" (at 10 20 90))\n    (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 10 22 90))\n    (property "Datasheet" "https://example.invalid/r.pdf" (at 10 24 90))\n    (instances (project "demo" (path "/" (reference "R1") (unit 1))))\n  )\n)\n';

const PCB = '(kicad_pcb\n  (version 20240108)\n  (generator rwmcp-test)\n  (footprint "Resistor_SMD:R_0603_1608Metric"\n    (layer "F.Cu")\n    (at 12.5 33.25 90)\n    (uuid 22222222-2222-4222-8222-222222222222)\n    (property "Reference" "R1" (at 0 -1.5 90) (layer "F.SilkS"))\n    (property "Value" "10k" (at 0 1.5 90) (layer "F.Fab"))\n    (clearance 0.2)\n    (zone_connect 1)\n    (attr smd exclude_from_pos_files)\n  )\n)\n';

test('KiCad edit parser exposes stable targets and patches only selected structural block', () => {
  const inspected = inspectKicadDocument(SCH, '.kicad_sch');
  assert.equal(inspected.kind, 'schematic');
  assert.equal(inspected.itemCount, 1);
  assert.equal(inspected.items[0]?.reference, 'R1');
  assert.equal(inspected.items[0]?.value, '10k');
  const patched = patchKicadDocument(SCH, [{
    kind: 'schematic_symbol_property',
    reference: 'R1',
    property: 'Value',
    value: '4.7k'
  }], '.kicad_sch');
  assert.match(patched.text, /\(property "Value" "4\.7k"/);
  assert.match(patched.text, /\(property "Footprint" "Resistor_SMD:R_0603_1608Metric"/);
  assert.equal(patched.results[0]?.before, '10k');
  assert.equal(patched.results[0]?.after, '4.7k');
});

test('KiCad Phase-2 schematic flags and datasheet edits are typed', () => {
  const inspected = inspectKicadDocument(SCH, '.kicad_sch');
  assert.equal(inspected.items[0]?.datasheet, 'https://example.invalid/r.pdf');
  assert.equal(inspected.items[0]?.inBom, true);
  assert.equal(inspected.items[0]?.onBoard, true);
  const patched = patchKicadDocument(SCH, [
    {
      kind: 'schematic_symbol_property',
      reference: 'R1',
      property: 'Datasheet',
      value: 'https://example.invalid/new.pdf'
    },
    {
      kind: 'schematic_symbol_flags',
      reference: 'R1',
      inBom: false,
      onBoard: false
    }
  ], '.kicad_sch');
  assert.match(patched.text, /\(property "Datasheet" "https:\/\/example\.invalid\/new\.pdf"/);
  assert.match(patched.text, /\(in_bom no\)/);
  assert.match(patched.text, /\(on_board no\)/);
});

test('KiCad Phase-2 PCB attributes and footprint copper settings preserve unrelated flags', () => {
  const inspected = inspectKicadDocument(PCB, '.kicad_pcb');
  assert.equal(inspected.items[0]?.attributes.type, 'smd');
  assert.equal(inspected.items[0]?.attributes.excludeFromPosFiles, true);
  assert.equal(inspected.items[0]?.attributes.excludeFromBom, false);
  assert.equal(inspected.items[0]?.clearance, 0.2);
  assert.equal(inspected.items[0]?.zoneConnect, 1);

  const patched = patchKicadDocument(PCB, [
    {
      kind: 'pcb_footprint_attributes',
      reference: 'R1',
      excludeFromBom: true,
      excludeFromPosFiles: false,
      boardOnly: true
    },
    {
      kind: 'pcb_footprint_copper',
      reference: 'R1',
      clearance: 0.35,
      zoneConnect: 2
    }
  ], '.kicad_pcb');

  assert.match(patched.text, /\(attr smd board_only exclude_from_bom\)/);
  assert.doesNotMatch(patched.text, /exclude_from_pos_files/);
  assert.match(patched.text, /\(clearance 0\.35\)/);
  assert.match(patched.text, /\(zone_connect 2\)/);
});

test('KiCad board move is typed and preserves footprint properties', () => {
  const patched = patchKicadDocument(PCB, [{
    kind: 'pcb_footprint_move',
    uuid: '22222222-2222-4222-8222-222222222222',
    x: 20,
    y: 40,
    rotation: 180
  }], '.kicad_pcb');
  assert.match(patched.text, /\(at 20 40 180\)/);
  assert.match(patched.text, /\(property "Reference" "R1"/);
  assert.match(patched.text, /\(property "Value" "10k"/);
});

test('KiCad transactional edit blocks stale SHA before validation or mutation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-edit-conflict-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin);
  process.env.PATH = bin + path.delimiter + (oldPath ?? '');
  const schematic = path.join(root, 'robot.kicad_sch');
  await fs.writeFile(schematic, SCH);
  const calls: string[][] = [];
  const runner = { async run(program: string, args: string[], cwd: string) { calls.push([...args]); return cmd(program, args, cwd); } };
  try {
    const policy = new PolicyEngine(config(root));
    const adapter = new KicadAdapter(policy, new PathGuard(policy), runner as never, new EngineeringResourceManager('tester'));
    await assert.rejects(
      adapter.transactionalEdit('w', '.', 'robot.kicad_sch', '0'.repeat(64), [{
        kind: 'schematic_symbol_property',
        reference: 'R1',
        property: 'Value',
        value: '22k'
      }]),
      /KICAD_EDIT_CONFLICT/
    );
    assert.equal(calls.length, 0);
    assert.equal(await fs.readFile(schematic, 'utf8'), SCH);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('KiCad transactional edit commits after non-regressing ERC acceptance and writes backup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-edit-commit-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin);
  process.env.PATH = bin + path.delimiter + (oldPath ?? '');
  const schematic = path.join(root, 'robot.kicad_sch');
  await fs.writeFile(schematic, SCH);
  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      const outputIndex = args.indexOf('--output');
      const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
      if (args.includes('erc') && output) await fs.writeFile(output, JSON.stringify({ sheets: [{ path: '/', violations: [] }] }));
      return cmd(program, args, cwd);
    }
  };
  try {
    const policy = new PolicyEngine(config(root));
    const adapter = new KicadAdapter(policy, new PathGuard(policy), runner as never, new EngineeringResourceManager('tester'));
    const edit = await adapter.transactionalEdit('w', '.', 'robot.kicad_sch', sha256Text(SCH), [{
      kind: 'schematic_symbol_property',
      reference: 'R1',
      property: 'Value',
      value: '22k'
    }]);
    assert.equal(edit.state, 'committed');
    assert.equal(edit.acceptance.passed, true);
    assert.match(await fs.readFile(schematic, 'utf8'), /\(property "Value" "22k"/);
    assert.equal(edit.originalSha256, sha256Text(SCH));
    assert.notEqual(edit.committedSha256, edit.originalSha256);
    assert.equal(await fs.readFile(path.join(root, edit.backupPath), 'utf8'), SCH);
    assert.equal((await fs.readdir(root)).some(name => name.startsWith('.rwmcp-edit-')), false);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('KiCad transactional edit fails closed when DRC regresses and leaves source byte-identical', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-edit-reject-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin);
  process.env.PATH = bin + path.delimiter + (oldPath ?? '');
  const board = path.join(root, 'robot.kicad_pcb');
  await fs.writeFile(board, PCB);
  let drcCalls = 0;
  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      const outputIndex = args.indexOf('--output');
      const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
      if (args.includes('drc') && output) {
        drcCalls += 1;
        await fs.writeFile(output, JSON.stringify(drcCalls === 1
          ? { violations: [], unconnected_items: [], schematic_parity: [], ignored_checks: [] }
          : { violations: [{ severity: 'error', description: 'clearance', items: [] }], unconnected_items: [], schematic_parity: [], ignored_checks: [] }));
      }
      return cmd(program, args, cwd);
    }
  };
  try {
    const policy = new PolicyEngine(config(root));
    const adapter = new KicadAdapter(policy, new PathGuard(policy), runner as never, new EngineeringResourceManager('tester'));
    await assert.rejects(
      adapter.transactionalEdit('w', '.', 'robot.kicad_pcb', sha256Text(PCB), [{
        kind: 'pcb_footprint_move',
        reference: 'R1',
        x: 20,
        y: 40
      }]),
      /KICAD_EDIT_ACCEPTANCE_FAILED/
    );
    assert.equal(await fs.readFile(board, 'utf8'), PCB);
    assert.equal((await fs.readdir(root)).some(name => name.startsWith('.rwmcp-edit-')), false);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});
