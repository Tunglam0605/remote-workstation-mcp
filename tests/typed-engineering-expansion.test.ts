import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DockerAdapter } from '../src/adapters/engineering/docker.js';
import { FirmwareAdapter } from '../src/adapters/engineering/firmware.js';
import { KicadAdapter } from '../src/adapters/engineering/kicad.js';
import { PlatformioAdapter } from '../src/adapters/engineering/platformio.js';
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
      if (args[0] === 'stats') {
        return command(program, args, cwd, [
          JSON.stringify({ Name: 'robot', CPUPerc: '12.00%', MemUsage: '100MiB / 1GiB' }),
          JSON.stringify({ Name: 'vision', CPUPerc: '5.00%', MemUsage: '200MiB / 1GiB' })
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
    const stats = await adapter.statsSnapshot('w');
    assert.equal(stats.count, 2);
    assert.equal(stats.containers[0]?.Name, 'robot');
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
      if (key === 'doctor --report') return command(program, args, cwd, 'NETWORK CONFIGURATION\nRMW MIDDLEWARE\n');
      return command(program, args, cwd);
    }
  };

  try {
    const engine = new PolicyEngine(config(root, 'workspace'));
    const adapter = new Ros2Adapter(engine, new PathGuard(engine), runner as never, {} as never);
    const result = await adapter.diagnostics('w');
    assert.deepEqual(result.summary, { nodes: 2, topics: 2, services: 1, actions: 1, packages: 3 });
    assert.deepEqual(result.packages, ['rclcpp', 'nav2_bringup', 'slam_toolbox']);
    const doctor = await adapter.doctor('w');
    assert.equal(doctor.structured, false);
    assert.match(doctor.report, /NETWORK CONFIGURATION/);
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
  await fs.mkdir(path.join(root, 'build', 'config'), { recursive: true });
  await fs.writeFile(path.join(root, 'build', 'project_description.json'), JSON.stringify({
    project_name: 'rwmcp_fixture',
    project_version: '1.2.3',
    target: 'esp32s3',
    idf_ver: 'v5.3.1',
    app_elf: 'rwmcp_fixture.elf',
    build_components: ['main', 'freertos']
  }));
  await fs.writeFile(path.join(root, 'build', 'flasher_args.json'), JSON.stringify({
    flash_settings: { flash_mode: 'dio', flash_size: '8MB', flash_freq: '80m' },
    flash_files: { '0x0': 'bootloader/bootloader.bin', '0x10000': 'rwmcp_fixture.bin' }
  }));
  await fs.writeFile(path.join(root, 'build', 'config', 'sdkconfig.json'), JSON.stringify({
    IDF_TARGET: 'esp32s3',
    CONFIG_ESPTOOLPY_FLASHMODE: 'dio',
    CONFIG_ESPTOOLPY_FLASHSIZE: '8MB',
    CONFIG_PARTITION_TABLE_FILENAME: 'partitions.csv'
  }));
  await fakeExecutable(bin, 'idf.py');
  await fakeExecutable(bin, 'python');
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;

  const calls: string[][] = [];
  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push([...args]);
      if (args.includes('--list-targets')) return command(program, args, cwd, 'esp32\nesp32s3\nesp32c6\n');
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
    assert.deepEqual(result.supportedTargets, ['esp32', 'esp32s3', 'esp32c6']);
    assert.equal(result.buildMetadata.available, true);
    assert.equal(result.buildMetadata.project?.target, 'esp32s3');
    assert.equal(result.buildMetadata.flash?.files.length, 2);
    assert.equal(result.buildMetadata.config?.partitionTable, 'partitions.csv');
    assert.equal(calls.some(args => args.includes('flash')), false);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('v0.22 workflow parameters bound ROS bag and Docker diagnostics selectors', () => {
  const parsed = workflowRuntimeParametersSchema.parse({
    rosBagPath: 'bags/run-001',
    dockerContainer: 'robot-api_1',
    dockerLogTail: 350
  });
  assert.equal(parsed.rosBagPath, 'bags/run-001');
  assert.equal(parsed.dockerContainer, 'robot-api_1');
  assert.equal(parsed.dockerLogTail, 350);
  assert.throws(() => workflowRuntimeParametersSchema.parse({ dockerContainer: '../escape' }));
  assert.throws(() => workflowRuntimeParametersSchema.parse({ dockerLogTail: 5001 }));
});

test('PlatformIO diagnostics use official JSON metadata and device inventory without upload mutation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-platformio-diagnostics-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fs.writeFile(path.join(root, 'platformio.ini'), [
    '[env:esp32s3]',
    'platform = espressif32',
    'board = esp32-s3-devkitc-1',
    'framework = arduino'
  ].join('\n'));
  await fakeExecutable(bin, 'pio');
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  const calls: string[][] = [];
  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push([...args]);
      if (args[0] === '--version') return command(program, args, cwd, 'PlatformIO Core, version 6.1.18\n');
      if (args[0] === 'project') {
        return command(program, args, cwd, JSON.stringify({
          env_name: 'esp32s3',
          platform: 'espressif32',
          board: 'esp32-s3-devkitc-1',
          framework: ['arduino']
        }));
      }
      if (args[0] === 'device') {
        return command(program, args, cwd, JSON.stringify([
          { port: process.platform === 'win32' ? 'COM8' : '/dev/ttyACM0', description: 'USB JTAG/serial debug unit' }
        ]));
      }
      return command(program, args, cwd);
    }
  };

  try {
    const engine = new PolicyEngine(config(root, 'workspace'));
    const adapter = new PlatformioAdapter(engine, new PathGuard(engine), runner as never);
    const result = await adapter.diagnostics('w');
    assert.match(result.version, /PlatformIO Core/);
    assert.equal((result.metadata as any).board, 'esp32-s3-devkitc-1');
    assert.equal(result.serialDevices.length, 1);
    assert.equal(calls.some(args => ['run', 'upload', 'erase'].includes(args[0] ?? '')), false);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ESP-IDF size analysis consumes official JSON size outputs and never flashes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-espidf-size-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fs.writeFile(path.join(root, 'CMakeLists.txt'), [
    'cmake_minimum_required(VERSION 3.16)',
    'include($ENV{IDF_PATH}/tools/cmake/project.cmake)',
    'project(size_fixture)'
  ].join('\n'));
  await fs.writeFile(path.join(root, 'sdkconfig'), 'CONFIG_IDF_TARGET="esp32s3"\n');
  await fakeExecutable(bin, 'idf.py');
  await fakeExecutable(bin, 'python');
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  const calls: string[][] = [];
  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push([...args]);
      const joined = args.join(' ');
      if (joined.includes('size-components')) return command(program, args, cwd, JSON.stringify({ components: [{ name: 'main', total: 1200 }] }));
      if (joined.includes('size-files')) return command(program, args, cwd, JSON.stringify({ files: [{ name: 'main.c.obj', total: 800 }] }));
      if (joined.match(/\bsize\b/) && joined.includes('--format') && joined.includes('json')) {
        return command(program, args, cwd, JSON.stringify({ total_size: 4096, free_space: 8192 }));
      }
      return command(program, args, cwd, 'ESP-IDF v5.3.1\n');
    }
  };

  try {
    const engine = new PolicyEngine(config(root, 'workspace'));
    const adapter = new FirmwareAdapter(engine, new PathGuard(engine), runner as never, {} as never, { list: async () => [] } as never);
    const result = await adapter.espIdfSizeAnalysis('w');
    assert.equal((result.summary as any).total_size, 4096);
    assert.equal((result.components as any).components[0].name, 'main');
    assert.equal((result.files as any).files[0].name, 'main.c.obj');
    assert.equal(calls.some(args => args.includes('flash') || args.includes('erase-flash')), false);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ROS 2 typed test and rosbag inspection stay bounded and non-mutating', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-ros2-test-bag-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin, 'ros2');
  await fakeExecutable(bin, 'colcon');
  await fs.mkdir(path.join(root, 'bags', 'run-001'), { recursive: true });
  await fs.writeFile(path.join(root, 'bags', 'run-001', 'metadata.yaml'), 'rosbag2_bagfile_information: {}\n');
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  const calls: string[][] = [];
  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push([...args]);
      if (args[0] === 'test') return command(program, args, cwd, 'Summary: 3 packages finished\n');
      if (args[0] === 'test-result') return command(program, args, cwd, 'Summary: 12 tests, 0 errors, 0 failures, 0 skipped\n');
      if (args[0] === 'bag' && args[1] === 'info') return command(program, args, cwd, 'Files:             run-001_0.db3\nDuration:          2.3s\n');
      return command(program, args, cwd);
    }
  };

  try {
    const engine = new PolicyEngine(config(root, 'workspace'));
    const adapter = new Ros2Adapter(engine, new PathGuard(engine), runner as never, {} as never);
    const tested = await adapter.test('w', '.', undefined, { packagesSelect: ['nav_pkg'] });
    assert.match(tested.result.report, /0 failures/);
    assert.deepEqual(tested.packagesSelect, ['nav_pkg']);
    const bag = await adapter.bagInfo('w', 'bags/run-001');
    assert.match(bag.report, /Duration/);
    assert.equal(calls.some(args => args[0] === 'bag' && ['record', 'play'].includes(args[1] ?? '')), false);
    await assert.rejects(() => adapter.bagInfo('w', '../outside'), /project-relative/);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Docker inspect and logs are read-only typed operations with bounded selectors', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-docker-inspect-'));
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
      if (args[0] === 'inspect') return command(program, args, cwd, JSON.stringify([{ Config: { User: '1000' }, HostConfig: {}, Mounts: [] }]));
      if (args[0] === 'logs') return command(program, args, cwd, 'ready\nhealthy\n');
      return command(program, args, cwd);
    }
  };

  try {
    const engine = new PolicyEngine(config(root, 'read_only'));
    const adapter = new DockerAdapter(engine, new PathGuard(engine), runner as never);
    const inspected = await adapter.inspect('w', 'robot-api');
    assert.equal(inspected.risk.highRisk, false);
    const logs = await adapter.logs('w', 'robot-api', 25);
    assert.match(logs.stdout, /healthy/);
    assert.ok(calls.some(args => args[0] === 'logs' && args.includes('--tail') && args.includes('25')));
    assert.equal(calls.some(args => ['start', 'stop', 'exec', 'build'].includes(args[0] ?? '')), false);
    await assert.rejects(() => adapter.logs('w', '../bad', 10), /Invalid container/);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('KiCad diagnostics and validation use bounded JSON reports without source mutation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-diagnostics-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin, 'kicad-cli');
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  await fs.writeFile(path.join(root, 'robot.kicad_pro'), '{}');
  await fs.writeFile(path.join(root, 'robot.kicad_sch'), '(kicad_sch)');
  await fs.writeFile(path.join(root, 'robot.kicad_pcb'), '(kicad_pcb)');
  const calls: string[][] = [];
  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push([...args]);
      if (args[0] === 'version') return command(program, args, cwd, '10.0.6\n');
      const outputIndex = args.indexOf('--output');
      const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
      if (!output) return command(program, args, cwd, '', 'missing output', 2);
      if (args.includes('stats')) {
        await fs.writeFile(output, JSON.stringify({ board_size: { width: 100, height: 80 }, copper_layers: 2 }));
      } else if (args.includes('drc')) {
        await fs.writeFile(output, JSON.stringify({
          '$schema': 'https://schemas.kicad.org/drc.v1.json',
          source: path.join(root, 'robot.kicad_pcb'),
          kicad_version: '10.0.6',
          coordinate_units: 'mm',
          included_severities: ['error', 'warning', 'exclusion'],
          violations: [{ severity: 'error', description: 'Clearance violation', excluded: false, items: [] }],
          unconnected_items: [{ severity: 'warning', description: 'Unconnected pad', excluded: false, items: [] }],
          schematic_parity: [],
          ignored_checks: []
        }));
      } else if (args.includes('erc')) {
        await fs.writeFile(output, JSON.stringify({
          '$schema': 'https://schemas.kicad.org/erc.v1.json',
          source: path.join(root, 'robot.kicad_sch'),
          kicad_version: '10.0.6',
          coordinate_units: 'mm',
          sheets: [{ path: '/', uuid_path: '/00000000-0000-0000-0000-000000000000', violations: [{ severity: 'warning', description: 'Power input not driven', excluded: false, items: [] }] }]
        }));
      }
      return command(program, args, cwd);
    }
  };

  try {
    const engine = new PolicyEngine(config(root, 'workspace'));
    const adapter = new KicadAdapter(engine, new PathGuard(engine), runner as never);
    const files = { project: 'robot.kicad_pro', schematic: 'robot.kicad_sch', board: 'robot.kicad_pcb', jobsets: [] };
    const diagnostics = await adapter.diagnostics('w', '.', files);
    assert.equal(diagnostics.provider.version, '10.0.6');
    assert.deepEqual(diagnostics.boardStats?.report, { board_size: { width: 100, height: 80 }, copper_layers: 2 });
    const validation = await adapter.validate('w', '.', files);
    assert.equal(validation.drc?.report.counts.total, 2);
    assert.equal(validation.drc?.report.counts.bySeverity.error, 1);
    assert.equal(validation.erc?.report.counts.violations, 1);
    assert.equal(validation.erc?.report.counts.bySeverity.warning, 1);
    const flat = calls.flat();
    assert.equal(flat.includes('upgrade'), false);
    assert.equal(flat.includes('import'), false);
    assert.equal(flat.includes('--save-board'), false);
    assert.equal(flat.includes('--refill-zones'), false);
    assert.equal(flat.includes('--exit-code-violations'), false);
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
          'Result=success',
          'MainPID=1234',
          'ExecMainCode=1',
          'ExecMainStatus=0',
          'NRestarts=2',
          'MemoryCurrent=104857600',
          'CPUUsageNSec=123456789',
          'TasksCurrent=7',
          'InvocationID=fixture-invocation',
          'ExecMainStartTimestampMonotonic=1000',
          'ActiveEnterTimestampMonotonic=1200',
          'FragmentPath=/etc/systemd/system/robot-gateway.service'
        ].join('\n'));
      }
      if (program.endsWith('journalctl')) return command(program, args, cwd, JSON.stringify({
        __REALTIME_TIMESTAMP: '1789891200000000',
        PRIORITY: '6',
        SYSLOG_IDENTIFIER: 'robot-gateway',
        _PID: '1234',
        _SYSTEMD_INVOCATION_ID: 'fixture-invocation',
        MESSAGE: 'ready'
      }) + '\n');
      return command(program, args, cwd);
    }
  };

  try {
    const engine = new PolicyEngine(config(root, 'full_control', ['robot-gateway.service']));
    const adapter = new SystemdAdapter(engine, new PathGuard(engine), runner as never);
    const before = await adapter.diagnostics('w', 'robot-gateway.service', '.', false, 25);
    assert.equal(before.properties.ActiveState, 'active');
    assert.equal(before.properties.NRestarts, '2');
    assert.equal(before.journal.format, 'json');
    assert.equal(before.journal.entries?.[0]?.message, 'ready');
    assert.equal(before.journal.entries?.[0]?.invocationId, 'fixture-invocation');
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
