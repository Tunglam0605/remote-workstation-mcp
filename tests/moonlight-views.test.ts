import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { getLanguage, setLanguage, t } from '../assets/moonlight/i18n.js';
import '../assets/moonlight/translations-views.js';
import { createViews } from '../assets/moonlight/views.js';

const viewsPath = path.resolve(import.meta.dirname, '../assets/moonlight/views.js');

test('Moonlight views retain documented owner-control routes', async () => {
  const source = await readFile(viewsPath, 'utf8');
  for (const route of [
    '/api/bootstrap', '/api/recovery/status', '/api/recovery/test', '/api/recovery/apply', '/api/save', '/api/runtime-key', '/api/runtime/action',
    '/api/install-tunnel-client', '/api/permissions/mode', '/api/permissions/config', '/api/permissions/lease',
    '/api/execution-policy', '/api/execution-policy/fallback-reset', '/api/execution-policy/clear-overrides',
    '/api/devices/pairing-code', '/api/devices/bootstrap-ssh', '/api/multi-node/enabled', '/api/multi-node/grants',
    '/api/update/check', '/api/update/config', '/api/update/install'
  ]) assert.match(source, new RegExp(route.replaceAll('/', '\\/')));
});

test('Moonlight views use actual workstation scope names and transient secret inputs', async () => {
  const source = await readFile(viewsPath, 'utf8');
  for (const scope of ['workstation.read', 'workstation.write', 'workstation.execute', 'workstation.admin_request', 'workstation.full_control', 'workstation.cross_node_transfer']) assert.match(source, new RegExp(scope.replace('.', '\\.')));
  assert.match(source, /type: 'password'/);
  assert.match(source, /finally \{ bootstrapKey\.value = ''; \}/);
  assert.match(source, /finally \{ recoveryKey\.value = ''; \}/);
  assert.match(source, /finally \{ bootstrapCode\.value = ''; \}/);
  assert.match(source, /control\.disabled = true/);
  assert.match(source, /timeoutMs = 180_000/);
  assert.doesNotMatch(source, /innerHTML/);
  assert.doesNotMatch(source, /sessionStorage/);
  assert.match(source, /codexModel/);
  assert.match(source, /codexAgentsEnabled/);
  assert.match(source, /codexSkillsEnabled/);
  assert.match(source, /Codex model/);
  assert.match(source, /Enable Codex EAS agents/);
  assert.match(source, /Share Codex skills with RWMCP workers/);
  assert.match(source, /AI worker routing/);
  assert.match(source, /workerRoutingProfile/);
  assert.match(source, /Smart routing/);
  assert.match(source, /worker-route-grid/);
  assert.match(source, /worker-provider-grid/);
  assert.match(source, /Advanced settings/);
  assert.match(source, /restartRequired/);
});

test('opening a view reads store state without issuing an API request', async () => {
  const source = await readFile(viewsPath, 'utf8');
  assert.match(source, /function open\(page\)/);
  assert.match(source, /\(\{ Access: openAccess, Execution: openExecution, Devices: openDevices, Updates: openUpdates, Settings: openSettings \}\[page\] \|\| \(\(\) => \{\}\)\)\(\);/);
  assert.match(source, /function live\(name\) \{ return resource\(store, name\)\.data; \}/);
  assert.match(source, /deriveNotifications\(store\.getState\(\)\)/);
  assert.match(source, /state\.updateAvailable === true \? 'Update available' : state\.updateAvailable === false \? 'Current' : 'Unavailable'/);
});

test('view translations render Vietnamese and preserve English source text', () => {
  setLanguage('vi');
  assert.equal(getLanguage(), 'vi');
  assert.equal(t('Access & owner controls'), 'Quyền truy cập và kiểm soát chủ sở hữu');
  assert.equal(t('Last seen: {value}', { value: '2026-09-22' }), 'Lần cuối thấy: 2026-09-22');
  assert.equal(t('Smart routing'), 'Điều phối thông minh');
  assert.equal(t('AI worker routing'), 'Điều phối AI worker');
  setLanguage('en');
  assert.equal(t('Access & owner controls'), 'Access & owner controls');
  assert.equal(t('Last seen: {value}', { value: '2026-09-22' }), 'Last seen: 2026-09-22');
  setLanguage('vi');
});

