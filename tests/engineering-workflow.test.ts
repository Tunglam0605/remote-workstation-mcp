import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
  const calls: string[] = [];
  let buildResult = okCommand();
  const firmware = {
    async inspect() { return project; },
    async listArtifacts() { return []; },
    async build() {
      calls.push('build');
      return { project, provider: project.family === 'esp32' ? 'esp-idf' : 'cmake', result: buildResult };
    },
    async flash(options: Record<string, unknown>) {
      calls.push(`flash:${String(options.port ?? options.probeSerial ?? 'auto')}`);
      return {
        plan: { provider: project.family === 'esp32' ? 'esp-idf' : 'openocd' },
        result: okCommand()
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
    }
  };
  const rosCalls: Array<{ workspace: string; cwd: string; runtime: unknown }> = [];
  const ros2 = {
    async health(workspace: string, cwd: string, runtime: unknown) {
      rosCalls.push({ workspace, cwd, runtime });
      return { summary: { nodes: 1, topics: 2, services: 3, actions: 4 } };
    }
  };
  const engine = new EngineeringWorkflowEngine(
    policy,
    profiles,
    firmware as never,
    hardware as never,
    serial as never,
    ros2 as never
  );
  return {
    root,
    profiles,
    engine,
    calls,
    rosCalls,
    setBuildResult(result: EngineeringCommandResult) { buildResult = result; }
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
    assert.deepEqual(f.calls, ['build', 'flash:/dev/ttyUSB0', 'serial:/dev/ttyUSB0:115200']);
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
    assert.deepEqual(f.calls, ['build']);
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
