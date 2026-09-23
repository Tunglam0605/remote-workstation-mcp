import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('Moonlight shell provides one secondary-page heading and localizes console copy', async () => {
  const [html, app, views, translationModule] = await Promise.all([
    readFile(path.join(root, 'assets/moonlight/index.html'), 'utf8'),
    readFile(path.join(root, 'assets/moonlight/app.js'), 'utf8'),
    readFile(path.join(root, 'assets/moonlight/views.js'), 'utf8'),
    readFile(path.join(root, 'assets/moonlight/translations-shell.js'), 'utf8')
  ]);

  assert.match(html, /id="page-outlet"/);
  assert.match(app, /outlet\.replaceChildren\(content\)/);
  assert.doesNotMatch(app, /class: 'page-heading'/);
  assert.match(app, /function greetingSource\(now = new Date\(\)\)/);
  assert.match(app, /timeZone: 'Asia\/Ho_Chi_Minh'/);
  assert.match(app, /Hybrid · RWMCP \+ Codex/);
  assert.match(views, /\['both', 'Hybrid · RWMCP \+ Codex'\]/);
  assert.match(views, /Specialist worker · Antigravity/);
  for (const source of [
    'Create session', 'Run permitted task', 'Read output', 'Stop process',
    'Execution catalogue unavailable: {message}', 'Session selected · choose a permitted task',
    'No output is available yet.', 'Notifications, {count} unread'
  ]) assert.match(translationModule, new RegExp(`'${source.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}'`));
});
