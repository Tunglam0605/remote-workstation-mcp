import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DockerAdapter } from '../src/adapters/engineering/docker.js';
import type { EngineeringCommandResult } from '../src/engineering/types.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

async function fakeDocker(dir: string): Promise<void> {
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(dir, 'docker.cmd'), '@echo off\r\nexit /b 0\r\n');
  } else {
    const file = path.join(dir, 'docker');
    await fs.writeFile(file, '#!/bin/sh\nexit 0\n');
    await fs.chmod(file, 0o755);
  }
}

function policy(root: string, mode: PolicyConfig['mode'], overrides: Partial<NonNullable<PolicyConfig['containers']>> = {}): PolicyConfig {
  return {
    version: 1,
    mode,
    workspaces: [{ id: 'w', root, readOnly: false }],
    filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
    process: { allowExecutables: [], inheritEnv: ['PATH', 'HOME', 'TEMP', 'TMP'], maxOutputBytes: 65536, maxRuntimeMs: 60000 },
    engineering: {
      enabled: true,
      maxCommandRuntimeMs: 60000,
      allowHardwareMutationInWorkspace: true,
      allowSerialWriteInWorkspace: false
    },
    containers: {
      allowLifecycleInWorkspace: false,
      allowExecInWorkspace: false,
      allowImageBuildInWorkspace: false,
      allowHighRisk: false,
      ...overrides
    }
  };
}

function inspectPayload(options: { privileged?: boolean; rootUser?: boolean; dockerSocket?: boolean } = {}) {
  return [{
    Config: { User: options.rootUser === false ? '1000:1000' : '' },
    HostConfig: {
      Privileged: options.privileged ?? false,
      PidMode: '',
      NetworkMode: 'bridge',
      Binds: options.dockerSocket ? ['/var/run/docker.sock:/var/run/docker.sock'] : [],
      Devices: [],
      DeviceRequests: []
    },
    Mounts: []
  }];
}

async function fixture(config: PolicyConfig, inspection = inspectPayload({ rootUser: false })) {
  const root = config.workspaces[0]!.root;
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fakeDocker(bin);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  const calls: Array<{ args: string[] }> = [];
  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push({ args: [...args] });
      let stdout = '';
      if (args[0] === 'inspect') stdout = JSON.stringify(inspection);
      else if (args[0] === 'context' && args[1] === 'show') stdout = 'default\n';
      else if (args[0] === 'context' && args[1] === 'inspect') stdout = JSON.stringify(process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock');
      else if (args[0] === 'info') stdout = JSON.stringify(['name=seccomp']);
      else if (args[0] === 'start') stdout = `${args[1] ?? ''}\n`;
      return { program, args: [...args], cwd, exitCode: 0, stdout, stderr: '', timedOut: false, durationMs: 1 };
    }
  };
  const engine = new PolicyEngine(config);
  const adapter = new DockerAdapter(engine, new PathGuard(engine), runner as never);
  return {
    adapter,
    calls,
    restore: async () => {
      process.env.PATH = oldPath;
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

test('container lifecycle no longer inherits hardware-mutation workspace permission', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-container-policy-'));
  const f = await fixture(policy(root, 'workspace'));
  try {
    await assert.rejects(() => f.adapter.start('w', 'demo'), /container capability 'lifecycle'/i);
    assert.equal(f.calls.some(call => call.args[0] === 'start'), false);
  } finally {
    await f.restore();
  }
});

test('high-risk container requires explicit owner allowHighRisk even under full_control', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-container-highrisk-deny-'));
  const f = await fixture(policy(root, 'full_control'), inspectPayload({ privileged: true, rootUser: true }));
  try {
    await assert.rejects(() => f.adapter.start('w', 'demo'), /allowHighRisk=false/i);
    assert.equal(f.calls.some(call => call.args[0] === 'start'), false);
  } finally {
    await f.restore();
  }
});

test('explicit full_control plus owner high-risk policy allows a classified privileged container', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-container-highrisk-allow-'));
  const config = policy(root, 'full_control', { allowHighRisk: true });
  const f = await fixture(config, inspectPayload({ privileged: true, rootUser: true, dockerSocket: true }));
  try {
    const result = await f.adapter.start('w', 'demo');
    assert.equal(result.risk.level, 'high');
    assert.equal(result.risk.highRisk, true);
    assert.ok(result.risk.findings.some(item => item.id === 'privileged'));
    assert.ok(result.risk.findings.some(item => item.id === 'docker-socket'));
    assert.equal(f.calls.some(call => call.args[0] === 'start'), true);
  } finally {
    await f.restore();
  }
});

test('container inspection returns bounded structured risk without mutating the container', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-container-inspect-risk-'));
  const f = await fixture(policy(root, 'read_only'), inspectPayload({ rootUser: true }));
  try {
    const result = await f.adapter.inspect('w', 'demo');
    assert.equal(result.risk.level, 'elevated');
    assert.equal(result.risk.highRisk, false);
    assert.ok(result.risk.findings.some(item => item.id === 'root-user'));
    assert.equal(f.calls.some(call => ['start', 'stop', 'exec', 'build'].includes(call.args[0] ?? '')), false);
  } finally {
    await f.restore();
  }
});


test('Windows host-root bind syntax is classified as high risk without confusing the drive-letter colon', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-container-windows-bind-'));
  const inspection = [{
    Config: { User: '1000:1000' },
    HostConfig: {
      Privileged: false,
      PidMode: '',
      NetworkMode: 'bridge',
      Binds: ['C:\\:/host-root:ro'],
      Devices: [],
      DeviceRequests: []
    },
    Mounts: []
  }];
  const f = await fixture(policy(root, 'full_control', { allowHighRisk: true }), inspection);
  try {
    const result = await f.adapter.riskAssessment('w', 'demo');
    assert.equal(result.highRisk, true);
    assert.ok(result.findings.some(item => item.id === 'host-root-bind'));
  } finally {
    await f.restore();
  }
});
