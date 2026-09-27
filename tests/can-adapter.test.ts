import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CanAdapter } from '../src/adapters/engineering/can.js';
import type { EngineeringCommandResult } from '../src/engineering/types.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';

function config(root: string): PolicyConfig {
  return {
    version: 1,
    mode: 'full_control',
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
    }
  };
}

async function fakeExecutable(dir: string, name: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(dir, `${name}.cmd`), '@echo off\r\nexit /b 0\r\n');
    return;
  }
  const file = path.join(dir, name);
  await fs.writeFile(file, '#!/bin/sh\nexit 0\n');
  await fs.chmod(file, 0o755);
}

function command(program: string, args: string[], cwd: string, stdout = '', stderr = '', exitCode = 0): EngineeringCommandResult {
  return { program, args: [...args], cwd, stdout, stderr, exitCode, timedOut: false, durationMs: 1 };
}

test('SocketCAN adapter lists CAN interfaces from bounded iproute2 JSON', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-can-list-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin, 'ip');
  await fakeExecutable(bin, 'candump');
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  const calls: string[][] = [];
  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push([...args]);
      if (args[0] === '-h') return command(program, args, cwd, '', 'candump - dump CAN bus traffic.');
      return command(program, args, cwd, JSON.stringify([
        {
          ifindex: 7,
          ifname: 'can0',
          flags: ['UP', 'LOWER_UP'],
          mtu: 72,
          operstate: 'UP',
          txqlen: 10,
          linkinfo: {
            info_kind: 'can',
            info_data: {
              state: 'ERROR-ACTIVE',
              restart_ms: 100,
              bittiming: { bitrate: 500000, sample_point: 0.875, tq: 125, prop_seg: 6, phase_seg1: 7, phase_seg2: 2, sjw: 1 },
              data_bittiming: { bitrate: 2000000, sample_point: 0.8 },
              berr_counter: { tx: 1, rx: 2 },
              clock: { freq: 80000000 }
            }
          },
          stats64: { rx: { bytes: 120, packets: 10, errors: 0, dropped: 0 }, tx: { bytes: 48, packets: 4, errors: 0, dropped: 0 } }
        },
        { ifindex: 2, ifname: 'eth0', linkinfo: { info_kind: 'ether' } }
      ]));
    }
  };

  try {
    const adapter = new CanAdapter(new PolicyEngine(config(root)), runner as never, 'linux');
    const provider = await adapter.providerStatus();
    assert.equal(provider.supported, true);
    assert.equal(provider.capture, true);
    const interfaces = await adapter.listInterfaces();
    assert.equal(interfaces.length, 1);
    assert.equal(interfaces[0]?.name, 'can0');
    assert.equal(interfaces[0]?.bitrate, 500000);
    assert.equal(interfaces[0]?.dataBitrate, 2000000);
    assert.equal(interfaces[0]?.errorCounters.tx, 1);
    assert.deepEqual(calls.at(-1), ['-json', '-details', '-statistics', 'link', 'show']);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SocketCAN bounded capture compiles typed filters and summarizes classic plus FD frames', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-can-capture-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin, 'candump');
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  const calls: string[][] = [];
  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push([...args]);
      return command(program, args, cwd, [
        '(1720000000.100000) can0 123#11223344',
        '(1720000000.200000) can0 001ABCDE##1AABBCCDDEEFF0011',
        '(1720000000.300000) can0 123#R8'
      ].join('\n'));
    }
  };

  try {
    const adapter = new CanAdapter(new PolicyEngine(config(root)), runner as never, 'linux');
    const capture = await adapter.capture('can0', {
      count: 3,
      inactivityTimeoutMs: 1500,
      filters: [
        { id: 0x123, mask: 0x7ff },
        { id: 0x1abcde, mask: 0x1fffffff, extended: true }
      ],
      includeErrorFrames: true
    });
    assert.deepEqual(calls.at(-1), ['-L', '-n', '3', '-T', '1500', 'can0,123:7FF,001ABCDE:1FFFFFFF,#1FFFFFFF']);
    assert.equal(capture.frames.length, 3);
    assert.equal(capture.frames[0]?.idHex, '123');
    assert.equal(capture.frames[1]?.fd, true);
    assert.equal(capture.frames[1]?.data.length, 8);
    assert.equal(capture.frames[2]?.rtr, true);
    assert.equal(capture.frames[2]?.dlc, 8);
    assert.equal(capture.summary.uniqueIdCount, 2);
    assert.equal(capture.summary.fdFrameCount, 1);
    assert.equal(capture.summary.rtrFrameCount, 1);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});



test('SocketCAN capture falls back to packaged Python AF_CAN receiver when candump is unavailable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-can-python-fallback-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin, 'ip');
  await fakeExecutable(bin, 'python3');
  process.env.PATH = bin;
  const calls: Array<{ program: string; args: string[] }> = [];
  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push({ program, args: [...args] });
      return command(program, args, cwd, '(1720000001.100000) can0 321#AABBCCDD\n');
    }
  };

  try {
    const adapter = new CanAdapter(new PolicyEngine(config(root)), runner as never, 'linux');
    const provider = await adapter.providerStatus();
    assert.equal(provider.capture, true);
    assert.equal(provider.captureBackend, 'python-af-can');
    const capture = await adapter.capture('can0', {
      count: 1,
      inactivityTimeoutMs: 500,
      filters: [{ id: 0x321, mask: 0x7ff }]
    });
    assert.equal(capture.backend, 'python-af-can');
    assert.equal(capture.frames[0]?.idHex, '321');
    const call = calls.at(-1)!;
    assert.match(call.program, /python3/i);
    assert.ok(call.args[0]?.endsWith(path.join('scripts', 'socketcan_capture.py')));
    assert.deepEqual(call.args.slice(1), [
      '--interface', 'can0',
      '--count', '1',
      '--timeout-ms', '500',
      '--filter', '321:7FF:0'
    ]);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SocketCAN capture rejects unsafe names, oversized filters and out-of-range identifiers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-can-bounds-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin, 'candump');
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  const runner = { async run(program: string, args: string[], cwd: string) { return command(program, args, cwd); } };

  try {
    const adapter = new CanAdapter(new PolicyEngine(config(root)), runner as never, 'linux');
    await assert.rejects(() => adapter.capture('can0;rm', {}), /interface name/i);
    await assert.rejects(() => adapter.capture('can0', { filters: Array.from({ length: 33 }, () => ({ id: 1, mask: 0x7ff })) }), /at most 32 filters/i);
    await assert.rejects(() => adapter.capture('can0', { filters: [{ id: 0x800, mask: 0x7ff }] }), /Standard CAN filter/i);
    await assert.rejects(() => adapter.capture('can0', { filters: [{ id: 0x20000000, mask: 0x1fffffff, extended: true }] }), /Extended CAN filter/i);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});
