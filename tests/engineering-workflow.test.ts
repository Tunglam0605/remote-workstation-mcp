import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DataPlaneAdapter } from '../src/adapters/data-plane.js';
import { ArtifactIntegrityAdapter } from '../src/adapters/engineering/artifact-integrity.js';
import { ArtifactTransferAdapter } from '../src/adapters/engineering/artifact-transfer.js';
import { EngineeringProjectProfileStore } from '../src/adapters/engineering/project-profile.js';
import { EngineeringWorkflowEngine } from '../src/adapters/engineering/workflow-engine.js';
import type { EngineeringCommandResult, FirmwareProjectInfo } from '../src/engineering/types.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

function config(root: string): PolicyConfig {
  return {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'w', root, readOnly: false }],
    filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
    process: { allowExecutables: [], inheritEnv: ['PATH'], maxOutputBytes: 262144, maxRuntimeMs: 600000 },
    engineering: { enabled: true, maxCommandRuntimeMs: 600000, allowHardwareMutationInWorkspace: true, allowSerialWriteInWorkspace: true }
  };
}

function okCommand(): EngineeringCommandResult {
  return { program: 'fake', args: [], cwd: '.', exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
}

async function fixture(project: FirmwareProjectInfo) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-workflow-'));
  await fs.mkdir(path.join(root, 'project'), { recursive: true });
  const policy = new PolicyEngine(config(root));
  const paths = new PathGuard(policy);
  const profiles = new EngineeringProjectProfileStore(policy, paths);
  const dataPlane = new DataPlaneAdapter(policy, paths, {
    bindAddress: '127.0.0.1',
    allowLoopbackForTests: true
  });
  const artifactIntegrity = new ArtifactIntegrityAdapter(policy, paths);
  const artifactTransfer = new ArtifactTransferAdapter(policy, paths, artifactIntegrity, {
    bindAddress: '127.0.0.1',
    allowLoopbackForTests: true
  });
  const calls: string[] = [];
  let buildResult = okCommand();
  let verifyResult = okCommand();
  let deployResult = okCommand();
  let deploymentReady = true;
  let deploymentBlockers: string[] = [];
  let artifacts: Array<{ path: string; kind: string; size: number }> = [];
  const firmware = {
    async inspect() { return project; },
    async listArtifacts() { return artifacts; },
    async build(
      _workspace: string,
      _projectPath: string,
      provider: string,
      buildDir: string,
      keilProject?: string,
      keilTarget?: string
    ) {
      calls.push(`build:${provider}:${buildDir}:${keilProject ?? '-'}:${keilTarget ?? '-'}`);
      const resolvedProvider = provider === 'auto'
        ? project.framework === 'esp-idf' ? 'esp-idf' : project.framework === 'keil-mdk' ? 'keil' : project.buildSystem === 'make' ? 'make' : 'cmake'
        : provider;
      return { project, provider: resolvedProvider, result: buildResult };
    },
    async flash(options: Record<string, unknown>) {
      calls.push(`flash:${String(options.port ?? options.probeSerial ?? 'auto')}`);
      return {
        plan: { provider: project.family === 'esp32' ? 'esp-idf' : 'openocd' },
        result: okCommand()
      };
    },
    async verify(options: Record<string, unknown>) {
      calls.push(`verify:${String(options.artifact ?? 'none')}`);
      return {
        provider: 'openocd',
        result: verifyResult,
        diagnostic: { code: verifyResult.exitCode === 0 ? 'ok' : 'verify-failed', ok: verifyResult.exitCode === 0 }
      };
    },
    async stm32DeploymentPreflight(options: Record<string, unknown>) {
      calls.push(`preflight:${String(options.probeSerial ?? 'auto')}:${String(options.monitorPort ?? '-')}`);
      return {
        ready: deploymentReady,
        provider: {
          provider: 'openocd',
          available: deploymentReady,
          capabilities: ['swd', 'flash', 'verify', 'reset'],
          intentionallyUnavailable: [],
          diagnostic: { code: deploymentReady ? 'ok' : 'provider-unavailable', ok: deploymentReady, retryable: false, message: deploymentReady ? 'ready' : 'OpenOCD unavailable' }
        },
        selectedProbe: deploymentReady ? { id: 'debug-probe:test', name: 'ST-Link', serialNumber: String(options.probeSerial ?? 'STLINK-01'), provider: 'test' } : undefined,
        selectedSerialPort: deploymentReady ? { id: 'serial:test', path: String(options.monitorPort ?? 'COM7'), name: 'UART', provider: 'test' } : undefined,
        discovered: { probes: [], serialPorts: [] },
        blockers: deploymentReady ? [] : (deploymentBlockers.length ? deploymentBlockers : ['OpenOCD unavailable'])
      };
    },
    async deployVerifyReset(options: Record<string, unknown>) {
      calls.push(`deploy:${String(options.artifact ?? 'none')}:${String(options.probeSerial ?? 'auto')}`);
      return {
        plan: { provider: 'openocd', resourceId: 'debug-probe:test', destructive: true },
        result: deployResult,
        diagnostic: { code: deployResult.exitCode === 0 ? 'ok' : 'deploy-failed', ok: deployResult.exitCode === 0 },
        stages: ['flash', 'verify', 'reset'] as const
      };
    }
  };
  const hardware = { async list() { return []; } };
  const serial = {
    async open(port: string, baudRate: number) {
      calls.push(`serial:${port}:${baudRate}`);
      return {
        id: '11111111-1111-4111-8111-111111111111',
        resourceId: `serial:${port}`,
        port,
        baudRate,
        status: 'open',
        startedAt: new Date(0).toISOString(),
        bytesRead: 0,
        bufferedBytes: 0
      };
    },
    async waitForText(id: string, expectedText: string, timeoutMs: number) {
      calls.push(`expect:${expectedText}:${timeoutMs}`);
      return {
        matched: expectedText !== 'NEVER',
        expectedText,
        text: expectedText === 'NEVER' ? 'booting...' : `booting... ${expectedText}`,
        nextCursor: 10,
        elapsedMs: 25,
        session: {
          id,
          resourceId: 'serial:test',
          port: 'test',
          baudRate: 115200,
          status: 'open',
          startedAt: new Date(0).toISOString(),
          bytesRead: 10,
          bufferedBytes: 10
        }
      };
    },
    async close(id: string) {
      calls.push(`serial.close:${id}`);
      return {
        id,
        resourceId: 'serial:test',
        port: 'test',
        baudRate: 115200,
        status: 'closed',
        startedAt: new Date(0).toISOString(),
        endedAt: new Date(1).toISOString(),
        bytesRead: 10,
        bufferedBytes: 10
      };
    }
  };
  const debug = {
    async start(options: Record<string, unknown>) {
      calls.push(`debug.start:${String(options.symbols)}:${String(options.probeSerial)}`);
      return { id: '22222222-2222-4222-8222-222222222222', status: 'connected' };
    },
    async halt(id: string) {
      calls.push(`debug.halt:${id}`);
      return { stopped: true };
    },
    async faultSnapshot(id: string) {
      calls.push(`debug.fault:${id}`);
      return { core: { pc: '0x08001234', lr: '0x08005678' }, decoded: { faults: ['BusFault'] } };
    },
    async stack(id: string, maxFrames: number) {
      calls.push(`debug.stack:${id}:${maxFrames}`);
      return [{ level: 0, function: 'HardFault_Handler' }];
    },
    async stop(id: string) {
      calls.push(`debug.stop:${id}`);
      return { id, status: 'stopped' };
    }
  };
  const rosCalls: Array<{ workspace: string; cwd: string; runtime: unknown; options?: unknown }> = [];
  const ros2 = {
    async build(workspace: string, cwd: string, runtime: unknown, options: unknown) {
      calls.push('ros2.build');
      rosCalls.push({ workspace, cwd, runtime, options });
      return { provider: 'colcon', options, result: okCommand() };
    },
    async health(workspace: string, cwd: string, runtime: unknown) {
      calls.push('ros2.health');
      rosCalls.push({ workspace, cwd, runtime });
      return { summary: { nodes: 1, topics: 2, services: 3, actions: 4 } };
    }
  };
  const engine = new EngineeringWorkflowEngine(
    policy,
    profiles,
    dataPlane,
    artifactIntegrity,
    artifactTransfer,
    firmware as never,
    hardware as never,
    serial as never,
    debug as never,
    ros2 as never
  );
  return {
    root,
    profiles,
    engine,
    dataPlane,
    calls,
    rosCalls,
    setArtifacts(value: Array<{ path: string; kind: string; size: number }>) { artifacts = value; },
    setBuildResult(result: EngineeringCommandResult) { buildResult = result; },
    setVerifyResult(result: EngineeringCommandResult) { verifyResult = result; },
    setDeployResult(result: EngineeringCommandResult) { deployResult = result; },
    setDeploymentReady(ready: boolean, blockers: string[] = []) { deploymentReady = ready; deploymentBlockers = blockers; }
  };
}

