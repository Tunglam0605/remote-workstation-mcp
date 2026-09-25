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

function config(root: string): PolicyConfig {
  return {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'w', root, readOnly: false }],
    filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
    process: { allowExecutables: [], inheritEnv: ['PATH', 'HOME', 'TEMP', 'TMP'], maxOutputBytes: 256 * 1024, maxRuntimeMs: 60_000 },
    engineering: { enabled: true, maxCommandRuntimeMs: 60_000, allowHardwareMutationInWorkspace: false, allowSerialWriteInWorkspace: false }
  };
}

async function fakeExecutable(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  if (process.platform === 'win32') await fs.writeFile(path.join(dir, 'kicad-cli.cmd'), '@echo off\r\nexit /b 0\r\n');
  else { const file = path.join(dir, 'kicad-cli'); await fs.writeFile(file, '#!/bin/sh\nexit 0\n'); await fs.chmod(file, 0o755); }
}

function result(program: string, args: string[], cwd: string, stdout = '', stderr = '', exitCode = 0): EngineeringCommandResult {
  return { program, args: [...args], cwd, exitCode, stdout, stderr, timedOut: false, durationMs: 1 };
}

test('KiCad professional tools use temporary reports and fixed BOM fields without source mutation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-professional-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin);
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  const schematic = path.join(root, 'robot.kicad_sch');
  const board = path.join(root, 'robot.kicad_pcb');
  await fs.writeFile(schematic, '(kicad_sch source)');
  await fs.writeFile(board, '(kicad_pcb source)');
  const schBefore = await fs.readFile(schematic, 'utf8');
  const pcbBefore = await fs.readFile(board, 'utf8');
  const calls: string[][] = [];
  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push([...args]);
      if (args[0] === 'version') return result(program, args, cwd, '10.0.6\n');
      if (args.at(-1) === '--help') return result(program, args, cwd, 'Usage: supported\n');
      const outputIndex = args.indexOf('--output');
      const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
      if (!output) return result(program, args, cwd, '', 'missing output', 2);
      if (args.includes('stats')) await fs.writeFile(output, JSON.stringify({ board_size: { width: 100, height: 80 }, copper_layers: 4, vias: 12 }));
      else if (args.includes('drc')) await fs.writeFile(output, JSON.stringify({ violations: [], unconnected_items: [], schematic_parity: [], ignored_checks: [] }));
      else if (args.includes('erc')) await fs.writeFile(output, JSON.stringify({ sheets: [{ path: '/', violations: [] }] }));
      else if (args.includes('bom')) await fs.writeFile(output, 'Refs,Value,Footprint,Qty,DNP\nR1,R10k,R_0603,1,\nC1,100n,C_0603,1,1\n');
      return result(program, args, cwd);
    }
  };
  try {
    const engine = new PolicyEngine(config(root));
    const adapter = new KicadAdapter(engine, new PathGuard(engine), runner as never);
    assert.equal((await adapter.version('w')).version, '10.0.6');
    const stats = await adapter.boardStats('w', '.', 'robot.kicad_pcb');
    assert.deepEqual(stats.report, { board_size: { width: 100, height: 80 }, copper_layers: 4, vias: 12 });
    assert.equal((await adapter.drc('w', '.', 'robot.kicad_pcb')).report.counts.total, 0);
    assert.equal((await adapter.erc('w', '.', 'robot.kicad_sch')).report.counts.violations, 0);
    const validation = await adapter.validate('w', '.', { board: 'robot.kicad_pcb', schematic: 'robot.kicad_sch', jobsets: [] });
    assert.equal(validation.drc?.report.counts.total, 0);
    assert.equal(validation.erc?.report.counts.violations, 0);
    const bom = await adapter.bomReport('w', '.', 'robot.kicad_sch', 10);
    assert.equal(bom.report.rowCount, 2);
    assert.equal(bom.report.dnpRows, 1);
    const bomArgs = calls.find(args => args.includes('bom') && args.includes('--fields'))!;
    assert.deepEqual(bomArgs.slice(0, 7), ['sch', 'export', 'bom', '--fields', 'Reference,Value,Footprint,QUANTITY,DNP', '--labels', 'Refs,Value,Footprint,Qty,DNP']);
    assert.equal(calls.flat().includes('upgrade'), false);
    assert.equal(calls.flat().includes('python-bom'), false);
    assert.equal(calls.flat().includes('--save-board'), false);
    assert.equal(await fs.readFile(schematic, 'utf8'), schBefore);
    assert.equal(await fs.readFile(board, 'utf8'), pcbBefore);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('KiCad diagnostics degrade when optional board statistics are unavailable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-no-stats-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin);
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  await fs.writeFile(path.join(root, 'robot.kicad_pcb'), '(kicad_pcb source)');
  const calls: string[][] = [];
  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push([...args]);
      if (args[0] === 'version') return result(program, args, cwd, '9.0.5\\n');
      if (args.at(-1) === '--help' && args.includes('stats')) return result(program, args, cwd, '', 'unknown command', 2);
      if (args.at(-1) === '--help') return result(program, args, cwd, 'Usage: supported\\n');
      return result(program, args, cwd);
    }
  };
  try {
    const engine = new PolicyEngine(config(root));
    const adapter = new KicadAdapter(engine, new PathGuard(engine), runner as never);
    const diagnostics = await adapter.diagnostics('w', '.', { board: 'robot.kicad_pcb', jobsets: [] });
    assert.equal(diagnostics.provider.capabilities.boardStats, false);
    assert.equal(diagnostics.boardStats, undefined);
    assert.match(diagnostics.warnings?.[0] ?? '', /statistics are unavailable/i);
    await assert.rejects(() => adapter.boardStats('w', '.', 'robot.kicad_pcb'), /KICAD_CAPABILITY_UNAVAILABLE/);
    assert.equal(calls.some(args => args.includes('stats') && args.includes('--output')), false);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('KiCad BOM report rejects non-schematic inputs before export', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-bom-invalid-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin);
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  await fs.writeFile(path.join(root, 'robot.txt'), 'not schematic');
  const calls: string[][] = [];
  const runner = { async run(program: string, args: string[], cwd: string) { calls.push([...args]); return result(program, args, cwd); } };
  try {
    const engine = new PolicyEngine(config(root));
    const adapter = new KicadAdapter(engine, new PathGuard(engine), runner as never);
    await assert.rejects(() => adapter.bomReport('w', '.', 'robot.txt'), /\.kicad_sch/);
    assert.equal(calls.length, 0);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});
