import assert from 'node:assert/strict';
import test from 'node:test';
import { setLanguage } from '../assets/moonlight/i18n.js';

class Node {
  children: Node[] = [];
  attributes = new Map<string, string>();
  className = '';
  hidden = false;
  textContent = '';
  title = '';
  dataset: Record<string, string> = {};
  open = false;
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
  close() {}
}

test('active theme text changes with the language while retaining the selected theme', async () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousHistory = globalThis.history;
  const previousLocalStorage = globalThis.localStorage;
  const nodes = new Map<string, Node>();
  const node = (selector: string) => nodes.get(selector) ?? nodes.set(selector, new Node()).get(selector)!;
  try {
    globalThis.document = { body: new Node(), documentElement: new Node(), createElement: () => new Node(), createTextNode: (value: string) => Object.assign(new Node(), { textContent: value }), querySelector: node } as never;
    globalThis.location = { href: 'https://example.test/' } as never;
    globalThis.history = { replaceState: () => {} } as never;
    globalThis.localStorage = { getItem: () => null, setItem: () => {} } as never;
    setLanguage('vi');
    const { createThemeController } = await import(`../assets/moonlight/themes.js?test=${Date.now()}`);
    let modalTitle = '';
    let modalContent = new Node();
    const controller = createThemeController({ openModal: (title: string, content: Node) => { modalTitle = title; modalContent = content; node('#modal').open = true; }, toast: () => {} });
    assert.equal(node('.season h2').textContent, 'Vui Tết Trung Thu');
    setLanguage('en');
    assert.equal(controller.current().id, 'mid-autumn');
    assert.equal(node('.season h2').textContent, 'Celebrate the Mid-Autumn Festival');
    assert.equal(node('.hero').attributes.get('aria-label'), 'Mid-Autumn');
    controller.show();
    assert.equal(modalTitle, 'Seasonal & event themes');
    const rendered = (item: Node): string => item.textContent + item.children.map(rendered).join('');
    assert.match(rendered(modalContent), /Mid-Autumn/);
    setLanguage('vi');
    assert.equal(controller.current().id, 'mid-autumn');
    assert.equal(modalTitle, 'Sắc màu bốn mùa & sự kiện');
  } finally {
    setLanguage('vi');
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
    globalThis.history = previousHistory;
    globalThis.localStorage = previousLocalStorage;
  }
});
