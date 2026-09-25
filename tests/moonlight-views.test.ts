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
});

test('opening a view reads store state without issuing an API request', async () => {
  const source = await readFile(viewsPath, 'utf8');
  assert.match(source, /function open\(page\)/);
  for (const mapping of ['Work: openWork', 'Agents: openExecution', 'Engineering: openEngineering', 'Office: openOffice', 'Web: openWeb', 'Devices: openDevices', 'Security: openAccess', 'System: openSystem']) assert.match(source, new RegExp(mapping.replace(/[.*+?^${}()|[\\]\\]/g, '\\  assert.match(source, /\(\{ Access: openAccess, Execution: openExecution, Devices: openDevices, Updates: openUpdates, Settings: openSettings \}\[page\] \|\| \(\(\) => \{\}\)\)\(\);/);')));
  assert.match(source, /function capabilityDomain\(/);
  assert.match(source, /Advanced access scopes/);
  assert.match(source, /security-summary/);
  assert.match(source, /security-primary-grid/);
  assert.match(source, /security-admin-section/);
  assert.match(source, /Show command hash/);
  assert.match(source, /Pair a new device/);
  assert.match(source, /Advanced multi-node transfers/);
  assert.match(source, /live\('capabilities'\)/);
  assert.match(source, /function live\(name\) \{ return resource\(store, name\)\.data; \}/);
  assert.match(source, /deriveNotifications\(store\.getState\(\)\)/);
  assert.match(source, /state\.updateAvailable === true \? 'Update available' : state\.updateAvailable === false \? 'Current' : 'Unavailable'/);
});

test('view translations render Vietnamese and preserve English source text', () => {
  setLanguage('vi');
  assert.equal(getLanguage(), 'vi');
  assert.equal(t('Access & owner controls'), 'Quyền truy cập và kiểm soát chủ sở hữu');
  assert.equal(t('Last seen: {value}', { value: '2026-09-22' }), 'Lần cuối thấy: 2026-09-22');
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
    append(...children: Node[]) {
      this.children.push(...children);
      const selected = children.find((child) => child.attributes.has('selected'));
      if (selected) this.value = selected.value;
    }
    querySelectorAll(selector: string) {
      if (selector === 'input:checked') return descendants(this).filter((node) => node.attributes.get('type') === 'checkbox' && node.checked);
      if (selector === '.agent-strategy-card') return descendants(this).filter((node) => node.className.split(/\s+/).includes('agent-strategy-card'));
      return [];
    }
    querySelector(selector: string) {
      if (selector === 'input[name="execution-strategy"]:checked') return descendants(this).find((node) => node.attributes.get('name') === 'execution-strategy' && node.checked);
      if (selector === 'input') return descendants(this).find((node) => node.attributes.has('type'));
      return undefined;
    }
    remove() {}
  }
  const descendants = (node: Node): Node[] => node.children.flatMap((child) => [child, ...descendants(child)]);
  const document = { body: new Node(), createElement: () => new Node(), createTextNode: (value: string) => { const node = new Node(); node.nodeType = 3; node.textContent = value; return node; } };
  globalThis.document = document as never;
  return { Node, descendants, restore: () => { globalThis.document = previousDocument; globalThis.confirm = previousConfirm; } };
}

test('Execution leads with simple routing choices while retaining advanced modes and technical controls', () => {
  const dom = installDom();
  const pages: Array<InstanceType<typeof dom.Node>> = [];
  const state = {
    execution: { data: {
      settings: { targetMode: 'rwmcp-only', defaultMode: 'rwmcp-only', workerRoutingProfile: 'custom', codexEnabled: true, antigravityEnabled: false, allowChatOverride: true, codexFallback: 'stop' },
      status: { effectiveMode: 'rwmcp-only', source: 'owner-default', activeSessionOverrides: 2 },
      codex: { installed: true, authenticated: true }, accountBroker: { effectiveBackend: 'blocked', pool: { detail: 'Pool unreachable' } },
      executionExperience: {
        timeline: { tool: 'work_objective_execution_timeline', progressModel: 'stage-only', authority: 'caller-owned-work-session-read-only' },
        cancellation: { providerIds: ['codex-local', 'antigravity-local'], mechanism: 'abort-signal-process-tree', terminalStateAuthoritative: true },
        ownerUiSessionTimeline: false
      }
    } },
    antigravity: { data: { available: true, authenticated: true, quotaGroups: [{ buckets: [{ window: 'weekly', remainingFraction: 0.95 }] }] } }
  };
  try {
    setLanguage('en');
    const views = createViews({ api: { request: async () => ({}) }, store: { getState: () => state },
      openModal: () => {}, openPage: (_page: string, _title: string, content: InstanceType<typeof dom.Node>) => { pages.push(content); }, toast: () => {}, refresh: async () => {} });
    views.open('Execution');
    const rendered = pages[0]!.textContent;
    assert.match(rendered, /How should AI work\?/);
    assert.match(rendered, /Choose how work is routed/);
    assert.match(rendered, /Auto \/ Smart/);
    assert.match(rendered, /Recommended/);
    assert.match(rendered, /RWMCP only/);
    assert.match(rendered, /Codex only/);
    assert.match(rendered, /Antigravity only/);
    assert.match(rendered, /More routing combinations/);
    assert.match(rendered, /RWMCP \+ Codex/);
    assert.match(rendered, /Codex \+ Antigravity/);
    assert.match(rendered, /All three/);
    assert.match(rendered, /What happens automatically/);
    assert.match(rendered, /Antigravity is preferred for interface and visual work/);
    assert.match(rendered, /Codex is preferred for backend, code, debugging, and engineering work/);
    assert.match(rendered, /RWMCP is preferred for deterministic workstation, Office, build, test, and read operations/);
    assert.match(rendered, /Available execution targets/);
    assert.match(rendered, /RWMCP Direct/);
    assert.match(rendered, /OpenAI Codex/);
    assert.match(rendered, /Google Antigravity/);
    assert.match(rendered, /Not selected/);
    assert.match(rendered, /Agent activity & control/);
    assert.match(rendered, /Safe cancel/);
    assert.match(rendered, /Stage timeline/);
    assert.match(rendered, /Started/);
    assert.match(rendered, /Current target/);
    assert.match(rendered, /Fallback \/ result/);
    assert.match(rendered, /Final outcome/);
    assert.match(rendered, /work_objective_execution_timeline/);
    assert.match(rendered, /owner-local Control Center intentionally does not expose another session/);
    assert.doesNotMatch(rendered, /[0-9]+% complete/);
    assert.match(rendered, /Technical details/);
    assert.match(rendered, /When AI targets are exhausted/);
    setLanguage('vi');
    assert.equal(t('How should AI work?'), 'AI n\u00ean l\u00e0m vi\u1ec7c nh\u01b0 th\u1ebf n\u00e0o?');
    assert.equal(t('Save AI settings'), 'L\u01b0u c\u00e0i \u0111\u1eb7t AI');
  } finally { dom.restore(); }
});

test('Agent Control saves the selected route and provider settings through the existing execution-policy API', async () => {
  const dom = installDom();
  const requests: Array<{ path: string; options: { body?: any; method?: string } }> = [];
  const pages: Array<InstanceType<typeof dom.Node>> = [];
  globalThis.confirm = (() => true) as never;
  const state = {
    execution: { data: {
      settings: {
        targetMode: 'auto',
        defaultMode: 'both',
        workerRoutingProfile: 'smart',
        codexEnabled: true,
        codexModel: 'gpt-6-sol',
        codexAgentsEnabled: true,
        codexSkillsEnabled: true,
        antigravityEnabled: true,
        antigravityModel: '',
        allowChatOverride: true,
        codexFallback: 'rwmcp-only',
        maxCodexTasksPerSession: 0,
        maxCodexTasksPerDay: 0,
        codexAccountBroker: { enabled: true, mode: 'cockpit-api-pool' }
      },
      status: { effectiveMode: 'both', configuredMode: 'both', source: 'owner-default', activeSessionOverrides: 0 },
      codex: { installed: true, authenticated: true, version: 'codex-cli test' },
      accountBroker: { effectiveBackend: 'cockpit-api-pool' },
      executionExperience: {
        timeline: { tool: 'work_objective_execution_timeline', progressModel: 'stage-only', authority: 'caller-owned-work-session-read-only' },
        cancellation: { providerIds: ['codex-local', 'antigravity-local'], mechanism: 'abort-signal-process-tree', terminalStateAuthoritative: true },
        ownerUiSessionTimeline: false
      }
    } },
    antigravity: { data: { available: true, authenticated: true, version: '1.2.9', model: { id: 'test-model' }, quotaGroups: [{ buckets: [{ window: 'weekly', remainingFraction: 0.8 }] }] } }
  };
  try {
    setLanguage('en');
    const views = createViews({
      api: { request: async (path: string, options: { body?: any; method?: string }) => {
        requests.push({ path, options });
        return { restartRequired: false };
      } },
      store: { getState: () => state },
      openModal: () => {},
      openPage: (_page: string, _title: string, content: InstanceType<typeof dom.Node>) => { pages.push(content); },
      toast: () => {},
      refresh: async () => {}
    });
    views.open('Execution');
    const page = pages[0]!;
    const save = dom.descendants(page).find((node) => node.textContent === 'Save AI settings' && node.listeners.has('click'));
    assert.ok(save);
    await save.listeners.get('click')!({ currentTarget: save });
    const request = requests.find((item) => item.path === '/api/execution-policy');
    assert.ok(request);
    assert.equal(request.options.method, 'POST');
    assert.deepEqual(request.options.body, {
      targetMode: 'auto',
      codexModel: 'gpt-6-sol',
      codexAgentsEnabled: true,
      codexSkillsEnabled: true,
      antigravityModel: '',
      allowChatOverride: true,
      codexFallback: 'rwmcp-only',
      maxCodexTasksPerSession: 0,
      maxCodexTasksPerDay: 0,
      codexAccountBroker: { enabled: true, mode: 'cockpit-api-pool' }
    });
  } finally { dom.restore(); }
});

test('Security page balances primary controls and keeps advanced scopes full-width', () => {
  const dom = installDom();
  const pages: Array<{ title: string; content: InstanceType<typeof dom.Node> }> = [];
  const state = {
    permissions: { data: { mode: 'full_control', httpScopes: ['workstation.read', 'workstation.full_control'], allowHostFilesystem: true, allowRawShell: true, lease: undefined } },
    admin: { data: { requests: [{ id: 'req-1', program: 'powershell.exe', state: 'pending', reason: 'Read-only diagnostic', commandHash: 'abc123' }] } },
    status: { data: { platform: 'win32' } }
  };
  try {
    setLanguage('en');
    const views = createViews({ api: { request: async () => ({}) }, store: { getState: () => state }, openModal: () => {}, openPage: (_page: string, title: string, content: InstanceType<typeof dom.Node>) => pages.push({ title, content }), toast: () => {}, refresh: async () => {} });
    views.open('Access');
    const page = pages[0]!.content;
    const rendered = page.textContent;
    assert.match(rendered, /Security & access/);
    assert.match(rendered, /Permission mode/);
    assert.match(rendered, /Full-control lease/);
    assert.match(rendered, /1 pending request/);
    assert.match(rendered, /Advanced access scopes/);
    assert.match(rendered, /Read-only diagnostic/);
    assert.match(rendered, /Show command hash/);
    assert.equal(dom.descendants(page).filter((node) => node.className.includes('security-primary-card')).length, 2);
    assert.ok(dom.descendants(page).some((node) => node.className.includes('security-admin-section')));
  } finally { dom.restore(); }
});

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
    assert.match(rendered, /B\u1ea3o m\u1eadt & truy c\u1eadp/);
    assert.ok(placeholders.includes('Tên thiết bị tùy chọn'));
    assert.ok(placeholders.includes('Để trống để giữ khóa hiện tại'));
    const saveScopes = pages.flatMap((page) => dom.descendants(page.content)).find((node) => node.textContent === 'Lưu phạm vi' && node.listeners.has('click'));
    assert.ok(saveScopes);
    await saveScopes.listeners.get('click')!({ currentTarget: saveScopes });
    assert.equal(confirmations.at(-1), 'Lưu các phạm vi truy cập đã chọn?');
    assert.deepEqual(requests.at(-1), { path: '/api/permissions/config', options: { method: 'POST', body: { httpScopes: ['workstation.read'], allowHostFilesystem: false, allowRawShell: false }, timeoutMs: 180_000 } });
  } finally { dom.restore(); }
});