function installDom() {
  const previousDocument = globalThis.document;
  const previousConfirm = globalThis.confirm;
  class Node {
    nodeType = 1;
    children: Node[] = [];
    attributes = new Map<string, string>();
    listeners = new Map<string, (event: { currentTarget: Node }) => unknown>();
    className = '';
    checked = false;
    disabled = false;
    value = '';
    private ownText = '';
    classList = { contains: () => false, toggle: () => {} };
    set textContent(value: string) { this.ownText = value; }
    get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(''); }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); if (name === 'value') this.value = value; }
    addEventListener(name: string, handler: (event: { currentTarget: Node }) => unknown) { this.listeners.set(name, handler); }
    append(...children: Node[]) { this.children.push(...children); }
    querySelectorAll(selector: string) { return selector === 'input:checked' ? descendants(this).filter((node) => node.attributes.get('type') === 'checkbox' && node.checked) : []; }
    remove() {}
  }
  const descendants = (node: Node): Node[] => node.children.flatMap((child) => [child, ...descendants(child)]);
  const document = { body: new Node(), createElement: () => new Node(), createTextNode: (value: string) => { const node = new Node(); node.nodeType = 3; node.textContent = value; return node; } };
  globalThis.document = document as never;
  return { Node, descendants, restore: () => { globalThis.document = previousDocument; globalThis.confirm = previousConfirm; } };
}

test('Vietnamese views localize interactive text while retaining backend request values', async () => {
  const dom = installDom();
  const confirmations: string[] = [];
  const requests: Array<{ path: string; options: { body?: unknown } }> = [];
  globalThis.confirm = ((message: string) => { confirmations.push(message); return true; }) as never;
  const state = {
    permissions: { data: { mode: 'read_only', httpScopes: ['workstation.read'], allowHostFilesystem: false, allowRawShell: false } },
    admin: { data: { requests: [] } }, status: { data: { platform: 'win32', settings: {}, onboardingRequired: false } }, runtime: { data: { mode: 'Local', running: true } },
    pairing: { data: { devices: [], bootstrapHosts: [] } }, multiNode: { data: { enabled: false, requiredScope: 'workstation.cross_node_transfer', configurationConsistent: true, grants: [] } }
  };
  const pages: Array<{ title: string; content: InstanceType<typeof dom.Node> }> = [];
  const views = createViews({
    api: { request: async (path: string, options: { body?: unknown }) => { requests.push({ path, options }); return {}; } },
    store: { getState: () => state }, openModal: () => {}, openPage: (_page: string, title: string, content: InstanceType<typeof dom.Node>) => { pages.push({ title, content }); }, toast: () => {}, refresh: async () => {}
  });
  try {
    setLanguage('vi');
    views.open('Access');
    views.open('Devices');
    views.open('Settings');
    const rendered = pages.map((page) => page.content.textContent).join('\n');
    const placeholders = pages.flatMap((page) => dom.descendants(page.content)).map((node) => node.attributes.get('placeholder'));
    assert.match(rendered, /Quyền truy cập và kiểm soát chủ sở hữu/);
    assert.ok(placeholders.includes('Tên thiết bị tùy chọn'));
    assert.ok(placeholders.includes('Để trống để giữ khóa hiện tại'));
    const saveScopes = pages.flatMap((page) => dom.descendants(page.content)).find((node) => node.textContent === 'Lưu phạm vi' && node.listeners.has('click'));
    assert.ok(saveScopes);
    await saveScopes.listeners.get('click')!({ currentTarget: saveScopes });
    assert.equal(confirmations.at(-1), 'Lưu các phạm vi truy cập đã chọn?');
    assert.deepEqual(requests.at(-1), { path: '/api/permissions/config', options: { method: 'POST', body: { httpScopes: ['workstation.read'], allowHostFilesystem: false, allowRawShell: false }, timeoutMs: 180_000 } });
  } finally { dom.restore(); }
});
