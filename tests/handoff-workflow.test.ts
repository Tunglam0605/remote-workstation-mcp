import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHandoffWorkflowContributions } from '../src/adapters/engineering/handoff-workflows.js';
import { packageHandoff } from '../src/adapters/engineering/handoff-package.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';
import { UltimateConsentManager } from '../src/security/ultimate-consent.js';
import { UltimateActionPolicy } from '../src/security/ultimate-action-policy.js';
import { runAsPrincipal } from '../src/security/request-principal.js';
import { CrossNodeReceiptLedger } from '../src/security/cross-node-receipt-ledger.js';
import { OwnerHandoffBuildProfiles } from '../src/adapters/engineering/handoff-trusted-preflight.js';

test('typed handoff contribution refuses inactive Ultimate then packages using exact permitted workspace', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-handoff-workflow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(path.join(workspace, 'out'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'source.c'), 'int a;\n');
  const policy = new PolicyEngine({
    version: 1, mode: 'workspace', workspaces: [{ id: 'projects', root: workspace, readOnly: false }],
    filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
    process: { allowExecutables: [], inheritEnv: [], maxOutputBytes: 1024, maxRuntimeMs: 60000 }
  });
  const epochPath = path.join(root, 'epoch');
  await fs.writeFile(epochPath, JSON.stringify({ epoch: 'runtime-1' }));
  const consent = new UltimateConsentManager({ epochPath, filePath: path.join(root, 'consent') });
  const actions = new UltimateActionPolicy(consent, policy, 'windows');
  const handoff = createHandoffWorkflowContributions({ paths: new PathGuard(policy), actions, nodeId: 'windows', receipts: new CrossNodeReceiptLedger(), multiNodeAuthorization: { authorizeDestination: async () => { throw new Error('No authorized transfer grant'); } } as never });
  const contribution = handoff.find(item => item.id === 'platform.handoff_package')!;
  const context = {
    workspace: 'projects', projectPath: '.',
    parameters: {
      handoffFiles: ['source.c'], handoffOutputRelativePath: 'out/project.zip',
      handoffJobId: 'test-job', handoffProjectId: 'laser', handoffSourceRevision: 'abc123',
      handoffRole: 'source', handoffDestinationNodeId: 'ssd', handoffDestinationWorkspace: 'incoming',
      handoffCreatedAt: '2026-10-24T03:00:00Z'
    }
  };
  const principal = { id: 'openai-tunnel', type: 'openai-secure-mcp-tunnel', scopes: ['workstation.write', 'workstation.execute'], authenticated: true as const };
  await assert.rejects(runAsPrincipal(principal, () => contribution.plan(context)), /Ultimate|inactive|expired/i);
  await consent.activate({ nodeId: 'windows', principalId: 'openai-tunnel', durationMinutes: 30, scope: { operations: ['workspace_add'], workspaces: ['projects'], profileIds: [], transferGrantIds: [] } });
  const plan = await runAsPrincipal(principal, () => contribution.plan(context));
  const run = await runAsPrincipal(principal, () => contribution.run({ ...context, plan }));
  assert.equal(run.status, 'succeeded');
  assert.ok((await fs.stat(path.join(workspace, 'out', 'project.zip'))).isFile());
  await consent.revoke();
  await assert.rejects(runAsPrincipal(principal, () => contribution.run({ ...context, plan })), /Ultimate|inactive|expired/i);
});

