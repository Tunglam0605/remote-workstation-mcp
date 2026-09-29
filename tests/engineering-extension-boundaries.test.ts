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

const CANOPEN_TOOLS = [
  'canopen_provider_status',
  'canopen_capture_decode',
  'canopen_node_observe'
] as const;

const MQTT_TOOLS = [
  'mqtt_provider_status',
  'mqtt_subscribe_sample',
  'mqtt_agv_lift_observe'
] as const;

const MODBUS_TCP_TOOLS = [
  'modbus_tcp_provider_status',
  'modbus_tcp_endpoint_status',
  'modbus_tcp_read',
  'modbus_tcp_probe'
] as const;

const MODBUS_TOOLS = [
  'modbus_rtu_provider_status',
  'modbus_rtu_endpoint_status',
  'modbus_rtu_read',
  'modbus_rtu_probe'
] as const;

const ROS2_TOOLS = [
  'ros2_build',
  'ros2_node_info',
  'ros2_topic_info',
  'ros2_node_list',
  'ros2_topic_list',
  'ros2_topic_echo',
  'ros2_topic_hz',
  'ros2_topic_bw',
  'ros2_tf_lookup',
  'ros2_lifecycle_get',
  'ros2_lifecycle_list',
  'ros2_lifecycle_set',
  'ros2_service_list',
  'ros2_service_call',
  'ros2_action_list',
  'ros2_action_info',
  'ros2_param_list',
  'ros2_param_get',
  'ros2_param_set',
  'ros2_bag_record'
] as const;

const STM32_TOOLS = [
  'stm32_ioc_inspect',
  'stm32_svd_inspect'
] as const;

const ESP32_TOOLS = [
  'esp32_preflight'
] as const;

const KICAD_TOOLS = [
  'kicad_ipc_prepare',
  'kicad_ipc_status',
  'kicad_ipc_board_inspect',
  'kicad_ipc_footprint_move',
  'kicad_ipc_footprint_update',
  'kicad_ipc_batch_place',
  'kicad_ipc_routing_inspect',
  'kicad_ipc_track_add',
  'kicad_ipc_track_update',
  'kicad_ipc_via_add',
  'kicad_ipc_via_update',
  'kicad_provider_status',
  'kicad_board_stats',
  'kicad_drc',
  'kicad_erc',
  'kicad_validate',
  'kicad_bom_report',
  'kicad_edit_inspect',
  'kicad_edit'
] as const;

function registeredTools(source: string): string[] {
  return [...source.matchAll(/server\.registerTool\('([^']+)'/g)].map(match => match[1]);
}

test('migrated engineering MCP handlers live behind domain extension boundaries', async () => {
  const [monolith, canSource, canopenSource, mqttSource, modbusTcpSource, modbusSource, ros2Source, stm32Source, esp32Source, kicadSource, builtin] = await Promise.all([
    fs.readFile(path.resolve('src/tools/engineering-tools.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/can/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/canopen/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/mqtt/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/modbus-tcp/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/modbus/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/ros2/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/stm32/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/esp32/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/kicad/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/builtin.ts'), 'utf8')
  ]);

  const monolithTools = new Set(registeredTools(monolith));
  for (const tool of [...CAN_TOOLS, ...CANOPEN_TOOLS, ...MQTT_TOOLS, ...MODBUS_TCP_TOOLS, ...MODBUS_TOOLS, ...ROS2_TOOLS, ...STM32_TOOLS, ...ESP32_TOOLS, ...KICAD_TOOLS]) {
    assert.equal(monolithTools.has(tool), false, `${tool} must not drift back into engineering-tools.ts`);
  }

  assert.deepEqual(registeredTools(canSource), [...CAN_TOOLS]);
  assert.deepEqual(registeredTools(canopenSource), [...CANOPEN_TOOLS]);
  assert.deepEqual(registeredTools(mqttSource), [...MQTT_TOOLS]);
  assert.deepEqual(registeredTools(modbusTcpSource), [...MODBUS_TCP_TOOLS]);
  assert.deepEqual(registeredTools(modbusSource), [...MODBUS_TOOLS]);
  assert.deepEqual(registeredTools(ros2Source), [...ROS2_TOOLS]);
  assert.deepEqual(registeredTools(stm32Source), [...STM32_TOOLS]);
  assert.deepEqual(registeredTools(esp32Source), [...ESP32_TOOLS]);
  assert.deepEqual(registeredTools(kicadSource), [...KICAD_TOOLS]);

  assert.match(builtin, /id: 'domain\.can'/);
  assert.match(builtin, /platforms: \['linux'\]/);
  assert.match(builtin, /register: registerCanTools/);
  assert.match(builtin, /id: 'domain\.canopen'/);
  assert.match(builtin, /register: registerCanopenTools/);
  assert.match(builtin, /id: 'domain\.mqtt'/);
  assert.match(builtin, /register: registerMqttTools/);
  assert.match(builtin, /id: 'domain\.modbus-tcp'/);
  assert.match(builtin, /register: registerModbusTcpTools/);
  assert.match(builtin, /id: 'domain\.modbus-rtu'/);
  assert.match(builtin, /register: registerModbusTools/);
  assert.match(builtin, /id: 'domain\.ros2'/);
  assert.match(builtin, /register: registerRos2Tools/);
  assert.match(builtin, /id: 'domain\.stm32'/);
  assert.match(builtin, /register: registerStm32Tools/);
  assert.match(builtin, /id: 'domain\.esp32'/);
  assert.match(builtin, /register: registerEsp32Tools/);
  assert.match(builtin, /id: 'domain\.kicad'/);
  assert.match(builtin, /register: registerKicadTools/);
});
