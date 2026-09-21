import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsApprovalToastCommand } from '../src/privileged/owner-notification.js';

test('Windows approval toast opens the local Control Center approval surface without embedding request data', () => {
  const script = Buffer.from(windowsApprovalToastCommand(), 'base64').toString('utf16le');
  assert.match(script, /ToastNotificationManager/);
  assert.match(script, /CreateToastNotifier\('Remote Workstation MCP'\)/);
  assert.match(script, /RWMCP_NOTIFY_TITLE/);
  assert.match(script, /RWMCP_NOTIFY_BODY/);
  assert.match(script, /RWMCP_NOTIFY_URL/);
  assert.match(script, /activationType/);
  assert.doesNotMatch(script, /api[_-]?key|token|password/i);
});
