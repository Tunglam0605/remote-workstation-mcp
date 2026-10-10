import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilitiesForPlatform } from '../src/capabilities.js';

test('Windows capability catalog excludes the Linux-only SocketCAN extension', () => {
  const win = capabilitiesForPlatform('win32');
  const linux = capabilitiesForPlatform('linux');
  const mac = capabilitiesForPlatform('darwin');
  assert.equal(win.some(c => c.id === 'engineering.can'), false);
  assert.equal(linux.some(c => c.id === 'engineering.can'), true);
  assert.equal(mac.some(c => c.id === 'engineering.can'), false);
  assert.equal(win.some(c => c.id === 'web.social'), true);
  assert.equal(win.some(c => c.id === 'engineering.kicad'), true);
  assert.equal(win.some(c => c.id === 'office.core'), true);
  assert.equal(linux.some(c => c.id === 'office.core'), false);
});
