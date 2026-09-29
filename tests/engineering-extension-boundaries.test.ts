import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const CAN_TOOLS = [
  'can_provider_status',
  'can_interface_list',
  'can_interface_status',
  'can_capture'
] as const;

const MODBUS_TOOLS = [
  'modbus_rtu_provider_status',
  'modbus_rtu_endpoint_status',
  'modbus_rtu_read',
  'modbus_rtu_probe'
] as const;

function registeredTools(source: string): string[] {
  return [...source.matchAll(/server\.registerTool\('([^']+)'/g)].map(match => match[1]);
}

test('CAN and Modbus MCP handlers live behind domain extension boundaries', async () => {
  const [monolith, canSource, modbusSource, builtin] = await Promise.all([
    fs.readFile(path.resolve('src/tools/engineering-tools.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/can/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/modbus/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/builtin.ts'), 'utf8')
  ]);

  const monolithTools = new Set(registeredTools(monolith));
  for (const tool of [...CAN_TOOLS, ...MODBUS_TOOLS]) {
    assert.equal(monolithTools.has(tool), false, `${tool} must not drift back into engineering-tools.ts`);
  }

  assert.deepEqual(registeredTools(canSource), [...CAN_TOOLS]);
  assert.deepEqual(registeredTools(modbusSource), [...MODBUS_TOOLS]);

  assert.match(builtin, /id: 'domain\.can'/);
  assert.match(builtin, /platforms: \['linux'\]/);
  assert.match(builtin, /register: registerCanTools/);
  assert.match(builtin, /id: 'domain\.modbus-rtu'/);
  assert.match(builtin, /register: registerModbusTools/);
});
