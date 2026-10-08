import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { McpServer } from '@modelcontextprotocol/server';
import { CAPABILITIES } from '../src/capabilities.js';
import type { AppContext } from '../src/context.js';
import { SocialPublishingService } from '../src/web/social-publishing.js';
import { SocialPublishTransactionStore } from '../src/web/social-publish-transaction.js';
import { registerSocialTools } from '../src/tools/social-tools.js';
import { requiredScopeForTool } from '../src/security/request-principal.js';
import { normalizeSetupSettings } from '../src/setup/settings.js';
import { browserDomainRules, createBrowserDomainPolicy, domainMatchesRule } from '../src/web/domain-policy.js';

function settings(overrides: Record<string, unknown> = {}) {
  return normalizeSetupSettings({
    workspaceRoot: path.resolve(os.tmpdir(), 'rwmcp-social-workspace'),
    browser: {
      allowedDomains: [],
      maxUploadFileBytes: 128 * 1024 * 1024,
      maxUploadBatchBytes: 256 * 1024 * 1024
    },
    social: {
      enabledPlatforms: ['youtube', 'tiktok'],
      mediaRoots: []
    },
    ...overrides
  });
}

test('social domain bundles are owner-enabled, suffix bounded and default-deny otherwise', () => {
  const configured = settings();
  const rules = browserDomainRules(configured);
  assert.ok(rules.includes('youtube.com'));
  assert.ok(rules.includes('tiktok.com'));
  const allowed = createBrowserDomainPolicy(configured);
  assert.equal(allowed('studio.youtube.com'), true);
  assert.equal(allowed('www.tiktok.com'), true);
  assert.equal(allowed('evil-youtube.com'), false);
  assert.equal(allowed('example.com'), false);
  assert.equal(domainMatchesRule('a.b.youtube.com', 'youtube.com'), true);
  assert.equal(domainMatchesRule('notyoutube.com', 'youtube.com'), false);

  const none = settings({ social: { enabledPlatforms: [], mediaRoots: [] } });
  assert.equal(createBrowserDomainPolicy(none)('studio.youtube.com'), false);
});

test('explicit browser domains remain owner-controlled alongside social bundles', () => {
  const configured = settings({
    browser: {
      allowedDomains: ['example.test'],
      maxUploadFileBytes: 64 * 1024 * 1024,
      maxUploadBatchBytes: 64 * 1024 * 1024
    },
    social: { enabledPlatforms: [], mediaRoots: [] }
  });
  const allowed = createBrowserDomainPolicy(configured);
  assert.equal(allowed('example.test'), true);
  assert.equal(allowed('sub.example.test'), true);
  assert.equal(allowed('studio.youtube.com'), false);
});

test('social publish plan is SHA-bound and rejects media-root escapes', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-social-'));
  const root = path.join(temp, 'videos');
  await fs.mkdir(root);
  const video = path.join(root, 'lesson-04.mp4');
  await fs.writeFile(video, Buffer.from('video-bytes-v1'));
  const configured = settings({
    social: {
      enabledPlatforms: ['youtube', 'tiktok'],
      mediaRoots: [{ id: 'videos', root }]
    }
  });
  const fakeBrowser = {
    capabilities: () => ({ availability: { available: true }, uploadLimits: { maxFileBytes: configured.browser.maxUploadFileBytes, maxBatchBytes: configured.browser.maxUploadBatchBytes } }),
    profileStatus: async (profile: string) => ({ profile, exists: false, active: false })
  };
  const service = new SocialPublishingService(configured.social, configured.browser, fakeBrowser as never);

  const input = {
    platform: 'youtube' as const,
    mediaRootId: 'videos',
    path: 'lesson-04.mp4',
    title: 'Bài 4',
    hashtags: ['CAN', 'CANopen', 'CAN'],
    playlist: 'CAN',
    scheduleAt: '2026-10-08T08:00:00+07:00',
    timezone: 'Asia/Bangkok'
  };
  const first = await service.publishPlan(input);
  const second = await service.publishPlan(input);
  assert.equal(first.planSha256, second.planSha256);
  assert.equal(first.source.name, 'lesson-04.mp4');
  assert.equal(first.source.bytes, Buffer.byteLength('video-bytes-v1'));
  assert.deepEqual(first.metadata.hashtags, ['CAN', 'CANopen']);
  assert.equal(first.browser.profile, 'social-youtube');

  await fs.writeFile(video, Buffer.from('video-bytes-v2'));
  const changed = await service.publishPlan(input);
  assert.notEqual(changed.planSha256, first.planSha256);
  assert.notEqual(changed.source.sha256, first.source.sha256);

  const outside = path.join(temp, 'outside.mp4');
  await fs.writeFile(outside, Buffer.from('outside'));
  await assert.rejects(
    service.publishPlan({ ...input, path: '..\\outside.mp4' }),
    /cannot escape|outside|media root/i
  );
});

