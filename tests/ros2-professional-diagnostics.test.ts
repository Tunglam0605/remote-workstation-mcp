import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Ros2Adapter } from '../src/adapters/engineering/ros2.js';
import type { EngineeringCommandResult } from '../src/engineering/types.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

function config(root: string, allowHardwareMutationInWorkspace = false): PolicyConfig {
  return {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'w', root, readOnly: false }],
    filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
    process: { allowExecutables: [], inheritEnv: ['PATH', 'HOME', 'TEMP', 'TMP'], maxOutputBytes: 256 * 1024, maxRuntimeMs: 60_000 },
    engineering: { enabled: true, maxCommandRuntimeMs: 60_000, allowHardwareMutationInWorkspace, allowSerialWriteInWorkspace: false }
  };
}

async function fakeRos2(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  if (process.platform === 'win32') await fs.writeFile(path.join(dir, 'ros2.cmd'), '@echo off\r\nexit /b 0\r\n');
  else { const file = path.join(dir, 'ros2'); await fs.writeFile(file, '#!/bin/sh\nexit 0\n'); await fs.chmod(file, 0o755); }
}

function result(program: string, args: string[], cwd: string, stdout: string, timedOut = false): EngineeringCommandResult {
  return { program, args: [...args], cwd, exitCode: timedOut ? null : 0, stdout, stderr: '', timedOut, durationMs: 1 };
}

test('ROS 2 professional diagnostics use only fixed typed argv and accept timeout as end-of-sample', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-ros2-professional-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeRos2(bin);
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  const calls: string[][] = [];
  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push([...args]);
      const key = args.slice(0, 2).join(' ');
      if (key === 'node info') return result(program, args, cwd, '/controller\n  Subscribers:\n    /cmd_vel: geometry_msgs/msg/Twist\n');
      if (key === 'topic hz') return result(program, args, cwd, 'average rate: 100.000\n\tmin: 0.009s max: 0.011s std dev: 0.00050s window: 50\n', true);
      if (key === 'topic bw') return result(program, args, cwd, '2.00 MB/s from 20 messages\n\tMessage size mean: 100.00 KB min: 90.00 KB max: 110.00 KB\n', true);
      if (key === 'run tf2_ros') return result(program, args, cwd, 'At time 42.0\n- Translation: [0.100, 0.200, 0.300]\n- Rotation: in Quaternion [0.000, 0.000, 0.000, 1.000]\n', true);
      if (key === 'lifecycle get') return result(program, args, cwd, 'active [3]\n');
      if (key === 'lifecycle list') return result(program, args, cwd, '- configure [1]\n- activate [3]\n');
      if (key === 'action info') return result(program, args, cwd, 'Action: /navigate_to_pose\nAction clients: 1\nAction servers: 1\n');
      return result(program, args, cwd, 'Transitioning successful\n');
    }
  };
  try {
    const engine = new PolicyEngine(config(root));
    const adapter = new Ros2Adapter(engine, new PathGuard(engine), runner as never, {} as never);
    assert.match((await adapter.nodeInfo('w', '/controller')).output, /cmd_vel/);
    const hz = await adapter.topicHz('w', '/odom', '.', 3000, 50, true);
    assert.equal(hz.sample.averageHz, 100);
    assert.equal(hz.semantics, 'receiver-side-subscription-rate');
    assert.equal(hz.wallTime, true);
    const bw = await adapter.topicBandwidth('w', '/camera/image', '.', 3000, 50);
    assert.equal(bw.sample.bytesPerSecond, 2_000_000);
    assert.equal(bw.semantics, 'receiver-side-subscription-bandwidth');
    const tf = await adapter.tfLookup('w', 'map', 'base_link', '.', 3000);
    assert.deepEqual(tf.transform.translation, { x: 0.1, y: 0.2, z: 0.3 });
    assert.deepEqual((await adapter.lifecycleGet('w', '/amcl')).state, { label: 'active', id: 3, raw: 'active [3]' });
    assert.equal((await adapter.lifecycleList('w', '/amcl')).transitions.length, 2);
    assert.match((await adapter.actionInfo('w', '/navigate_to_pose')).output, /Action servers: 1/);
    assert.ok(calls.some(args => args.join(' ') === 'topic hz /odom --window 50 --wall-time'));
    assert.ok(calls.some(args => args.join(' ') === 'topic bw /camera/image --window 50'));
    assert.ok(calls.some(args => args.join(' ') === 'run tf2_ros tf2_echo map base_link'));
    assert.equal(calls.some(args => args.includes('send_goal')), false);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ROS 2 professional diagnostics reject unsafe names and lifecycle mutation remains hardware-gated', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-ros2-professional-policy-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeRos2(bin);
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  const calls: string[][] = [];
  const runner = { async run(program: string, args: string[], cwd: string) { calls.push([...args]); return result(program, args, cwd, 'Transitioning successful\n'); } };
  try {
    const deniedEngine = new PolicyEngine(config(root, false));
    const denied = new Ros2Adapter(deniedEngine, new PathGuard(deniedEngine), runner as never, {} as never);
    await assert.rejects(() => denied.nodeInfo('w', '../controller'), /Invalid ROS 2 node/);
    await assert.rejects(() => denied.tfLookup('w', '../map', 'base_link'), /Invalid TF source/);
    await assert.rejects(() => denied.lifecycleSet('w', '/amcl', 'activate'), /hardware mutation|workspace/i);
    assert.equal(calls.length, 0);

    const allowedEngine = new PolicyEngine(config(root, true));
    const allowed = new Ros2Adapter(allowedEngine, new PathGuard(allowedEngine), runner as never, {} as never);
    const changed = await allowed.lifecycleSet('w', '/amcl', 'activate');
    assert.equal(changed.transition, 'activate');
    assert.ok(calls.some(args => args.join(' ') === 'lifecycle set /amcl activate'));
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});
