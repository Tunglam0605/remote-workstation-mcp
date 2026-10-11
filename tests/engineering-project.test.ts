import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FirmwareArtifactFinder } from '../src/adapters/engineering/artifact-finder.js';
import { FirmwareProjectInspector, stm32OpenOcdTargetConfig } from '../src/adapters/engineering/project-inspector.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

function policy(root: string): PolicyConfig {
  return {
    version: 1, mode: 'workspace', workspaces: [{ id: 'w', root, readOnly: false }],
    filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
    process: { allowExecutables: [], inheritEnv: ['PATH'], maxOutputBytes: 262144, maxRuntimeMs: 600000 },
    engineering: { enabled: true, maxCommandRuntimeMs: 600000, allowHardwareMutationInWorkspace: false, allowSerialWriteInWorkspace: false }
  };
}

test('project inspector detects ESP-IDF and target from sdkconfig', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-eng-idf-'));
  try {
    await fs.writeFile(path.join(root, 'CMakeLists.txt'), 'include($ENV{IDF_PATH}/tools/cmake/project.cmake)\nproject(callbox)\n');
    await fs.writeFile(path.join(root, 'sdkconfig'), 'CONFIG_IDF_TARGET="esp32s3"\n');
    const inspector = new FirmwareProjectInspector(new PathGuard(new PolicyEngine(policy(root))));
    const info = await inspector.inspect('w', '.');
    assert.equal(info.family, 'esp32');
    assert.equal(info.framework, 'esp-idf');
    assert.equal(info.target, 'esp32s3');
    assert.equal(info.buildSystem, 'idf.py');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('project inspector detects PlatformIO ESP32 projects and board metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-eng-platformio-'));
  try {
    await fs.writeFile(path.join(root, 'platformio.ini'), [
      '[env:esp32s3]',
      'platform = espressif32',
      'board = esp32-s3-devkitc-1',
      'framework = arduino'
    ].join('\n'));
    const inspector = new FirmwareProjectInspector(new PathGuard(new PolicyEngine(policy(root))));
    const info = await inspector.inspect('w', '.');
    assert.equal(info.family, 'esp32');
    assert.equal(info.framework, 'platformio');
    assert.equal(info.buildSystem, 'platformio');
    assert.equal(info.board, 'esp32-s3-devkitc-1');
    assert.ok(info.markers.includes('platformio.ini'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('project inspector detects STM32 Cube project and OpenOCD target mapping', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-eng-stm32-'));
  try {
    await fs.writeFile(path.join(root, 'Main.ioc'), 'Mcu.Name=STM32H743ZITx\nMcu.Family=STM32H7\nBoard=Custom\n');
    await fs.writeFile(path.join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.22)\n');
    const paths = new PathGuard(new PolicyEngine(policy(root)));
    const info = await new FirmwareProjectInspector(paths).inspect('w', '.');
    assert.equal(info.family, 'stm32');
    assert.equal(info.framework, 'stm32-cube');
    assert.equal(info.target, 'STM32H743ZITx');
    assert.equal(stm32OpenOcdTargetConfig(info.target), 'target/stm32h7x.cfg');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('artifact finder returns bounded firmware outputs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-eng-artifact-'));
  try {
    await fs.mkdir(path.join(root, 'build'));
    await fs.writeFile(path.join(root, 'build', 'app.elf'), 'elf');
    await fs.writeFile(path.join(root, 'build', 'app.bin'), 'bin');
    await fs.writeFile(path.join(root, 'build', 'ignore.txt'), 'x');
    const finder = new FirmwareArtifactFinder(new PathGuard(new PolicyEngine(policy(root))));
    const artifacts = await finder.find('w', '.');
    assert.deepEqual(new Set(artifacts.map(item => item.kind)), new Set(['elf', 'bin']));
    assert.ok(artifacts.every(item => !path.isAbsolute(item.path)));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


test('project inspector detects KiCad project files without reclassifying firmware family', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-eng-kicad-'));
  try {
    await fs.writeFile(path.join(root, 'robot.kicad_pro'), '{}');
    await fs.writeFile(path.join(root, 'robot.kicad_sch'), '(kicad_sch)');
    await fs.writeFile(path.join(root, 'robot.kicad_pcb'), '(kicad_pcb)');
    await fs.writeFile(path.join(root, 'fab.kicad_jobset'), '{}');
    const inspector = new FirmwareProjectInspector(new PathGuard(new PolicyEngine(policy(root))));
    const info = await inspector.inspect('w', '.');
    assert.equal(info.family, 'unknown');
    assert.equal(info.framework, 'unknown');
    assert.deepEqual(info.kicad, {
      project: 'robot.kicad_pro',
      schematic: 'robot.kicad_sch',
      board: 'robot.kicad_pcb',
      jobsets: ['fab.kicad_jobset']
    });
    assert.ok(info.markers.includes('robot.kicad_pcb'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('project inspector detects Keil MDK multi-target STM32 projects without guessing across devices', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-eng-keil-'));
  try {
    await fs.writeFile(path.join(root, 'Main_V2_F407.uvprojx'), `<?xml version="1.0"?>
<Project><Targets>
<Target><TargetName>Main_V2_F407</TargetName><TargetOption><TargetCommonOption>
<Device>STM32F407ZETx</Device><OutputDirectory>.\\Objects\\F407\\</OutputDirectory><OutputName>Main_V2_F407</OutputName><CreateHexFile>1</CreateHexFile>
</TargetCommonOption></TargetOption></Target>
<Target><TargetName>Main_V2_F407_HardwareTest</TargetName><TargetOption><TargetCommonOption>
<Device>STM32F407ZETx</Device><OutputDirectory>.\\Objects\\HardwareTest\\</OutputDirectory><OutputName>Main</OutputName><CreateHexFile>1</CreateHexFile>
</TargetCommonOption></TargetOption></Target>
</Targets></Project>`);
    await fs.writeFile(path.join(root, 'Main_V3_H743.uvprojx'), `<?xml version="1.0"?>
<Project><Targets><Target><TargetName>Main_V3_H743</TargetName><TargetOption><TargetCommonOption>
<Device>STM32H743ZITx</Device><OutputDirectory>.\\Objects\\H743\\</OutputDirectory><OutputName>Main_V3_H743</OutputName>
</TargetCommonOption></TargetOption></Target></Targets></Project>`);

    const inspector = new FirmwareProjectInspector(new PathGuard(new PolicyEngine(policy(root))));
    const info = await inspector.inspect('w', '.');
    assert.equal(info.family, 'stm32');
    assert.equal(info.framework, 'keil-mdk');
    assert.equal(info.buildSystem, 'keil');
    assert.equal(info.target, undefined, 'multi-device Keil projects must not guess one MCU target');
    assert.equal(info.targets?.length, 3);
    const f407 = info.targets?.find(item => item.targetName === 'Main_V2_F407');
    assert.equal(f407?.projectFile, 'Main_V2_F407.uvprojx');
    assert.equal(f407?.device, 'STM32F407ZETx');
    assert.equal(f407?.outputDirectory, 'Objects/F407');
    assert.equal(f407?.expectedArtifact, 'Objects/F407/Main_V2_F407.axf');
    assert.equal(f407?.createHexFile, true);
    const h743 = info.targets?.find(item => item.targetName === 'Main_V3_H743');
    assert.equal(stm32OpenOcdTargetConfig(h743?.device), 'target/stm32h7x.cfg');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('KiCad inspection chooses matching .pro/.sch/.pcb rather than alphabetical leftover .pro', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-canonical-'));
  try {
    await fs.writeFile(path.join(root, '_candidate_ground.kicad_pro'), '{}');
    await fs.writeFile(path.join(root, 'mega_v11.kicad_pro'), '{}');
    await fs.writeFile(path.join(root, 'mega_v11.kicad_sch'), '(kicad_sch)');
    await fs.writeFile(path.join(root, 'mega_v11.kicad_pcb'), '(kicad_pcb)');
    const inspector = new FirmwareProjectInspector(new PathGuard(new PolicyEngine(policy(root))));
    const result = await inspector.inspect('w');
    assert.deepEqual(result.kicad, {
      project: 'mega_v11.kicad_pro',
      schematic: 'mega_v11.kicad_sch',
      board: 'mega_v11.kicad_pcb',
      jobsets: []
    });
    assert.ok(!result.markers.includes('_candidate_ground.kicad_pro'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('KiCad inspection rejects multiple complete projects with equal authority', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-ambiguous-'));
  try {
    for (const stem of ['old', 'new']) {
      for (const ext of ['pro', 'sch', 'pcb']) {
        await fs.writeFile(path.join(root, stem + '.kicad_' + ext), 'fixture');
      }
    }
    const inspector = new FirmwareProjectInspector(new PathGuard(new PolicyEngine(policy(root))));
    await assert.rejects(() => inspector.inspect('w'), /Ambiguous KiCad project.*old.*Select the intended/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('KiCad inspection selects a same-name project folder among complete revisions', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-folder-'));
  const root = path.join(parent, 'current');
  await fs.mkdir(root);
  try {
    for (const stem of ['current', 'legacy']) {
      for (const ext of ['pro', 'sch', 'pcb']) {
        await fs.writeFile(path.join(root, stem + '.kicad_' + ext), 'fixture');
      }
    }
    const inspector = new FirmwareProjectInspector(new PathGuard(new PolicyEngine(policy(parent))));
    const result = await inspector.inspect('w', 'current');
    assert.equal(result.kicad?.project, 'current.kicad_pro');
    assert.equal(result.kicad?.schematic, 'current.kicad_sch');
    assert.equal(result.kicad?.board, 'current.kicad_pcb');
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});

test('KiCad inspection does not combine mismatched lone .sch with unrelated .pro', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-partial-'));
  try {
    await fs.writeFile(path.join(root, 'first.kicad_pro'), '{}');
    await fs.writeFile(path.join(root, 'second.kicad_sch'), '(kicad_sch)');
    const inspector = new FirmwareProjectInspector(new PathGuard(new PolicyEngine(policy(root))));
    await assert.rejects(() => inspector.inspect('w'), /Ambiguous KiCad project/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
