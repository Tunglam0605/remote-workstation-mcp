import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EngineeringResourceManager } from '../../adapters/engineering/resource-manager.js';
import type { WindowsSemanticUiAdapter, WindowsUiLocator } from '../../adapters/windows-semantic-ui.js';
import type { PathGuard } from '../../security/path-guard.js';
import type { CapCutDraftAdapter } from './capcut-draft.js';
import type { CapCutExportProfile, CapCutExportProfileStore } from './capcut-export-profile.js';
import type { MediaVideoAdapter } from './media-adapter.js';

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function sha256File(filename: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filename);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

function stablePlanDigest(value: Record<string, unknown>): string {
  return sha256Text(JSON.stringify(value));
}

function dynamicProjectLocator(profile: CapCutExportProfile, draftName: string): WindowsUiLocator {
  return {
    ...(profile.activeProject.automationId ? { automationId: profile.activeProject.automationId } : {}),
    names: [draftName],
    controlType: profile.activeProject.controlType,
    ...(profile.activeProject.className ? { className: profile.activeProject.className } : {})
  };
}

function absentSemanticElement(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UIA_ELEMENT_NOT_FOUND|UIA_ELEMENT_TIMEOUT/i.test(message);
}

export interface CapCutExportPlan {
  ready: boolean;
  blockers: string[];
  workspace: string;
  projectPath: string;
  capcutProjectId: string;
  draftName: string;
  draftSha256: string;
  output: string;
  profileId: string;
  profileDigest: string;
  capcutVersion?: string;
  plannedWithRunningProject: boolean;
  planSha256: string;
}

export class CapCutNativeExportAdapter {
  constructor(
    private readonly paths: PathGuard,
    private readonly resources: EngineeringResourceManager,
    private readonly drafts: CapCutDraftAdapter,
    private readonly ui: WindowsSemanticUiAdapter,
    private readonly profiles: CapCutExportProfileStore,
    private readonly media: MediaVideoAdapter
  ) {}

  async listProfiles() {
    return await this.profiles.publicList();
  }

