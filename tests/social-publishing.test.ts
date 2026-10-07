import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { McpServer } from '@modelcontextprotocol/server';
import { CAPABILITIES } from '../src/capabilities.js';
import type { AppContext } from '../src/context.js';
import { SocialPublishingService } from '../src/web/social-publishing.js';
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
  assert.equal(capability.tools.length, 10);
  for (const tool of capability.tools) {
    assert.ok(['workstation.read', 'workstation.write', 'workstation.execute'].includes(requiredScopeForTool(tool)!));
  }
  assert.equal(requiredScopeForTool('social_publish_plan'), 'workstation.read');
  assert.equal(requiredScopeForTool('social_session_open'), 'workstation.execute');
  assert.equal(requiredScopeForTool('social_upload'), 'workstation.write');

  const registered: string[] = [];
  const server = { registerTool: (name: string) => { registered.push(name); } } as unknown as McpServer;
  registerSocialTools(server, {} as AppContext);
  assert.deepEqual(registered.sort(), [...capability.tools].sort());
});
