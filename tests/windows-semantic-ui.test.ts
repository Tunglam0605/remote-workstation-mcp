import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  WindowsSemanticUiAdapter,
  validateWindowsUiLocator
} from '../src/adapters/windows-semantic-ui.js';

test('Windows semantic UI locators require exact semantic identity and reject coordinate-style input', () => {
  assert.deepEqual(validateWindowsUiLocator({
    automationId: 'ExportButton',
    names: ['Export', 'Xuất'],
    controlType: 'button'
  }), {
    automationId: 'ExportButton',
    names: ['Export', 'Xuất'],
    controlType: 'button'
  });
  assert.throws(() => validateWindowsUiLocator({}), /requires automationId or exact name aliases/i);
  assert.throws(() => validateWindowsUiLocator({ names: [] }), /1\.\.8/);
  assert.throws(() => validateWindowsUiLocator({ names: ['x'], controlType: 'unknown' as never }), /unsupported/i);
  assert.throws(
    () => validateWindowsUiLocator({ names: ['a','b','c','d','e','f','g','h','i'] }),
    /1\.\.8/
  );
});

test('Windows semantic UI adapter emits only bounded typed helper requests', async () => {
  const requests: Record<string, unknown>[] = [];
  const adapter = new WindowsSemanticUiAdapter({
    platform: 'win32',
    executor: async request => {
      requests.push(request);
      if (request.action === 'status') {
        return {
          ok: true,
          supported: true,
          provider: 'windows-uia',
          helperElevated: false,
          uiAccessEnabledByRwmcp: false,
          rootAvailable: true,
          allowedActions: ['status','inspect','invoke']
        };
      }
      if (request.action === 'inspect') {
        return {
          ok: true,
          provider: 'windows-uia',
          windowCount: 1,
          nodeCount: 1,
          truncated: false,
          nodes: [{
            depth: 0,
            processId: 123,
            name: 'CapCut',
            automationId: 'main',
            className: 'Window',
            controlType: 'Window',
            enabled: true,
            offscreen: false,
            keyboardFocusable: true,
            patterns: ['WindowPattern', 123, 'InvokePattern']
          }]
        };
      }
      return {
        ok: true,
        provider: 'windows-uia',
        action: request.action,
        element: {
          depth: 1,
          processId: 123,
          name: 'Export',
          automationId: 'ExportButton',
          className: 'Button',
          controlType: 'Button',
          enabled: true,
          offscreen: false,
          keyboardFocusable: true,
          patterns: ['InvokePattern']
        }
      };
    }
  });

  const status = await adapter.status();
  assert.equal(status.supported, true);
  assert.equal('uiAccessEnabledByRwmcp' in status && status.uiAccessEnabledByRwmcp, false);

  const inspected = await adapter.inspect('C:/Apps/CapCut.exe', { processId: 123, maxDepth: 4, maxNodes: 128 });
  assert.equal(inspected.nodeCount, 1);
  assert.deepEqual(inspected.nodes[0]?.patterns, ['WindowPattern', 'InvokePattern']);

  const invoked = await adapter.invoke('C:/Apps/CapCut.exe', 123, {
    automationId: 'ExportButton',
    names: ['Export'],
    controlType: 'button'
  });
  assert.equal(invoked.element.automationId, 'ExportButton');

  const invokeRequest = requests.find(item => item.action === 'invoke');
  assert.ok(invokeRequest);
  assert.equal(invokeRequest?.processId, 123);
  assert.deepEqual(invokeRequest?.locator, {
    automationId: 'ExportButton',
    names: ['Export'],
    controlType: 'button'
  });
  for (const forbidden of ['x', 'y', 'screenX', 'screenY', 'mouseButton', 'keyCode', 'rawSelector']) {
    assert.equal(Object.hasOwn(invokeRequest ?? {}, forbidden), false);
  }

  await assert.rejects(
    () => adapter.inspect('C:/Apps/CapCut.exe', { maxDepth: 13 }),
    /maxDepth/i
  );
  await assert.rejects(
    () => adapter.invoke('C:/Apps/CapCut.exe', 0, { names: ['Export'] }),
    /processId/i
  );
});

test('Windows UI Automation helper source excludes pixel, raw keyboard and UIAccess primitives', async () => {
  const source = await fs.readFile(path.resolve('scripts/ui/windows-ui-automation.ps1'), 'utf8');
  assert.match(source, /UIAutomationClient/);
  assert.match(source, /AutomationElement/);
  assert.match(source, /InvokePattern/);
  assert.match(source, /ValuePattern/);
  assert.match(source, /SelectionItemPattern/);
  assert.match(source, /UIA_ELEVATED_HELPER_REFUSED/);
  assert.match(source, /uiAccessEnabledByRwmcp = \$false/);
  assert.doesNotMatch(source, /SendKeys|SendInput|mouse_event|SetCursorPos|Click\(|BoundingRectangle/i);
});

test('Windows native UI Automation helper loads on Windows without enabling UIAccess', {
  skip: process.platform !== 'win32'
}, async () => {
  const adapter = new WindowsSemanticUiAdapter();
  const status = await adapter.status();
  assert.equal(status.supported, true);
  if (status.supported) {
    assert.equal(status.rootAvailable, true);
    assert.equal(status.uiAccessEnabledByRwmcp, false);
    assert.ok(status.allowedActions.includes('invoke'));
    assert.ok(status.allowedActions.includes('set-value'));
  }
});