  private async resolveOutput(workspace: string, projectPath: string, output: string) {
    if (!output || output.length > 1024 || output.includes('\0')) throw new Error('CapCut export output is invalid.');
    if (path.isAbsolute(output)) throw new Error('CapCut export output must be relative to the selected project root.');
    if (path.extname(output).toLowerCase() !== '.mp4') throw new Error('CapCut native export output must use .mp4.');
    const projectRoot = await this.paths.resolveExisting(workspace, projectPath);
    const outputAbsolute = await this.paths.resolveForWrite(workspace, path.join(projectPath, output));
    const parentReal = await fs.realpath(path.dirname(outputAbsolute));
    if (!inside(projectRoot, parentReal)) throw new Error('CapCut export output parent escapes the selected project.');
    const existing = await fs.lstat(outputAbsolute).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) throw new Error('CapCut export output already exists; native export never overwrites.');
    return { projectRoot, outputAbsolute };
  }

  private async installationAndProfile(profileId: string) {
    const [installation, profile] = await Promise.all([
      this.drafts.installationInfo(),
      this.profiles.get(profileId)
    ]);
    if (installation.platform !== 'win32') throw new Error('CAPCUT_EXPORT_UNAVAILABLE: native semantic export is Windows-only.');
    if (!installation.executable || !installation.version) throw new Error('CAPCUT_EXPORT_UNAVAILABLE: CapCut desktop installation/version is unavailable.');
    if (profile.appVersion !== installation.version) {
      throw new Error(`CAPCUT_EXPORT_PROFILE_MISMATCH: profile ${profile.id} is for ${profile.appVersion}, installed CapCut is ${installation.version}.`);
    }
    return { installation, profile, profileDigest: this.profiles.digest(profile) };
  }

  private async activeProcess(
    executable: string,
    profile: CapCutExportProfile,
    draftName: string
  ): Promise<number | undefined> {
    const windows = await this.ui.windows(executable);
    const processIds = [...new Set(windows.windows.map(item => item.processId).filter(item => item > 0))].slice(0, 16);
    const locator = dynamicProjectLocator(profile, draftName);
    const matches: number[] = [];
    for (const processId of processIds) {
      try {
        await this.ui.wait(executable, processId, locator, 200);
        matches.push(processId);
      } catch (error) {
        if (!absentSemanticElement(error)) throw error;
      }
    }
    if (matches.length > 1) throw new Error('CAPCUT_EXPORT_AMBIGUOUS: multiple CapCut processes expose the requested active project.');
    return matches[0];
  }

  private async blockerCode(
    executable: string,
    processId: number,
    profile: CapCutExportProfile,
    stage: 'editor' | 'dialog'
  ): Promise<string | undefined> {
    for (const blocker of profile.blockers.filter(item => item.stage === stage)) {
      try {
        await this.ui.wait(executable, processId, blocker.locator as WindowsUiLocator, 100);
        return blocker.code;
      } catch (error) {
        if (!absentSemanticElement(error)) throw error;
      }
    }
    return undefined;
  }

  private planPayload(input: Omit<CapCutExportPlan, 'planSha256'>) {
    return {
      ready: input.ready,
      blockers: [...input.blockers],
      workspace: input.workspace,
      projectPath: input.projectPath,
      capcutProjectId: input.capcutProjectId,
      draftName: input.draftName,
      draftSha256: input.draftSha256,
      output: input.output,
      profileId: input.profileId,
      profileDigest: input.profileDigest,
      capcutVersion: input.capcutVersion,
      plannedWithRunningProject: input.plannedWithRunningProject
    };
  }

  async plan(
    workspace: string,
    projectPath: string,
    capcutProjectId: string,
    profileId: string,
    output: string
  ): Promise<CapCutExportPlan> {
    await this.resolveOutput(workspace, projectPath, output);
    const identity = await this.drafts.projectIdentity(capcutProjectId);
    const blockers: string[] = [];
    if (!identity.mirrorConsistent) blockers.push('draft-mirrors-diverge');
    const { installation, profile, profileDigest } = await this.installationAndProfile(profileId);

    let processId: number | undefined;
    try {
      processId = await this.activeProcess(installation.executable!, profile, identity.draftName);
      if (!processId) blockers.push('project-not-open-in-capcut');
      if (processId) {
        const blocked = await this.blockerCode(installation.executable!, processId, profile, 'editor');
        if (blocked) blockers.push(blocked);
        try {
          const target = await this.ui.wait(installation.executable!, processId, profile.editorExportButton as WindowsUiLocator, 500);
          if (!target.element.patterns.some(item => /InvokePattern/i.test(item))) blockers.push('export-control-not-invokable');
        } catch (error) {
          if (absentSemanticElement(error)) blockers.push('export-control-not-found');
          else throw error;
        }
      }
    } catch (error) {
      blockers.push(error instanceof Error ? error.message.slice(0, 256) : String(error).slice(0, 256));
    }

    const base: Omit<CapCutExportPlan, 'planSha256'> = {
      ready: blockers.length === 0,
      blockers,
      workspace,
      projectPath,
      capcutProjectId: identity.projectId,
      draftName: identity.draftName,
      draftSha256: identity.sha256,
      output,
      profileId: profile.id,
      profileDigest,
      capcutVersion: installation.version,
      plannedWithRunningProject: Boolean(processId)
    };
    return { ...base, planSha256: stablePlanDigest(this.planPayload(base)) };
  }

  private async revalidatePlan(plan: CapCutExportPlan, expectedPlanSha256: string) {
    if (!/^[a-f0-9]{64}$/i.test(expectedPlanSha256)) throw new Error('expectedPlanSha256 must be a SHA-256 digest.');
    if (plan.planSha256 !== expectedPlanSha256.toLowerCase()) {
      throw new Error('CONFLICT: CapCut export plan changed since review.');
    }
    if (!plan.ready) throw new Error(`CAPCUT_EXPORT_NOT_READY: ${plan.blockers.join(', ')}`);
  }

  async export(
    workspace: string,
    projectPath: string,
    capcutProjectId: string,
    profileId: string,
    output: string,
    expectedPlanSha256: string,
    timeoutMs = 600_000
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 900_000) {
      throw new Error('CapCut native export timeoutMs must be 10000..900000.');
    }
    const resourceId = `capcut-export:${capcutProjectId}`;
    return await this.resources.withLease(resourceId, 'orchestrating', async () => {
      const currentPlan = await this.plan(workspace, projectPath, capcutProjectId, profileId, output);
      await this.revalidatePlan(currentPlan, expectedPlanSha256);
      const { outputAbsolute } = await this.resolveOutput(workspace, projectPath, output);
      const identity = await this.drafts.projectIdentity(capcutProjectId);
      if (identity.sha256 !== currentPlan.draftSha256) throw new Error('CONFLICT: CapCut draft changed after export planning.');
      const { installation, profile, profileDigest } = await this.installationAndProfile(profileId);
      if (profileDigest !== currentPlan.profileDigest) throw new Error('CONFLICT: CapCut export profile changed after planning.');

      const executable = installation.executable!;
      const processId = await this.activeProcess(executable, profile, identity.draftName);
      if (!processId) throw new Error('CAPCUT_EXPORT_NOT_READY: planned project is no longer open in CapCut.');
      const editorBlocked = await this.blockerCode(executable, processId, profile, 'editor');
      if (editorBlocked) throw new Error(`CAPCUT_EXPORT_BLOCKED: ${editorBlocked}`);

      let exportStarted = false;
      let accepted = false;
      let cancelAttempted = false;
      try {
        await this.ui.invoke(executable, processId, profile.editorExportButton as WindowsUiLocator, 5_000);
        const dialogBlocked = await this.blockerCode(executable, processId, profile, 'dialog');
        if (dialogBlocked) throw new Error(`CAPCUT_EXPORT_BLOCKED: ${dialogBlocked}`);

        if (profile.output.mode === 'full-path') {
          await this.ui.setValue(executable, processId, profile.output.pathField as WindowsUiLocator, outputAbsolute, 5_000);
        } else {
          await this.ui.setValue(executable, processId, profile.output.directoryField as WindowsUiLocator, path.dirname(outputAbsolute), 5_000);
          await this.ui.setValue(executable, processId, profile.output.nameField as WindowsUiLocator, path.basename(outputAbsolute), 5_000);
        }

        const confirm = await this.ui.wait(executable, processId, profile.confirmExportButton as WindowsUiLocator, 5_000);
        if (!confirm.element.patterns.some(item => /InvokePattern/i.test(item))) {
          throw new Error('CAPCUT_EXPORT_UNSUPPORTED_UI: confirm control does not expose InvokePattern.');
        }
        await this.ui.invoke(executable, processId, profile.confirmExportButton as WindowsUiLocator, 5_000);
        exportStarted = true;

        const deadline = Date.now() + timeoutMs;
        let stableSize = -1;
        let stableSamples = 0;
        let lastProbeError = '';
        while (Date.now() < deadline) {
          const stat = await fs.stat(outputAbsolute).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
          });
          if (stat?.isFile() && stat.size > 0) {
            if (stat.size === stableSize) stableSamples += 1;
            else {
              stableSize = stat.size;
              stableSamples = 0;
            }
            if (stableSamples >= 2) {
              try {
                const probe = await this.media.probeFile(workspace, projectPath, output, 5_000);
                const duration = probe.format.durationSeconds;
                const hasVideo = probe.streams.some((stream: { codecType?: string }) => stream.codecType === 'video');
                if (hasVideo && typeof duration === 'number' && duration > 0) {
                  const sha256 = await sha256File(outputAbsolute);
                  accepted = true;
                  return {
                    provider: 'capcut-windows-uia',
                    workspace,
                    projectPath,
                    capcutProjectId,
                    draftName: identity.draftName,
                    draftSha256: identity.sha256,
                    profileId: profile.id,
                    profileDigest,
                    capcutVersion: installation.version,
                    output,
                    bytes: stat.size,
                    sha256,
                    probe,
                    acceptance: {
                      outputWasAbsentBeforeRun: true,
                      semanticProjectMatched: true,
                      profileVersionMatched: true,
                      ffprobeAccepted: true,
                      sha256Computed: true
                    }
                  };
                }
                lastProbeError = 'ffprobe did not report a positive-duration video stream';
              } catch (error) {
                lastProbeError = error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512);
              }
            }
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw new Error(`CAPCUT_EXPORT_TIMEOUT: no accepted MP4 before timeout${lastProbeError ? `; last probe: ${lastProbeError}` : ''}.`);
      } finally {
        if (!accepted) {
          if (exportStarted) {
            try {
              await this.ui.invoke(executable, processId, profile.cancelExportButton as WindowsUiLocator, 2_000);
              cancelAttempted = true;
            } catch {
              cancelAttempted = true;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          const removed = await fs.rm(outputAbsolute, { force: true }).then(() => true).catch(() => false);
          if (!removed) {
            throw new Error(`CAPCUT_EXPORT_CLEANUP_INCOMPLETE: partial output could not be removed; cancelAttempted=${cancelAttempted}.`);
          }
        }
      }
    });
  }
}
