import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const read = (relative: string) => fs.readFile(path.resolve(relative), 'utf8');

test('owner routing presets map to bounded backend execution settings without unnecessary provider disablement', async () => {
  const source = await read('src/setup/setup-server.ts');
  assert.match(source, /workerRoutingProfile\?: 'direct' \| 'codex-assisted' \| 'smart' \| 'custom'/);
  assert.match(source, /requestedProfile === 'direct'[\s\S]*defaultMode: 'rwmcp-only'/);
  assert.match(source, /requestedProfile === 'codex-assisted'[\s\S]*codexEnabled: true[\s\S]*defaultMode: 'both'/);
  assert.match(source, /requestedProfile === 'smart'[\s\S]*codexEnabled: true[\s\S]*antigravityEnabled: true[\s\S]*defaultMode: 'both'/);
  assert.doesNotMatch(source, /requestedProfile === 'direct'[\s\S]{0,180}codexEnabled: false/);
  assert.doesNotMatch(source, /requestedProfile === 'direct'[\s\S]{0,220}antigravityEnabled: false/);
  assert.match(source, /requestedProfile === 'custom' && typeof body\.codexEnabled === 'boolean'/);
  assert.match(source, /requestedProfile === 'custom' && typeof body\.antigravityEnabled === 'boolean'/);
});

test('Moonlight Execution UX is profile-first and keeps advanced controls secondary', async () => {
  const [views, css, translations] = await Promise.all([
    read('assets/moonlight/views.js'),
    read('assets/moonlight/integration.css'),
    read('assets/moonlight/translations-views.js')
  ]);
  for (const token of [
    'AI worker routing',
    'Routing profile',
    'Direct',
    'Codex assisted',
    'Smart routing',
    'Custom',
    'workerRoutingProfile',
    'worker-route-grid',
    'worker-provider-grid',
    'worker-advanced',
    'Advanced settings',
    'Restart RWMCP now to activate these provider changes?'
  ]) assert.ok(views.includes(token), token);

  assert.match(css, /\.worker-route-card:has\(input:checked\)/);
  assert.match(css, /\.worker-provider-grid/);
  assert.match(css, /@media\(max-width:760px\)[\s\S]*worker-route-grid.*worker-provider-grid/);
  assert.ok(translations.includes("'Smart routing': 'Điều phối thông minh'"));
  assert.ok(translations.includes("'AI worker routing': 'Điều phối AI worker'"));
});

test('Antigravity prompt hardening forbids privilege expansion and keeps dangerous bypass absent', async () => {
  const source = await read('src/workers/antigravity-worker-provider.ts');
  assert.match(source, /Do not request privilege escalation, administrator\/root access/);
  assert.match(source, /stay inside the current sandbox/);
  assert.match(source, /Do not leave the assigned worktree/);
  assert.doesNotMatch(source, /--dangerously-skip-permissions/);
});
