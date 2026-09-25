import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('Moonlight shell provides one secondary-page heading and localizes console copy', async () => {
  const [html, app, translationModule] = await Promise.all([
    readFile(path.join(root, 'assets/moonlight/index.html'), 'utf8'),
    readFile(path.join(root, 'assets/moonlight/app.js'), 'utf8'),
    readFile(path.join(root, 'assets/moonlight/translations-shell.js'), 'utf8')
  ]);

  assert.match(html, /id="page-outlet"/);
  assert.match(app, /outlet\.replaceChildren\(content\)/);
  assert.doesNotMatch(app, /class: 'page-heading'/);
  for (const source of [
    'Create session', 'Run permitted task', 'Read output', 'Stop process',
    'Execution catalogue unavailable: {message}', 'Session selected · choose a permitted task',
    'No output is available yet.', 'Notifications, {count} unread',
    'Good morning,', 'Good afternoon,', 'Good evening,'
  ]) assert.match(translationModule, new RegExp(`'${source.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}'`));
  assert.match(app, /greetingSource\(now\)/);
  assert.match(app, /CONTROL_CENTER_TIME_ZONE/);
  assert.doesNotMatch(app, /tr\('Good evening,'\)/);
  assert.doesNotMatch(html, /Good evening,/);
  assert.match(html, /class="overview-command"/);
  assert.match(html, /id="overview-health"/);
  assert.match(html, /id="overview-ai-mode"/);
  assert.match(html, /id="overview-attention"/);
  assert.match(html, /data-quick-page="Agents"/);
  assert.match(app, /renderOverviewSummary\(resources, notices\)/);
  assert.match(app, /data-nav-group/);
  assert.match(app, /store\.refresh\(\['status', 'runtime', 'execution', 'antigravity', 'updates', 'admin'\]\)/);
  for (const source of ['At a glance', 'Ready to work', 'Quick actions', 'AI & routing', 'Overview refreshed.']) assert.ok(translationModule.includes(`'${source}'`));
});
