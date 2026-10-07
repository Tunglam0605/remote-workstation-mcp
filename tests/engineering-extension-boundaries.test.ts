import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const CAMERA_TOOLS = [
  'camera_provider_status',
  'camera_profile_list',
  'camera_profile_inspect',
  'camera_rtsp_probe',
  'camera_stream_metadata',
  'camera_ptz_status',
  'camera_ptz_move',
  'camera_ptz_stop',
  'camera_fleet_probe'
] as const;

const CAN_TOOLS = [
  'can_provider_status',
  'can_interface_list',
  'can_interface_status',
  'can_capture'
] as const;

const CANOPEN_TOOLS = [
  'canopen_provider_status',
  'canopen_capture_decode',
  'canopen_capture_analyze',
  'canopen_node_observe',
  'canopen_eds_inspect',
  'canopen_eds_profile',
  'canopen_object_lookup',
  'canopen_capture_semantic_decode'
] as const;

const MEDIA_TOOLS = [
  'media_provider_status',
  'media_capcut_status',
  'media_capcut_ui_inspect',
  'media_capcut_export_profile_list',
  'media_capcut_export_plan',
  'media_capcut_export',
  'media_capcut_headless_render_plan',
  'media_capcut_headless_render',
  'media_capcut_project_list',
  'media_capcut_project_inspect',
  'media_capcut_edit_plan',
  'media_capcut_edit',
  'media_file_probe',
  'media_transcode_plan',
  'media_transcode',
  'media_remotion_status',
  'media_remotion_preset_list',
  'media_remotion_render_plan',
  'media_remotion_render',
  'media_comfyui_status',
  'media_comfyui_preset_list',
  'media_comfyui_job_plan',
  'media_comfyui_job_submit',
  'media_comfyui_job_status',
  'media_comfyui_artifact_plan',
  'media_comfyui_artifact_import'
] as const;

const MQTT_TOOLS = [
  'mqtt_provider_status',
  'mqtt_subscribe_sample',
  'mqtt_json_observe'
] as const;

const INDUSTRIAL_TOOLS = [
  'industrial_profile_list',
  'industrial_profile_inspect',
  'industrial_profile_preflight'
] as const;

const OPCUA_TOOLS = [
  'opcua_provider_status',
  'opcua_endpoint_describe',
  'opcua_browse',
  'opcua_read'
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
  'stm32_pin_plan',
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
  'kicad_library_lookup',
  'kicad_schematic_synthesize',
  'kicad_semantic_place_plan',
  'kicad_board_synthesize',
  'kicad_route_plan',
  'kicad_route_batch_apply',
  'kicad_electrical_review',
  'kicad_manufacturing_package',
  'kicad_design_agent_run',
  'kicad_board_stats',
  'kicad_drc',
  'kicad_erc',
  'kicad_validate',
  'kicad_design_review',
  'kicad_layout_optimize_plan',
  'kicad_constraints_review',
  'kicad_visual_export',
  'kicad_bom_report',
  'kicad_edit_inspect',
  'kicad_edit'
] as const;

function registeredTools(source: string): string[] {
  return [...source.matchAll(/server\.registerTool\('([^']+)'/g)].map(match => match[1]);
}

test('migrated engineering MCP handlers live behind domain extension boundaries', async () => {
  const [monolith, cameraSource, canSource, canopenSource, mediaSource, mqttSource, industrialSource, opcuaSource, modbusTcpSource, modbusSource, ros2Source, stm32Source, esp32Source, kicadSource, builtin] = await Promise.all([
    fs.readFile(path.resolve('src/tools/engineering-tools.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/camera/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/can/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/canopen/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/media/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/mqtt/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/industrial/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/opcua/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/modbus-tcp/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/modbus/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/ros2/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/stm32/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/esp32/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/kicad/register.ts'), 'utf8'),
    fs.readFile(path.resolve('src/extensions/builtin.ts'), 'utf8')
  ]);

  const monolithTools = new Set(registeredTools(monolith));
  for (const tool of [...CAMERA_TOOLS, ...CAN_TOOLS, ...CANOPEN_TOOLS, ...MEDIA_TOOLS, ...MQTT_TOOLS, ...INDUSTRIAL_TOOLS, ...OPCUA_TOOLS, ...MODBUS_TCP_TOOLS, ...MODBUS_TOOLS, ...ROS2_TOOLS, ...STM32_TOOLS, ...ESP32_TOOLS, ...KICAD_TOOLS]) {
    assert.equal(monolithTools.has(tool), false, `${tool} must not drift back into engineering-tools.ts`);
  }

  assert.deepEqual(registeredTools(cameraSource), [...CAMERA_TOOLS]);
  assert.deepEqual(registeredTools(canSource), [...CAN_TOOLS]);
  assert.deepEqual(registeredTools(canopenSource), [...CANOPEN_TOOLS]);
  assert.deepEqual(registeredTools(mediaSource), [...MEDIA_TOOLS]);
  assert.deepEqual(registeredTools(mqttSource), [...MQTT_TOOLS]);
  assert.deepEqual(registeredTools(industrialSource), [...INDUSTRIAL_TOOLS]);
  assert.deepEqual(registeredTools(opcuaSource), [...OPCUA_TOOLS]);
  assert.deepEqual(registeredTools(modbusTcpSource), [...MODBUS_TCP_TOOLS]);
  assert.deepEqual(registeredTools(modbusSource), [...MODBUS_TOOLS]);
  assert.deepEqual(registeredTools(ros2Source), [...ROS2_TOOLS]);
  assert.deepEqual(registeredTools(stm32Source), [...STM32_TOOLS]);
  assert.deepEqual(registeredTools(esp32Source), [...ESP32_TOOLS]);
  assert.deepEqual(registeredTools(kicadSource), [...KICAD_TOOLS]);

  assert.match(builtin, /id: 'domain\.camera'/);
  assert.match(builtin, /register: registerCameraTools/);
  assert.match(builtin, /id: 'domain\.can'/);
  assert.match(builtin, /platforms: \['linux'\]/);
  assert.match(builtin, /register: registerCanTools/);
  assert.match(builtin, /id: 'domain\.canopen'/);
  assert.match(builtin, /register: registerCanopenTools/);
  assert.match(builtin, /id: 'domain\.media'/);
  assert.match(builtin, /register: registerMediaTools/);
  assert.match(builtin, /id: 'domain\.mqtt'/);
  assert.match(builtin, /register: registerMqttTools/);
  assert.match(builtin, /id: 'domain\.industrial-profiles'/);
  assert.match(builtin, /register: registerIndustrialTools/);
  assert.match(builtin, /id: 'domain\.opcua'/);
  assert.match(builtin, /register: registerOpcUaTools/);
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
