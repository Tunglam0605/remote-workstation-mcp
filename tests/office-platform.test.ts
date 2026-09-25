import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { CAPABILITIES, capabilitiesForPlatform } from '../src/capabilities.js';
import { officePlatformSupported } from '../src/tools/office-tools.js';

test('Office capability pack is exposed only on Windows hosts', () => {
  assert.equal(officePlatformSupported('win32'), true);
  assert.equal(officePlatformSupported('linux'), false);
  assert.equal(officePlatformSupported('darwin'), false);

  const windows = capabilitiesForPlatform('win32');
  const linux = capabilitiesForPlatform('linux');
  const darwin = capabilitiesForPlatform('darwin');

  assert.ok(windows.some(capability => capability.id === 'office.core'));
  assert.ok(windows.some(capability => capability.tools.includes('word_edit')));
  assert.ok(windows.some(capability => capability.tools.includes('excel_inspect')));
  assert.ok(windows.some(capability => capability.tools.includes('excel_edit')));
  assert.ok(windows.some(capability => capability.tools.includes('powerpoint_inspect')));
  assert.ok(windows.some(capability => capability.tools.includes('powerpoint_edit')));
  assert.equal(linux.some(capability => capability.id.startsWith('office.')), false);
  assert.equal(darwin.some(capability => capability.id.startsWith('office.')), false);

  const nonOffice = CAPABILITIES.filter(capability => !capability.id.startsWith('office.'));
  assert.deepEqual(linux, nonOffice);
  assert.deepEqual(darwin, nonOffice);
});

test('server registration fail-closes Office tools behind the Windows platform gate', async () => {
  const source = await fs.readFile(path.resolve('src/server.ts'), 'utf8');
  assert.match(source, /if \(officePlatformSupported\(process\.platform\)\) registerOfficeTools\(server, ctx\);/);
  assert.doesNotMatch(source, /^\s*registerOfficeTools\(server, ctx\);/m);
});
