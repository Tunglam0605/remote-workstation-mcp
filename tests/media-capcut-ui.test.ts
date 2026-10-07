import assert from 'node:assert/strict';
import test from 'node:test';
import { CapCutUiAdapter } from '../src/extensions/media/capcut-ui.js';

function node(overrides: Record<string, unknown> = {}) {
  return {
    depth: 0,
    processId: 44,
    name: 'CapCut',
    automationId: 'main-window',
    className: 'CapCutWindow',
    controlType: 'Window',
    enabled: true,
    offscreen: false,
    keyboardFocusable: true,
    patterns: ['WindowPattern'],
    ...overrides
  };
}

test('CapCut semantic UI status binds UIA only to the verified CapCut executable and hides its path', async () => {
  const calls: Array<{ kind: string; executable?: string }> = [];
  const drafts = {
    installationInfo: async () => ({
      platform: 'win32',
      supported: true,
      installed: true,
      executable: 'C:/Users/Test/AppData/Local/CapCut/Apps/CapCut.exe',
      version: '9.5.0.4050'
    })
  };
  const ui = {
    status: async () => ({
      ok: true,
      supported: true,
      provider: 'windows-uia',
      helperElevated: false,
      uiAccessEnabledByRwmcp: false,
      rootAvailable: true,
      allowedActions: ['status','inspect']
    }),
    windows: async (executable: string) => {
      calls.push({ kind: 'windows', executable });
      return { ok: true, provider: 'windows-uia', windowCount: 1, windows: [node()] };
    }
  };
  const adapter = new CapCutUiAdapter(drafts as never, ui as never);
  const status = await adapter.status();
  assert.equal(status.supported, true);
  assert.equal(status.running, true);
  assert.equal(status.windowCount, 1);
  assert.equal(status.installation.version, '9.5.0.4050');
  assert.equal(JSON.stringify(status).includes('C:/Users/Test'), false);
  assert.deepEqual(calls, [{
    kind: 'windows',
    executable: 'C:/Users/Test/AppData/Local/CapCut/Apps/CapCut.exe'
  }]);
  assert.equal(status.safety.coordinateInput, false);
  assert.equal(status.safety.rawKeyboardInput, false);
  assert.equal(status.safety.rawMouseInput, false);
});

test('CapCut semantic UI inspection returns bounded semantic metadata and no coordinate/value channel', async () => {
  const calls: unknown[] = [];
  const drafts = {
    installationInfo: async () => ({
      platform: 'win32',
      supported: true,
      installed: true,
      executable: 'C:/CapCut/CapCut.exe',
      version: '9.5.0.4050'
    })
  };
  const ui = {
    inspect: async (executable: string, options: unknown) => {
      calls.push({ executable, options });
      return {
        ok: true,
        provider: 'windows-uia',
        windowCount: 1,
        nodeCount: 2,
        truncated: false,
        nodes: [
          node(),
          node({
            depth: 1,
            name: 'Export',
            automationId: 'export-button',
            controlType: 'Button',
            patterns: ['InvokePattern']
          })
        ]
      };
    }
  };
  const adapter = new CapCutUiAdapter(drafts as never, ui as never);
  const result = await adapter.inspect({ maxDepth: 5, maxNodes: 200 });
  assert.equal(result.capcutVersion, '9.5.0.4050');
  assert.equal(result.nodeCount, 2);
  assert.deepEqual(calls, [{
    executable: 'C:/CapCut/CapCut.exe',
    options: { maxDepth: 5, maxNodes: 200 }
  }]);
  assert.equal(result.nodes[1]?.automationId, 'export-button');
  assert.ok(result.intentionallyUnavailable.includes('screen coordinates'));
  const serialized = JSON.stringify(result);
  for (const forbidden of ['boundingRectangle', 'screenX', 'screenY', '"value":']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('CapCut semantic UI is Windows-only and refuses absent installations', async () => {
  const nonWindows = new CapCutUiAdapter({
    installationInfo: async () => ({ platform: 'linux', supported: false, installed: false })
  } as never, {} as never);
  const status = await nonWindows.status();
  assert.equal(status.supported, false);

  const missing = new CapCutUiAdapter({
    installationInfo: async () => ({ platform: 'win32', supported: true, installed: false })
  } as never, {
    status: async () => ({
      supported: true,
      provider: 'windows-uia',
      ok: true,
      helperElevated: false,
      uiAccessEnabledByRwmcp: false,
      rootAvailable: true,
      allowedActions: []
    })
  } as never);
  await assert.rejects(() => missing.inspect(), /not installed/i);
});
