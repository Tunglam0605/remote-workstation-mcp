import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const dir = path.join(process.cwd(), 'assets', 'chatgpt-approval-voice-alert');
const load = (name: string) => readFileSync(path.join(dir, name), 'utf8');

type DialogInput = { visible: boolean; buttons: string[]; text: string };
function detector() {
  const sandbox: Record<string, unknown> = {};
  vm.runInNewContext(load('detector.js'), sandbox);
  return sandbox.RwmcpApprovalDetector as { isApprovalDialog: (input: DialogInput) => boolean };
}

test('classifies English and Vietnamese ChatGPT tool approvals', () => {
  const d = detector();
  assert.equal(d.isApprovalDialog({
    visible: true, buttons: ['Deny', 'Allow', 'Always Allow'],
    text: 'ChatGPT requests permission to use Remote Workstation MCP tool'
  }), true);
  assert.equal(d.isApprovalDialog({
    visible: true, buttons: ['Từ chối', 'Cho phép', 'Luôn cho phép'],
    text: 'ChatGPT yêu cầu cấp quyền sử dụng công cụ'
  }), true);
});

test('does not alert for hidden, unrelated or buttonless content', () => {
  const d = detector();
  for (const input of [
    { visible: false, buttons: ['Allow'], text: 'tool permission required' },
    { visible: true, buttons: ['Save', 'Cancel'], text: 'ChatGPT tool permission' },
    { visible: true, buttons: ['Allow'], text: 'Allow this cookie preference' },
    { visible: true, buttons: [], text: 'Allow tool access' }
  ]) assert.equal(d.isApprovalDialog(input), false);
});

