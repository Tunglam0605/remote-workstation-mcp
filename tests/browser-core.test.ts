import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type {
  BrowserElementCandidate,
  BrowserElementTarget,
  BrowserInteraction,
  BrowserProvider,
  BrowserWaitCondition,
  ManagedBrowser
} from '../src/web/browser-provider.js';
import { BrowserCore } from '../src/web/browser-core.js';
import { PlaywrightBrowserProvider } from '../src/web/browser-provider.js';
import { requiredScopeForTool } from '../src/security/request-principal.js';
import { CAPABILITIES } from '../src/capabilities.js';
import { registerBrowserTools } from '../src/tools/browser-tools.js';
import type { AppContext } from '../src/context.js';
import type { McpServer } from '@modelcontextprotocol/server';

const owner = { principalId: 'alice', workSessionId: 'work-1' };

function fakeProvider() {
  let requestHandler: ((route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => Promise<void>) | undefined;
  let url = 'about:blank';
  let closed = false;
  let browserClosed = false;
  let count = 0;
  const interactions: { target: BrowserElementTarget; action: BrowserInteraction }[] = [];
  const uploads: { target: BrowserElementTarget; files: string[] }[] = [];
  const waits: BrowserWaitCondition[] = [];
  let downloadPath = '';
  const page = {
    url: () => url,
    isClosed: () => closed,
    close: async () => { closed = true; },
    title: async () => 'Example'
  };
  const browser = { isConnected: () => !browserClosed, on: () => {}, close: async () => { browserClosed = true; } };
  const context = { route: async (_pattern: string, handler: typeof requestHandler) => { requestHandler = handler; }, on: () => {}, newPage: async () => page };
  const candidates = (maxItems: number): BrowserElementCandidate[] => Array.from({ length: Math.min(count, maxItems) }, (_, index) => ({
    role: 'button',
    name: index === 0 ? 'Save' : `Button ${index + 1}`,
    ordinal: 0,
    visible: true,
    enabled: true
  }));
  const provider: BrowserProvider = {
    availability: () => ({ available: true }),
    launch: async () => ({ browser, context, page, close: async () => { browserClosed = true; } }) as unknown as ManagedBrowser,
    openTab: async () => page as never,
    closeTab: async () => { closed = true; },
    navigate: async (_page, _action, target) => { if (target) url = target; },
    inspect: async (_page, maxItems) => candidates(maxItems),
    find: async (_page, role, name, maxItems) => {
      const matches = candidates(maxItems).filter(item => item.role === role && item.name === name);
      return { matches, truncated: false };
    },
    interact: async (_page, target, action) => { interactions.push({ target, action }); },
    upload: async (_page, target, files) => { uploads.push({ target, files }); },
    download: async () => ({ suggestedFilename: 'artifact.pdf', temporaryPath: downloadPath }),
    wait: async (_page, condition) => { waits.push(condition); },
    extract: async (_page, maxChars) => ({ text: 'x'.repeat(maxChars), truncated: true }),
    screenshot: async () => Buffer.from('image')
  };
  return {
    provider,
    interactions,
    uploads,
    waits,
    setCount: (value: number) => { count = value; },
    setDownloadPath: (value: string) => { downloadPath = value; },
    route: async (target: string) => {
      let outcome = '';
      await requestHandler!({
        request: () => ({ url: () => target }),
        continue: async () => { outcome = 'continued'; },
        abort: async () => { outcome = 'blocked'; }
      });
      return outcome;
    }
  };
}

test('browser tools have explicit read/write/execute scopes and appear in sibling pack', () => {
  const tools = CAPABILITIES.find(capability => capability.id === 'web.automation')!.tools;
  assert.equal(tools.length, 28);
  for (const tool of tools) assert.ok(['workstation.read', 'workstation.write', 'workstation.execute'].includes(requiredScopeForTool(tool)!));
  assert.equal(requiredScopeForTool('browser_profile_status'), 'workstation.read');
  assert.equal(requiredScopeForTool('browser_navigate'), 'workstation.execute');
  assert.equal(requiredScopeForTool('browser_extract'), 'workstation.read');
  assert.equal(requiredScopeForTool('browser_click'), 'workstation.write');
  assert.equal(requiredScopeForTool('browser_fill'), 'workstation.write');
  assert.equal(requiredScopeForTool('browser_wait'), 'workstation.read');
  assert.equal(requiredScopeForTool('browser_upload'), 'workstation.write');
  assert.equal(requiredScopeForTool('browser_download'), 'workstation.write');
  assert.equal(requiredScopeForTool('browser_download_status'), 'workstation.read');
});

test('server registration covers every advertised browser tool', () => {
  const registered: string[] = [];
  const server = { registerTool: (name: string) => { registered.push(name); } } as unknown as McpServer;
  registerBrowserTools(server, {} as AppContext);
  assert.deepEqual(registered.sort(), [...CAPABILITIES.find(capability => capability.id === 'web.automation')!.tools].sort());
});

test('missing browser provider fails cleanly on non-Windows', () => {
  if (process.platform !== 'win32') assert.equal(new PlaywrightBrowserProvider().availability().available, false);
});

test('Windows provider detection tolerates sparse service environments', () => {
  if (process.platform === 'win32') {
    const result = new PlaywrightBrowserProvider().availability();
    assert.equal(result.available, true);
    assert.match(result.executable ?? '', /(chrome|msedge)\.exe$/i);
  }
});

test('unavailable provider reports status without attempting a launch', async () => {
  const fake = fakeProvider();
  const provider: BrowserProvider = { ...fake.provider, availability: () => ({ available: false, reason: 'Browser not installed.' }), launch: async () => { throw new Error('Browser not installed.'); } };
  const core = new BrowserCore(provider);
  assert.equal(core.capabilities().availability.available, false);
  await assert.rejects(core.create(owner), /Browser not installed/);
});

test('sessions enforce principal and Work Session ownership and stale tab handling', async () => {
  const fake = fakeProvider();
  const core = new BrowserCore(fake.provider);
  const { sessionId, tabId } = await core.create(owner);
  assert.throws(() => core.status(sessionId, { ...owner, principalId: 'bob' }), /not found/);
  assert.throws(() => core.status(sessionId, { ...owner, workSessionId: 'other' }), /not found/);
  await core.closeTab(sessionId, tabId, owner);
  assert.throws(() => core.activateTab(sessionId, tabId, owner), /not found/);
  await core.close(sessionId, owner);
  assert.throws(() => core.status(sessionId, owner), /not found/);
});

test('default deny and redirect requests are checked against exact allowlisted host', async () => {
  const fake = fakeProvider();
  const core = new BrowserCore(fake.provider, hostname => hostname === 'example.test');
  const { sessionId, tabId } = await core.create(owner);
  await assert.rejects(core.navigate(sessionId, tabId, owner, 'goto', 'https://evil.test/'), /denied/);
  assert.equal(await fake.route('https://example.test/page'), 'continued');
  assert.equal(await fake.route('https://evil.test/redirect'), 'blocked');
  assert.equal(await fake.route('file:///secret'), 'blocked');
  await core.closeAll();
});

test('no injected domain policy means navigation is denied', async () => {
  const core = new BrowserCore(fakeProvider().provider);
  const { sessionId, tabId } = await core.create(owner);
  await assert.rejects(core.navigate(sessionId, tabId, owner, 'goto', 'https://example.test/'), /denied/);
  await core.closeAll();
});

test('semantic results are bounded and publish short-lived element references', async () => {
  const fake = fakeProvider();
  fake.setCount(100);
  const core = new BrowserCore(fake.provider);
  const { sessionId, tabId } = await core.create(owner);
  const inspected = await core.inspect(sessionId, tabId, owner, 3);
  assert.equal(inspected.elements.length, 3);
  assert.match(inspected.elements[0]!.elementId, /^el_0_1$/);
  const found = await core.find(sessionId, tabId, owner, 'button', 'Save', 2);
  assert.equal(found.matches.length, 1);
  assert.match(found.matches[0]!.elementId, /^el_0_1$/);
  const extracted = await core.extract(sessionId, tabId, owner, 100);
  assert.equal(extracted.text.length, 100);
  assert.equal(extracted.truncated, true);
  await core.closeAll();
});

test('semantic mutation invalidates the previous generation and stale refs fail closed', async () => {
  const fake = fakeProvider();
  fake.setCount(1);
  const core = new BrowserCore(fake.provider);
  const { sessionId, tabId } = await core.create(owner);
  const inspected = await core.inspect(sessionId, tabId, owner, 5);
  const elementId = inspected.elements[0]!.elementId;
  const action = await core.interact(sessionId, tabId, owner, elementId, { kind: 'click' });
  assert.equal(action.generation, 1);
  assert.equal(fake.interactions.length, 1);
  await assert.rejects(core.interact(sessionId, tabId, owner, elementId, { kind: 'click' }), /stale/i);
  const reinspected = await core.inspect(sessionId, tabId, owner, 5);
  assert.match(reinspected.elements[0]!.elementId, /^el_1_1$/);
  await core.closeAll();
});

test('typed wait is bounded and does not mutate tab generation', async () => {
  const fake = fakeProvider();
  const core = new BrowserCore(fake.provider, hostname => hostname === 'example.test');
  const { sessionId, tabId } = await core.create(owner);
  await core.navigate(sessionId, tabId, owner, 'goto', 'https://example.test/');
  const before = core.tabs(sessionId, owner)[0]!.generation;
  const result = await core.wait(sessionId, tabId, owner, { kind: 'text', text: 'Ready', state: 'visible' }, 500);
  assert.equal(result.satisfied, true);
  assert.equal(core.tabs(sessionId, owner)[0]!.generation, before);
  assert.equal(fake.waits.length, 1);
  await core.closeAll();
});


test('upload requires a semantic file input and invalidates its element generation', async () => {
  const fake = fakeProvider();
  fake.setCount(1);
  const core = new BrowserCore(fake.provider);
  const { sessionId, tabId } = await core.create(owner);
  const candidate = {
    role: 'file' as const,
    name: 'Upload PDF',
    ordinal: 0,
    visible: true,
    enabled: true
  };
  fake.provider.inspect = async () => [candidate];
  const inspected = await core.inspect(sessionId, tabId, owner, 5);
  const elementId = inspected.elements[0]!.elementId;
  const uploaded = await core.upload(sessionId, tabId, owner, elementId, [{
    absolutePath: 'C:/workspace/source.pdf',
    name: 'source.pdf',
    bytes: 123,
    mimeType: 'application/pdf'
  }]);
  assert.equal(uploaded.totalBytes, 123);
  assert.deepEqual(fake.uploads[0]!.files, ['C:/workspace/source.pdf']);
  await assert.rejects(core.upload(sessionId, tabId, owner, elementId, [{
    absolutePath: 'C:/workspace/source.pdf',
    name: 'source.pdf',
    bytes: 123,
    mimeType: 'application/pdf'
  }]), /stale/i);
  await core.closeAll();
});

test('download copies into controlled artifacts and returns SHA-256 metadata', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-browser-download-test-'));
  const browserTemp = path.join(temp, 'browser-temp.pdf');
  const artifactRoot = path.join(temp, 'artifacts');
  await fs.writeFile(browserTemp, Buffer.from('%PDF-1.4\nRWMCP\n%%EOF\n'));
  const fake = fakeProvider();
  fake.setDownloadPath(browserTemp);
  fake.provider.inspect = async () => [{
    role: 'link',
    name: 'Download PDF',
    ordinal: 0,
    visible: true,
    enabled: true
  }];
  const core = new BrowserCore(fake.provider, host => host === 'example.test', artifactRoot);
  const { sessionId, tabId } = await core.create(owner);
  await core.navigate(sessionId, tabId, owner, 'goto', 'https://example.test/');
  const inspected = await core.inspect(sessionId, tabId, owner, 5);
  const record = await core.download(sessionId, tabId, owner, inspected.elements[0]!.elementId, 1_000);
  assert.equal(record.status, 'ready');
  assert.equal(record.name, 'artifact.pdf');
  assert.equal(record.mimeType, 'application/pdf');
  assert.equal(record.sourceDomain, 'example.test');
  assert.match(record.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await fs.readFile(record.path, 'utf8')).includes('RWMCP'), true);
  assert.equal(core.downloadStatus(sessionId, owner, record.downloadId).sha256, record.sha256);
  await core.closeAll();
  await fs.rm(temp, { recursive: true, force: true });
});


