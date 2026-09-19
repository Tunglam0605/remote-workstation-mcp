import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { DeviceIdentity } from '../src/device-identity.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { AuditLogger } from '../src/security/audit.js';
import { MultiNodeAuthorization, type CrossNodeTransferIntent } from '../src/security/multi-node-authorization.js';
import { runAsPrincipal, type RequestPrincipal } from '../src/security/request-principal.js';
import { runWithWorkSession } from '../src/security/execution-context.js';

const sourceIdentity: DeviceIdentity = {
  version: 1,
  id: 'dev_source',
  name: 'Source',
  hostname: 'source',
  platform: 'linux',
  arch: 'x64',
  createdAt: new Date(0).toISOString()
};

const destinationIdentity: DeviceIdentity = {
  ...sourceIdentity,
  id: 'dev_dest',
  name: 'Destination',
  hostname: 'dest'
};

function securePrincipal(scopes = ['workstation.cross_node_transfer']): RequestPrincipal {
  return {
    id: 'openai-tunnel',
    type: 'openai-secure-mcp-tunnel',
    scopes,
    authenticated: true
  };
}

function grantPolicy(root: string, enabled = true): PolicyConfig {
  return {
    version: 1,
    mode: 'workspace',
    workspaces: [
      { id: 'source', root: path.join(root, 'source'), readOnly: false },
      { id: 'dest', root: path.join(root, 'dest'), readOnly: false }
    ],
    filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
    process: { allowExecutables: [], inheritEnv: ['PATH'], maxOutputBytes: 262144, maxRuntimeMs: 600000 },
    multiNode: {
      enabled,
      controllerPrincipalId: 'openai-tunnel',
      controllerPrincipalType: 'openai-secure-mcp-tunnel',
      grants: [{
        id: 'build-to-vision',
        enabled: true,
        sourceNodeId: 'dev_source',
        destinationNodeId: 'dev_dest',
        sourceWorkspace: 'source',
        destinationWorkspace: 'dest',
        sourcePathPrefixes: ['project/approved'],
        destinationBasePaths: ['project/incoming'],
        allowedExtensions: ['.json', '.bin'],
        maxBytes: 1024 * 1024,
        transports: ['direct', 'relay']
      }]
    },
    legacyRemoteControl: { enabled: false }
  };
}

function intent(overrides: Partial<CrossNodeTransferIntent> = {}): CrossNodeTransferIntent {
  return {
    grantId: 'build-to-vision',
    sourceNodeId: 'dev_source',
    destinationNodeId: 'dev_dest',
    sourceWorkspace: 'source',
    destinationWorkspace: 'dest',
    sourcePath: 'project/approved/report.json',
    destinationBasePath: 'project/incoming',
    destinationFileName: 'report.json',
    size: 4096,
    sha256: 'a'.repeat(64),
    transport: 'relay',
    ...overrides
  };
}

async function fixture(identity: DeviceIdentity = sourceIdentity, enabled = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-multinode-auth-'));
  await fs.mkdir(path.join(root, 'source'), { recursive: true });
  await fs.mkdir(path.join(root, 'dest'), { recursive: true });
  const policy = new PolicyEngine(grantPolicy(root, enabled));
  const auditPath = path.join(root, 'audit.jsonl');
  const audit = new AuditLogger(auditPath);
  const auth = new MultiNodeAuthorization(policy, identity, audit);
  return { root, policy, auditPath, auth };
}

