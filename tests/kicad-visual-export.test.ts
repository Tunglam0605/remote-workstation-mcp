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

test('KiCad visual export creates bounded schematic and 3D artifacts with manifests', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-visual-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin);
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  await fs.writeFile(path.join(root, 'robot.kicad_sch'), '(kicad_sch (version 20250101))');
  await fs.writeFile(path.join(root, 'robot.kicad_pcb'), '(kicad_pcb (version 20250101))');
  const calls: string[][] = [];

  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push([...args]);
      if (args.at(-1) === '--help') return result(program, args, cwd, 'supported\n');
      const outputIndex = args.indexOf('--output');
      const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
      if (!output) return result(program, args, cwd, '', 'missing output', 2);
      if (args.includes('svg')) {
        await fs.mkdir(output, { recursive: true });
        await fs.writeFile(path.join(output, 'robot.svg'), '<svg/>');
      } else if (args.includes('pdf')) {
        await fs.writeFile(output, Buffer.from('%PDF-1.4\n'));
      } else if (args.includes('render')) {
        await fs.writeFile(output, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      } else if (args.includes('step')) {
        await fs.writeFile(output, 'ISO-10303-21;\nEND-ISO-10303-21;\n');
      }
      return result(program, args, cwd);
    }
  };

  try {
    const policy = new PolicyEngine(config(root));
    const adapter = new KicadAdapter(policy, new PathGuard(policy), runner as never);

    const svg = await adapter.visualExport('w', '.', {
      kind: 'schematic_svg',
      schematic: 'robot.kicad_sch',
      outputDir: 'out/svg',
      blackAndWhite: true,
      pages: [1, 2]
    });
    assert.equal(svg.kind, 'schematic_svg');
    assert.equal(svg.manifest.fileCount, 1);
    assert.equal(svg.manifest.files[0]?.path, 'robot.svg');
    assert.equal(await fs.readFile(path.join(root, 'out', 'svg', 'robot.svg'), 'utf8'), '<svg/>');

    const pdf = await adapter.visualExport('w', '.', {
      kind: 'schematic_pdf',
      schematic: 'robot.kicad_sch',
      outputDir: 'out/pdf',
      fileName: 'overview.pdf',
      excludeDrawingSheet: true
    });
    assert.equal(pdf.primaryArtifact?.path, 'overview.pdf');
    assert.ok(pdf.primaryArtifact?.sha256);

    const render = await adapter.visualExport('w', '.', {
      kind: 'pcb_3d_render',
      board: 'robot.kicad_pcb',
      outputDir: 'out/render',
      fileName: 'board.png',
      format: 'png',
      width: 1280,
      height: 720,
      side: 'top',
      quality: 'high',
      perspective: true,
      floor: true,
      useBoardStackupColors: true,
      zoom: 1.2
    });
    assert.equal(render.primaryArtifact?.path, 'board.png');
    const renderCall = calls.find(args => args[0] === 'pcb' && args[1] === 'render' && args.includes('--output') && !args.includes('--help'))!;
    assert.ok(renderCall.includes('--perspective'));
    assert.ok(renderCall.includes('--floor'));
    assert.ok(renderCall.includes('--use-board-stackup-colors'));

    const step = await adapter.visualExport('w', '.', {
      kind: 'pcb_step',
      board: 'robot.kicad_pcb',
      outputDir: 'out/step',
      fileName: 'mechanical.step',
      noDnp: true,
      substituteModels: true,
      includeTracks: true,
      includePads: true,
      includeZones: true,
      includeInnerCopper: true,
      includeSilkscreen: true,
      includeSoldermask: true,
      fuseShapes: true
    });
    assert.equal(step.primaryArtifact?.path, 'mechanical.step');
    const stepCall = calls.find(args => args[0] === 'pcb' && args[1] === 'export' && args[2] === 'step' && args.includes('--output') && !args.includes('--help'))!;
    for (const flag of ['--no-dnp', '--subst-models', '--include-tracks', '--include-pads', '--include-zones', '--include-inner-copper', '--include-silkscreen', '--include-soldermask', '--fuse-shapes']) {
      assert.ok(stepCall.includes(flag), `missing ${flag}`);
    }

    await assert.rejects(
      () => adapter.visualExport('w', '.', {
        kind: 'pcb_3d_render',
        board: 'robot.kicad_pcb',
        outputDir: 'out/render'
      }),
      /already exists/
    );

    assert.equal(calls.flat().includes('--force'), false);
    assert.equal(calls.flat().includes('upgrade'), false);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('KiCad visual export rejects path escape and mismatched output extensions before execution', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-visual-reject-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin);
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  await fs.writeFile(path.join(root, 'robot.kicad_pcb'), '(kicad_pcb (version 20250101))');
  const calls: string[][] = [];
  const runner = { async run(program: string, args: string[], cwd: string) { calls.push([...args]); return result(program, args, cwd, 'supported\n'); } };
  try {
    const policy = new PolicyEngine(config(root));
    const adapter = new KicadAdapter(policy, new PathGuard(policy), runner as never);
    await assert.rejects(() => adapter.visualExport('w', '.', {
      kind: 'pcb_step',
      board: 'robot.kicad_pcb',
      outputDir: '../escape'
    }), /must not escape/);
    await assert.rejects(() => adapter.visualExport('w', '.', {
      kind: 'pcb_3d_render',
      board: 'robot.kicad_pcb',
      outputDir: 'render-safe',
      fileName: 'board.jpg',
      format: 'png'
    }), /must use \.png/);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});
