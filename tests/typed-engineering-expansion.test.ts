import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DockerAdapter } from '../src/adapters/engineering/docker.js';
import { FirmwareAdapter } from '../src/adapters/engineering/firmware.js';
import { Ros2Adapter } from '../src/adapters/engineering/ros2.js';
import { SystemdAdapter } from '../src/adapters/engineering/systemd.js';
import { workflowRuntimeParametersSchema } from '../src/engineering-workflow-contract.js';
import type { EngineeringCommandResult } from '../src/engineering/types.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

function config(
  root: string,
  mode: PolicyConfig['mode'] = 'workspace',
  systemdUnits: string[] = []
): PolicyConfig {
  return {
    version: 1,
    mode,
    workspaces: [{ id: 'w', root, readOnly: false }],
    filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
    process: {
      allowExecutables: [],
      inheritEnv: ['PATH', 'HOME', 'TEMP', 'TMP'],
      maxOutputBytes: 256 * 1024,
      maxRuntimeMs: 60_000
    },
    engineering: {
      enabled: true,
      maxCommandRuntimeMs: 60_000,
      allowHardwareMutationInWorkspace: false,
      allowSerialWriteInWorkspace: false
    },
    systemd: { allowRestartUnits: systemdUnits }
  };
}

async function fakeExecutable(dir: string, name: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  if (process.platform === 'win32' && !path.extname(name)) {
    const file = path.join(dir, `${name}.cmd`);
    await fs.writeFile(file, '@echo off\r\nexit /b 0\r\n');
    return file;
  }
  const file = path.join(dir, name);
  await fs.writeFile(file, process.platform === 'win32' ? '' : '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') await fs.chmod(file, 0o755);
  return file;
}

function command(
  program: string,
  args: string[],
  cwd: string,
  stdout = '',
  stderr = '',
  exitCode = 0
): EngineeringCommandResult {
  return {
    program,
    args: [...args],
    cwd,
    exitCode,
    stdout,
    stderr,
    timedOut: false,
    durationMs: 1
  };
}

test('systemd workflow parameters are bounded and unit names are explicit', () => {
  const parsed = workflowRuntimeParametersSchema.parse({
    systemdUnit: 'robot-gateway.service',
    systemdUser: true,
    journalLines: 250
  });
  assert.equal(parsed.systemdUnit, 'robot-gateway.service');
  assert.equal(parsed.systemdUser, true);
  assert.equal(parsed.journalLines, 250);

  assert.throws(
    () => workflowRuntimeParametersSchema.parse({ systemdUnit: '../bad.service' }),
    /invalid/i
  );
  assert.throws(
    () => workflowRuntimeParametersSchema.parse({ systemdUnit: 'robot-gateway.service', journalLines: 1001 })
  );
});