test('cross-node transfer is default-deny without explicit local owner enablement', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-multinode-default-'));
  try {
    await fs.mkdir(path.join(root, 'source'), { recursive: true });
    await fs.mkdir(path.join(root, 'dest'), { recursive: true });
    const config: PolicyConfig = {
      version: 1,
      mode: 'workspace',
      workspaces: [
        { id: 'source', root: path.join(root, 'source'), readOnly: false },
        { id: 'dest', root: path.join(root, 'dest'), readOnly: false }
      ],
      filesystem: { maxReadBytes: 1024, maxWriteBytes: 1024 },
      process: { allowExecutables: [], inheritEnv: [], maxOutputBytes: 1024, maxRuntimeMs: 1000 }
    };
    const auth = new MultiNodeAuthorization(
      new PolicyEngine(config),
      sourceIdentity,
      new AuditLogger(path.join(root, 'audit.jsonl'))
    );
    await assert.rejects(
      runAsPrincipal(securePrincipal(), () => auth.authorizeSource(intent())),
      /disabled by local owner policy/i
    );
    assert.equal(auth.status().enabled, false);
    assert.equal(auth.status().defaultDeny, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local or unauthenticated callers cannot use cross-node transfer even when a grant exists', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.auth.authorizeSource(intent()), /authenticated OpenAI Secure MCP Tunnel principal/i);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('full_control does not imply the dedicated cross-node scope', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      runAsPrincipal(securePrincipal(['workstation.full_control']), () => f.auth.authorizeSource(intent())),
      /dedicated 'workstation\.cross_node_transfer' scope/i
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('wrong authenticated principal cannot impersonate the ChatGPT control plane', async () => {
  const f = await fixture();
  try {
    const wrong: RequestPrincipal = {
      id: 'local-http-client',
      type: 'mcp-http',
      scopes: ['workstation.cross_node_transfer'],
      authenticated: true
    };
    await assert.rejects(
      runAsPrincipal(wrong, () => f.auth.authorizeSource(intent())),
      /owner-approved OpenAI Secure MCP Tunnel principal/i
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('source and destination independently authorize the same owner grant', async () => {
  const source = await fixture(sourceIdentity);
  const dest = await fixture(destinationIdentity);
  try {
    const sourceResult = await runAsPrincipal(securePrincipal(), () => source.auth.authorizeSource(intent()));
    const destinationResult = await runAsPrincipal(securePrincipal(), () => dest.auth.authorizeDestination(intent()));
    assert.equal(sourceResult.grantId, 'build-to-vision');
    assert.equal(sourceResult.localRole, 'source');
    assert.equal(destinationResult.localRole, 'destination');
    assert.equal(sourceResult.remoteNodeId, 'dev_dest');
    assert.equal(destinationResult.remoteNodeId, 'dev_source');
  } finally {
    await fs.rm(source.root, { recursive: true, force: true });
    await fs.rm(dest.root, { recursive: true, force: true });
  }
});

test('grant binds direction, workspaces, paths, extensions, size and transport', async () => {
  const f = await fixture();
  try {
    const cases: Array<[Partial<CrossNodeTransferIntent>, RegExp]> = [
      [{ sourceNodeId: 'dev_dest', destinationNodeId: 'dev_source' }, /Source node identity|node identities/i],
      [{ destinationWorkspace: 'source' }, /workspaces do not match/i],
      [{ sourcePath: 'project/secrets/report.json' }, /outside the prefixes/i],
      [{ destinationBasePath: 'project/other' }, /Destination base path/i],
      [{ destinationFileName: 'payload.exe' }, /Destination file extension/i],
      [{ sourcePath: 'project/approved/payload.exe' }, /Source file extension/i],
      [{ size: 2 * 1024 * 1024 }, /exceeds grant/i],
      [{ transport: 'direct', grantId: 'missing-grant' }, /not enabled/i]
    ];
    for (const [change, expected] of cases) {
      await assert.rejects(
        runAsPrincipal(securePrincipal(), () => f.auth.authorizeSource(intent(change))),
        expected
      );
    }

    f.policy.config.multiNode!.grants[0]!.transports = ['relay'];
    await assert.rejects(
      runAsPrincipal(securePrincipal(), () => f.auth.authorizeSource(intent({ transport: 'direct' }))),
      /transport 'direct' is not allowed/i
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('revoking a grant takes effect on the next authorization check', async () => {
  const f = await fixture();
  try {
    const allowed = await runAsPrincipal(securePrincipal(), () => f.auth.authorizeSource(intent()));
    assert.equal(allowed.grantId, 'build-to-vision');

    f.policy.config.multiNode!.grants[0]!.enabled = false;
    await assert.rejects(
      runAsPrincipal(securePrincipal(), () => f.auth.authorizeSource(intent())),
      /not enabled/i
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('cross-node authorization writes explicit allow and deny security audit events', async () => {
  const f = await fixture();
  try {
    await runAsPrincipal(securePrincipal(), () => f.auth.authorizeSource(intent()));
    await assert.rejects(
      runAsPrincipal(securePrincipal(), () => f.auth.authorizeSource(intent({ sourcePath: 'project/private/secret.json' }))),
      /outside the prefixes/i
    );
    const lines = (await fs.readFile(f.auditPath, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].event, 'multi_node.transfer_authorization');
    assert.equal(lines[0].ok, true);
    assert.equal(lines[0].details.grantId, 'build-to-vision');
    assert.equal(lines[1].ok, false);
    assert.equal(lines[1].details.sourcePath, 'project/private/secret.json');
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});


test('Work Session identity cannot create or widen cross-node authority', async () => {
  const f = await fixture();
  const sessionId = '11111111-1111-4111-8111-111111111111';
  try {
    await assert.rejects(
      runAsPrincipal(
        securePrincipal(['workstation.full_control']),
        () => runWithWorkSession(sessionId, () => f.auth.authorizeSource(intent()))
      ),
      /dedicated 'workstation\.cross_node_transfer' scope/i
    );

    const allowed = await runAsPrincipal(
      securePrincipal(['workstation.cross_node_transfer']),
      () => runWithWorkSession(sessionId, () => f.auth.authorizeSource(intent()))
    );
    assert.equal(allowed.grantId, 'build-to-vision');
    assert.equal(allowed.localRole, 'source');
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