test('domain pages are capability-driven and keep providers below their domain', () => {
  const dom = installDom();
  const pages: Array<{ title: string; content: InstanceType<typeof dom.Node> }> = [];
  const state = {
    capabilities: { data: { capabilities: [
      { id: 'engineering.hardware', status: 'available', tools: ['hardware_list'], note: 'Hardware' },
      { id: 'office.word.inspect', status: 'available', tools: ['word_inspect'], note: 'Word inspect' },
      { id: 'web.automation', status: 'available', tools: ['browser_inspect'], note: 'Browser' },
      { id: 'agent.antigravity_worker', status: 'available', tools: ['antigravity_status'], note: 'Worker' }
    ] } },
    runtime: { data: { running: true } },
    updates: { data: { installedVersion: '0.36.0', latestVersion: '0.36.0' } },
    status: { data: { platform: 'win32' } }
  };
  try {
    setLanguage('en');
    const views = createViews({
      api: { request: async () => ({}) },
      store: { getState: () => state },
      openModal: () => {},
      openPage: (_page: string, title: string, content: InstanceType<typeof dom.Node>) => { pages.push({ title, content }); },
      openExecutionConsole: () => {},
      toast: () => {},
      refresh: async () => {}
    });
    views.open('Engineering');
    views.open('Office');
    views.open('Web');
    views.open('System');

    assert.match(pages[0]!.content.textContent, /What you can do/);
    assert.match(pages[0]!.content.textContent, /Hardware/);
    assert.match(pages[0]!.content.textContent, /Technical details/);
    assert.match(pages[0]!.content.textContent, /engineering\.hardware/);
    assert.doesNotMatch(pages[0]!.content.textContent, /agent\.antigravity_worker/);
    assert.match(pages[1]!.content.textContent, /office\.word\.inspect/);
    assert.match(pages[2]!.content.textContent, /web\.automation/);
    assert.match(pages[3]!.content.textContent, /Runtime & recovery/);
    assert.match(pages[3]!.content.textContent, /Updates/);
  } finally { dom.restore(); }
});
