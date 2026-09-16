import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DebugSessionManager } from '../src/adapters/engineering/debug-session.js';
import { DockerAdapter } from '../src/adapters/engineering/docker.js';
import { FirmwareAdapter } from '../src/adapters/engineering/firmware.js';
import { EngineeringResourceManager } from '../src/adapters/engineering/resource-manager.js';
import type { EngineeringCommandResult } from '../src/engineering/types.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

async function fakeTool(dir: string, name: string): Promise<void> {
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(dir, `${name}.cmd`), '@echo off\r\nexit /b 0\r\n');
  } else {
    const file = path.join(dir, name);
    await fs.writeFile(file, '#!/bin/sh\nexit 0\n');
    await fs.chmod(file, 0o755);
  }
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-eng-hardening-'));
  const bin = path.join(root, 'bin');
  const project = path.join(root, 'project');
  await fs.mkdir(bin);
  await fs.mkdir(path.join(project, 'build'), { recursive: true });
  await fs.mkdir(path.join(root, 'outside'));
  await fs.writeFile(path.join(root, 'outside', 'app.elf'), 'OUTSIDE');
  await fs.writeFile(path.join(project, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nproject(test C)\n');
  await fs.writeFile(path.join(project, 'board.ioc'), 'Mcu.Name=STM32H743ZIT6\n');
  await fs.writeFile(path.join(project, 'build', 'app.elf'), 'ELF');
  await Promise.all(['cmake', 'openocd', 'docker', 'arm-none-eabi-gdb'].map(name => fakeTool(bin, name)));

  const config: PolicyConfig = {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'w', root, readOnly: false }],
    filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
    process: { allowExecutables: [], inheritEnv: ['PATH', 'HOME', 'TEMP', 'TMP'], maxOutputBytes: 65536, maxRuntimeMs: 60000, maxInputBytes: 65536 },
    engineering: { enabled: true, maxCommandRuntimeMs: 60000, allowHardwareMutationInWorkspace: true, allowSerialWriteInWorkspace: false }
  };
  const policy = new PolicyEngine(config);
  const paths = new PathGuard(policy);
  const calls: Array<{ program: string; args: string[]; cwd: string }> = [];
  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push({ program, args: [...args], cwd });
      return { program, args: [...args], cwd, exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
    }
  };
  const hardware = { async list() { return []; } };
  return { root, bin, policy, paths, calls, runner, hardware };
}

async function withFixture(fn: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const oldPath = process.env.PATH;
  const f = await fixture();
  process.env.PATH = `${f.bin}${path.delimiter}${oldPath ?? ''}`;
  try { await fn(f); } finally {
    process.env.PATH = oldPath;
    await fs.rm(f.root, { recursive: true, force: true });
  }
}

test('OpenOCD targetConfig only accepts packaged target/*.cfg identifiers', async () => {
  await withFixture(async f => {
    const firmware = new FirmwareAdapter(f.policy, f.paths, f.runner as never, new EngineeringResourceManager('owner'), f.hardware as never);
    await assert.rejects(
      () => firmware.flashPlan({ workspace: 'w', projectPath: 'project', artifact: 'build/app.elf', provider: 'openocd', targetConfig: '../../evil.cfg' }),
      /targetConfig|OpenOCD target config/i
    );
  });
});

test('CMake build directory cannot escape the selected project root', async () => {
  await withFixture(async f => {
    const firmware = new FirmwareAdapter(f.policy, f.paths, f.runner as never, new EngineeringResourceManager('owner'), f.hardware as never);
    await assert.rejects(
      () => firmware.build('w', 'project', 'cmake', '../outside'),
      /buildDir|project root|escape/i
    );
    assert.equal(f.calls.length, 0);
  });
});

test('container_exec rejects shell hosts that would reintroduce arbitrary shell strings', async () => {
  await withFixture(async f => {
    const docker = new DockerAdapter(f.policy, f.paths, f.runner as never);
    await assert.rejects(
      () => docker.exec('w', 'demo', 'sh', ['-c', 'echo unsafe']),
      /shell|interpreter/i
    );
    assert.equal(f.calls.length, 0);
  });
});



test('firmware verify auto-selects the only discovered ST-Link serial for lease and backend argv', async () => {
  await withFixture(async f => {
    const hardware = {
      async list() {
        return [{ id: 'debug-probe:test:SN1', kind: 'debug-probe', name: 'ST-Link', serialNumber: 'SN1', provider: 'test', capabilities: ['swd', 'openocd', 'gdb'] }];
      }
    };
    const firmware = new FirmwareAdapter(f.policy, f.paths, f.runner as never, new EngineeringResourceManager('owner'), hardware as never);
    await firmware.verify({ workspace: 'w', projectPath: 'project', artifact: 'build/app.elf' });
    assert.equal(f.calls.length, 1);
    assert.ok(f.calls[0]!.args.includes('adapter serial SN1'));
  });
});

test('debug session requires an explicit probe serial before launching backend processes', async () => {
  await withFixture(async f => {
    const debug = new DebugSessionManager(f.policy, f.paths, new EngineeringResourceManager('owner'), 'owner');
    await assert.rejects(
      () => debug.start({ workspace: 'w', projectPath: 'project', symbols: 'build/app.elf' }),
      /probeSerial|required|explicit/i
    );
  });
});

test('debug session rejects arbitrary OpenOCD target config paths before spawning OpenOCD', async () => {
  await withFixture(async f => {
    const debug = new DebugSessionManager(f.policy, f.paths, new EngineeringResourceManager('owner'), 'owner');
    await assert.rejects(
      () => debug.start({ workspace: 'w', projectPath: 'project', symbols: 'build/app.elf', probeSerial: 'SN1', targetConfig: '../../evil.cfg' }),
      /targetConfig|OpenOCD target config/i
    );
  });
});


test('firmware artifact cannot escape the selected project subtree', async () => {
  await withFixture(async f => {
    const firmware = new FirmwareAdapter(f.policy, f.paths, f.runner as never, new EngineeringResourceManager('owner'), f.hardware as never);
    await assert.rejects(
      () => firmware.flashPlan({ workspace: 'w', projectPath: 'project', artifact: '../outside/app.elf', provider: 'openocd', targetConfig: 'target/stm32h7x.cfg' }),
      /artifact|project root|escape/i
    );
  });
});

test('debug symbols cannot escape the selected project subtree', async () => {
  await withFixture(async f => {
    const debug = new DebugSessionManager(f.policy, f.paths, new EngineeringResourceManager('owner'), 'owner');
    await assert.rejects(
      () => debug.start({ workspace: 'w', projectPath: 'project', symbols: '../outside/app.elf', probeSerial: 'SN1', targetConfig: 'target/stm32h7x.cfg' }),
      /symbols|project root|escape/i
    );
  });
});
