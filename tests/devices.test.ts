import assert from 'node:assert/strict';
import test from 'node:test';
import { DeviceRegistryAdapter } from '../src/adapters/devices.js';

function fakeSsh(reachable = true) {
  return {
    listHosts: () => [{
      id: 'ubuntu-lab', name: 'Ubuntu Lab', hostname: '192.0.2.10', port: 22, user: 'robot',
      auth: 'identity_file' as const, strictHostKeyChecking: 'yes' as const,
      remoteRoot: '/home/robot/projects', allowPrograms: ['git', 'cmake'], maxRuntimeMs: 1000
    }],
    probe: async (id: string) => ({ host: id, reachable, durationMs: 12 }),
    execute: async (id: string, program: string, args: string[] = [], cwd = '.', timeoutMs?: number) => ({
      host: id, program, ok: true, exitCode: 0, stdout: `${program} ${args.join(' ')}`.trim(), stderr: '', cwd, timeoutMs
    })
  };
}

test('device registry lists local workstation and owner-registered SSH devices without credentials', async () => {
  const previousId = process.env.RWMCP_DEVICE_ID;
  const previousName = process.env.RWMCP_DEVICE_NAME;
  process.env.RWMCP_DEVICE_ID = 'hub-win';
  process.env.RWMCP_DEVICE_NAME = 'Office Hub';
  try {
    const registry = new DeviceRegistryAdapter(fakeSsh() as never);
    const devices = await registry.list(true);
    assert.equal(devices[0]?.id, 'hub-win');
    assert.equal(devices[0]?.transport, 'local');
    assert.equal(devices[0]?.online, true);
    assert.equal(devices[1]?.id, 'ubuntu-lab');
    assert.equal(devices[1]?.transport, 'ssh');
    assert.equal(devices[1]?.remoteRoot, '/home/robot/projects');
    assert.equal(devices[1]?.online, true);
    assert.equal(devices[1]?.latencyMs, 12);
    assert.equal('identityFile' in (devices[1] as object), false);
  } finally {
    if (previousId === undefined) delete process.env.RWMCP_DEVICE_ID; else process.env.RWMCP_DEVICE_ID = previousId;
    if (previousName === undefined) delete process.env.RWMCP_DEVICE_NAME; else process.env.RWMCP_DEVICE_NAME = previousName;
  }
});

test('device list can skip probes for fast inventory', async () => {
  const registry = new DeviceRegistryAdapter(fakeSsh(false) as never);
  const devices = await registry.list(false);
  assert.equal(devices[1]?.id, 'ubuntu-lab');
  assert.equal(devices[1]?.online, undefined);
  assert.equal(devices[1]?.latencyMs, undefined);
});

test('device probe delegates remote reachability checks', async () => {
  const registry = new DeviceRegistryAdapter(fakeSsh() as never);
  const result = await registry.probe('ubuntu-lab');
  assert.equal(result.device, 'ubuntu-lab');
  assert.equal(result.transport, 'ssh');
  assert.equal(result.reachable, true);
});

test('device exec routes only to registered remote devices', async () => {
  const registry = new DeviceRegistryAdapter(fakeSsh() as never);
  const result = await registry.execute('ubuntu-lab', 'git', ['status'], '.', 500);
  assert.equal(result.device, 'ubuntu-lab');
  assert.equal(result.ok, true);
  await assert.rejects(() => registry.execute('missing', 'git'), /not registered/);
});

test('paired device identity replaces its bootstrap SSH host and routes through that transport', async () => {
  const pairing = {
    listDevices: async () => [{
      id: 'dev_ubuntu_lab', name: 'Ubuntu Vision PC', hostname: 'lab-host', platform: 'linux', arch: 'x86_64',
      version: '0.8.2', capabilities: ['paired.identity', 'ssh.bootstrap'], bootstrapTransport: 'ssh' as const,
      bootstrapHostId: 'ubuntu-lab', credentialIssuedAt: '2026-09-15T10:00:00Z', pairedAt: '2026-09-15T10:00:00Z',
      lastSeenAt: '2026-09-15T10:00:00Z'
    }],
    getActiveDevice: async (id: string) => id === 'dev_ubuntu_lab' ? {
      id, name: 'Ubuntu Vision PC', hostname: 'lab-host', platform: 'linux', arch: 'x86_64', version: '0.8.2',
      capabilities: ['paired.identity', 'ssh.bootstrap'], bootstrapTransport: 'ssh' as const, bootstrapHostId: 'ubuntu-lab',
      credentialIssuedAt: '2026-09-15T10:00:00Z', pairedAt: '2026-09-15T10:00:00Z', lastSeenAt: '2026-09-15T10:00:00Z'
    } : undefined
  };
  const registry = new DeviceRegistryAdapter(fakeSsh() as never, pairing as never);
  const devices = await registry.list(true);
  assert.equal(devices.some(device => device.id === 'ubuntu-lab'), false);
  const paired = devices.find(device => device.id === 'dev_ubuntu_lab');
  assert.equal(paired?.transport, 'paired_ssh');
  assert.equal(paired?.online, true);
  assert.equal(paired?.version, '0.8.2');
  const probe = await registry.probe('dev_ubuntu_lab');
  assert.equal(probe.transport, 'paired_ssh');
  assert.equal(probe.routedVia, 'ubuntu-lab');
  const exec = await registry.execute('dev_ubuntu_lab', 'git', ['status'], '.', 500);
  assert.equal(exec.transport, 'paired_ssh');
  assert.equal(exec.routedVia, 'ubuntu-lab');
  assert.equal(exec.ok, true);
});
