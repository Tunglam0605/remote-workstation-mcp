import assert from 'node:assert/strict';
import test from 'node:test';
import { SERVER_VERSION } from '../src/capabilities.js';
import vm from 'node:vm';
import { startSetupServer } from '../src/setup/setup-server.js';

test('Setup & Control Center requires the ephemeral token for API access', async () => {
  const setup = await startSetupServer({ repoRoot: process.cwd(), port: 23180, openBrowser: false });
  try {
    const parsed = new URL(setup.url);
    assert.equal(parsed.hash, '');
    const base = `${parsed.protocol}//${parsed.host}`;

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /Remote Workstation MCP Setup & Control Center/);
    assert.match(pageText, /data-theme="dark"/);
    assert.match(pageText, /id="themeToggle"/);
    assert.match(pageText, /rwmcp\.theme/);
    assert.match(pageText, /id="langEn"/);
    assert.match(pageText, /id="langVi"/);
    assert.match(pageText, /id="accessMode"/);
    assert.match(pageText, /id="firstRunCard"/);
    assert.match(pageText, /id="bootstrapTunnel"/);
    assert.match(pageText, /id="bootstrapKey"/);
    assert.match(pageText, /id="bootstrapConnect"/);
    assert.match(pageText, /api\/bootstrap/);
    assert.match(pageText, /id="autoUpdate"/);
    assert.match(pageText, /id="checkUpdate"/);
    assert.match(pageText, /id="devicePairingCard"/);
    assert.match(pageText, /id="multiNodeCard"/);
    assert.match(pageText, /id="executionPolicyCard"/);
    assert.match(pageText, /Ch\u00ednh s\u00e1ch th\u1ef1c thi/);
    assert.match(pageText, /Ch\u1ebf \u0111\u1ed9 m\u1eb7c \u0111\u1ecbnh/);
    assert.match(pageText, /Khi Codex \u0111\u1ea1t gi\u1edbi h\u1ea1n/);
    assert.match(pageText, /kh\u00f4ng gi\u1edbi h\u1ea1n/);
    assert.match(pageText, /id="executionDefault"/);
    assert.match(pageText, /id="codexFallback"/);
    assert.match(pageText, /id="codexEnabled"/);
    assert.match(pageText, /id="codexBrokerMode"/);
    assert.match(pageText, /id="codexBrokerEnabled"/);
    assert.match(pageText, /id="codexBrokerStatus"/);
    assert.match(pageText, /id="antigravityEnabled"/);
    assert.match(pageText, /id="antigravityModel"/);
    assert.match(pageText, /id="antigravityStatus"/);
    assert.match(pageText, /sidebar\.className='cc-sidebar'/);
    assert.match(pageText, /pages\.id='controlCenterPages'/);
    assert.match(pageText, /function buildControlCenterLayout\(\)/);
    assert.match(pageText, /navOverview:'Tổng quan'/);
    assert.match(pageText, /broker-account-grid/);
    assert.match(pageText, /updatesCardTitle:'Cập nhật phần mềm'/);
    assert.match(pageText, /controlCenterShort:'Trung tâm điều khiển'/);
    assert.match(pageText, /const configCard=pageCardFor\('updateStatus'\)/);
    assert.doesNotMatch(pageText, /var\(--(?:bg|surface-2|primary|success)\)/);
    assert.match(pageText, /id="allowChatOverride"/);
    assert.match(pageText, /\/api\/execution-policy/);
    assert.match(pageText, /id="toggleMultiNode"/);
    assert.match(pageText, /id="saveMultiNodeGrant"/);
    assert.match(pageText, /id="multiNodeGrants"/);
    assert.match(pageText, /\/api\/multi-node/);
    assert.match(pageText, /\/api\/multi-node\/grants/);
    assert.match(pageText, /id="createPairingCode"/);
    assert.match(pageText, /id="pairSelectedHost"/);
    assert.match(pageText, /id="testConnection"/);
    assert.match(pageText, /id="saveReconnect"/);
    assert.match(pageText, /api\/recovery\/status/);
    assert.match(pageText, /api\/recovery\/test/);
    assert.match(pageText, /api\/recovery\/apply/);
    assert.match(pageText, /id="openSetup"/);
    assert.match(pageText, /<dialog class="gw-modal setup-modal" id="setupModal">/);
    assert.match(pageText, /<dialog class="gw-modal confirm-modal" id="fullAccessConfirmModal">/);
    assert.doesNotMatch(pageText, /<details class="advanced-panel">/);
    assert.match(pageText, /id="notificationToggle"/);
    assert.match(pageText, /id="notificationBadge"/);
    assert.match(pageText, /id="notificationPanel"/);
    assert.match(pageText, /id="notificationList"/);
    assert.match(pageText, /id="versionBadge"/);
    assert.match(pageText, /assets\/brand\/logo\.png\?v=0\.28\.0/);
    assert.match(pageText, /assets\/brand\/logo-background\.png\?v=0\.28\.0/);
    assert.match(pageText, /function executionModeLabel\(mode\)/);
    assert.match(pageText, /executionResetFallback:'Đặt lại chế độ dự phòng Codex'/);
    assert.match(pageText, /executionClearOverrides:'Xóa ghi đè của cuộc trò chuyện'/);
    assert.match(pageText, /executionTasksToday:'Số tác vụ Codex hôm nay'/);
    assert.match(pageText, /\.brand-mark\{width:56px;height:56px;object-fit:contain;border-radius:0;padding:0;background:transparent;border:0;box-shadow:none/);
    assert.match(pageText, /\.brand-signature\{display:block;width:min\(300px,60vw\).*opacity:\.95/);
    assert.match(pageText, /notificationCodexFallbackTitle/);
    assert.match(pageText, /notificationCodexUnavailableTitle/);
    assert.match(pageText, /notificationUpdateTitle/);
    assert.match(pageText, /renderControlNotifications/);
    assert.match(pageText, /NOTIFICATION_READ_KEY/);
    assert.match(pageText, /markCurrentNotificationsRead/);
    assert.match(pageText, /select\{width:100%;min-height:38px/);
    assert.doesNotMatch(pageText, /id="adminApprovalCard"/);
    assert.match(pageText, /r=>r\.state==='pending'/);
    assert.doesNotMatch(pageText, /\['pending','approved','running'\]/);
    assert.match(pageText, /value="read_only"/);
    assert.match(pageText, /value="workspace"/);
    assert.match(pageText, /value="full_control"/);
    assert.doesNotMatch(pageText, /id="applyMode"/);
    assert.doesNotMatch(pageText, /id="scopeFull"/);
    assert.doesNotMatch(pageText, /id="gateRawShell"/);
    assert.match(pageText, /Quick setup for ChatGPT/);
    assert.match(pageText, /rwmcp\.language/);
    assert.match(pageText, /navigator\.language/);
    const embeddedScript = pageText.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(embeddedScript, 'Control Center should contain an embedded script.');
    assert.doesNotThrow(() => new vm.Script(embeddedScript[1]!), 'Embedded Control Center JavaScript must parse.');
    assert.doesNotMatch(pageText, /\uFFFD|â€¦|â€”|Â·|Ã—|â˜|âš|Thiáº¿t|Trung tÃ¢m/, 'Control Center HTML must not contain known mojibake markers.');
    assert.match(pageText, /Thiết lập & Trung tâm điều khiển/);


    const logo = await fetch(`${base}/assets/brand/logo.png`);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('content-type'), 'image/png');
    const signature = await fetch(`${base}/assets/brand/logo-background.png`);
    assert.equal(signature.status, 200);
    assert.equal(signature.headers.get('content-type'), 'image/png');
    const tokenMatch = pageText.match(/const token = ("[^"]+");/);
    assert.ok(tokenMatch, 'Control Center page should embed an ephemeral CSRF token.');
    const token = JSON.parse(tokenMatch[1]!) as string;
    assert.ok(token.length >= 32);
    assert.ok(!setup.url.includes(token), 'CSRF token must not be placed in the URL.');

    const missing = await fetch(`${base}/api/status`);
    assert.equal(missing.status, 403);

    const wrongOrigin = await fetch(`${base}/api/status`, {
      headers: {
        'x-rwmcp-setup-token': token,
        origin: 'https://example.invalid'
      }
    });
    assert.equal(wrongOrigin.status, 403);

    const ok = await fetch(`${base}/api/status`, {
      headers: { 'x-rwmcp-setup-token': token }
    });
    assert.equal(ok.status, 200);
    const body = await ok.json() as { version: string; onboardingRequired: boolean; settings: { mcpPort: number } };
    assert.equal(body.version, SERVER_VERSION);
    assert.ok(Number.isInteger(body.settings.mcpPort));
    assert.equal(typeof body.onboardingRequired, 'boolean');

    const recoveryStatus = await fetch(`${base}/api/recovery/status`, {
      headers: { 'x-rwmcp-setup-token': token }
    });
    assert.equal(recoveryStatus.status, 200);
    const recoveryBody = await recoveryStatus.json() as { recoveryMode: boolean; localControlCenter: string };
    assert.equal(recoveryBody.recoveryMode, true);
    assert.equal(recoveryBody.localControlCenter, 'ONLINE');

    const qualityReview = await fetch(`${base}/api/quality/review`, {
      headers: { 'x-rwmcp-setup-token': token }
    });
    assert.equal(qualityReview.status, 200);
    const qualityReviewBody = await qualityReview.json() as {
      items: unknown[];
      authority: string;
      promotionEnabled: boolean;
      activationEnabled: boolean;
    };
    assert.ok(Array.isArray(qualityReviewBody.items));
    assert.equal(qualityReviewBody.authority, 'owner-local-only');
    assert.equal(qualityReviewBody.promotionEnabled, false);
    assert.equal(qualityReviewBody.activationEnabled, false);

    const qualitySettings = await fetch(`${base}/api/quality/settings`, {
      headers: { 'x-rwmcp-setup-token': token }
    });
    assert.equal(qualitySettings.status, 200);
    const qualitySettingsBody = await qualitySettings.json() as {
      settings: { enabled: boolean; retentionDays: number; minApprovedSamples: number; minScore: number };
      authority: string;
      canonicalProjectDataUnaffected: boolean;
    };
    assert.equal(qualitySettingsBody.authority, 'owner-local-only');
    assert.equal(typeof qualitySettingsBody.settings.enabled, 'boolean');
    assert.ok(qualitySettingsBody.settings.retentionDays >= 1);
    assert.ok(qualitySettingsBody.settings.minApprovedSamples >= 1);
    assert.ok(qualitySettingsBody.settings.minScore >= 0.5);
    assert.equal(qualitySettingsBody.canonicalProjectDataUnaffected, true);

    const qualityKnowledge = await fetch(`${base}/api/quality/knowledge`, {
      headers: { 'x-rwmcp-setup-token': token }
    });
    assert.equal(qualityKnowledge.status, 200);
    const qualityKnowledgeBody = await qualityKnowledge.json() as {
      records: unknown[];
      authority: string;
      recommendationOnly: boolean;
      executionActivationEnabled: boolean;
      mcpPromotionEnabled: boolean;
    };
    assert.ok(Array.isArray(qualityKnowledgeBody.records));
    assert.equal(qualityKnowledgeBody.authority, 'owner-local-only');
    assert.equal(qualityKnowledgeBody.recommendationOnly, true);
    assert.equal(qualityKnowledgeBody.executionActivationEnabled, false);
    assert.equal(qualityKnowledgeBody.mcpPromotionEnabled, false);

    const recoveryTest = await fetch(`${base}/api/recovery/test`, {
      method: 'POST',
      headers: { 'x-rwmcp-setup-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ tunnelId: 'not-a-tunnel' })
    });
    assert.equal(recoveryTest.status, 200);
    const recoveryTestBody = await recoveryTest.json() as { ok: boolean };
    assert.equal(recoveryTestBody.ok, false);
  } finally {
    await setup.close();
  }
});
