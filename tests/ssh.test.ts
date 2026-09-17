import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostsConfig, PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { buildWindowsPowerShellRemoteCommand, quotePosix, SshAdapter } from '../src/adapters/ssh.js';

test('quotePosix preserves arguments without shell interpolation', () => {
  assert.equal(quotePosix('hello world'), "'hello world'");
  assert.equal(quotePosix("a'b"), "'a'\"'\"'b'");
  assert.equal(quotePosix('$(touch /tmp/pwned)'), "'$(touch /tmp/pwned)'");
});

test('Windows PowerShell SSH command transports argv without POSIX exec or cmd metacharacter interpolation', () => {
  const command = buildWindowsPowerShellRemoteCommand(
    'powershell.exe',
    ['-File', 'C:\\Program Files\\RWMCP\\run.ps1', '-Value', "a&b|c<'d'"],
    'C:\\Users\\Admin'
  );
  assert.match(command, /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  assert.doesNotMatch(command, /\bexec\b/);
  assert.doesNotMatch(command, /a&b|run\.ps1/);

  const encoded = command.split(' ').at(-1)!;
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.match(script, /Set-Location -LiteralPath 'C:\\Users\\Admin'/);
  assert.match(script, /\$__rwmcpProgram = 'powershell\.exe'/);
  assert.ok(script.includes("'a&b|c<''d'''"));
  assert.match(script, /& \$__rwmcpProgram @__rwmcpArgs/);
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
      identityFile: '/home/user/.ssh/private-key', strictHostKeyChecking: 'yes', remoteShell: 'windows-powershell', allowPrograms: ['git'], maxRuntimeMs: 1000
    }]
  };
  const adapter = new SshAdapter(new PolicyEngine(policyConfig), hostsConfig);
  const listed = adapter.listHosts()[0] as Record<string, unknown>;
  assert.equal(listed.id, 'lab');
  assert.equal('identityFile' in listed, false);
  assert.equal(listed.remoteShell, 'windows-powershell');
});
