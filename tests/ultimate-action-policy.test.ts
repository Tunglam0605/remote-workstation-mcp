import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { UltimateConsentManager } from '../src/security/ultimate-consent.js';
import { UltimateActionPolicy } from '../src/security/ultimate-action-policy.js';
import { runAsPrincipal, type RequestPrincipal } from '../src/security/request-principal.js';

function principal(scopes = ['workstation.read', 'workstation.write', 'workstation.execute', 'workstation.cross_node_transfer']): RequestPrincipal {
  return { id: 'openai-tunnel', type: 'openai-secure-mcp-tunnel', scopes, authenticated: true };
}

async function fixture(t: test.TestContext, mode: PolicyConfig['mode'] = 'workspace') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-ultimate-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const epochPath = path.join(root, 'epoch.json');
  await fs.writeFile(epochPath, JSON.stringify({ epoch: 'runtime-A' }));
  const consent = new UltimateConsentManager({ filePath: path.join(root, 'consent.json'), epochPath });
  await consent.activate({
    nodeId: 'dev_windows', principalId: 'openai-tunnel', durationMinutes: 30,
    scope: {
      operations: ['build', 'transfer', 'workspace_add', 'artifact_verify'],
      workspaces: ['stm32'], profileIds: ['keil-release'], transferGrantIds: ['ssd-to-windows'],
      workSessionId: 'work-a'
    }
  });
  const policyConfig: PolicyConfig = {
    version: 1, mode,
    workspaces: [{ id: 'stm32', root: path.join(root, 'stm32'), readOnly: false }],
    filesystem: { maxReadBytes: 1024, maxWriteBytes: 1024 },
    process: { allowExecutables: ['cmake'], inheritEnv: [], maxOutputBytes: 1024, maxRuntimeMs: 60000 },
    engineering: { enabled: true },
    multiNode: {
      enabled: true, controllerPrincipalId: 'openai-tunnel', controllerPrincipalType: 'openai-secure-mcp-tunnel',
      grants: []
    }
  };
  const gateway = new UltimateActionPolicy(consent, new PolicyEngine(policyConfig), 'dev_windows');
  return { consent, gateway };
}

const build = {
  operation: 'build' as const,
  workspaceId: 'stm32',
  profileId: 'keil-release',
  workSessionId: 'work-a'
};

test('typed build checks actual authenticated tunnel principal and owner scope', async t => {
  const { gateway } = await fixture(t);
  await runAsPrincipal(principal(), () => gateway.assert(build));
  await assert.rejects(gateway.assert(build), /authenticated|principal/i);
  await assert.rejects(
    runAsPrincipal(principal(['workstation.read']), () => gateway.assert(build)),
    /scope|execute/i
  );
  await assert.rejects(
    runAsPrincipal({ ...principal(), type: 'mcp-http' }, () => gateway.assert(build)),
    /tunnel|principal/i
  );
  await assert.rejects(
    runAsPrincipal(principal(), () => gateway.assert({ ...build, workSessionId: 'work-b' })),
    /denied|scope/i
  );
});

test('read-only and disabled engineering policy cannot be widened by active Ultimate consent', async t => {
  const { gateway } = await fixture(t, 'read_only');
  await assert.rejects(
    runAsPrincipal(principal(), () => gateway.assert(build)),
    /read_only|disabled/i
  );
});

test('cross-node transfer requires exact dedicated scope and local multi-node enablement', async t => {
  const { gateway } = await fixture(t);
  const transfer = {
    operation: 'transfer' as const, workspaceId: 'stm32',
    grantId: 'ssd-to-windows', workSessionId: 'work-a'
  };
  await runAsPrincipal(principal(), () => gateway.assert(transfer));
  await assert.rejects(
    runAsPrincipal(principal(['workstation.read', 'workstation.write', 'workstation.execute', 'workstation.full_control']),
      () => gateway.assert(transfer)),
    /cross_node_transfer|scope/i
  );
  await assert.rejects(
    runAsPrincipal(principal(), () => gateway.assert({ ...transfer, grantId: 'other' })),
    /denied|scope/i
  );
});

test('unknown operations such as generic shell, Administrator or hardware mutation fail closed', async t => {
  const { gateway } = await fixture(t);
  for (const operation of ['shell', 'admin', 'flash', 'erase']) {
    await assert.rejects(
      runAsPrincipal(principal(), () => gateway.assert({ ...build, operation: operation as 'build' })),
      /denied|scope|unsupported/i
    );
  }
});