test('social settings validate bounded upload limits and absolute media roots', () => {
  assert.throws(() => settings({
    browser: {
      allowedDomains: [],
      maxUploadFileBytes: 128,
      maxUploadBatchBytes: 64
    }
  }), /maxUploadBatchBytes/);

  assert.throws(() => settings({
    social: {
      enabledPlatforms: ['youtube'],
      mediaRoots: [{ id: 'videos', root: 'relative/videos' }]
    }
  }), /absolute path/);
});

test('social tools are advertised, pack-scoped and explicitly classified', () => {
  const capability = CAPABILITIES.find(item => item.id === 'web.social');
  assert.ok(capability);
  assert.equal(capability.tools.length, 13);
  for (const tool of capability.tools) {
    assert.ok(['workstation.read', 'workstation.write', 'workstation.execute'].includes(requiredScopeForTool(tool)!));
  }
  assert.equal(requiredScopeForTool('social_publish_plan'), 'workstation.read');
  assert.equal(requiredScopeForTool('social_session_open'), 'workstation.execute');
  assert.equal(requiredScopeForTool('social_schedule_apply'), 'workstation.write');
  assert.equal(requiredScopeForTool('social_upload'), 'workstation.write');

  const registered: string[] = [];
  const server = { registerTool: (name: string) => { registered.push(name); } } as unknown as McpServer;
  registerSocialTools(server, {} as AppContext);
  assert.deepEqual(registered.sort(), [...capability.tools].sort());
});


