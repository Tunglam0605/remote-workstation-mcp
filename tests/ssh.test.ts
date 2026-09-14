import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostsConfig, PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { quotePosix, SshAdapter } from '../src/adapters/ssh.js';

test('quotePosix preserves arguments without shell interpolation', () => {
  assert.equal(quotePosix('hello world'), "'hello world'");
  assert.equal(quotePosix("a'b"), "'a'\"'\"'b'");
  assert.equal(quotePosix('$(touch /tmp/pwned)'), "'$(touch /tmp/pwned)'");
});

test('ssh host listing never exposes identity file paths', () => {
  const policyConfig: PolicyConfig = {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'w', root: '/tmp' }],
    filesystem: { maxReadBytes: 1024, maxWriteBytes: 1024 },
    process: { allowExecutables: [], inheritEnv: [], maxOutputBytes: 1024, maxRuntimeMs: 1000 }
  };
  const hostsConfig: HostsConfig = {
    version: 1,
    hosts: [{
      id: 'lab', hostname: '127.0.0.1', port: 22, user: 'robot', auth: 'identity_file',
      identityFile: '/home/user/.ssh/private-key', strictHostKeyChecking: 'yes', allowPrograms: ['git'], maxRuntimeMs: 1000
    }]
  };
  const adapter = new SshAdapter(new PolicyEngine(policyConfig), hostsConfig);
  const listed = adapter.listHosts()[0] as Record<string, unknown>;
  assert.equal(listed.id, 'lab');
  assert.equal('identityFile' in listed, false);
});
