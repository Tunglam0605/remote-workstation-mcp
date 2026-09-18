import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyOpenOcdResult, resolveOpenOcdExecutable, validateAdapterSpeedKhz } from '../src/adapters/engineering/openocd-provider.js';
import { FirmwareAdapter } from '../src/adapters/engineering/firmware.js';
import { EngineeringResourceManager } from '../src/adapters/engineering/resource-manager.js';
import type { EngineeringCommandResult } from '../src/engineering/types.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

function commandResult(stderr: string, exitCode = 1, timedOut = false): EngineeringCommandResult {
  return { program: 'openocd', args: [], cwd: '.', exitCode, stdout: '', stderr, timedOut, durationMs: 10 };
}



test('OpenOCD resolver honors only an absolute owner-controlled override', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-openocd-override-'));
  const executable = path.join(root, process.platform === 'win32' ? 'openocd.exe' : 'openocd');
  await fs.writeFile(executable, process.platform === 'win32' ? '' : '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') await fs.chmod(executable, 0o755);
  const previous = process.env.RWMCP_OPENOCD_EXECUTABLE;
  try {
    process.env.RWMCP_OPENOCD_EXECUTABLE = executable;
    const resolved = await resolveOpenOcdExecutable();
    assert.equal(resolved?.path, executable);
    assert.equal(resolved?.source, 'owner-override');

    process.env.RWMCP_OPENOCD_EXECUTABLE = 'relative/openocd';
    await assert.rejects(resolveOpenOcdExecutable(), /absolute path/i);
  } finally {
    if (previous === undefined) delete process.env.RWMCP_OPENOCD_EXECUTABLE;
    else process.env.RWMCP_OPENOCD_EXECUTABLE = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('OpenOCD adapter speed is bounded and accepts common 4 MHz SWD', () => {
  assert.equal(validateAdapterSpeedKhz(4000), 4000);
  assert.equal(validateAdapterSpeedKhz(undefined), undefined);
  assert.throws(() => validateAdapterSpeedKhz(0), /adapterSpeedKhz/i);
  assert.throws(() => validateAdapterSpeedKhz(50000), /adapterSpeedKhz/i);
});

test('OpenOCD failures are classified into actionable diagnostics', () => {
  assert.equal(classifyOpenOcdResult(commandResult('Error: unable to find a matching CMSIS-DAP device')).code, 'probe-not-found');
  assert.equal(classifyOpenOcdResult(commandResult('LIBUSB_ERROR_ACCESS')).code, 'probe-permission-denied');
  assert.equal(classifyOpenOcdResult(commandResult('Error: target voltage may be too low')).code, 'target-power-invalid');
  assert.equal(classifyOpenOcdResult(commandResult('Error: target examination failed')).code, 'target-connect-failed');
  assert.equal(classifyOpenOcdResult(commandResult('Error: verify_image failed; contents mismatch')).code, 'verify-failed');
  assert.equal(classifyOpenOcdResult(commandResult('Error: timed out', 1, true)).code, 'backend-timeout');
  assert.equal(classifyOpenOcdResult(commandResult('some unknown backend failure')).code, 'backend-failed');
  assert.equal(classifyOpenOcdResult(commandResult('', 0)).code, 'ok');
});

test('STM32 flash plan emits bounded adapter speed before target init', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-openocd-plan-'));
  const bin = path.join(root, 'bin');
  const project = path.join(root, 'project');
  await fs.mkdir(bin);
  await fs.mkdir(path.join(project, 'build'), { recursive: true });
  await fs.writeFile(path.join(project, 'Main.ioc'), 'Mcu.Name=STM32H743ZIT6\n');
  await fs.writeFile(path.join(project, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.22)\n');
  await fs.writeFile(path.join(project, 'build', 'app.elf'), 'ELF');
  const openocd = path.join(bin, process.platform === 'win32' ? 'openocd.cmd' : 'openocd');
  await fs.writeFile(openocd, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') await fs.chmod(openocd, 0o755);

  const cfg: PolicyConfig = {
    version: 1, mode: 'workspace', workspaces: [{ id: 'w', root, readOnly: false }],
    filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
    process: { allowExecutables: [], inheritEnv: ['PATH'], maxOutputBytes: 65536, maxRuntimeMs: 60000 },
    engineering: { enabled: true, maxCommandRuntimeMs: 60000, allowHardwareMutationInWorkspace: true, allowSerialWriteInWorkspace: false }
  };
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  try {
    const policy = new PolicyEngine(cfg);
    const paths = new PathGuard(policy);
    const runner = { async run(program: string, args: string[], cwd: string) { return { program, args, cwd, exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }; } };
    const hardware = { async list() { return [{ id: 'debug-probe:test:SN1', kind: 'debug-probe', name: 'ST-Link', serialNumber: 'SN1', provider: 'test', capabilities: ['swd', 'openocd', 'gdb'] }]; } };
    const firmware = new FirmwareAdapter(policy, paths, runner as never, new EngineeringResourceManager('owner'), hardware as never);
    const plan = await firmware.flashPlan({ workspace: 'w', projectPath: 'project', artifact: 'build/app.elf', provider: 'openocd', probeSerial: 'SN1', adapterSpeedKhz: 4000 });
    const speedIndex = plan.args.indexOf('adapter speed 4000');
    const initIndex = plan.args.indexOf('init');
    assert.ok(speedIndex > 0);
    assert.ok(initIndex > speedIndex);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('firmware provider preflight reports OpenOCD version and locked dangerous surfaces', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-openocd-provider-'));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  const openocd = path.join(bin, process.platform === 'win32' ? 'openocd.cmd' : 'openocd');
  await fs.writeFile(openocd, process.platform === 'win32' ? '@echo Open On-Chip Debugger 0.12.0\r\n' : '#!/bin/sh\necho "Open On-Chip Debugger 0.12.0"\n');
  if (process.platform !== 'win32') await fs.chmod(openocd, 0o755);
  const cfg: PolicyConfig = {
    version: 1, mode: 'workspace', workspaces: [{ id: 'w', root, readOnly: false }],
    filesystem: { maxReadBytes: 1024, maxWriteBytes: 1024 },
    process: { allowExecutables: [], inheritEnv: ['PATH'], maxOutputBytes: 65536, maxRuntimeMs: 60000 },
    engineering: { enabled: true, maxCommandRuntimeMs: 60000, allowHardwareMutationInWorkspace: false, allowSerialWriteInWorkspace: false }
  };
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  try {
    const policy = new PolicyEngine(cfg);
    const paths = new PathGuard(policy);
    const runner = { async run(program: string, args: string[], cwd: string) { return { program, args, cwd, exitCode: 0, stdout: 'Open On-Chip Debugger 0.12.0\n', stderr: '', timedOut: false, durationMs: 1 }; } };
    const firmware = new FirmwareAdapter(policy, paths, runner as never, new EngineeringResourceManager('owner'), { async list() { return []; } } as never);
    const status = await firmware.providerStatus('openocd');
    assert.equal(status.available, true);
    assert.equal(status.version, '0.12.0');
    assert.ok(status.intentionallyUnavailable.includes('mass-erase'));
    assert.ok(status.intentionallyUnavailable.includes('arbitrary-tcl'));
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('STM32 deploy transaction keeps one ST-Link lease for flash verify and reset in one OpenOCD process', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-openocd-deploy-'));
  const bin = path.join(root, 'bin');
  const project = path.join(root, 'project');
  await fs.mkdir(bin);
  await fs.mkdir(path.join(project, 'build'), { recursive: true });
  await fs.writeFile(path.join(project, 'Main.ioc'), 'Mcu.Name=STM32F407ZET6\n');
  await fs.writeFile(path.join(project, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.22)\n');
  await fs.writeFile(path.join(project, 'build', 'app.elf'), 'ELF');
  const openocd = path.join(bin, process.platform === 'win32' ? 'openocd.cmd' : 'openocd');
  await fs.writeFile(openocd, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') await fs.chmod(openocd, 0o755);

  const cfg: PolicyConfig = {
    version: 1, mode: 'workspace', workspaces: [{ id: 'w', root, readOnly: false }],
    filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
    process: { allowExecutables: [], inheritEnv: ['PATH'], maxOutputBytes: 65536, maxRuntimeMs: 60000 },
    engineering: { enabled: true, maxCommandRuntimeMs: 60000, allowHardwareMutationInWorkspace: true, allowSerialWriteInWorkspace: false }
  };
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  try {
    const policy = new PolicyEngine(cfg);
    const paths = new PathGuard(policy);
    const resources = new EngineeringResourceManager('owner');
    const calls: Array<{ program: string; args: string[]; cwd: string; activeLeases: number }> = [];
    const runner = {
      async run(program: string, args: string[], cwd: string) {
        calls.push({ program, args: [...args], cwd, activeLeases: resources.list().length });
        return { program, args, cwd, exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
      }
    };
    const hardware = {
      async list() {
        return [
          { id: 'debug-probe:test:SN1', kind: 'debug-probe', name: 'ST-Link', serialNumber: 'SN1', provider: 'test', capabilities: ['swd', 'openocd', 'gdb'] },
          { id: 'serial:test:COM7', kind: 'serial', name: 'UART', path: 'COM7', provider: 'test', capabilities: ['serial-monitor'] }
        ];
      }
    };
    const firmware = new FirmwareAdapter(policy, paths, runner as never, resources, hardware as never);

    const preflight = await firmware.stm32DeploymentPreflight({ probeSerial: 'SN1', monitorPort: 'COM7' });
    assert.equal(preflight.ready, true);
    assert.equal(preflight.selectedProbe?.serialNumber, 'SN1');
    assert.equal(preflight.selectedSerialPort?.path, 'COM7');

    calls.length = 0;
    const result = await firmware.deployVerifyReset({
      workspace: 'w',
      projectPath: 'project',
      artifact: 'build/app.elf',
      probeSerial: 'SN1',
      targetConfig: 'target/stm32f4x.cfg',
      adapterSpeedKhz: 4000
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.activeLeases, 1, 'OpenOCD must run while exactly one ST-Link lease is held');
    assert.equal(resources.list().length, 0, 'ST-Link lease must be released after the transaction');
    assert.deepEqual(result.stages, ['flash', 'verify', 'reset']);
    assert.equal(result.result.exitCode, 0);
    assert.equal(result.plan.targetConfig, 'target/stm32f4x.cfg');
    assert.ok(result.plan.args.includes('adapter serial SN1'));
    assert.ok(result.plan.args.includes('adapter speed 4000'));

    const programIndex = result.plan.args.findIndex(arg => arg.startsWith('program {') && arg.endsWith('} verify'));
    const verifyIndex = result.plan.args.findIndex(arg => arg.startsWith('verify_image {'));
    const resetIndex = result.plan.args.indexOf('reset run');
    const shutdownIndex = result.plan.args.indexOf('shutdown');
    assert.ok(programIndex > 0);
    assert.ok(verifyIndex > programIndex);
    assert.ok(resetIndex > verifyIndex);
    assert.ok(shutdownIndex > resetIndex);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});
