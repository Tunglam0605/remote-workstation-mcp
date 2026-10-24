import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import type { MultiNodeAuthorization } from '../../security/multi-node-authorization.js';
import type { CrossNodeReceiptLedger } from '../../security/cross-node-receipt-ledger.js';
import type { UltimateActionPolicy } from '../../security/ultimate-action-policy.js';
import { currentWorkSessionId } from '../../security/execution-context.js';
import type { PathGuard } from '../../security/path-guard.js';
import { acceptHandoff, packageHandoff } from './handoff-package.js';
import { validateHandoffPath } from './handoff-manifest.js';
import type { EngineeringWorkflowContribution } from './workflow-contribution.js';
import { OwnerHandoffBuildProfiles, verifyAcceptedSourceSnapshot } from './handoff-trusted-preflight.js';
import { validateHandoffBuildIntent } from './handoff-build-preflight.js';

const identifier = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const relative = z.string().min(1).max(512).superRefine((value, ctx) => {
  try { validateHandoffPath(value); } catch { ctx.addIssue({ code: 'custom', message: 'Portable relative path required.' }); }
});
const base = z.object({
  handoffJobId: identifier,
  handoffProjectId: identifier,
  handoffRole: z.enum(['source', 'build_artifacts'])
});
const packageParameters = base.extend({
  handoffFiles: z.array(relative).min(1).max(2048),
  handoffOutputRelativePath: relative,
  handoffSourceRevision: z.string().min(1).max(200),
  handoffDestinationNodeId: identifier,
  handoffDestinationWorkspace: identifier,
  handoffCreatedAt: z.iso.datetime({ offset: true }),
  handoffProfileId: identifier.optional()
});
const acceptParameters = base.extend({
  handoffArchiveRelativePath: relative,
  handoffDestinationRelativeBase: relative,
  handoffExpectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  handoffSourceNodeId: identifier,
  sourceWorkspace: identifier,
  sourcePath: relative,
  transferGrantId: identifier,
  handoffTransport: z.enum(['direct', 'relay'])
});
const buildPreflightParameters = z.object({
  handoffAcceptedRelativePath: relative,
  handoffProfileId: identifier,
  handoffTarget: z.string().min(1).max(160)
}).strict();

