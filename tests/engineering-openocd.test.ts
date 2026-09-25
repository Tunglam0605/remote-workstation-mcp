import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyOpenOcdResult, openOcdSearchPathArgs, resolveOpenOcdExecutable, validateAdapterSpeedKhz } from '../src/adapters/engineering/openocd-provider.js';
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

test('OpenOCD resolver discovers STM32CubeIDE bundled executable and ST scripts without PATH setup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-cubeide-openocd-'));
  const ide = path.join(root, 'STM32CubeIDE');
  const external = path.join(
    ide,
    'plugins',
    'com.st.stm32cube.ide.mcu.externaltools.openocd.win32_2.4.500.202604080855',
    'tools',
    'bin'
  );
  const scripts = path.join(
    ide,
    'plugins',
    'com.st.stm32cube.ide.mcu.debug.openocd_2.3.400.202606220929',
    'resources',
    'openocd',
    'st_scripts'
  );
  await fs.mkdir(external, { recursive: true });
  await fs.mkdir(path.join(scripts, 'interface'), { recursive: true });
  await fs.mkdir(path.join(scripts, 'target'), { recursive: true });
  const executable = path.join(external, 'openocd.exe');
  await fs.writeFile(executable, '');
  await fs.writeFile(path.join(scripts, 'interface', 'stlink.cfg'), '# fake stlink\n');
  await fs.writeFile(path.join(scripts, 'target', 'stm32f4x.cfg'), '# fake target\n');

  const previous = {
    cube: process.env.RWMCP_STM32CUBEIDE_HOME,
    executable: process.env.RWMCP_OPENOCD_EXECUTABLE,
    scripts: process.env.RWMCP_OPENOCD_SCRIPTS,
    path: process.env.PATH
  };
  try {
    process.env.RWMCP_STM32CUBEIDE_HOME = ide;
    delete process.env.RWMCP_OPENOCD_EXECUTABLE;
    delete process.env.RWMCP_OPENOCD_SCRIPTS;
    process.env.PATH = '';

    const resolved = await resolveOpenOcdExecutable();
    assert.equal(resolved?.path, executable);
    assert.equal(resolved?.source, 'known-install');
    assert.equal(resolved?.scriptsPath, scripts);
    assert.deepEqual(resolved ? openOcdSearchPathArgs(resolved) : [], ['-s', scripts]);
  } finally {
    if (previous.cube === undefined) delete process.env.RWMCP_STM32CUBEIDE_HOME;
    else process.env.RWMCP_STM32CUBEIDE_HOME = previous.cube;
    if (previous.executable === undefined) delete process.env.RWMCP_OPENOCD_EXECUTABLE;
    else process.env.RWMCP_OPENOCD_EXECUTABLE = previous.executable;
    if (previous.scripts === undefined) delete process.env.RWMCP_OPENOCD_SCRIPTS;
    else process.env.RWMCP_OPENOCD_SCRIPTS = previous.scripts;
    process.env.PATH = previous.path;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('OpenOCD scripts override is absolute and must contain interface/stlink.cfg', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-openocd-scripts-'));
  const executable = path.join(root, process.platform === 'win32' ? 'openocd.exe' : 'openocd');
  await fs.writeFile(executable, process.platform === 'win32' ? '' : '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') await fs.chmod(executable, 0o755);
  const scripts = path.join(root, 'scripts');
  await fs.mkdir(path.join(scripts, 'interface'), { recursive: true });
  await fs.writeFile(path.join(scripts, 'interface', 'stlink.cfg'), '# fake\n');

  const previousExecutable = process.env.RWMCP_OPENOCD_EXECUTABLE;
  const previousScripts = process.env.RWMCP_OPENOCD_SCRIPTS;
  try {
    process.env.RWMCP_OPENOCD_EXECUTABLE = executable;
    process.env.RWMCP_OPENOCD_SCRIPTS = scripts;
    const resolved = await resolveOpenOcdExecutable();
    assert.equal(resolved?.scriptsPath, scripts);

    process.env.RWMCP_OPENOCD_SCRIPTS = 'relative/scripts';
    await assert.rejects(resolveOpenOcdExecutable(), /scripts.*absolute path/i);
  } finally {
    if (previousExecutable === undefined) delete process.env.RWMCP_OPENOCD_EXECUTABLE;
    else process.env.RWMCP_OPENOCD_EXECUTABLE = previousExecutable;
    if (previousScripts === undefined) delete process.env.RWMCP_OPENOCD_SCRIPTS;
    else process.env.RWMCP_OPENOCD_SCRIPTS = previousScripts;
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
  assert.equal(classifyOpenOcdResult(commandResult('Error: claim interface failed; LIBUSB_ERROR_BUSY')).code, 'probe-busy');
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
    const programIndex = plan.args.findIndex(arg => arg.startsWith('program {') && arg.endsWith('} verify reset exit'));
    assert.ok(speedIndex > 0);
    assert.ok(programIndex > speedIndex);
    assert.equal(plan.args.includes('init'), false);
    assert.equal(plan.args.some(arg => arg.startsWith('verify_image {')), false);
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
    assert.equal(status.provenance?.status, 'release');
    assert.ok(status.intentionallyUnavailable.includes('mass-erase'));
    assert.ok(status.intentionallyUnavailable.includes('arbitrary-tcl'));
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('STM32 deployment preflight actively opens an unambiguous probe without target mutation and reports voltage', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-openocd-preflight-ready-'));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  const openocd = path.join(bin, process.platform === 'win32' ? 'openocd.cmd' : 'openocd');
  await fs.writeFile(openocd, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
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
    const resources = new EngineeringResourceManager('owner');
    const calls: Array<{ args: string[]; activeLeases: number }> = [];
    const runner = {
      async run(program: string, args: string[], cwd: string) {
        calls.push({ args: [...args], activeLeases: resources.list().length });
        if (args.includes('--version')) {
          return { program, args, cwd, exitCode: 0, stdout: 'Open On-Chip Debugger 0.12.0\n', stderr: '', timedOut: false, durationMs: 1 };
        }
        return { program, args, cwd, exitCode: 0, stdout: 'Info : STLINK V2J35S7\nInfo : Target voltage: 3.087468\n', stderr: '', timedOut: false, durationMs: 2 };
      }
    };
    const monitorPort = process.platform === 'win32' ? 'COM7' : '/dev/ttyUSB0';
    const probeId = 'debug-probe:test:0483:3748:1-10.1';
    const hardware = {
      async list() {
        return [
          { id: probeId, kind: 'debug-probe', name: 'ST-Link 3748', provider: 'test', capabilities: ['swd', 'openocd', 'gdb'] },
          { id: 'serial:test:monitor', kind: 'serial', name: 'UART', path: monitorPort, provider: 'test', capabilities: ['serial-monitor'] }
        ];
      }
    };
    const firmware = new FirmwareAdapter(policy, paths, runner as never, resources, hardware as never);
    const preflight = await firmware.stm32DeploymentPreflight({ monitorPort, adapterSpeedKhz: 2000 });

    assert.equal(preflight.ready, true);
    assert.equal(preflight.selectedProbe?.id, probeId);
    assert.equal(preflight.probeAccess?.resourceId, probeId);
    assert.equal(preflight.probeAccess?.adapterSpeedKhz, 2000);
    assert.equal(preflight.probeAccess?.targetVoltage, 3.087468);
    assert.equal(preflight.probeAccess?.diagnostic.code, 'ok');
    assert.equal(resources.list().length, 0, 'probe preflight lease must be released');
    const accessCall = calls.find(call => call.args.includes('init'));
    assert.ok(accessCall);
    assert.equal(accessCall?.args.includes('-d3'), true, 'active probe preflight must enable debug output for ownership diagnostics');
    assert.equal(accessCall?.activeLeases, 1);
    assert.equal(accessCall?.args.includes('reset halt'), false);
    assert.equal(accessCall?.args.some(arg => arg.startsWith('program ')), false);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('STM32 deployment preflight classifies an externally owned ST-Link as probe-busy before build', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-openocd-preflight-busy-'));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  const openocd = path.join(bin, process.platform === 'win32' ? 'openocd.cmd' : 'openocd');
  await fs.writeFile(openocd, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
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
    const resources = new EngineeringResourceManager('owner');
    const runner = {
      async run(program: string, args: string[], cwd: string) {
        if (args.includes('--version')) {
          return { program, args, cwd, exitCode: 0, stdout: 'Open On-Chip Debugger 0.12.0\n', stderr: '', timedOut: false, durationMs: 1 };
        }
        return {
          program, args, cwd, exitCode: 1, stdout: '',
          stderr: args.includes('-d3')
            ? 'Debug: stlink_open\nDebug: stlink_usb_usb_open(): claim interface failed\n'
            : '',
          timedOut: false, durationMs: 2
        };
      }
    };
    const probeId = 'debug-probe:test:0483:3748:1-10.1';
    const hardware = {
      async list() {
        return [{ id: probeId, kind: 'debug-probe', name: 'ST-Link 3748', provider: 'test', capabilities: ['swd', 'openocd', 'gdb'] }];
      }
    };
    const firmware = new FirmwareAdapter(policy, paths, runner as never, resources, hardware as never);
    const preflight = await firmware.stm32DeploymentPreflight();

    assert.equal(preflight.ready, false);
    assert.equal(preflight.probeAccess?.resourceId, probeId);
    assert.equal(preflight.probeAccess?.diagnostic.code, 'probe-busy');
    assert.match(preflight.blockers.join(' '), /already owned by another process/i);
    assert.equal(resources.list().length, 0, 'failed probe preflight must release its lease');
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('STM32 deploy transaction keeps one ST-Link lease for flash verify and reset in one OpenOCD process', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-openocd-deploy-'));
  const bin = path.join(root, 'bin');
  const project = path.join(root, 'project');
  const scripts = path.join(root, 'openocd-scripts');
  await fs.mkdir(bin);
  await fs.mkdir(path.join(project, 'build'), { recursive: true });
  await fs.mkdir(path.join(scripts, 'interface'), { recursive: true });
  await fs.writeFile(path.join(scripts, 'interface', 'stlink.cfg'), '# test stlink\n');
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
  const oldScripts = process.env.RWMCP_OPENOCD_SCRIPTS;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  process.env.RWMCP_OPENOCD_SCRIPTS = scripts;
  try {
    const policy = new PolicyEngine(cfg);
    const paths = new PathGuard(policy);
    const resources = new EngineeringResourceManager('owner');
    const monitorPort = process.platform === 'win32' ? 'COM7' : '/dev/ttyUSB0';
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
          { id: 'serial:test:monitor', kind: 'serial', name: 'UART', path: monitorPort, provider: 'test', capabilities: ['serial-monitor'] }
        ];
      }
    };
    const firmware = new FirmwareAdapter(policy, paths, runner as never, resources, hardware as never);

    const preflight = await firmware.stm32DeploymentPreflight({ probeSerial: 'SN1', monitorPort });
    assert.equal(preflight.ready, true);
    assert.equal(preflight.selectedProbe?.serialNumber, 'SN1');
    assert.equal(preflight.selectedSerialPort?.path, monitorPort);

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
    assert.equal(result.plan.scriptSearchPath, scripts);
    assert.deepEqual(calls[0]?.args.slice(0, 2), ['-s', scripts]);
    assert.ok(result.plan.args.includes('adapter serial SN1'));
    assert.ok(result.plan.args.includes('adapter speed 4000'));

    const programArgs = result.plan.args.filter(arg => arg.startsWith('program {'));
    assert.equal(programArgs.length, 1);
    assert.match(programArgs[0]!, /^program \{.+\} verify reset exit$/);
    assert.equal(result.plan.args.some(arg => arg.startsWith('verify_image {')), false, 'program ... verify already performs verification');
    assert.equal(result.plan.args.includes('reset run'), false, 'program ... reset owns the reset stage');
    assert.equal(result.plan.args.includes('shutdown'), false, 'program ... exit owns OpenOCD termination');
  } finally {
    process.env.PATH = oldPath;
    if (oldScripts === undefined) delete process.env.RWMCP_OPENOCD_SCRIPTS;
    else process.env.RWMCP_OPENOCD_SCRIPTS = oldScripts;
    await fs.rm(root, { recursive: true, force: true });
  }
});