test('extension scope limited to ChatGPT, speech and local settings', () => {
  const manifest = JSON.parse(load('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['tts', 'storage']);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    'https://chatgpt.com/*', 'https://chat.openai.com/*'
  ]);
  assert.equal(manifest.content_scripts[0].all_frames, false);
  assert.equal(manifest.action.default_popup, 'popup.html');
  const code = ['service-worker.js', 'content-script.js', 'popup.js'].map(load).join('\n');
  assert.doesNotMatch(code, /\.click\(|\bexecuteScript\b|\bscripting\b|\bdebugger\b|\bfetch\(|\bXMLHttpRequest\b/);
  assert.match(code, /chrome\.tts\.speak/);
  assert.match(code, /MutationObserver/);
  assert.match(load('popup.html'), /id="enabled"/);
  assert.match(load('popup.html'), /id="volume"/);
  assert.match(load('popup.html'), /id="test"/);
});

type WorkerHarness = {
  emit: (message: Record<string, string>, sender: Record<string, unknown>) => Promise<unknown>;
  said: Array<{ words: string; options: Record<string, unknown> }>;
  setEnabled: (enabled: boolean) => void;
};
function makeWorker(voiceLanguages: string[] = ['vi-VN']): WorkerHarness {
  let handler: (m: unknown, s: unknown, reply: (v: unknown) => void) => boolean;
  let enabled = true;
  const said: Array<{ words: string; options: Record<string, unknown> }> = [];
  const chrome = {
    runtime: {
      id: 'test-extension',
      getURL: (file: string) => 'chrome-extension://test-extension/' + file,
      onMessage: { addListener(fn: typeof handler) { handler = fn; } }
    },
    storage: {
      local: { get: async () => ({ enabled, volume: 0.65 }), set: async () => undefined }
    },
    tts: {
      getVoices: async () => voiceLanguages.map((lang, i) => ({ lang, voiceName: 'voice-' + i })),
      stop: async () => undefined,
      speak: async (words: string, options: Record<string, unknown>) => {
        said.push({ words, options });
      }
    }
  };
  const sandbox = { chrome, URL, Date, Promise, Number, Set, String };
  vm.runInNewContext(load('service-worker.js'), sandbox);
  return {
    said,
    setEnabled: value => { enabled = value; },
    emit: (message, sender) => new Promise((resolve, reject) => {
      const keepAlive = handler(message, sender, resolve);
      if (keepAlive !== true) reject(new Error('message rejected'));
    })
  };
}

const validTab = {
  id: 'test-extension', frameId: 0, tab: { id: 12 },
  url: 'https://chatgpt.com/c/test'
};
const popupSender = {
  id: 'test-extension', url: 'chrome-extension://test-extension/popup.html'
};

test('speaks Vietnamese only for a trusted top-level ChatGPT approval', async () => {
  const worker = makeWorker(['en-US', 'vi-VN']);
  const result = await worker.emit({ type: 'rwmcp.approval.alert' }, validTab);
  assert.equal((result as { ok: boolean }).ok, true);
  assert.equal((result as { language: string }).language, 'vi-VN');
  assert.equal(worker.said.length, 1);
  assert.match(worker.said[0].words, /Anh Tùng Lâm ơi!/);
  assert.equal(worker.said[0].options.volume, 0.65);
});

test('rejects messages from untrusted page origins and frames', async () => {
  const worker = makeWorker();
  await assert.rejects(worker.emit({ type: 'rwmcp.approval.alert' },
    { ...validTab, url: 'https://somewhere-else.example/' }), /message rejected/);
  await assert.rejects(worker.emit({ type: 'rwmcp.approval.alert' },
    { ...validTab, frameId: 1 }), /message rejected/);
  assert.equal(worker.said.length, 0);
});

test('avoids duplicate alerts when multiple Chrome tabs prompt simultaneously', async () => {
  const worker = makeWorker();
  await worker.emit({ type: 'rwmcp.approval.alert' }, validTab);
  const result = await worker.emit({ type: 'rwmcp.approval.alert' }, { ...validTab, tab: { id: 13 } });
  assert.equal((result as { suppressed: boolean }).suppressed, true);
  assert.equal(worker.said.length, 1);
});

test('off toggle silences real alerts but test button still works', async () => {
  const worker = makeWorker();
  worker.setEnabled(false);
  const silenced = await worker.emit({ type: 'rwmcp.approval.alert' }, validTab);
  assert.equal((silenced as { reason: string }).reason, 'disabled');
  assert.equal(worker.said.length, 0);
  const result = await worker.emit({ type: 'rwmcp.alert.test' }, popupSender);
  assert.equal((result as { ok: boolean }).ok, true);
  assert.equal(worker.said.length, 1);
});

test('falls back to understandable English rather than mispronouncing Vietnamese', async () => {
  const worker = makeWorker(['en-US']);
  const result = await worker.emit({ type: 'rwmcp.alert.test' }, popupSender);
  assert.equal((result as { language: string }).language, 'en-US');
  assert.match(worker.said[0].words, /Tung Lam, ChatGPT/);
});

test('popup can read installed Vietnamese voice availability', async () => {
  const worker = makeWorker(['en-US']);
  const result = await worker.emit({ type: 'rwmcp.alert.status' }, popupSender);
  assert.equal((result as { vietnameseVoiceAvailable: boolean }).vietnameseVoiceAvailable, false);
});


function makeContentHarness() {
  class FakeElement {
    isConnected = true;
    innerText = '';
    closest() { return null; }
    getBoundingClientRect() { return { width: 350, height: 40 }; }
    getAttribute(key: string) { return key === 'aria-hidden' ? null : null; }
    querySelectorAll() { return buttons; }
  }
  const buttons = [new FakeElement(), new FakeElement()];
  buttons[0].innerText = 'Deny';
  buttons[1].innerText = 'Allow';
  const modal = new FakeElement();
  modal.innerText = 'ChatGPT requests permission to use Remote Workstation MCP tool';
  let visible = true;
  let enabledChange: ((changes: unknown, area: string) => void) | undefined;
  let mutation: (() => void) | undefined;
  const messages: unknown[] = [];
  const timers = new Map<number, { callback: () => void; milliseconds: number }>();
  let nextId = 1;
  const chrome = {
    storage: {
      local: { get: async () => ({ enabled: true }) },
      onChanged: { addListener(fn: typeof enabledChange) { enabledChange = fn; } }
    },
    runtime: { sendMessage: async (message: unknown) => { messages.push(message); return { ok: true }; } }
  };
  class MutationObserverStub {
    constructor(fn: () => void) { mutation = fn; }
    observe() { /* no-op */ }
    disconnect() { /* no-op */ }
  }
  const sandbox = {
    chrome,
    document: {
      documentElement: new FakeElement(),
      querySelectorAll: () => visible ? [modal] : []
    },
    Element: FakeElement,
    MutationObserver: MutationObserverStub,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    setTimeout: (callback: () => void, milliseconds: number) => {
      const id = nextId++;
      timers.set(id, { callback, milliseconds });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    window: { addEventListener: () => undefined }
  };
  vm.runInNewContext(load('detector.js'), sandbox);
  vm.runInNewContext(load('content-script.js'), sandbox);
  return {
    messages,
    ready: async () => { await Promise.resolve(); await Promise.resolve(); },
    tick: (milliseconds: number) => {
      const next = [...timers.entries()].find(([, timer]) => timer.milliseconds === milliseconds);
      if (!next) throw new Error('no timer with interval ' + milliseconds);
      timers.delete(next[0]);
      next[1].callback();
    },
    hide: () => { visible = false; mutation?.(); },
    disable: () => enabledChange?.({ enabled: { newValue: false } }, 'local'),
    pending: () => [...timers.values()].map(t => t.milliseconds)
  };
}

test('visible approval fires once and retries at 30s only twice, then stops', async () => {
  const h = makeContentHarness();
  await h.ready();
  h.tick(180);
  assert.equal(h.messages.length, 1);
  h.tick(30_000);
  h.tick(30_000);
  assert.equal(h.messages.length, 3);
  assert.equal(h.pending().includes(30_000), false);
});

test('when approval disappears or alerting is disabled reminder timers are cleared', async () => {
  const h = makeContentHarness();
  await h.ready();
  h.tick(180);
  h.hide();
  h.tick(180);
  assert.equal(h.pending().includes(30_000), false);
  assert.equal(h.messages.length, 1);

  const j = makeContentHarness();
  await j.ready();
  j.tick(180);
  j.disable();
  assert.equal(j.pending().includes(30_000), false);
});
