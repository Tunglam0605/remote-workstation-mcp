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
