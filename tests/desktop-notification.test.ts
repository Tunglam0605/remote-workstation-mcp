import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopNotificationService } from '../src/desktop-notification.js';

test('desktop notifications are a no-op on non-Windows platforms', async () => {
  let called = false;
  const service = new DesktopNotificationService('0.0.0-test', {
    platform: 'linux',
    spawnProcess: (() => {
      called = true;
      throw new Error('must not spawn');
    }) as any
  });

  assert.deepEqual(await service.notify({ title: 'Task complete', body: 'Done.' }), {
    delivered: false,
    reason: 'unsupported-platform'
  });
  assert.equal(called, false);
});

test('Windows desktop notifications use a packaged PowerShell helper without shell interpolation', async () => {
  let captured: { program?: string; args?: string[]; options?: Record<string, unknown> } = {};
  const fakeChild = {
    once() { return this; },
    unref() {}
  };
  const service = new DesktopNotificationService('0.26.0', {
    platform: 'win32',
    scriptPath: 'C:\\Program Files\\RWMCP\\show-windows-notification.ps1',
    spawnProcess: ((program: string, args: string[], options: Record<string, unknown>) => {
      captured = { program, args, options };
      return fakeChild;
    }) as any
  });

  const result = await service.notify({
    title: 'Codex task completed',
    body: 'Regression test passed & no production was touched.',
    kind: 'success'
  });

  assert.deepEqual(result, { delivered: true });
  assert.equal(captured.program, 'powershell.exe');
  assert.equal(captured.options?.shell, false);
  assert.equal(captured.options?.detached, true);
  assert.equal(captured.options?.windowsHide, true);
  assert.ok(captured.args?.includes('-Sta'));
  assert.ok(captured.args?.includes('-File'));
  assert.ok(captured.args?.includes('C:\\Program Files\\RWMCP\\show-windows-notification.ps1'));

  const payloadIndex = captured.args!.indexOf('-PayloadBase64');
  assert.ok(payloadIndex >= 0);
  const payload = JSON.parse(Buffer.from(captured.args![payloadIndex + 1]!, 'base64').toString('utf8'));
  assert.deepEqual(payload, {
    app: 'Remote Workstation MCP v0.26.0',
    title: 'Codex task completed',
    body: 'Regression test passed & no production was touched.',
    kind: 'success'
  });
});

test('desktop notification payloads are bounded before dispatch', async () => {
  let encoded = '';
  const service = new DesktopNotificationService('0.26.0', {
    platform: 'win32',
    spawnProcess: ((_program: string, args: string[]) => {
      encoded = args[args.indexOf('-PayloadBase64') + 1]!;
      return { once() { return this; }, unref() {} };
    }) as any
  });

  await service.notify({
    title: ' T '.repeat(100),
    body: ' B '.repeat(500),
    kind: 'warning'
  });

  const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  assert.ok(payload.title.length <= 96);
  assert.ok(payload.body.length <= 320);
});