test('systemd restart is default-deny even in full_control and requires exact owner allowlist', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-systemd-policy-'));
  try {
    const denied = new PolicyEngine(config(root, 'full_control'));
    assert.throws(
      () => denied.assertSystemdRestart('robot-gateway.service'),
      /allowRestartUnits/i
    );

    const allowed = new PolicyEngine(config(root, 'full_control', ['robot-gateway.service']));
    assert.doesNotThrow(() => allowed.assertSystemdRestart('robot-gateway.service'));
    assert.throws(
      () => allowed.assertSystemdRestart('tunglam-apriltag.service'),
      /allowRestartUnits/i
    );

    const workspaceMode = new PolicyEngine(config(root, 'workspace', ['robot-gateway.service']));
    assert.throws(
      () => workspaceMode.assertSystemdRestart('robot-gateway.service'),
      /full_control/i
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('docker diagnostics aggregate daemon risk and container runtime state without mutation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-docker-diagnostics-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin, 'docker');
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  const calls: string[][] = [];
  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push([...args]);
      if (args[0] === 'context' && args[1] === 'show') return command(program, args, cwd, 'default\n');
      if (args[0] === 'context' && args[1] === 'inspect') {
        const endpoint = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
        return command(program, args, cwd, JSON.stringify(endpoint));
      }
      if (args[0] === 'info') return command(program, args, cwd, JSON.stringify(['name=seccomp']));
      if (args[0] === 'ps') {
        return command(program, args, cwd, [
          JSON.stringify({ Names: 'robot', State: 'running', Status: 'Up 2 minutes' }),
          JSON.stringify({ Names: 'report', State: 'exited', Status: 'Exited (0) 1 hour ago' }),
          JSON.stringify({ Names: 'vision', State: 'running', Status: 'Up 3 minutes (unhealthy)' })
        ].join('\n'));
      }
      return command(program, args, cwd);
    }
  };

  try {
    const engine = new PolicyEngine(config(root, 'read_only'));
    const adapter = new DockerAdapter(engine, new PathGuard(engine), runner as never);
    const result = await adapter.diagnostics('w');
    assert.equal(result.summary.total, 3);
    assert.equal(result.summary.running, 2);
    assert.equal(result.summary.exited, 1);
    assert.equal(result.summary.unhealthy, 1);
    assert.equal(result.daemon.remote, false);
    assert.equal(calls.some(args => ['start', 'stop', 'exec', 'build'].includes(args[0] ?? '')), false);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ROS 2 diagnostics combine graph health with package inventory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-ros2-diagnostics-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin, 'ros2');
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;

  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      const key = args.slice(0, 2).join(' ');
      if (key === 'node list') return command(program, args, cwd, '/controller\n/vision\n');
      if (key === 'topic list') return command(program, args, cwd, '/cmd_vel [geometry_msgs/msg/Twist]\n/scan [sensor_msgs/msg/LaserScan]\n');
      if (key === 'service list') return command(program, args, cwd, '/reset [std_srvs/srv/Trigger]\n');
      if (key === 'action list') return command(program, args, cwd, '/navigate_to_pose [nav2_msgs/action/NavigateToPose]\n');
      if (key === 'pkg list') return command(program, args, cwd, 'rclcpp\nnav2_bringup\nslam_toolbox\n');
      return command(program, args, cwd);
    }
  };

  try {
    const engine = new PolicyEngine(config(root, 'workspace'));
    const adapter = new Ros2Adapter(engine, new PathGuard(engine), runner as never, {} as never);
    const result = await adapter.diagnostics('w');
    assert.deepEqual(result.summary, { nodes: 2, topics: 2, services: 1, actions: 1, packages: 3 });
    assert.deepEqual(result.packages, ['rclcpp', 'nav2_bringup', 'slam_toolbox']);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ESP-IDF diagnostics expose provider, project, artifacts and serial inventory without flashing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-espidf-diagnostics-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fs.writeFile(path.join(root, 'CMakeLists.txt'), [
    'cmake_minimum_required(VERSION 3.16)',
    'include($ENV{IDF_PATH}/tools/cmake/project.cmake)',
    'project(rwmcp_fixture)'
  ].join('\n'));
  await fakeExecutable(bin, 'idf.py');
  await fakeExecutable(bin, 'python');
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;

  const calls: string[][] = [];
  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push([...args]);
      return command(program, args, cwd, 'ESP-IDF v5.3.1\n');
    }
  };
  const hardware = {
    async list() {
      return [{
        id: 'serial:fixture',
        kind: 'serial',
        name: 'ESP32-S3 USB',
        path: process.platform === 'win32' ? 'COM9' : '/dev/ttyACM0',
        serialNumber: 'ESPTEST',
        provider: 'fixture',
        capabilities: ['serial-monitor', 'serial-write']
      }];
    }
  };

  try {
    const engine = new PolicyEngine(config(root, 'workspace'));
    const adapter = new FirmwareAdapter(
      engine,
      new PathGuard(engine),
      runner as never,
      {} as never,
      hardware as never
    );
    const result = await adapter.espIdfDiagnostics('w');
    assert.equal(result.provider, 'esp-idf');
    assert.match(result.version, /ESP-IDF v5\.3\.1/);
    assert.equal(result.project.family, 'esp32');
    assert.equal(result.project.framework, 'esp-idf');
    assert.equal(result.serialPorts.length, 1);
    assert.equal(calls.some(args => args.includes('flash')), false);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('systemd adapter diagnostics are bounded and restart remains exact-allowlist gated', { skip: process.platform !== 'linux' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-systemd-adapter-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin, 'systemctl');
  await fakeExecutable(bin, 'journalctl');
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  const calls: string[][] = [];
  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push([...args]);
      if (args.includes('show')) {
        return command(program, args, cwd, [
          'LoadState=loaded',
          'ActiveState=active',
          'SubState=running',
          'UnitFileState=enabled',
          'MainPID=1234',
          'ExecMainCode=1',
          'ExecMainStatus=0',
          'FragmentPath=/etc/systemd/system/robot-gateway.service'
        ].join('\n'));
      }
      if (program.endsWith('journalctl')) return command(program, args, cwd, '2026-09-20T00:00:00+0000 ready\n');
      return command(program, args, cwd);
    }
  };

  try {
    const engine = new PolicyEngine(config(root, 'full_control', ['robot-gateway.service']));
    const adapter = new SystemdAdapter(engine, new PathGuard(engine), runner as never);
    const before = await adapter.diagnostics('w', 'robot-gateway.service', '.', false, 25);
    assert.equal(before.properties.ActiveState, 'active');
    const after = await adapter.restart('w', 'robot-gateway.service', '.', false, 25);
    assert.equal(after.diagnostics.properties.SubState, 'running');
    assert.equal(calls.some(args => args.includes('restart') && args.includes('robot-gateway.service')), true);
    await assert.rejects(
      () => adapter.restart('w', 'tunglam-apriltag.service', '.', false, 25),
      /allowRestartUnits/i
    );
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});