test('persistent profiles use a dedicated root and enforce one active session per profile', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-browser-profile-test-'));
  const profileRoot = path.join(temp, 'profiles');
  const fake = fakeProvider();
  const launches: (string | undefined)[] = [];
  const originalLaunch = fake.provider.launch;
  fake.provider.launch = async (mode, profileDir) => {
    launches.push(profileDir);
    return await originalLaunch(mode, profileDir);
  };
  const core = new BrowserCore(fake.provider, () => false, path.join(temp, 'artifacts'), profileRoot);
  const before = await core.profileStatus('notebooklm-main');
  assert.equal(before.exists, false);
  assert.equal(before.active, false);

  const first = await core.create(owner, 'background', 'NotebookLM-Main');
  const active = await core.profileStatus('notebooklm-main');
  assert.equal(active.exists, true);
  assert.equal(active.active, true);
  assert.equal(active.sessionId, first.sessionId);
  assert.equal(launches[0], path.join(profileRoot, 'notebooklm-main'));
  await assert.rejects(core.create(owner, 'background', 'notebooklm-main'), /already active/i);

  await core.close(first.sessionId, owner);
  const after = await core.profileStatus('notebooklm-main');
  assert.equal(after.exists, true);
  assert.equal(after.active, false);
  assert.equal(after.sessionId, undefined);
  await fs.rm(temp, { recursive: true, force: true });
});

test('persistent profile names are bounded and cannot escape the managed profile root', async () => {
  const core = new BrowserCore(fakeProvider().provider, () => false, path.join(os.tmpdir(), 'rwmcp-a'), path.join(os.tmpdir(), 'rwmcp-p'));
  await assert.rejects(core.profileStatus('../default'), /profile name/i);
  await assert.rejects(core.create(owner, 'background', 'C:\\Users\\Admin'), /profile name/i);
});
