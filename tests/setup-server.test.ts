import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
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
    assert.match(pageText, /Moonlight · MCP Control Center/);
    assert.match(pageText, /Vui Tết Trung Thu/);
    assert.match(pageText, /Kết Nối Yêu Thương/);
    assert.match(pageText, /Đêm Trung Thu/);
    assert.match(pageText, /id="devices"/);
    assert.match(pageText, /id="command-form"/);
    assert.match(pageText, /type="module" src="\/assets\/moonlight\/app.js"/);
    assert.doesNotMatch(pageText, /__RWMCP_SETUP_TOKEN__|cc-sidebar|DEMO UI|Simulate/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const csp = page.headers.get('content-security-policy') ?? '';
    assert.ok(csp.includes("script-src 'self'"));
    assert.ok(!csp.includes("script-src 'unsafe-inline'"));
    assert.ok(csp.includes("frame-ancestors 'none'"));
    for (const [name, mime] of [['app.js', 'text/javascript'], ['i18n.js', 'text/javascript'], ['time.js', 'text/javascript'], ['translations-shell.js', 'text/javascript'], ['translations-views.js', 'text/javascript'], ['style.css', 'text/css'], ['assets/mid-autumn.png', 'image/png'], ['assets/font-0.woff2', 'font/woff2']]) {
      const asset = await fetch(base + '/assets/moonlight/' + name);
      assert.equal(asset.status, 200, name);
      assert.ok(asset.headers.get('content-type')?.startsWith(mime!), name);
      assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
      assert.ok((await asset.arrayBuffer()).byteLength > 0);
    }

    const logo = await fetch(`${base}/assets/brand/logo.png`);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('content-type'), 'image/png');
    const signature = await fetch(`${base}/assets/brand/logo-background.png`);
    assert.equal(signature.status, 200);
    assert.equal(signature.headers.get('content-type'), 'image/png');
    const tokenMatch = pageText.match(/<meta name="rwmcp-setup-token" content="([A-Za-z0-9_-]+)">/);
    assert.ok(tokenMatch, 'Control Center page should embed an ephemeral CSRF token.');
    const token = tokenMatch[1]!;
    assert.ok(token.length >= 32);
    assert.ok(!setup.url.includes(token), 'CSRF token must not be placed in the URL.');

    const missing = await fetch(`${base}/api/status`);
    assert.equal(missing.status, 403);

    const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
      http.get(base, { headers: { host: 'attacker.invalid' } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      }).on('error', reject);
    });
    assert.equal(foreignHost, 403, 'A foreign Host must not receive the owner page token.');

    for (const method of ['GET', 'POST']) {
      const unauthenticatedExecution = await fetch(`${base}/api/execution`, { method });
      assert.equal(unauthenticatedExecution.status, 403);
    }

    const wrongOrigin = await fetch(`${base}/api/status`, {
      headers: {
        'x-rwmcp-setup-token': token,
        origin: 'https://example.invalid'
      }
    });
    assert.equal(wrongOrigin.status, 403);

    const wrongToken = await fetch(base + '/api/status', { headers: { 'x-rwmcp-setup-token': 'wrong' } });
    assert.equal(wrongToken.status, 403);
    for (const resource of ['index.html', 'unknown.js', 'assets/../../package.json', '%2e%2e%2fsrc%2fsetup%2fsettings.ts']) {
      const denied = await fetch(base + '/assets/moonlight/' + resource, { headers: { 'x-rwmcp-setup-token': token } });
      assert.equal(denied.status, 404, resource);
    }

    const ok = await fetch(`${base}/api/status`, {
      headers: { 'x-rwmcp-setup-token': token }
    });
    assert.equal(ok.status, 200);
    const body = await ok.json() as { version: string; onboardingRequired: boolean; settings: { mcpPort: number } };
    assert.equal(body.version, SERVER_VERSION);
    assert.ok(Number.isInteger(body.settings.mcpPort));
    assert.equal(typeof body.onboardingRequired, 'boolean');

    const catalogResponse = await fetch(`${base}/api/execution`, { headers: { 'x-rwmcp-setup-token': token } });
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json() as { authority: string; node: { id: string }; operations: string[] };
    assert.equal(catalog.authority, 'owner-local-only');
    assert.ok(catalog.operations.includes('git-status'));
    for (const request of [
      { op: 'git-status', nodeId: 'remote-node', sessionId: 'missing' },
      { op: 'task-run', nodeId: catalog.node.id, sessionId: 'missing', profile: 'unknown', shell: 'echo injected' }
    ]) {
      const denied = await fetch(`${base}/api/execution`, { method: 'POST', headers: { 'x-rwmcp-setup-token': token, 'content-type': 'application/json' }, body: JSON.stringify(request) });
      assert.equal(denied.status, 400);
    }

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