test('social metadata mutation verifies title/description postconditions before advancing transaction', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-social-metadata-'));
  try {
    const root = path.join(temp, 'videos');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'lesson.mp4'), Buffer.from('video'));
    const configured = settings({ social: { enabledPlatforms: ['youtube'], mediaRoots: [{ id: 'videos', root }] } });
    const state = { title: 'Old title', description: 'Old description' };
    const fakeBrowser = {
      inspect: async () => ({
        tabId: 'tab', url: 'https://studio.youtube.com/video/test/edit', title: 'Studio', generation: 1,
        elements: [
          { elementId: 'title', role: 'textbox', name: 'Tiêu đề (bắt buộc)', visible: true, enabled: true, value: state.title },
          { elementId: 'desc', role: 'textbox', name: 'Mô tả', visible: true, enabled: true, value: state.description }
        ]
      }),
      extract: async () => ({ text: 'Chi tiết video', truncated: false }),
      interact: async (_sessionId: string, _tabId: string, _owner: unknown, elementId: string, action: any) => {
        if (action.kind !== 'fill') throw new Error('unexpected action');
        if (elementId === 'title') state.title = action.value;
        else if (elementId === 'desc') state.description = action.value;
        else throw new Error('unexpected element');
        return { action: action.kind };
      }
    };
    const store = new SocialPublishTransactionStore(path.join(temp, 'transactions'));
    const service = new SocialPublishingService(configured.social, configured.browser, fakeBrowser as never, store);
    const input = {
      platform: 'youtube' as const, mediaRootId: 'videos', path: 'lesson.mp4',
      title: 'BÀI 4 — Identifier', description: 'Nội dung bài 4', hashtags: ['CANBus', 'CANopen']
    };
    const plan = await service.publishPlan(input);
    const owner = { principalId: 'p', workSessionId: 'w' };
    const ensured = await store.ensure({
      platform: 'youtube', planSha256: plan.planSha256, sourceSha256: plan.source.sha256,
      principalId: owner.principalId, workSessionId: owner.workSessionId
    });
    await store.startMutation(ensured.transaction.id, 'upload');
    await store.completeMutation(ensured.transaction.id, 'upload', { observedAt: new Date().toISOString() });

    const result = await service.applyMetadata(input, plan.planSha256, ensured.transaction.id, 's', 't', owner);
    assert.equal(result.transaction.phase, 'metadata-applied');
    assert.equal(state.title, input.title);
    assert.equal(state.description, 'Nội dung bài 4\n\n#CANBus #CANopen');
    assert.equal(result.audit.verified, true);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('custom playlist button blocks before metadata transaction starts', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-social-playlist-preflight-'));
  try {
    const root = path.join(temp, 'videos');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'lesson.mp4'), Buffer.from('video'));
    const configured = settings({ social: { enabledPlatforms: ['youtube'], mediaRoots: [{ id: 'videos', root }] } });
    const fakeBrowser = {
      inspect: async () => ({
        tabId: 'tab', url: 'https://studio.youtube.com/video/test/edit', title: 'Studio', generation: 1,
        elements: [{ elementId: 'playlist', role: 'button', name: 'Danh sách phát', visible: true, enabled: true }]
      }),
      extract: async () => ({ text: 'Chi tiết video', truncated: false })
    };
    const store = new SocialPublishTransactionStore(path.join(temp, 'transactions'));
    const service = new SocialPublishingService(configured.social, configured.browser, fakeBrowser as never, store);
    const input = { platform: 'youtube' as const, mediaRootId: 'videos', path: 'lesson.mp4', playlist: 'CAN' };
    const plan = await service.publishPlan(input);
    const owner = { principalId: 'p', workSessionId: 'w' };
    const ensured = await store.ensure({
      platform: 'youtube', planSha256: plan.planSha256, sourceSha256: plan.source.sha256,
      principalId: owner.principalId, workSessionId: owner.workSessionId
    });
    await store.startMutation(ensured.transaction.id, 'upload');
    await store.completeMutation(ensured.transaction.id, 'upload', { observedAt: new Date().toISOString() });

    await assert.rejects(
      service.applyMetadata(input, plan.planSha256, ensured.transaction.id, 's', 't', owner),
      /SOCIAL_PLAYLIST_CONTROL_REQUIRES_CALIBRATION/
    );
    assert.equal((await store.read(ensured.transaction.id)).phase, 'uploaded');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('YouTube schedule mutation adjusts only the time on an already-correct date and verifies after save', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-social-schedule-'));
  try {
    const root = path.join(temp, 'videos');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'lesson.mp4'), Buffer.from('video'));
    const configured = settings({ social: { enabledPlatforms: ['youtube'], mediaRoots: [{ id: 'videos', root }] } });

    const state = { panelOpen: true, time: '12:00', saved: false };
    const fakeBrowser = {
      inspect: async () => ({
        tabId: 'tab',
        url: 'https://studio.youtube.com/video/test/edit',
        title: 'Studio',
        generation: 1,
        elements: state.panelOpen
          ? [
              { elementId: 'time', role: 'textbox', name: '', visible: true, enabled: true, value: state.time },
              { elementId: 'done', role: 'button', name: 'Xong', visible: true, enabled: true },
              { elementId: 'save', role: 'button', name: 'Lưu', visible: true, enabled: true }
            ]
          : [
              { elementId: 'visibility', role: 'button', name: 'Chỉnh sửa trạng thái hiển thị của video', visible: true, enabled: true },
              { elementId: 'save', role: 'button', name: 'Lưu', visible: true, enabled: true }
            ]
      }),
      extract: async () => ({ text: 'Đã lên lịch\n9 thg 10, 2026\nMúi giờ', truncated: false }),
      interact: async (_sessionId: string, _tabId: string, _owner: unknown, elementId: string, action: any) => {
        if (elementId === 'time' && action.kind === 'fill') state.time = action.value;
        else if (elementId === 'done' && action.kind === 'click') state.panelOpen = false;
        else if (elementId === 'save' && action.kind === 'click') state.saved = true;
        else if (elementId === 'visibility' && action.kind === 'click') state.panelOpen = true;
        else throw new Error('unexpected interaction ' + elementId + ':' + action.kind);
        return { action: action.kind };
      }
    };

    const store = new SocialPublishTransactionStore(path.join(temp, 'transactions'));
    const service = new SocialPublishingService(configured.social, configured.browser, fakeBrowser as never, store);
    const input = {
      platform: 'youtube' as const,
      mediaRootId: 'videos',
      path: 'lesson.mp4',
      scheduleAt: '2026-10-09T08:00:00+07:00',
      timezone: 'Asia/Ho_Chi_Minh'
    };
    const plan = await service.publishPlan(input);
    const owner = { principalId: 'p', workSessionId: 'w' };
    const ensured = await store.ensure({
      platform: 'youtube',
      planSha256: plan.planSha256,
      sourceSha256: plan.source.sha256,
      principalId: owner.principalId,
      workSessionId: owner.workSessionId
    });
    await store.startMutation(ensured.transaction.id, 'upload');
    await store.completeMutation(ensured.transaction.id, 'upload', { observedAt: new Date().toISOString() });
    await store.startMutation(ensured.transaction.id, 'metadata');
    await store.completeMutation(ensured.transaction.id, 'metadata', { observedAt: new Date().toISOString() });

    const result = await service.applySchedule(input, plan.planSha256, ensured.transaction.id, 's', 't', owner);
    assert.equal(state.time, '08:00');
    assert.equal(state.saved, true);
    assert.equal(result.audit.status.verified, true);
    assert.equal(result.idempotent, false);
    assert.equal(result.transaction.phase, 'scheduled');
    assert.equal(result.transaction.evidence.schedule?.scheduleAt, input.scheduleAt);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('schedule mutation refuses calendar changes before starting the transaction', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-social-schedule-date-'));
  try {
    const root = path.join(temp, 'videos');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'lesson.mp4'), Buffer.from('video'));
    const configured = settings({ social: { enabledPlatforms: ['youtube'], mediaRoots: [{ id: 'videos', root }] } });
    const fakeBrowser = {
      inspect: async () => ({
        tabId: 'tab',
        url: 'https://studio.youtube.com/video/test/edit',
        title: 'Studio',
        generation: 1,
        elements: [{ elementId: 'time', role: 'textbox', name: '', visible: true, enabled: true, value: '12:00' }]
      }),
      extract: async () => ({ text: 'Đã lên lịch\n10 thg 10, 2026\nMúi giờ', truncated: false })
    };
    const store = new SocialPublishTransactionStore(path.join(temp, 'transactions'));
    const service = new SocialPublishingService(configured.social, configured.browser, fakeBrowser as never, store);
    const input = {
      platform: 'youtube' as const,
      mediaRootId: 'videos',
      path: 'lesson.mp4',
      scheduleAt: '2026-10-09T08:00:00+07:00',
      timezone: 'Asia/Ho_Chi_Minh'
    };
    const plan = await service.publishPlan(input);
    const owner = { principalId: 'p', workSessionId: 'w' };
    const ensured = await store.ensure({
      platform: 'youtube',
      planSha256: plan.planSha256,
      sourceSha256: plan.source.sha256,
      principalId: owner.principalId,
      workSessionId: owner.workSessionId
    });
    await store.startMutation(ensured.transaction.id, 'upload');
    await store.completeMutation(ensured.transaction.id, 'upload', { observedAt: new Date().toISOString() });
    await store.startMutation(ensured.transaction.id, 'metadata');
    await store.completeMutation(ensured.transaction.id, 'metadata', { observedAt: new Date().toISOString() });

    await assert.rejects(
      service.applySchedule(input, plan.planSha256, ensured.transaction.id, 's', 't', owner),
      /SOCIAL_SCHEDULE_DATE_REQUIRES_CALIBRATION/
    );
    assert.equal((await store.read(ensured.transaction.id)).phase, 'metadata-applied');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
