import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setLanguage } from '../assets/moonlight/i18n.js';
import { resolveAutomaticTheme, seasonForMonth } from '../assets/moonlight/themes.js';

const root = path.resolve(import.meta.dirname, '..');

class Node {
  children: Node[] = [];
  attributes = new Map<string, string>();
  className = '';
  hidden = false;
  textContent = '';
  title = '';
  dataset: Record<string, string> = {};
  open = false;
  disabled = false;
  style = { backgroundImage: '', setProperty: () => {} };
  private classes = new Set<string>();
  classList = {
    remove: (...names: string[]) => names.forEach((name) => this.classes.delete(name)),
    add: (...names: string[]) => names.forEach((name) => this.classes.add(name)),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force?: boolean) => force === undefined ? this.classes.has(name) ? (this.classes.delete(name), false) : (this.classes.add(name), true) : (force ? this.classes.add(name) : this.classes.delete(name), force)
  };
  after(child: Node) { this.children.push(child); }
  append(...children: Node[]) { this.children.push(...children); }
  replaceChildren(...children: Node[]) { this.children = children; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener() {}
  close() { this.open = false; }
}

test('automatic Moonlight theme follows season outside event windows', () => {
  assert.equal(seasonForMonth(3), 'spring');
  assert.equal(seasonForMonth(6), 'summer');
  assert.equal(seasonForMonth(9), 'autumn');
  assert.equal(seasonForMonth(12), 'winter');

  const september28 = resolveAutomaticTheme(new Date('2026-09-28T03:00:00Z'));
  assert.equal(september28.id, 'autumn');
  assert.equal(september28.season, 'autumn');
  assert.equal(september28.event, null);
});

test('automatic Moonlight theme uses bounded event windows and expires back to season', () => {
  const tooEarly = resolveAutomaticTheme(new Date('2026-09-18T16:59:59Z'));
  assert.equal(tooEarly.id, 'autumn');

  const fiveDaysBefore = resolveAutomaticTheme(new Date('2026-09-19T17:00:00Z'));
  assert.equal(fiveDaysBefore.id, 'mid-autumn');
  assert.equal(fiveDaysBefore.event?.delta, 5);

  const eventDay = resolveAutomaticTheme(new Date('2026-09-24T17:00:00Z'));
  assert.equal(eventDay.id, 'mid-autumn');
  assert.equal(eventDay.event?.delta, 0);

  const oneDayAfter = resolveAutomaticTheme(new Date('2026-09-25T17:00:00Z'));
  assert.equal(oneDayAfter.id, 'mid-autumn');
  assert.equal(oneDayAfter.event?.delta, -1);

  const expired = resolveAutomaticTheme(new Date('2026-09-26T17:00:00Z'));
  assert.equal(expired.id, 'autumn');

  const nationalDay = resolveAutomaticTheme(new Date('2026-08-27T17:00:00Z'));
  assert.equal(nationalDay.id, 'national-day');
  assert.equal(nationalDay.event?.delta, 5);
});

test('overlapping 30 April and 1 May windows select the nearest event', () => {
  const april30 = resolveAutomaticTheme(new Date('2026-04-29T17:00:00Z'));
  assert.equal(april30.id, 'reunification');
  assert.equal(april30.event?.delta, 0);

  const may1 = resolveAutomaticTheme(new Date('2026-04-30T17:00:00Z'));
  assert.equal(may1.id, 'labour-day');
  assert.equal(may1.event?.delta, 0);
});

test('active automatic theme localizes without changing its resolved identity', async () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousHistory = globalThis.history;
  const previousLocalStorage = globalThis.localStorage;
  const previousSessionStorage = globalThis.sessionStorage;
  const nodes = new Map<string, Node>();
  const node = (selector: string) => nodes.get(selector) ?? nodes.set(selector, new Node()).get(selector)!;
  try {
    globalThis.document = {
      body: new Node(),
      documentElement: new Node(),
      createElement: () => new Node(),
      createTextNode: (value: string) => Object.assign(new Node(), { textContent: value }),
      querySelector: node,
      querySelectorAll: () => []
    } as never;
    globalThis.location = { href: 'https://example.test/?theme=mid-autumn' } as never;
    globalThis.history = { replaceState: () => {} } as never;
    globalThis.localStorage = { getItem: () => 'mid-autumn', setItem: () => {}, removeItem: () => {} } as never;
    globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} } as never;

    setLanguage('vi');
    const { createThemeController } = await import(`../assets/moonlight/themes.js?test=${Date.now()}`);
    let modalTitle = '';
    let modalContent = new Node();
    const controller = createThemeController({
      openModal: (title: string, content: Node) => {
        modalTitle = title;
        modalContent = content;
        node('#modal').open = true;
      },
      toast: () => {}
    });
    const id = controller.current().id;
    assert.equal(id, resolveAutomaticTheme(new Date()).id);
    assert.equal(controller.mode(), 'automatic');
    assert.equal(node('.hero').attributes.get('aria-label')?.length! > 0, true);

    setLanguage('en');
    assert.equal(controller.current().id, id);
    controller.show();
    assert.equal(modalTitle, 'Seasonal & event themes');
    const rendered = (item: Node): string => item.textContent + item.children.map(rendered).join('');
    assert.match(rendered(modalContent), /Automatic cycle/);

    setLanguage('vi');
    assert.equal(controller.current().id, id);
    assert.equal(modalTitle, 'Sắc màu bốn mùa & sự kiện');
  } finally {
    setLanguage('vi');
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
    globalThis.history = previousHistory;
    globalThis.localStorage = previousLocalStorage;
    globalThis.sessionStorage = previousSessionStorage;
  }
});

test('manual theme override is session-only and legacy persistent override is cleared', async () => {
  const source = await readFile(path.join(root, 'assets/moonlight/themes.js'), 'utf8');
  const shell = await readFile(path.join(root, 'assets/moonlight/index.html'), 'utf8');

  assert.match(source, /sessionStorage\.getItem\(SESSION_KEY\)/);
  assert.match(source, /sessionStorage\.setItem\(SESSION_KEY, theme\.id\)/);
  assert.match(source, /sessionStorage\.removeItem\(SESSION_KEY\)/);
  assert.match(source, /localStorage\.removeItem\(LEGACY_KEY\)/);
  assert.doesNotMatch(source, /localStorage\.setItem\(LEGACY_KEY/);
  assert.doesNotMatch(source, /searchParams\.set\('theme'/);
  assert.match(shell, /data-theme-ready="false"/);
  assert.doesNotMatch(shell, /class="overview-command"/);
});
