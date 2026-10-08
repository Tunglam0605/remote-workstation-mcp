import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SetupSettings } from '../setup/settings.js';
import type { BrowserCore, BrowserUploadFile } from './browser-core.js';
import { SOCIAL_PLATFORM_DOMAINS, type SocialPlatform } from './domain-policy.js';
import { SocialPublishTransactionStore, type SocialMutation, type SocialTransactionEvidence } from './social-publish-transaction.js';
import { auditSocialMetadata, auditSocialSchedule, composeSocialDescription, findSocialSemanticField } from './social-semantic.js';

type Owner = { principalId: string; workSessionId: string };

export interface SocialPublishInput {
  platform: SocialPlatform;
  mediaRootId: string;
  path: string;
  title?: string;
  description?: string;
  hashtags?: string[];
  playlist?: string;
  scheduleAt?: string;
  timezone?: string;
}

const PLATFORM_CONFIG: Record<SocialPlatform, {
  profile: string;
  studioUrl: string;
  uploadAliases: readonly string[];
  createAliases: readonly string[];
  schedule: { minLeadMinutes: number; maxAheadDays?: number };
}> = {
  youtube: {
    profile: 'social-youtube',
    studioUrl: 'https://studio.youtube.com/',
    uploadAliases: ['upload videos', 'tải video lên'],
    createAliases: ['create', 'tạo'],
    schedule: { minLeadMinutes: 0 }
  },
  tiktok: {
    profile: 'social-tiktok',
    studioUrl: 'https://www.tiktok.com/tiktokstudio/upload?from=creator_center',
    uploadAliases: ['select file', 'chọn tệp', 'upload', 'tải lên'],
    createAliases: [],
    schedule: { minLeadMinutes: 15, maxAheadDays: 10 }
  }
};

function normalizeLabel(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('vi-VN').replace(/\s+/g, ' ');
}

function mimeForSocial(filename: string): string {
  const known: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.webm': 'video/webm'
  };
  return known[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

async function sha256File(filename: string): Promise<string> {
  const handle = await fs.open(filename, 'r');
  try {
    const hash = createHash('sha256');
    const stream = handle.createReadStream();
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => {});
  }
}

function planDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class SocialPublishingService {
  constructor(
    private readonly settings: SetupSettings['social'],
    private readonly browserSettings: SetupSettings['browser'],
    private readonly browser: BrowserCore,
    private readonly transactions = new SocialPublishTransactionStore()
  ) {}

  capabilities() {
    return {
      platforms: (['youtube', 'tiktok'] as const).map(platform => ({
        platform,
        enabled: this.settings.enabledPlatforms.includes(platform),
        profile: PLATFORM_CONFIG[platform].profile,
        studioUrl: PLATFORM_CONFIG[platform].studioUrl,
        domains: [...SOCIAL_PLATFORM_DOMAINS[platform]],
        schedule: { ...PLATFORM_CONFIG[platform].schedule }
      })),
      mediaRoots: this.settings.mediaRoots.map(root => ({ id: root.id })),
      uploadLimits: {
        maxFileBytes: this.browserSettings.maxUploadFileBytes,
        maxBatchBytes: this.browserSettings.maxUploadBatchBytes
      },
      safety: {
        persistentProfiles: true,
        passwordExtraction: false,
        cookieExtraction: false,
        rawSelectors: false,
        coordinateClicks: false,
        publishRequiresSemanticAcceptance: true
      }
    };
  }

  async platformStatus(platform: SocialPlatform) {
    const config = PLATFORM_CONFIG[platform];
    return {
      platform,
      enabled: this.settings.enabledPlatforms.includes(platform),
      browser: this.browser.capabilities().availability,
      profile: await this.browser.profileStatus(config.profile),
      studioUrl: config.studioUrl,
      domains: [...SOCIAL_PLATFORM_DOMAINS[platform]],
      schedule: { ...config.schedule },
      mediaRootCount: this.settings.mediaRoots.length
    };
  }

  private assertEnabled(platform: SocialPlatform) {
    if (!this.settings.enabledPlatforms.includes(platform)) {
      throw new Error(`Social platform '${platform}' is not enabled by the local owner settings.`);
    }
  }

  private async resolveMedia(mediaRootId: string, childPath: string) {
    if (path.isAbsolute(childPath)) throw new Error('Social media path must be relative to an owner-configured media root.');
    const root = this.settings.mediaRoots.find(item => item.id === mediaRootId);
    if (!root) throw new Error(`Unknown social media root '${mediaRootId}'.`);
    const realRoot = await fs.realpath(root.root);
    const candidate = await fs.realpath(path.resolve(realRoot, childPath));
    const relative = path.relative(realRoot, candidate);
    if (!relative || relative === '.') throw new Error('Social media source must be a file below the configured media root.');
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('Social media source cannot escape the configured media root.');
    }
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) throw new Error('Social media source must be a regular file.');
    if (stat.size <= 0 || stat.size > this.browserSettings.maxUploadFileBytes) {
      throw new Error(`Social media source exceeds the configured upload file limit of ${this.browserSettings.maxUploadFileBytes} bytes.`);
    }
    const mimeType = mimeForSocial(candidate);
    if (mimeType === 'application/octet-stream') throw new Error('Social publishing only accepts MP4, MOV, M4V or WebM video files.');
    return {
      absolutePath: candidate,
      relativePath: relative.split(path.sep).join('/'),
      name: path.basename(candidate).slice(0, 256),
      bytes: stat.size,
      mimeType,
      sha256: await sha256File(candidate)
    };
  }

  async publishPlan(input: SocialPublishInput) {
    this.assertEnabled(input.platform);
    const source = await this.resolveMedia(input.mediaRootId, input.path);
    const config = PLATFORM_CONFIG[input.platform];
    const normalized = {
      version: 1,
      platform: input.platform,
      mediaRootId: input.mediaRootId,
      source: {
        relativePath: source.relativePath,
        name: source.name,
        bytes: source.bytes,
        mimeType: source.mimeType,
        sha256: source.sha256
      },
      metadata: {
        title: input.title?.trim() || undefined,
        description: input.description?.trim() || undefined,
        hashtags: [...new Set((input.hashtags ?? []).map(value => value.trim()).filter(Boolean))].slice(0, 30),
        playlist: input.playlist?.trim() || undefined
      },
      schedule: input.scheduleAt ? {
        at: input.scheduleAt,
        timezone: input.timezone?.trim() || undefined
      } : undefined,
      browser: {
        profile: config.profile,
        studioUrl: config.studioUrl
      }
    };
    return {
      ...normalized,
      planSha256: planDigest(normalized),
      constraints: { schedule: { ...config.schedule } }
    };
  }

  async openSession(platform: SocialPlatform, owner: Owner, mode: 'background' | 'visible' = 'visible') {
    this.assertEnabled(platform);
    const config = PLATFORM_CONFIG[platform];
    const created = await this.browser.create(owner, mode, config.profile);
    try {
      const navigated = await this.browser.navigate(created.sessionId, created.tabId, owner, 'goto', config.studioUrl);
      return { ...created, platform, studioUrl: config.studioUrl, url: navigated.url };
    } catch (error) {
      await this.browser.close(created.sessionId, owner).catch(() => {});
      throw error;
    }
  }

  sessionStatus(sessionId: string, owner: Owner) {
    return this.browser.status(sessionId, owner);
  }

  async closeSession(sessionId: string, owner: Owner) {
    return await this.browser.close(sessionId, owner);
  }

  async inspect(platform: SocialPlatform, sessionId: string, tabId: string, owner: Owner) {
    this.assertEnabled(platform);
    const page = await this.browser.inspect(sessionId, tabId, owner, 50);
    const text = await this.browser.extract(sessionId, tabId, owner, 8_000);
    const normalizedText = normalizeLabel(text.text);
    const loginNeeded = ['sign in', 'log in', 'đăng nhập', 'login'].some(marker => normalizedText.includes(marker));
    return {
      platform,
      ...page,
      text: text.text,
      textTruncated: text.truncated,
      loginNeeded,
      fileInputs: page.elements.filter(item => item.role === 'file'),
      semanticOnly: true
    };
  }

  async auditSchedule(
    platform: SocialPlatform,
    sessionId: string,
    tabId: string,
    scheduleAt: string,
    timezone: string,
    owner: Owner
  ) {
    const inspected = await this.inspect(platform, sessionId, tabId, owner);
    if (inspected.loginNeeded) {
      throw new Error('SOCIAL_AUTH_REQUIRED: complete login/consent in the persistent social profile before schedule audit.');
    }
    return {
      sessionId,
      tabId,
      ...auditSocialSchedule({
        platform,
        scheduleAt,
        timezone,
        text: inspected.text,
        elements: inspected.elements
      }),
      semanticOnly: true,
      textTruncated: inspected.textTruncated
    };
  }

  private async locateUploadInput(platform: SocialPlatform, sessionId: string, tabId: string, owner: Owner) {
    const config = PLATFORM_CONFIG[platform];
    let page = await this.browser.inspect(sessionId, tabId, owner, 50);
    const visibleFile = () => page.elements.find(item => item.role === 'file' && item.visible && item.enabled);
    const initial = visibleFile();
    if (initial) return initial;

    for (const aliases of [config.createAliases, config.uploadAliases]) {
      if (!aliases.length) continue;
      const match = page.elements.find(item =>
        item.role === 'button' &&
        item.visible &&
        item.enabled &&
        aliases.includes(normalizeLabel(item.name))
      );
      if (!match) continue;
      await this.browser.interact(sessionId, tabId, owner, match.elementId, { kind: 'click' });
      page = await this.browser.inspect(sessionId, tabId, owner, 50);
      const found = visibleFile();
      if (found) return found;
    }

    throw new Error('SOCIAL_UPLOAD_INPUT_NOT_READY: no semantic file input is available. Complete login/consent in the visible social profile, then inspect again.');
  }

  async upload(
    input: SocialPublishInput,
    expectedPlanSha256: string,
    sessionId: string,
    tabId: string,
    owner: Owner
  ) {
    const plan = await this.publishPlan(input);
    if (plan.planSha256 !== expectedPlanSha256) {
      throw new Error('SOCIAL_PLAN_CHANGED: publish plan no longer matches expectedPlanSha256.');
    }
    const source = await this.resolveMedia(input.mediaRootId, input.path);
    if (source.sha256 !== plan.source.sha256) {
      throw new Error('SOCIAL_SOURCE_CHANGED: source bytes changed after planning.');
    }
    const ensured = await this.transactions.ensure({
      platform: input.platform,
      planSha256: plan.planSha256,
      sourceSha256: source.sha256,
      principalId: owner.principalId,
      workSessionId: owner.workSessionId
    });
    const started = await this.transactions.startMutation(ensured.transaction.id, 'upload');
    if (started.alreadyCompleted) {
      return {
        platform: input.platform,
        planSha256: plan.planSha256,
        source: plan.source,
        transaction: started.transaction,
        idempotent: true,
        skipped: 'upload-already-completed',
        next: 'Resume from the recorded transaction phase instead of uploading the same plan again.'
      };
    }
    const inputElement = await this.locateUploadInput(input.platform, sessionId, tabId, owner);
    const file: BrowserUploadFile = {
      absolutePath: source.absolutePath,
      name: source.name,
      bytes: source.bytes,
      mimeType: source.mimeType
    };
    const uploaded = await this.browser.upload(sessionId, tabId, owner, inputElement.elementId, [file]);
    const transaction = await this.transactions.completeMutation(ensured.transaction.id, 'upload', {
      observedAt: new Date().toISOString(),
      note: `Semantic browser upload accepted ${uploaded.uploaded.length} file(s).`,
      fields: uploaded.uploaded.map(item => item.name)
    });
    return {
      platform: input.platform,
      planSha256: plan.planSha256,
      source: plan.source,
      uploaded,
      transaction,
      idempotent: false,
      next: 'Inspect the platform details/scheduling UI and continue the same transaction; do not create a new upload plan.'
    };
  }

  async applyMetadata(
    input: SocialPublishInput,
    expectedPlanSha256: string,
    transactionId: string,
    sessionId: string,
    tabId: string,
    owner: Owner
  ) {
    const plan = await this.publishPlan(input);
    if (plan.planSha256 !== expectedPlanSha256) {
      throw new Error('SOCIAL_PLAN_CHANGED: publish plan no longer matches expectedPlanSha256.');
    }
    const existing = await this.transactionStatus(transactionId, owner);
    if (existing.planSha256 !== expectedPlanSha256 || existing.platform !== input.platform || existing.sourceSha256 !== plan.source.sha256) {
      throw new Error('SOCIAL_TRANSACTION_PLAN_MISMATCH: transaction does not belong to this platform/plan/source.');
    }

    const expected = {
      ...(plan.metadata.title ? { title: plan.metadata.title } : {}),
      ...(composeSocialDescription(input.platform, plan.metadata.description, plan.metadata.hashtags) ? {
        description: composeSocialDescription(input.platform, plan.metadata.description, plan.metadata.hashtags)!
      } : {}),
      ...(plan.metadata.playlist ? { playlist: plan.metadata.playlist } : {})
    };

    const preflight = await this.inspect(input.platform, sessionId, tabId, owner);
    if (preflight.loginNeeded) {
      throw new Error('SOCIAL_AUTH_REQUIRED: complete login/consent in the persistent social profile before metadata mutation.');
    }
    for (const field of ['title', 'description', 'playlist'] as const) {
      const value = expected[field];
      if (value === undefined) continue;
      const found = findSocialSemanticField(input.platform, preflight.elements, field);
      if (found.ambiguous) throw new Error(`SOCIAL_METADATA_CONTROL_AMBIGUOUS: ${field} resolved to multiple semantic controls.`);
      if (!found.element) throw new Error(`SOCIAL_METADATA_CONTROL_NOT_READY: ${field} semantic control is unavailable.`);
      if (field === 'playlist' && found.element.role !== 'combobox') {
        throw new Error('SOCIAL_PLAYLIST_CONTROL_REQUIRES_CALIBRATION: playlist is not exposed as a standard semantic combobox; refusing a partial metadata mutation.');
      }
    }

    const started = await this.transactions.startMutation(transactionId, 'metadata');
    if (started.alreadyCompleted) {
      return {
        platform: input.platform,
        planSha256: expectedPlanSha256,
        transaction: started.transaction,
        idempotent: true,
        skipped: 'metadata-already-completed'
      };
    }

    const freshField = async (field: 'title' | 'description' | 'playlist') => {
      const page = await this.inspect(input.platform, sessionId, tabId, owner);
      const found = findSocialSemanticField(input.platform, page.elements, field);
      if (found.ambiguous || !found.element) {
        throw new Error(`SOCIAL_METADATA_CONTROL_STALE: ${field} could not be uniquely resolved after mutation began; reconcile remote state before retrying.`);
      }
      return found.element;
    };

    if (expected.title !== undefined) {
      const target = await freshField('title');
      await this.browser.interact(sessionId, tabId, owner, target.elementId, { kind: 'fill', value: expected.title });
    }
    if (expected.description !== undefined) {
      const target = await freshField('description');
      await this.browser.interact(sessionId, tabId, owner, target.elementId, { kind: 'fill', value: expected.description });
    }
    if (expected.playlist !== undefined) {
      const target = await freshField('playlist');
      if (target.role !== 'combobox') {
        throw new Error('SOCIAL_PLAYLIST_CONTROL_REQUIRES_CALIBRATION: playlist control changed shape after metadata mutation began; reconcile remote state before retrying.');
      }
      await this.browser.interact(sessionId, tabId, owner, target.elementId, { kind: 'select', value: expected.playlist });
    }

    const after = await this.inspect(input.platform, sessionId, tabId, owner);
    const audit = Object.keys(expected).length === 0
      ? { platform: input.platform, checks: [], verified: true, blockers: [] as string[] }
      : auditSocialMetadata({ platform: input.platform, expected, elements: after.elements });
    if (!audit.verified) {
      throw new Error(`SOCIAL_METADATA_POSTCONDITION_FAILED: ${JSON.stringify(audit).slice(0, 1500)}`);
    }
    const transaction = await this.transactions.completeMutation(transactionId, 'metadata', {
      observedAt: new Date().toISOString(),
      note: 'Semantic metadata mutation passed postcondition verification.',
      fields: audit.checks.map(item => item.field)
    });
    return {
      platform: input.platform,
      planSha256: expectedPlanSha256,
      transaction,
      audit,
      idempotent: false
    };
  }

  async transactionStatus(transactionId: string, owner: Owner) {
    const transaction = await this.transactions.read(transactionId);
    if (transaction.principalId !== owner.principalId) throw new Error('SOCIAL_TRANSACTION_OWNER_MISMATCH: transaction belongs to a different principal.');
    return transaction;
  }

  async reconcileTransaction(
    transactionId: string,
    mutation: SocialMutation,
    outcome: 'applied' | 'not-applied',
    evidence: SocialTransactionEvidence,
    owner: Owner
  ) {
    const transaction = await this.transactions.read(transactionId);
    if (transaction.principalId !== owner.principalId) throw new Error('SOCIAL_TRANSACTION_OWNER_MISMATCH: transaction belongs to a different principal.');
    return await this.transactions.reconcileMutation(transactionId, mutation, outcome, evidence);
  }
}
