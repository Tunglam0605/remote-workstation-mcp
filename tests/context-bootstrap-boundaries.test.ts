import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('AppContext delegates engineering and web construction to bootstrap factories', async () => {
  const [context, engineeringFactory, webFactory] = await Promise.all([
    fs.readFile(path.resolve('src/context.ts'), 'utf8'),
    fs.readFile(path.resolve('src/bootstrap/engineering-services.ts'), 'utf8'),
    fs.readFile(path.resolve('src/bootstrap/web-services.ts'), 'utf8')
  ]);

  assert.match(context, /createEngineeringServices/);
  assert.match(context, /createWebServices/);
  assert.doesNotMatch(context, /from '\.\/adapters\/engineering\/(?:firmware|debug-session|ros2|kicad|can|modbus-rtu|network-diagnostics|docker|systemd|platformio|stm32-ioc|stm32-svd|serial-session|terminal-manager)\.js'/);
  assert.doesNotMatch(context, /from '\.\/web\/(?:browser-core|browser-provider|existing-chrome-bridge|existing-chrome-session)\.js'/);
  assert.doesNotMatch(context, /from '\.\/web\/adapters\/notebooklm-adapter\.js'/);

  for (const marker of [
    'HardwareDiscoveryAdapter',
    'FirmwareAdapter',
    'DebugSessionManager',
    'Ros2Adapter',
    'KicadAdapter',
    'CanAdapter',
    'ModbusRtuAdapter',
    'NetworkDiagnosticsAdapter'
  ]) {
    assert.match(engineeringFactory, new RegExp(marker));
  }

  assert.match(webFactory, /BrowserCore/);
  assert.match(webFactory, /ExistingChromeSessionService/);
  assert.match(webFactory, /NotebookLmAdapter/);
});
