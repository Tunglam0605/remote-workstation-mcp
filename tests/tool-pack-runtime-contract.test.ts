import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('Windows managed runtime projects persisted OpenAI tool packs into runtime environment', async () => {
  const settings = await fs.readFile('scripts/windows-settings.ps1', 'utf8');
  assert.match(settings, /openaiToolPacks/);
  assert.match(settings, /RWMCP_OPENAI_TOOL_PACKS/);
  assert.match(settings, /-join ','/);
});

test('Linux Direct Node persists and reloads the same OpenAI tool-pack contract', async () => {
  const server = await fs.readFile('src/setup/setup-server.ts', 'utf8');
  assert.match(server, /RWMCP_OPENAI_TOOL_PACKS/);
  assert.match(server, /settings\.openaiToolPacks/);
  assert.match(server, /parseOpenAiToolPacks/);
  assert.match(server, /syncLinuxDirectNodeSettings/);
});

test('Moonlight Settings exposes only canonical reusable OpenAI packs and reports restart requirement', async () => {
  const views = await fs.readFile('assets/moonlight/views.js', 'utf8');
  for (const pack of ['camera', 'canopen', 'media', 'social', 'industrial']) {
    assert.match(views, new RegExp(`['"]${pack}['"]`));
  }
  assert.match(views, /openaiToolPacks/);
  assert.match(views, /Runtime capability changes were saved/);
  assert.match(views, /restartRequired/);
});

test('runtime settings save marks tool-pack, browser and social capability changes as restart-relevant', async () => {
  const server = await fs.readFile('src/setup/setup-server.ts', 'utf8');
  assert.match(server, /toolPacksChanged/);
  assert.match(server, /browserSettingsChanged/);
  assert.match(server, /socialSettingsChanged/);
  assert.match(server, /restartRequired:\s*runtimeSettingsChanged/);
});