test('accept workflow binds import base to receiver grant and rejects revoked destination authorization', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-handoff-receive-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'ssd'); const destination = path.join(root, 'win');
  await fs.mkdir(path.join(source, 'exports'), { recursive: true });
  await fs.mkdir(path.join(destination, 'incoming', '.rwmcp', 'transfers', 'verified'), { recursive: true });
  await fs.writeFile(path.join(source, 'a.c'), 'int x;');
  const packed = await packageHandoff({ workspaceRoot: source, projectRelativePath: '.', outputRelativePath: 'exports/source.zip', includedFiles: ['a.c'],
    manifestDraft: { schemaVersion: 1, jobId: 'job-1', sourceNodeId: 'ssd', destinationNodeId: 'windows', sourceWorkspace: 'sources', destinationWorkspace: 'projects', projectId: 'f4', sourceRevision: 'rev1', role: 'source', toolchainProfileId: 'trusted-f4', createdAt: '2026-10-24T02:00:00Z' } });
  const verifiedName = `${packed.sha256}-source.zip`;
  const verifiedDir = path.join(destination, 'incoming', '.rwmcp', 'transfers', 'verified');
  await fs.copyFile(path.join(source, packed.relativePath), path.join(verifiedDir, verifiedName));
  await fs.writeFile(path.join(verifiedDir, `${verifiedName}.manifest.json`), JSON.stringify({ schemaVersion: 1, file: 'source.zip', sha256: packed.sha256, size: packed.bytes, verifiedPath: `.rwmcp/transfers/verified/${verifiedName}` }));
  const epochPath = path.join(root, 'epoch'); await fs.writeFile(epochPath, JSON.stringify({ epoch: 'runtime-2' }));
  const consent = new UltimateConsentManager({ epochPath, filePath: path.join(root, 'consent') });
  const policy = new PolicyEngine({ version: 1, mode: 'workspace', workspaces: [{ id: 'projects', root: destination, readOnly: false }],
    engineering: { enabled: true, maxCommandRuntimeMs: 60000, allowHardwareMutationInWorkspace: false, allowSerialWriteInWorkspace: false },
    filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
    process: { allowExecutables: [], inheritEnv: [], maxOutputBytes: 1024, maxRuntimeMs: 60000 } });
  await consent.activate({ nodeId: 'windows', principalId: 'openai-tunnel', durationMinutes: 30, scope: { operations: ['workspace_add', 'build'], workspaces: ['projects'], profileIds: ['trusted-f4'], transferGrantIds: [] } });
  let grantLive = true; let checked = 0;
  const receipts = new CrossNodeReceiptLedger();
  const trustedProfilesPath = path.join(root, 'owner-build-profiles.json');
  await fs.writeFile(trustedProfilesPath, JSON.stringify({ schemaVersion: 1, profiles: [
    { id: 'trusted-f4', projectId: 'f4', target: 'STM32F407', sourceNodeId: 'ssd', sourceRevision: 'rev1', destinationWorkspace: 'projects', allowed: true }
  ] }), { mode: 0o600 });
  const verifiedPath = `.rwmcp/transfers/verified/${verifiedName}`;
  const authorization = {
    grantId: 'ssd-to-win', sourceNodeId: 'ssd', destinationNodeId: 'windows',
    sourceWorkspace: 'sources', destinationWorkspace: 'projects', sourcePath: 'exports/source.zip',
    destinationBasePath: 'incoming', destinationFileName: 'source.zip', size: packed.bytes,
    sha256: packed.sha256, transport: 'relay' as const
  };
  const workflows = createHandoffWorkflowContributions({ nodeId: 'windows', paths: new PathGuard(policy), actions: new UltimateActionPolicy(consent, policy, 'windows'),
    receipts, ownerBuildProfiles: new OwnerHandoffBuildProfiles(trustedProfilesPath),
    multiNodeAuthorization: { authorizeDestination: async intent => {
      checked++; assert.equal(intent.destinationBasePath, 'incoming'); assert.equal(intent.destinationWorkspace, 'projects');
      if (!grantLive) throw new Error('Bilateral destination grant revoked');
      return {} as never;
    } }
  });
  const accept = workflows.find(item => item.id === 'platform.handoff_accept')!;
  const context = { workspace: 'projects', projectPath: '.', parameters: {
    handoffJobId: 'job-1', handoffProjectId: 'f4', handoffRole: 'source', handoffSourceNodeId: 'ssd',
    handoffArchiveRelativePath: `incoming/.rwmcp/transfers/verified/${verifiedName}`,
    handoffDestinationRelativeBase: 'incoming', handoffExpectedSha256: packed.sha256,
    sourceWorkspace: 'sources', sourcePath: 'exports/source.zip', transferGrantId: 'ssd-to-win', handoffTransport: 'relay'
  } };
  const principal = { id: 'openai-tunnel', type: 'openai-secure-mcp-tunnel', scopes: ['workstation.write', 'workstation.execute', 'workstation.cross_node_transfer'], authenticated: true as const };
  await assert.rejects(runAsPrincipal(principal, () => accept.plan({ ...context, parameters: { ...context.parameters, handoffDestinationRelativeBase: 'different' } })), /granted|base/i);
  await assert.rejects(runAsPrincipal(principal, () => accept.plan(context)), /receipt|sidecar/i);
  receipts.recordReceived({ authorization, verifiedPath });
  const plan = await runAsPrincipal(principal, () => accept.plan(context));
  grantLive = false;
  await assert.rejects(runAsPrincipal(principal, () => accept.run({ ...context, plan })), /grant revoked/i);
  await assert.rejects(fs.stat(path.join(destination, 'incoming', 'f4-source-job-1')), /ENOENT/);
  grantLive = true;
  const done = await runAsPrincipal(principal, () => accept.run({ ...context, plan }));
  assert.equal(done.status, 'succeeded');
  assert.ok(checked >= 3);
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(destination, 'incoming', 'f4-source-job-1', 'a.c'))).digest('hex'), packed.manifest.files[0]?.sha256);
  const preflight = workflows.find(item => item.id === 'platform.handoff_build_preflight')!;
  const buildContext = { workspace: 'projects', projectPath: '.', parameters: {
    handoffAcceptedRelativePath: done.outputs?.acceptedPath as string,
    handoffProfileId: 'trusted-f4', handoffTarget: 'STM32F407'
  } };
  const buildPlan = await runAsPrincipal(principal, () => preflight.plan(buildContext));
  const buildResult = await runAsPrincipal(principal, () => preflight.run({ ...buildContext, plan: buildPlan }));
  assert.equal(buildResult.status, 'succeeded');
  assert.equal(buildResult.outputs?.profileId, 'trusted-f4');
  await fs.mkdir(path.join(destination, 'incoming', 'forged'));
  await fs.cp(path.join(destination, 'incoming', 'f4-source-job-1'), path.join(destination, 'incoming', 'forged', 'f4-source-job-1'), { recursive: true });
  await assert.rejects(runAsPrincipal(principal, () => preflight.run({ ...buildContext,
    parameters: { ...buildContext.parameters, handoffAcceptedRelativePath: 'incoming/forged/f4-source-job-1' }, plan: buildPlan })), /provenance|receipt/i);
  await fs.writeFile(path.join(destination, 'incoming', 'f4-source-job-1', 'a.c'), 'tampered');
  await assert.rejects(runAsPrincipal(principal, () => preflight.run({ ...buildContext, plan: buildPlan })), /checksum|changed|modified/i);
});