export function createHandoffWorkflowContributions(deps: {
  paths: PathGuard;
  actions: UltimateActionPolicy;
  nodeId: string;
  multiNodeAuthorization: Pick<MultiNodeAuthorization, 'authorizeDestination'>;
  receipts: CrossNodeReceiptLedger;
  ownerBuildProfiles?: OwnerHandoffBuildProfiles;
}): EngineeringWorkflowContribution[] {
  async function authorize(workspace: string) {
    await deps.actions.assert({
      operation: 'workspace_add', workspaceId: workspace, workSessionId: currentWorkSessionId()
    });
    return await deps.paths.resolveExisting(workspace, '.');
  }
  async function authorizeReceivedArchive(workspace: string, input: z.infer<typeof acceptParameters>, archiveSha: string, archiveBytes: number) {
    await authorize(workspace);
    const relative = input.handoffArchiveRelativePath;
    const verifiedSuffix = '/.rwmcp/transfers/verified/';
    const separator = relative.indexOf(verifiedSuffix);
    if (separator <= 0) throw new Error('Handoff acceptance requires a verified data-plane receipt path, not an arbitrary ZIP.');
    const receiveBase = relative.slice(0, separator);
    if (input.handoffDestinationRelativeBase !== receiveBase) {
      throw new Error('Handoff import base must equal the exact owner-granted receive base.');
    }
    const verifiedRelative = relative.slice(separator + 1);
    const verifiedName = path.posix.basename(relative);
    if (!verifiedName.startsWith(`${archiveSha}-`) || !verifiedName.endsWith('.zip')) {
      throw new Error('Handoff archive filename must bind to its verified SHA-256 receipt.');
    }
    const manifestPath = await deps.paths.resolveExisting(workspace, `${relative}.manifest.json`);
    const receipt = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      schemaVersion?: unknown; file?: unknown; sha256?: unknown; size?: unknown; verifiedPath?: unknown;
    };
    if (receipt.schemaVersion !== 1 || receipt.sha256 !== archiveSha || receipt.size !== archiveBytes ||
        receipt.verifiedPath !== verifiedRelative || typeof receipt.file !== 'string' ||
        `${archiveSha}-${receipt.file}` !== verifiedName) {
      throw new Error('Handoff requires a matching verified local data-plane receipt.');
    }
    const authorization = {
      grantId: input.transferGrantId,
      sourceNodeId: input.handoffSourceNodeId,
      destinationNodeId: deps.nodeId,
      sourceWorkspace: input.sourceWorkspace,
      destinationWorkspace: workspace,
      sourcePath: input.sourcePath,
      destinationBasePath: receiveBase,
      destinationFileName: receipt.file,
      size: archiveBytes,
      sha256: archiveSha,
      transport: input.handoffTransport
    };
    const approved = await deps.multiNodeAuthorization.authorizeDestination(authorization);
    deps.receipts.assertReceived({ authorization, verifiedPath: verifiedRelative });
    return approved;
  }
  async function checkTrustedBuild(workspace: string, input: z.infer<typeof buildPreflightParameters>) {
    await deps.actions.assert({ operation: 'build', workspaceId: workspace,
      profileId: input.handoffProfileId, workSessionId: currentWorkSessionId() });
    if (!deps.ownerBuildProfiles) throw new Error('Receiver-local owner build profile registry is unavailable.');
    const root = await deps.paths.resolveExisting(workspace, '.');
    const manifest = await verifyAcceptedSourceSnapshot(root, input.handoffAcceptedRelativePath);
    deps.receipts.assertImported({ workspace, acceptedPath: input.handoffAcceptedRelativePath, manifest });
    const profiles = await deps.ownerBuildProfiles.load();
    return validateHandoffBuildIntent({
      manifest, localNodeId: deps.nodeId, workspaceId: workspace,
      requestedProfileId: input.handoffProfileId, requestedTarget: input.handoffTarget,
      sourceRevision: manifest.sourceRevision, cleanSnapshot: true, buildHooks: [], ownerProfiles: profiles
    });
  }
  const pack: EngineeringWorkflowContribution = {
    id: 'platform.handoff_package',
    description: 'Package an explicit source/artifact file list into a deterministic SHA-256 ZIP manifest. Requires scoped Ultimate and writable owner workspace.',
    destructive: false,
    async plan({ workspace, projectPath, parameters }) {
      const input = packageParameters.parse(parameters);
      await authorize(workspace);
      const project = projectPath === '.' ? '.' : validateHandoffPath(projectPath);
      const output = input.handoffOutputRelativePath;
      return { steps: ['ultimate.check', 'handoff.pack.sha256', 'handoff.archive.atomic'], workspace, project, output, fileCount: input.handoffFiles.length };
    },
    async run({ workspace, projectPath, parameters }) {
      const input = packageParameters.parse(parameters);
      const root = await authorize(workspace);
      const started = Date.now();
      const output = await packageHandoff({
        workspaceRoot: root,
        projectRelativePath: projectPath,
        outputRelativePath: input.handoffOutputRelativePath,
        includedFiles: input.handoffFiles,
        manifestDraft: {
          schemaVersion: 1,
          jobId: input.handoffJobId,
          sourceNodeId: deps.nodeId,
          destinationNodeId: input.handoffDestinationNodeId,
          sourceWorkspace: workspace,
          destinationWorkspace: input.handoffDestinationWorkspace,
          projectId: input.handoffProjectId,
          sourceRevision: input.handoffSourceRevision,
          role: input.handoffRole,
          createdAt: input.handoffCreatedAt,
          ...(input.handoffProfileId ? { toolchainProfileId: input.handoffProfileId } : {})
        }
      });
      return { status: 'succeeded', steps: [{ id: 'handoff.package', status: 'succeeded', durationMs: Date.now() - started, result: output }], outputs: output };
    }
  };

  const accept: EngineeringWorkflowContribution = {
    id: 'platform.handoff_accept',
    description: 'Verify a SHA-256 handoff ZIP and exact node/workspace/job/role manifest before atomic fail-if-exists import. Requires scoped Ultimate.',
    destructive: false,
    async plan({ workspace, parameters }) {
      const input = acceptParameters.parse(parameters);
      await authorize(workspace);
      const archive = await deps.paths.resolveExisting(workspace, input.handoffArchiveRelativePath);
      const expectedSize = (await fs.stat(archive)).size;
      await authorizeReceivedArchive(workspace, input, input.handoffExpectedSha256, expectedSize);
      return { steps: ['ultimate.check', 'handoff.grant.verify', 'handoff.verify.sha256', 'handoff.import.atomic'], workspace, role: input.handoffRole, jobId: input.handoffJobId };
    },
    async run({ workspace, parameters }) {
      const input = acceptParameters.parse(parameters);
      const root = await authorize(workspace);
      const started = Date.now();
      const output = await acceptHandoff({
        workspaceRoot: root,
        archiveRelativePath: input.handoffArchiveRelativePath,
        expectedSha256: input.handoffExpectedSha256,
        destinationRelativeBase: input.handoffDestinationRelativeBase,
        expectedRole: input.handoffRole,
        expectedDestinationNodeId: deps.nodeId,
        expectedDestinationWorkspace: workspace,
        expectedSourceNodeId: input.handoffSourceNodeId,
        expectedProjectId: input.handoffProjectId,
        expectedJobId: input.handoffJobId,
        beforePromote: async validated => {
          if (validated.manifest.sourceWorkspace !== input.sourceWorkspace) {
            throw new Error('Handoff manifest source workspace does not match authorized grant.');
          }
          await authorizeReceivedArchive(workspace, input, validated.sha256, validated.bytes);
        }
      });
      deps.receipts.recordImported({ workspace, acceptedPath: output.acceptedPath, manifest: output.manifest });
      return { status: 'succeeded', steps: [{ id: 'handoff.accept', status: 'succeeded', durationMs: Date.now() - started, result: output }], outputs: output };
    }
  };
  const buildPreflight: EngineeringWorkflowContribution = {
    id: 'platform.handoff_build_preflight',
    description: 'Rehash a received source snapshot and check receiver-local owner-approved STM32 build profile; never runs a compiler or downloaded hooks.',
    destructive: false,
    async plan({ workspace, parameters }) {
      const input = buildPreflightParameters.parse(parameters);
      await checkTrustedBuild(workspace, input);
      return { workspace, acceptedPath: input.handoffAcceptedRelativePath, profileId: input.handoffProfileId,
        steps: ['ultimate.build.check', 'handoff.receipt.provenance', 'handoff.rehash', 'owner.profile.validate'] };
    },
    async run({ workspace, parameters }) {
      const input = buildPreflightParameters.parse(parameters);
      const started = Date.now();
      const result = await checkTrustedBuild(workspace, input);
      await deps.actions.assert({ operation: 'build', workspaceId: workspace,
        profileId: input.handoffProfileId, workSessionId: currentWorkSessionId() });
      return { status: 'succeeded', steps: [{ id: 'handoff.build_preflight', status: 'succeeded',
        durationMs: Date.now() - started, result }], outputs: { ...result, acceptedPath: input.handoffAcceptedRelativePath } };
    }
  };
  return [pack, accept, buildPreflight];
}