test('project profile persists recurring ESP-IDF flash and monitor defaults', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'esp32', framework: 'esp-idf',
    target: 'esp32s3', buildSystem: 'idf.py', markers: ['sdkconfig'], ros2: false, docker: false
  };
  const f = await fixture(project);
  try {
    const created = await f.engine.initProfile('w', 'project', {
      id: 'callbox',
      firmware: {
        port: 'COM7',
        monitor: { port: 'COM7', baudRate: 921600 }
      }
    });
    assert.equal(created.profile.id, 'callbox');
    assert.equal(created.profile.kind, 'esp-idf');
    const raw = await fs.readFile(path.join(f.root, 'project', '.rwmcp', 'project.yaml'), 'utf8');
    assert.match(raw, /port: COM7/);

    const plan = await f.engine.plan('w', 'project', 'firmware.build_flash_monitor');
    assert.equal(plan.resolved.firmware?.flashProvider, 'esp-idf');
    assert.equal(plan.resolved.firmware?.port, 'COM7');
    assert.equal(plan.resolved.firmware?.monitorBaudRate, 921600);
    assert.deepEqual(plan.steps, ['firmware.build', 'firmware.flash', 'serial.open']);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('build-flash-monitor workflow executes typed adapters in order and returns the serial session', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'esp32', framework: 'esp-idf',
    target: 'esp32s3', buildSystem: 'idf.py', markers: [], ros2: false, docker: false
  };
  const f = await fixture(project);
  try {
    await f.engine.initProfile('w', 'project', {
      firmware: { port: '/dev/ttyUSB0', monitor: { baudRate: 115200 } }
    });
    const result = await f.engine.run('w', 'project', 'firmware.build_flash_monitor');
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(f.calls, ['build:esp-idf:build:-:-', 'flash:/dev/ttyUSB0', 'serial:/dev/ttyUSB0:115200']);
    assert.equal(result.outputs?.serialSession.port, '/dev/ttyUSB0');
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('compound workflow stops before flash when build fails', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'stm32', framework: 'stm32-cube',
    target: 'STM32H743ZIT6', buildSystem: 'cmake', markers: [], ros2: false, docker: false
  };
  const f = await fixture(project);
  try {
    await f.engine.initProfile('w', 'project', { firmware: { probeSerial: 'STLINK-01' } });
    f.setBuildResult({ ...okCommand(), exitCode: 2, stderr: 'compile failed' });
    const result = await f.engine.run('w', 'project', 'firmware.build_flash');
    assert.equal(result.status, 'failed');
    assert.deepEqual(f.calls, ['build:auto:build:-:-']);
    assert.equal(result.steps.at(-1)?.status, 'failed');
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('ROS 2 health workflow propagates canonical distro, workspace setup and domain without per-chat source commands', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'unknown', framework: 'unknown',
    markers: ['package.xml'], ros2: true, docker: false
  };
  const f = await fixture(project);
  try {
    await fs.mkdir(path.join(f.root, 'project', 'install'), { recursive: true });
    await fs.writeFile(path.join(f.root, 'project', 'install', 'setup.bash'), '# test\n');
    await f.engine.initProfile('w', 'project', {
      id: 'robot-ws',
      ros2: { distro: 'humble', cwd: '.', workspaceSetup: 'install/setup.bash', domainId: 42 }
    });
    const result = await f.engine.run('w', 'project', 'ros2.health');
    assert.equal(result.status, 'succeeded');
    assert.equal(f.rosCalls.length, 1);
    assert.equal(f.rosCalls[0]!.cwd, path.normalize('project'));
    assert.deepEqual(f.rosCalls[0]!.runtime, {
      distro: 'humble',
      workspaceSetup: path.normalize('project/install/setup.bash'),
      domainId: 42
    });
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('project profile rejects relative paths that escape the selected project', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'stm32', framework: 'stm32-cube',
    target: 'STM32F407VET6', buildSystem: 'cmake', markers: [], ros2: false, docker: false
  };
  const f = await fixture(project);
  try {
    await assert.rejects(
      () => f.engine.initProfile('w', 'project', { firmware: { buildDir: '../outside' } }),
      /must not escape|relative/i
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('project profile loader blocks .rwmcp symlink escape outside the authorized workspace', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-profile-symlink-'));
  const root = path.join(base, 'root');
  const projectRoot = path.join(root, 'project');
  const outside = path.join(base, 'outside');
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'project.yaml'), 'version: 1\nid: escaped\nkind: generic\n');
  await fs.symlink(outside, path.join(projectRoot, '.rwmcp'), os.platform() === 'win32' ? 'junction' : 'dir');
  try {
    const policy = new PolicyEngine(config(root));
    const profiles = new EngineeringProjectProfileStore(policy, new PathGuard(policy));
    await assert.rejects(
      () => profiles.load('w', 'project'),
      /escapes the authorized workspace|escape/i
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});


test('STM32 build-flash-verify resolves one artifact and verifies after flash', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'stm32', framework: 'stm32-cube',
    target: 'STM32H743ZIT6', buildSystem: 'cmake', markers: [], ros2: false, docker: false
  };
  const f = await fixture(project);
  try {
    f.setArtifacts([{ path: 'build/main.elf', kind: 'elf', size: 1024 }]);
    await f.engine.initProfile('w', 'project', { firmware: { probeSerial: 'STLINK-H743' } });
    const result = await f.engine.run('w', 'project', 'firmware.build_flash_verify');
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(f.calls, ['build:auto:build:-:-', 'flash:STLINK-H743', 'verify:build/main.elf']);
    assert.equal((result as any).outputs.artifact, 'build/main.elf');
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('STM32 build-flash-verify fails closed when independent verify fails', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'stm32', framework: 'stm32-cube',
    target: 'STM32F407VET6', buildSystem: 'cmake', markers: [], ros2: false, docker: false
  };
  const f = await fixture(project);
  try {
    f.setArtifacts([{ path: 'build/app.hex', kind: 'hex', size: 512 }]);
    f.setVerifyResult({ ...okCommand(), exitCode: 1, stderr: 'verify mismatch' });
    await f.engine.initProfile('w', 'project', { firmware: { probeSerial: 'STLINK-F407' } });
    const result = await f.engine.run('w', 'project', 'firmware.build_flash_verify');
    assert.equal(result.status, 'failed');
    assert.deepEqual(f.calls, ['build:auto:build:-:-', 'flash:STLINK-F407', 'verify:build/app.hex']);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('ESP monitor-expect collapses build flash monitor and readiness acceptance into one workflow', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'esp32', framework: 'esp-idf',
    target: 'esp32s3', buildSystem: 'idf.py', markers: ['sdkconfig'], ros2: false, docker: false
  };
  const f = await fixture(project);
  try {
    await f.engine.initProfile('w', 'project', {
      firmware: {
        port: '/dev/ttyUSB0',
        monitor: { baudRate: 115200, expectText: 'APP_READY', expectTimeoutMs: 5000 }
      }
    });
    const result = await f.engine.run('w', 'project', 'firmware.build_flash_monitor_expect');
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(f.calls, [
      'build:esp-idf:build:-:-',
      'flash:/dev/ttyUSB0',
      'serial:/dev/ttyUSB0:115200',
      'expect:APP_READY:5000'
    ]);
    assert.equal((result as any).outputs.expectation.matched, true);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('ESP monitor-expect fails acceptance without discarding the open serial session', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'esp32', framework: 'esp-idf',
    target: 'esp32', buildSystem: 'idf.py', markers: [], ros2: false, docker: false
  };
  const f = await fixture(project);
  try {
    await f.engine.initProfile('w', 'project', {
      firmware: { port: 'COM9', monitor: { expectText: 'NEVER', expectTimeoutMs: 1000 } }
    });
    const result = await f.engine.run('w', 'project', 'firmware.build_flash_monitor_expect');
    assert.equal(result.status, 'failed');
    assert.equal((result as any).outputs.serialSession.id, '11111111-1111-4111-8111-111111111111');
    assert.equal((result as any).outputs.expectation.matched, false);
    assert.match(result.steps.at(-1)?.error ?? '', /did not contain expected readiness marker/i);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('monitor-expect plan fails closed without a persisted or explicit readiness marker', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'esp32', framework: 'esp-idf',
    target: 'esp32', buildSystem: 'idf.py', markers: [], ros2: false, docker: false
  };
  const f = await fixture(project);
  try {
    await f.engine.initProfile('w', 'project', { firmware: { port: 'COM3' } });
    await assert.rejects(
      () => f.engine.plan('w', 'project', 'firmware.build_flash_monitor_expect'),
      /expectText|readiness marker/i
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('ROS 2 build-health runs typed colcon before graph health with canonical build options', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'unknown', framework: 'unknown',
    markers: ['src'], ros2: true, docker: false
  };
  const f = await fixture(project);
  try {
    await fs.mkdir(path.join(f.root, 'project', 'install'), { recursive: true });
    await fs.writeFile(path.join(f.root, 'project', 'install', 'setup.bash'), '# test\n');
    await f.engine.initProfile('w', 'project', {
      id: 'robot-ws',
      ros2: {
        distro: 'humble',
        workspaceSetup: 'install/setup.bash',
        domainId: 7,
        build: { symlinkInstall: true, packagesSelect: ['robot_bringup', 'robot_control'] }
      }
    });
    const plan = await f.engine.plan('w', 'project', 'ros2.build_health');
    assert.deepEqual(plan.steps, [
      'ros2.colcon.build',
      'ros2.environment.bootstrap',
      'ros2.node.list',
      'ros2.topic.list',
      'ros2.service.list',
      'ros2.action.list'
    ]);
    const result = await f.engine.run('w', 'project', 'ros2.build_health');
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(f.calls, ['ros2.build', 'ros2.health']);
    assert.equal(f.rosCalls.length, 2);
    assert.deepEqual((plan.resolved.ros2 as any).build.packagesSelect, ['robot_bringup', 'robot_control']);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('ROS 2 build rejects mutually exclusive merge and symlink install options', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'unknown', framework: 'unknown',
    markers: ['src'], ros2: true, docker: false
  };
  const f = await fixture(project);
  try {
    await f.engine.initProfile('w', 'project', {
      ros2: { distro: 'humble', build: { symlinkInstall: true, mergeInstall: true } }
    });
    await assert.rejects(
      () => f.engine.plan('w', 'project', 'ros2.build'),
      /cannot combine symlinkInstall=true with mergeInstall=true/i
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});


test('STM32 debug fault workflow opens, halts, snapshots, stacks and releases the probe', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'stm32', framework: 'stm32-cube',
    target: 'STM32H743ZIT6', buildSystem: 'cmake', markers: [], ros2: false, docker: false
  };
  const f = await fixture(project);
  try {
    f.setArtifacts([{ path: 'build/main.elf', kind: 'elf', size: 4096 }]);
    await f.engine.initProfile('w', 'project', { firmware: { probeSerial: 'STLINK-H743' } });
    const plan = await f.engine.plan('w', 'project', 'stm32.debug_fault_snapshot', { debugMaxFrames: 8 });
    assert.deepEqual(plan.steps, [
      'debug.session.start',
      'debug.halt',
      'debug.fault_snapshot',
      'debug.stack',
      'debug.session.stop'
    ]);
    const result = await f.engine.run('w', 'project', 'stm32.debug_fault_snapshot', { debugMaxFrames: 8 });
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(f.calls, [
      'debug.start:build/main.elf:STLINK-H743',
      'debug.halt:22222222-2222-4222-8222-222222222222',
      'debug.fault:22222222-2222-4222-8222-222222222222',
      'debug.stack:22222222-2222-4222-8222-222222222222:8',
      'debug.stop:22222222-2222-4222-8222-222222222222'
    ]);
    assert.equal((result as any).outputs.symbols, 'build/main.elf');
    assert.equal((result as any).outputs.stack[0].function, 'HardFault_Handler');
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('STM32 debug fault workflow refuses to guess a probe or non-symbol artifact', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'stm32', framework: 'stm32-cube',
    target: 'STM32F407VET6', buildSystem: 'cmake', markers: [], ros2: false, docker: false
  };
  const f = await fixture(project);
  try {
    f.setArtifacts([{ path: 'build/app.hex', kind: 'hex', size: 1024 }]);
    await f.engine.initProfile('w', 'project', { firmware: {} });
    await assert.rejects(
      () => f.engine.run('w', 'project', 'stm32.debug_fault_snapshot'),
      /ELF\/AXF|ELF or AXF|probeSerial/i
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});




test('Keil multi-target suggested profile creates variants and requires explicit selection', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'stm32', framework: 'keil-mdk',
    buildSystem: 'keil', markers: ['Main_V2_F407.uvprojx', 'Main_V3_H743.uvprojx'], ros2: false, docker: false,
    targets: [
      {
        id: 'Main_V2_F407-Main_V2_F407',
        projectFile: 'Main_V2_F407.uvprojx',
        targetName: 'Main_V2_F407',
        device: 'STM32F407ZETx',
        outputDirectory: 'Objects/F407',
        outputName: 'Main_V2_F407',
        expectedArtifact: 'Objects/F407/Main_V2_F407.axf'
      },
      {
        id: 'Main_V3_H743-Main_V3_H743',
        projectFile: 'Main_V3_H743.uvprojx',
        targetName: 'Main_V3_H743',
        device: 'STM32H743ZITx',
        outputDirectory: 'Objects/H743',
        outputName: 'Main_V3_H743',
        expectedArtifact: 'Objects/H743/Main_V3_H743.axf'
      }
    ]
  };
  const f = await fixture(project);
  try {
    const inspected = await f.engine.inspect('w', 'project');
    assert.equal(inspected.profile.firmware?.buildProvider, 'keil');
    assert.equal(inspected.profile.firmware?.defaultVariant, undefined);
    assert.equal(Object.keys(inspected.profile.firmware?.variants ?? {}).length, 2);
    assert.equal(
      inspected.profile.firmware?.variants?.['Main_V2_F407-Main_V2_F407']?.targetConfig,
      'target/stm32f4x.cfg'
    );
    assert.equal(
      inspected.profile.firmware?.variants?.['Main_V3_H743-Main_V3_H743']?.targetConfig,
      'target/stm32h7x.cfg'
    );

    await assert.rejects(
      () => f.engine.plan('w', 'project', 'firmware.build'),
      /multiple firmware variants|defaultVariant|parameters\.variant/i
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('Keil variant flows through build parameters without shell command input', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'stm32', framework: 'keil-mdk',
    buildSystem: 'keil', markers: ['Main_V2_F407.uvprojx'], ros2: false, docker: false,
    targets: [{
      id: 'main-v2-f407',
      projectFile: 'Main_V2_F407.uvprojx',
      targetName: 'Main_V2_F407',
      device: 'STM32F407ZETx',
      outputDirectory: 'Objects/F407',
      outputName: 'Main_V2_F407',
      expectedArtifact: 'Objects/F407/Main_V2_F407.axf'
    }]
  };
  const f = await fixture(project);
  try {
    const plan = await f.engine.plan('w', 'project', 'firmware.build', { variant: 'main-v2-f407' });
    assert.equal(plan.resolved.firmware?.variant, 'main-v2-f407');
    assert.equal(plan.resolved.firmware?.buildProvider, 'keil');
    assert.equal(plan.resolved.firmware?.keilProject, 'Main_V2_F407.uvprojx');
    assert.equal(plan.resolved.firmware?.keilTarget, 'Main_V2_F407');
    assert.equal(plan.resolved.firmware?.artifact, 'Objects/F407/Main_V2_F407.axf');

    const result = await f.engine.run('w', 'project', 'firmware.build', { variant: 'main-v2-f407' });
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(f.calls, [
      'build:keil:Objects/F407:Main_V2_F407.uvprojx:Main_V2_F407'
    ]);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('Keil warning exit code 1 succeeds while error exit code 2 fails', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'stm32', framework: 'keil-mdk',
    buildSystem: 'keil', markers: ['Main.uvprojx'], ros2: false, docker: false,
    targets: [{
      id: 'main',
      projectFile: 'Main.uvprojx',
      targetName: 'Main',
      device: 'STM32F407ZETx',
      outputDirectory: 'Objects',
      outputName: 'Main',
      expectedArtifact: 'Objects/Main.axf'
    }]
  };
  const f = await fixture(project);
  try {
    f.setBuildResult({ ...okCommand(), exitCode: 1, stdout: '0 Error(s), 2 Warning(s)' });
    const warning = await f.engine.run('w', 'project', 'firmware.build');
    assert.equal(warning.status, 'succeeded');

    f.calls.length = 0;
    f.setBuildResult({ ...okCommand(), exitCode: 2, stderr: '1 Error(s)' });
    const error = await f.engine.run('w', 'project', 'firmware.build');
    assert.equal(error.status, 'failed');
    assert.equal(error.steps.at(-1)?.status, 'failed');
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('generic versioned profile payload is validated and persisted for frozen action schemas', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'stm32', framework: 'keil-mdk',
    buildSystem: 'keil', markers: ['Main.uvprojx'], ros2: false, docker: false,
    targets: [{
      id: 'f407',
      projectFile: 'Main.uvprojx',
      targetName: 'Main',
      device: 'STM32F407ZETx',
      outputDirectory: 'Objects',
      outputName: 'Main',
      expectedArtifact: 'Objects/Main.axf'
    }]
  };
  const f = await fixture(project);
  try {
    const written = await f.engine.initProfile('w', 'project', {
      profile: {
        version: 1,
        id: 'b300',
        name: 'B300',
        kind: 'stm32',
        firmware: {
          buildProvider: 'keil',
          flashProvider: 'openocd',
          defaultVariant: 'f407',
          variants: {
            f407: {
              keilProject: 'Main.uvprojx',
              keilTarget: 'Main',
              buildDir: 'Objects',
              artifact: 'Objects/Main.axf',
              targetConfig: 'target/stm32f4x.cfg'
            }
          }
        }
      }
    });
    assert.equal(written.profile.firmware?.defaultVariant, 'f407');
    assert.equal(written.profile.firmware?.variants?.f407?.keilTarget, 'Main');
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});


test('STM32 deploy-accept plan reports blockers and run stops before build when hardware is unavailable', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'stm32', framework: 'stm32-cube',
    target: 'STM32F407ZET6', buildSystem: 'cmake', markers: [], ros2: false, docker: false
  };
  const f = await fixture(project);
  try {
    await f.engine.initProfile('w', 'project', {
      firmware: {
        artifact: 'build/main.axf',
        probeSerial: 'STLINK-01',
        targetConfig: 'target/stm32f4x.cfg',
        monitor: { port: 'COM7', baudRate: 115200, expectText: 'APP_READY', expectTimeoutMs: 5000 }
      }
    });
    f.setDeploymentReady(false, ['OpenOCD unavailable', 'No ST-Link/SWD debug probe is currently discovered.']);

    const plan = await f.engine.plan('w', 'project', 'stm32.deploy_accept');
    assert.equal(plan.preflight?.ready, false);
    assert.deepEqual(plan.steps, [
      'preflight.stm32_deploy',
      'firmware.build',
      'serial.open',
      'firmware.flash_verify_reset',
      'serial.wait_for_text',
      'serial.close'
    ]);
    assert.match(plan.preflight?.blockers.join(' ') ?? '', /OpenOCD unavailable/);

    f.calls.length = 0;
    const result = await f.engine.run('w', 'project', 'stm32.deploy_accept');
    assert.equal(result.status, 'blocked');
    assert.deepEqual(f.calls, ['preflight:STLINK-01:COM7']);
    assert.equal(result.steps[0]?.status, 'blocked');
    assert.equal(result.steps.some(step => step.id === 'firmware.build'), false);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('STM32 deploy-accept opens serial before one atomic flash-verify-reset transaction and closes it after readiness', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'stm32', framework: 'stm32-cube',
    target: 'STM32F407ZET6', buildSystem: 'cmake', markers: [], ros2: false, docker: false
  };
  const f = await fixture(project);
  try {
    await f.engine.initProfile('w', 'project', {
      firmware: {
        artifact: 'build/main.axf',
        probeSerial: 'STLINK-01',
        targetConfig: 'target/stm32f4x.cfg',
        monitor: { port: 'COM7', baudRate: 115200, expectText: 'APP_READY', expectTimeoutMs: 5000 }
      }
    });

    const result = await f.engine.run('w', 'project', 'stm32.deploy_accept');
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(f.calls, [
      'preflight:STLINK-01:COM7',
      'build:auto:build:-:-',
      'serial:COM7:115200',
      'deploy:build/main.axf:STLINK-01',
      'expect:APP_READY:5000',
      'serial.close:11111111-1111-4111-8111-111111111111'
    ]);
    assert.deepEqual((result as any).outputs.deployment.stages, ['flash', 'verify', 'reset']);
    assert.equal((result as any).outputs.expectation.matched, true);
    assert.equal((result as any).outputs.serialSession.status, 'closed');
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('STM32 deploy-accept closes serial when the OpenOCD transaction fails and does not wait for readiness', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'stm32', framework: 'stm32-cube',
    target: 'STM32F407ZET6', buildSystem: 'cmake', markers: [], ros2: false, docker: false
  };
  const f = await fixture(project);
  try {
    await f.engine.initProfile('w', 'project', {
      firmware: {
        artifact: 'build/main.axf',
        probeSerial: 'STLINK-01',
        monitor: { port: 'COM7', expectText: 'APP_READY' }
      }
    });
    f.setDeployResult({ ...okCommand(), exitCode: 1, stderr: 'OpenOCD verify failed' });

    const result = await f.engine.run('w', 'project', 'stm32.deploy_accept');
    assert.equal(result.status, 'failed');
    assert.deepEqual(f.calls, [
      'preflight:STLINK-01:COM7',
      'build:auto:build:-:-',
      'serial:COM7:115200',
      'deploy:build/main.axf:STLINK-01',
      'serial.close:11111111-1111-4111-8111-111111111111'
    ]);
    assert.equal(result.steps.some(step => step.id === 'serial.wait_for_text'), false);
    assert.equal((result as any).outputs.serialSession.status, 'closed');
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('STM32 deploy-accept treats readiness timeout as failure and still releases serial by default', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'stm32', framework: 'stm32-cube',
    target: 'STM32H743ZIT6', buildSystem: 'cmake', markers: [], ros2: false, docker: false
  };
  const f = await fixture(project);
  try {
    await f.engine.initProfile('w', 'project', {
      firmware: {
        artifact: 'build/main.elf',
        probeSerial: 'STLINK-H743',
        targetConfig: 'target/stm32h7x.cfg',
        monitor: { port: 'COM8', baudRate: 921600, expectText: 'NEVER', expectTimeoutMs: 1200 }
      }
    });

    const result = await f.engine.run('w', 'project', 'stm32.deploy_accept');
    assert.equal(result.status, 'failed');
    assert.deepEqual(f.calls, [
      'preflight:STLINK-H743:COM8',
      'build:auto:build:-:-',
      'serial:COM8:921600',
      'deploy:build/main.elf:STLINK-H743',
      'expect:NEVER:1200',
      'serial.close:11111111-1111-4111-8111-111111111111'
    ]);
    assert.equal((result as any).outputs.expectation.matched, false);
    assert.equal((result as any).outputs.serialSession.status, 'closed');
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('STM32 deploy-accept may keep the serial session open only when explicitly requested through parameters', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'stm32', framework: 'stm32-cube',
    target: 'STM32F407ZET6', buildSystem: 'cmake', markers: [], ros2: false, docker: false
  };
  const f = await fixture(project);
  try {
    await f.engine.initProfile('w', 'project', {
      firmware: {
        artifact: 'build/main.axf',
        probeSerial: 'STLINK-01',
        monitor: { port: 'COM7', expectText: 'APP_READY' }
      }
    });
    const result = await f.engine.run('w', 'project', 'stm32.deploy_accept', { keepMonitorOpen: true });
    assert.equal(result.status, 'succeeded');
    assert.equal(f.calls.some(call => call.startsWith('serial.close:')), false);
    assert.equal((result as any).outputs.serialSession.status, 'open');
    assert.equal(result.plan.steps.includes('serial.close'), false);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});


test('firmware artifact prepare hashes without triggering a build or hardware mutation', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'stm32', framework: 'stm32-cube',
    target: 'STM32F407ZET6', buildSystem: 'cmake', markers: [], ros2: false, docker: false
  };
  const f = await fixture(project);
  try {
    const body = ':020000040801F1\n:00000001FF\n';
    await fs.mkdir(path.join(f.root, 'project', 'staging'), { recursive: true });
    await fs.writeFile(path.join(f.root, 'project', 'staging', 'firmware.hex'), body, 'utf8');
    const list = await f.engine.list('w', 'project');
    assert.ok(list.workflows.some(item => item.id === 'firmware.artifact_prepare'));
    assert.ok(list.workflows.some(item => item.id === 'firmware.artifact_accept'));

    const result = await f.engine.run('w', 'project', 'firmware.artifact_prepare', {
      artifact: 'staging/firmware.hex'
    });
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(f.calls, []);
    assert.equal((result as any).outputs.manifest.sha256, createHash('sha256').update(body).digest('hex'));
    assert.equal((result as any).outputs.manifest.size, Buffer.byteLength(body));
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('firmware artifact accept blocks on integrity mismatch before any build or promotion', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'stm32', framework: 'stm32-cube',
    target: 'STM32F407ZET6', buildSystem: 'cmake', markers: [], ros2: false, docker: false
  };
  const f = await fixture(project);
  try {
    await fs.mkdir(path.join(f.root, 'project', 'staging'), { recursive: true });
    await fs.writeFile(path.join(f.root, 'project', 'staging', 'firmware.hex'), ':00000001FF\n', 'utf8');
    const result = await f.engine.run('w', 'project', 'firmware.artifact_accept', {
      artifact: 'staging/firmware.hex',
      expectedSha256: '0'.repeat(64)
    });
    assert.equal(result.status, 'blocked');
    assert.deepEqual(f.calls, []);
    assert.equal(result.steps[0]?.id, 'artifact.preflight');
    assert.equal(result.steps[0]?.status, 'blocked');
    await assert.rejects(
      fs.access(path.join(f.root, 'project', '.rwmcp', 'artifacts', 'verified')),
      /ENOENT/
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('firmware artifact accept promotes verified content without invoking build or flash', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'stm32', framework: 'stm32-cube',
    target: 'STM32F407ZET6', buildSystem: 'cmake', markers: [], ros2: false, docker: false
  };
  const f = await fixture(project);
  try {
    const body = ':020000040801F1\n:00000001FF\n';
    await fs.mkdir(path.join(f.root, 'project', 'staging'), { recursive: true });
    await fs.writeFile(path.join(f.root, 'project', 'staging', 'firmware.hex'), body, 'utf8');
    const expectedSha256 = createHash('sha256').update(body).digest('hex');
    const result = await f.engine.run('w', 'project', 'firmware.artifact_accept', {
      artifact: 'staging/firmware.hex',
      expectedSha256,
      expectedSize: Buffer.byteLength(body)
    });
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(f.calls, []);
    assert.equal((result as any).outputs.accepted.sha256, expectedSha256);
    assert.match((result as any).outputs.accepted.verifiedPath, /^\.rwmcp\/artifacts\/verified\//);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});


test('native artifact workflows are exposed through the generic workflow contract without echoing transfer tickets in plans', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w', projectPath: 'project', family: 'stm32', framework: 'stm32-cube',
    target: 'STM32F407ZET6', buildSystem: 'cmake', markers: [], ros2: false, docker: false
  };
  const f = await fixture(project);
  try {
    const body = ':020000040801F1\n:00000001FF\n';
    await fs.writeFile(path.join(f.root, 'project', 'firmware.hex'), body, 'utf8');
    const expectedSha256 = createHash('sha256').update(body).digest('hex');
    const expectedSize = Buffer.byteLength(body);
    const list = await f.engine.list('w', 'project');
    assert.ok(list.workflows.some(item => item.id === 'firmware.artifact_receive_offer'));
    assert.ok(list.workflows.some(item => item.id === 'firmware.artifact_push'));

    const secret = 'S'.repeat(43);
    const plan = await f.engine.plan('w', 'project', 'firmware.artifact_push', {
      artifact: 'firmware.hex',
      transferEndpoint: 'http://127.0.0.1:34567/artifact-transfer/test-transfer-1234',
      transferTicket: secret,
      expectedSha256,
      expectedSize
    });
    assert.equal(plan.artifactTransfer?.ready, true);
    assert.equal(plan.resolved.artifactTransfer?.ticketPresent, true);
    assert.equal(JSON.stringify(plan).includes(secret), false);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});


test('generic platform transfer workflows remain available without firmware capability and never expose the transfer ticket in plans', async () => {
  const project: FirmwareProjectInfo = {
    workspace: 'w',
    projectPath: 'project',
    family: 'unknown',
    framework: 'unknown',
    buildSystem: undefined,
    markers: [],
    ros2: false,
    docker: false
  };
  const f = await fixture(project);
  try {
    const body = JSON.stringify({ kind: 'report', ok: true }) + '\n';
    await fs.writeFile(path.join(f.root, 'project', 'report.json'), body, 'utf8');
    const expectedSha256 = createHash('sha256').update(body).digest('hex');
    const expectedSize = Buffer.byteLength(body);

    const list = await f.engine.list('w', 'project');
    assert.ok(list.workflows.some(item => item.id === 'platform.transfer_prepare'));
    assert.ok(list.workflows.some(item => item.id === 'platform.transfer_receive_offer'));
    assert.ok(list.workflows.some(item => item.id === 'platform.transfer_push'));
    assert.equal(list.workflows.some(item => item.id === 'firmware.build'), false);

    const prepared = await f.engine.run('w', 'project', 'platform.transfer_prepare', { file: 'report.json' });
    assert.equal(prepared.status, 'succeeded');
    assert.equal((prepared as any).outputs.manifest.sha256, expectedSha256);
    assert.deepEqual(f.calls, []);

    const secret = 'S'.repeat(43);
    const pushPlan = await f.engine.plan('w', 'project', 'platform.transfer_push', {
      file: 'report.json',
      transferEndpoint: 'http://127.0.0.1:34567/rwmcp-data/test-transfer-1234',
      transferTicket: secret,
      expectedSha256,
      expectedSize
    });
    assert.equal(pushPlan.dataPlane?.ready, true);
    assert.equal(pushPlan.resolved.dataPlane?.ticketPresent, true);
    assert.equal(JSON.stringify(pushPlan).includes(secret), false);
  } finally {
    await f.dataPlane.closeAllForTests();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
