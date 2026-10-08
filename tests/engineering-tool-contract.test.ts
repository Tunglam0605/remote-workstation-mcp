import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve('.');
const read = (relative: string) => fs.readFile(path.join(root, relative), 'utf8');

test('Engineering Workflow Engine exposes a frozen-snapshot-safe ChatGPT action contract', async () => {
  const tools = await read('src/tools/engineering-tools.ts');
  const contract = await read('src/engineering-workflow-contract.ts');

  assert.match(tools, /engineeringWorkflowIdSchema/);
  assert.match(tools, /workflowParametersSchema/);
  assert.match(tools, /workflowRuntimeParametersSchema/);
  assert.match(tools, /engineering_workflow_plan[\s\S]*parameters: workflowParameters[\s\S]*overrides: legacyWorkflowOverrides/);
  assert.match(tools, /engineering_workflow_run[\s\S]*parameters: workflowParameters[\s\S]*overrides: legacyWorkflowOverrides/);
  assert.match(tools, /engineering_profile_init[\s\S]*profile: z\.record\(z\.string\(\), z\.unknown\(\)\)\.optional\(\)/);

  assert.match(contract, /engineeringWorkflowIdSchema = z\.string\(\)[\s\S]*regex\(\/\^\[a-z0-9\]/);
  assert.doesNotMatch(contract, /engineeringWorkflowIdSchema = z\.enum\(/);
  const legacyStart = contract.indexOf('legacyWorkflowOverridesSchema = z.object({');
  const runtimeStart = contract.indexOf('workflowRuntimeParametersSchema = z.object({');
  const persistedStart = contract.indexOf('persistedWorkflowParametersSchema', runtimeStart);
  assert.ok(legacyStart >= 0 && runtimeStart > legacyStart && persistedStart > runtimeStart);
  const legacyBlock = contract.slice(legacyStart, runtimeStart);
  const runtimeBlock = contract.slice(runtimeStart, persistedStart);
  assert.doesNotMatch(legacyBlock, /keepMonitorOpen/);
  assert.match(runtimeBlock, /keepMonitorOpen: z\.boolean\(\)\.optional\(\)/);
  assert.match(contract, /persistedWorkflowParametersSchema[\s\S]*transferTicket: true[\s\S]*relayDataBase64: true/);

  assert.match(tools, /workflowRuntimeParameters\.parse\(\{ \.\.\.\(overrides \?\? \{\}\), \.\.\.parameters \}\)/);
});

test('v0.54 adds typed SocketCAN diagnostics and advances Action Schema v26 while retaining Engineering API v5', async () => {
  const capabilities = await read('src/capabilities.ts');
  assert.match(capabilities, /export const ACTION_SCHEMA_VERSION = 72;/);
  assert.match(capabilities, /export const ENGINEERING_API_VERSION = 5;/);
  const packageJson = JSON.parse(await read('package.json')) as { version: string };
  assert.ok(capabilities.includes(`export const SERVER_VERSION = '${packageJson.version}';`));
  const settings = await read('src/setup/settings.ts');
  const policy = await read('src/execution-policy.ts');
  const routes = await read('src/worker-route-plan.ts');
  const decomposition = await read('src/objective-decomposition.ts');
  const waveExecution = await read('src/objective-wave-execution.ts');
  const taskGraph = await read('src/task-graph.ts');
  assert.match(settings, /targetPolicy/);
  assert.match(settings, /inferExecutionTargetPolicy/);
  assert.match(policy, /beforeTargetDispatch/);
  assert.match(policy, /sessionTargetTasks/);
  assert.match(routes, /targetBudgetAvailable/);
  assert.match(decomposition, /ObjectiveDecompositionService/);
  assert.match(decomposition, /NO_AI_TARGET_ALLOWED/);
  assert.match(waveExecution, /ObjectiveWaveExecutionService/);
  assert.match(waveExecution, /bounded-wave-execution/);
  assert.match(taskGraph, /addTaskBatch/);
  const engineeringTools = await read('src/tools/engineering-tools.ts');
  const canTools = await read('src/extensions/can/register.ts');
  const ros2Tools = await read('src/extensions/ros2/register.ts');
  const stm32Tools = await read('src/extensions/stm32/register.ts');
  const kicadTools = await read('src/extensions/kicad/register.ts');
  const officeTools = await read('src/tools/office-tools.ts');
  for (const tool of ['firmware_memory_report', 'debug_locals', 'debug_rtos_tasks', 'debug_cortexm_exception_frame', 'debug_disassemble', 'debug_watchpoint_add']) {
    assert.match(engineeringTools, new RegExp(`server\\.registerTool\\('${tool}'`));
  }
  for (const tool of ['kicad_provider_status', 'kicad_board_stats', 'kicad_drc', 'kicad_erc', 'kicad_validate', 'kicad_bom_report']) {
    assert.match(kicadTools, new RegExp(`server\\.registerTool\\('${tool}'`));
  }
  assert.match(stm32Tools, /server\.registerTool\('stm32_svd_inspect'/);
  for (const tool of ['ros2_node_info', 'ros2_topic_hz', 'ros2_topic_bw', 'ros2_tf_lookup', 'ros2_lifecycle_get', 'ros2_lifecycle_set', 'ros2_action_info']) {
    assert.match(ros2Tools, new RegExp(`server\\.registerTool\\('${tool}'`));
  }
  for (const tool of ['can_provider_status', 'can_interface_list', 'can_interface_status', 'can_capture']) {
    assert.match(canTools, new RegExp(`server\\.registerTool\\('${tool}'`));
  }
  for (const tool of ['excel_inspect', 'excel_edit', 'powerpoint_inspect', 'powerpoint_edit']) {
    assert.match(officeTools, new RegExp(`server\\.registerTool\\('${tool}'`));
  }
  assert.match(capabilities, /export const BUILD_CHANNEL = 'development'/);
  assert.match(capabilities, /RWMCP_GIT_COMMIT/);
  assert.match(capabilities, /multi_device\.data_plane/);
  assert.match(capabilities, /multi_device\.control_plane_relay/);
  assert.match(capabilities, /multi_device\.authorization/);
  assert.match(capabilities, /stm32_ioc_inspect/);
  assert.match(capabilities, /agent\.routing/);
  assert.match(capabilities, /worker_route_plan/);
  const coreTools = await read('src/tools/core-tools.ts');
  const scopes = await read('src/security/request-principal.ts');
  assert.match(scopes, /debug_rtos_tasks: 'workstation\.read'/);
  assert.match(scopes, /debug_cortexm_exception_frame: 'workstation\.read'/);
  assert.match(engineeringTools, /rtosAwareness: z\.enum\(\['none', 'auto', 'freertos'\]\)\.default\('none'\)/);
  for (const tool of ['can_provider_status', 'can_interface_list', 'can_interface_status', 'can_capture']) {
    assert.match(scopes, new RegExp(`${tool}: 'workstation\\.read'`));
    assert.match(capabilities, new RegExp(tool));
  }
  assert.match(scopes, /worker_route_plan: 'workstation\.read'/);
  assert.match(scopes, /execution_target_set_override: 'workstation\.write'/);
  assert.match(coreTools, /server\.registerTool\('execution_target_set_override'/);
  assert.match(coreTools, /server\.registerTool\('work_objective_decompose'/);
  assert.match(coreTools, /server\.registerTool\('work_objective_execute_wave'/);
  assert.match(scopes, /work_objective_decompose: 'workstation\.write'/);
  assert.match(scopes, /work_objective_execute_wave: 'workstation\.execute'/);
  assert.match(coreTools, /z\.enum\(EXECUTION_TARGET_MODES\)/);
  const routeStart = coreTools.indexOf("server.registerTool('worker_route_plan'");
  const routeEnd = coreTools.indexOf("server.registerTool('worker_provider_list'", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const routeBlock = coreTools.slice(routeStart, routeEnd);
  assert.match(routeBlock, /readOnlyHint: true/);
  assert.match(routeBlock, /planWorkerRoute/);
  assert.doesNotMatch(routeBlock, /work_objective_execute_task|taskWorkflowExecution\.execute|\.dispatch\(/);
  const navigation = await read('assets/moonlight/navigation.js');
  const app = await read('assets/moonlight/app.js');
  const views = await read('assets/moonlight/views.js');
  const capabilityViews = await read('assets/moonlight/capability-views.js');
  const systemAccessViews = await read('assets/moonlight/system-access-views.js');
  const executionView = await read('assets/moonlight/execution-view.js');
  assert.match(navigation, /group: 'Home'/);
  assert.match(navigation, /group: 'Tools'/);
  assert.doesNotMatch(app, /renderOverviewSummary/);
  assert.doesNotMatch(app, /overview-refresh/);
  assert.match(app, /themes\.tick\(now\)/);
  assert.match(executionView, /How should AI work\?/);
  assert.match(executionView, /More routing combinations/);
  assert.match(capabilityViews, /What you can do/);
  assert.match(systemAccessViews, /Advanced access scopes/);
  assert.match(views, /Advanced multi-node transfers/);
  assert.match(systemAccessViews, /security-primary-grid/);
  assert.match(systemAccessViews, /security-admin-section/);
  assert.match(systemAccessViews, /Show command hash/);
  assert.match(capabilityViews, /Multi-agent objective flow/);
  assert.match(capabilityViews, /work_objective_execute_wave/);
});

test('v0.54 SocketCAN surface stays bounded and read-only', async () => {
  const canTools = await read('src/extensions/can/register.ts');
  const canAdapter = await read('src/adapters/engineering/can.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');
  for (const tool of ['can_provider_status', 'can_interface_list', 'can_interface_status', 'can_capture']) {
    assert.match(canTools, new RegExp(`server\\.registerTool\\('${tool}'`));
    assert.match(scopes, new RegExp(`${tool}: 'workstation\\.read'`));
    assert.match(capabilities, new RegExp(tool));
  }
  assert.match(canAdapter, /\['-json', '-details', '-statistics', 'link', 'show'\]/);
  assert.match(canAdapter, /\['-L', '-n', String\(count\), '-T', String\(inactivityTimeoutMs\), interfaceSpec\]/);
  assert.match(canAdapter, /at most 32 filters|accepts at most 32 filters/);
  assert.doesNotMatch(canTools, /can_send|cansend|canplayer|can_interface_set|can_bitrate_set/);
  assert.doesNotMatch(canAdapter, /'cansend'|'canplayer'|'cangen'|'cangw'/);
  const pythonFallback = await read('scripts/socketcan_capture.py');
  assert.match(pythonFallback, /socket\.PF_CAN/);
  assert.match(pythonFallback, /socket\.SOCK_RAW/);
  assert.match(pythonFallback, /sock\.recv\(72\)/);
  assert.doesNotMatch(pythonFallback, /\.send(?:to|msg)?\(/);
  assert.doesNotMatch(pythonFallback, /subprocess|os\.system|Popen/);
});

test('v0.44 embedded diagnostics remain typed and do not expose arbitrary debugger or firmware execution', async () => {
  const engineeringTools = await read('src/tools/engineering-tools.ts');
  const debug = await read('src/adapters/engineering/debug-session.ts');
  const firmware = await read('src/adapters/engineering/firmware.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  for (const tool of ['firmware_memory_report', 'debug_locals', 'debug_disassemble', 'debug_watchpoint_add', 'debug_watchpoint_remove']) {
    assert.match(engineeringTools, new RegExp(`server\\.registerTool\\('${tool}'`));
    assert.match(scopes, new RegExp(`${tool}: 'workstation\\.(?:read|execute)'`));
    assert.match(capabilities, new RegExp(tool));
  }
  assert.match(firmware, /arm-none-eabi-size/);
  assert.match(firmware, /arm-none-eabi-nm/);
  assert.match(debug, /-stack-list-variables --simple-values/);
  assert.match(debug, /-data-disassemble -s/);
  assert.match(debug, /-break-watch/);
  assert.doesNotMatch(engineeringTools, /debug_command|gdb_command|memory_write|firmware_shell/);
  assert.match(debug, /intentionallyUnavailable: \['arbitrary-gdb-command', 'arbitrary-tcl-command', 'memory-write', 'gdb-flash'\]/);
});

test('v0.44 ROS2 professional diagnostics stay bounded and defer unsafe action-goal dispatch', async () => {
  const ros2Tools = await read('src/extensions/ros2/register.ts');
  const ros2 = await read('src/adapters/engineering/ros2.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');
  for (const tool of ['ros2_node_info', 'ros2_topic_hz', 'ros2_topic_bw', 'ros2_tf_lookup', 'ros2_lifecycle_get', 'ros2_lifecycle_list', 'ros2_lifecycle_set', 'ros2_action_info']) {
    assert.match(ros2Tools, new RegExp(`server\\.registerTool\\('${tool}'`));
    assert.match(scopes, new RegExp(`${tool}: 'workstation\\.(?:read|execute)'`));
    assert.match(capabilities, new RegExp(tool));
  }
  assert.match(ros2, /\['topic', 'hz', name, '--window'/);
  assert.match(ros2, /\['topic', 'bw', name, '--window'/);
  assert.match(ros2, /\['run', 'tf2_ros', 'tf2_echo'/);
  assert.match(ros2Tools, /z\.enum\(\['configure', 'cleanup', 'activate', 'deactivate', 'shutdown'\]\)/);
  assert.doesNotMatch(ros2Tools, /ros2_action_send_goal|ros2_shell|ros2_command/);
  assert.match(capabilities, /Action goal dispatch is intentionally deferred until RWMCP can guarantee goal-handle cancellation on timeout/);
});

test('v0.44 KiCad professional tools expose typed temporary diagnostics without arbitrary plugins', async () => {
  const kicadTools = await read('src/extensions/kicad/register.ts');
  const kicad = await read('src/adapters/engineering/kicad.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');
  for (const tool of ['kicad_provider_status', 'kicad_board_stats', 'kicad_drc', 'kicad_erc', 'kicad_validate', 'kicad_bom_report']) {
    assert.match(kicadTools, new RegExp(`server\\.registerTool\\('${tool}'`));
    assert.match(scopes, new RegExp(`${tool}: 'workstation\\.read'`));
    assert.match(capabilities, new RegExp(tool));
  }
  assert.match(kicad, /'sch', 'export', 'bom'/);
  assert.match(kicad, /'Reference,Value,Footprint,QUANTITY,DNP'/);
  assert.doesNotMatch(kicadTools, /kicad_script|kicad_plugin|python-bom/);
  assert.match(capabilities, /arbitrary BOM plugins\/scripts/);
});

test('v0.56 KiCad editing stays typed, transactional and bounded', async () => {
  const kicadTools = await read('src/extensions/kicad/register.ts');
  const kicad = await read('src/adapters/engineering/kicad.ts');
  const edit = await read('src/adapters/engineering/kicad-edit.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');
  assert.match(kicadTools, /server\.registerTool\('kicad_edit_inspect'/);
  assert.match(kicadTools, /server\.registerTool\('kicad_edit'/);
  assert.match(scopes, /kicad_edit_inspect: 'workstation\.read'/);
  assert.match(scopes, /kicad_edit: 'workstation\.write'/);
  assert.match(capabilities, /kicad_edit_inspect/);
  assert.match(capabilities, /kicad_edit/);
  assert.match(kicad, /KICAD_EDIT_CONFLICT/);
  assert.match(kicad, /KICAD_EDIT_ACCEPTANCE_FAILED/);
  assert.match(kicad, /createKicadBackup/);
  assert.match(kicad, /withLease\('kicad-file:' \+ input, 'orchestrating'/);
  assert.match(edit, /schematic_symbol_property/);
  assert.match(edit, /pcb_footprint_property/);
  assert.match(edit, /pcb_footprint_move/);
  assert.doesNotMatch(kicadTools, /kicad_raw|kicad_sexpr|kicad_autoroute|kicad_track_add|kicad_via_add|kicad_zone_add/);
  assert.doesNotMatch(edit, /eval\(|new Function|child_process|spawn\(|exec\(/);
});

test('v0.57 KiCad Phase 2 adds documented fabrication flags and official IPC readiness only', async () => {
  const kicadTools = await read('src/extensions/kicad/register.ts');
  const kicad = await read('src/adapters/engineering/kicad.ts');
  const edit = await read('src/adapters/engineering/kicad-edit.ts');
  const probe = await read('scripts/kicad_ipc_probe.py');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  assert.match(kicadTools, /server\.registerTool\('kicad_ipc_status'/);
  assert.match(scopes, /kicad_ipc_status: 'workstation\.read'/);
  assert.match(capabilities, /kicad_ipc_status/);
  assert.match(edit, /schematic_symbol_flags/);
  assert.match(edit, /pcb_footprint_attributes/);
  assert.match(edit, /pcb_footprint_copper/);
  assert.match(edit, /exclude_from_pos_files/);
  assert.match(edit, /zone_connect/);
  assert.match(kicad, /headlessApiSupported: major >= 11/);
  assert.match(kicad, /guiRequired: major >= 9 && major <= 10/);
  assert.match(probe, /from kipy import KiCad/);
  assert.match(probe, /get_board/);
  assert.doesNotMatch(probe, /save\(|update_items|add_items|delete_items|refill_zones|import_netlist/);
  assert.doesNotMatch(kicadTools, /kicad_dru_edit|kicad_raw_rule|kicad_autoroute|kicad_track_add|kicad_via_add|kicad_zone_add/);
});

test('v0.58 KiCad IPC live control remains bounded, project-scoped and unsaved', async () => {
  const kicadTools = await read('src/extensions/kicad/register.ts');
  const kicad = await read('src/adapters/engineering/kicad.ts');
  const live = await read('scripts/kicad_ipc_live.py');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  for (const tool of ['kicad_ipc_board_inspect', 'kicad_ipc_footprint_move']) {
    assert.match(kicadTools, new RegExp(`server\\.registerTool\\('${tool}'`));
    assert.match(capabilities, new RegExp(tool));
  }
  assert.match(scopes, /kicad_ipc_board_inspect: 'workstation\.read'/);
  assert.match(scopes, /kicad_ipc_footprint_move: 'workstation\.write'/);
  assert.match(kicad, /discoverKicadPythonProvider/);
  assert.match(kicad, /kicad-ipc-board:/);
  assert.match(live, /from kipy import KiCad/);
  assert.match(live, /board\.begin_commit\(\)/);
  assert.match(live, /board\.update_items\(fp\)/);
  assert.match(live, /board\.push_commit/);
  assert.match(live, /KICAD_IPC_BOARD_MISMATCH/);
  assert.match(live, /KICAD_IPC_CONFLICT/);
  assert.match(live, /rollback rejected footprint move/);
  assert.match(live, /"saved": False/);
  assert.doesNotMatch(live, /board\.save\(/);
  assert.doesNotMatch(kicadTools, /kicad_ipc_raw|kicad_ipc_command|kicad_ipc_script|kicad_ipc_save/);
});

test('v0.59 KiCad IPC preparation and path hardening stay bounded', async () => {
  const kicadTools = await read('src/extensions/kicad/register.ts');
  const kicad = await read('src/adapters/engineering/kicad.ts');
  const live = await read('scripts/kicad_ipc_live.py');
  const prepare = await read('scripts/kicad_ipc_prepare.ps1');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  assert.match(kicadTools, /server\.registerTool\('kicad_ipc_prepare'/);
  assert.match(scopes, /kicad_ipc_prepare: 'workstation\.write'/);
  assert.match(capabilities, /kicad_ipc_prepare/);
  assert.match(kicad, /KICAD_IPC_PREPARE_UNSUPPORTED/);
  assert.match(kicad, /kicad-ipc-config:/);
  assert.match(prepare, /KICAD_IPC_PREPARE_REQUIRES_KICAD_CLOSED/);
  assert.match(prepare, /api\.enable_server/);
  assert.match(prepare, /Copy-Item/);
  assert.match(live, /board\.document\.project\.path/);
  assert.match(live, /wanted\.parent \/ value/);
  assert.doesNotMatch(prepare, /pip install|Invoke-WebRequest|Start-Process/);
  assert.doesNotMatch(kicadTools, /kicad_ipc_raw|kicad_ipc_save|kicad_ipc_script/);
});

test('v0.60 KiCad IPC Phase 5 stays typed, transactional and unsaved', async () => {
  const kicadTools = await read('src/extensions/kicad/register.ts');
  const kicad = await read('src/adapters/engineering/kicad.ts');
  const live = await read('scripts/kicad_ipc_live.py');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  for (const tool of ['kicad_ipc_footprint_update', 'kicad_ipc_batch_place']) {
    assert.match(kicadTools, new RegExp(`server\\.registerTool\\('${tool}'`));
    assert.match(capabilities, new RegExp(tool));
  }
  assert.match(scopes, /kicad_ipc_footprint_update: 'workstation\.write'/);
  assert.match(scopes, /kicad_ipc_batch_place: 'workstation\.write'/);
  assert.match(kicad, /ipcFootprintUpdate/);
  assert.match(kicad, /ipcBatchPlace/);
  assert.match(kicad, /kicad-ipc-board:/);
  assert.match(live, /exclude_from_bill_of_materials/);
  assert.match(live, /exclude_from_position_files/);
  assert.match(live, /do_not_populate/);
  assert.match(live, /not_in_schematic/);
  assert.match(live, /board\.update_items\(items\)/);
  assert.match(live, /RWMCP: batch place footprints/);
  assert.match(live, /--update-b64/);
  assert.match(live, /--placements-b64/);
  assert.match(live, /rollback rejected batch placement/);
  assert.match(live, /"saved": False/);
  assert.doesNotMatch(kicadTools, /kicad_ipc_reference_rename|kicad_ipc_save|kicad_ipc_routing_remove|kicad_ipc_zone_refill|kicad_ipc_autoroute|kicad_ipc_arc_track/);
  assert.doesNotMatch(live, /board\.save\(/);
});

test('v0.61 KiCad IPC Phase 6 routing primitives stay bounded and rollback-gated', async () => {
  const kicadTools = await read('src/extensions/kicad/register.ts');
  const kicad = await read('src/adapters/engineering/kicad.ts');
  const routing = await read('scripts/kicad_ipc_routing.py');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  for (const tool of [
    'kicad_ipc_routing_inspect',
    'kicad_ipc_track_add',
    'kicad_ipc_track_update',
    'kicad_ipc_via_add',
    'kicad_ipc_via_update'
  ]) {
    assert.match(kicadTools, new RegExp(`server\\.registerTool\\('${tool}'`));
    assert.match(capabilities, new RegExp(tool));
  }
  assert.match(scopes, /kicad_ipc_routing_inspect: 'workstation\.read'/);
  assert.match(scopes, /kicad_ipc_track_add: 'workstation\.write'/);
  assert.match(scopes, /kicad_ipc_track_update: 'workstation\.write'/);
  assert.match(scopes, /kicad_ipc_via_add: 'workstation\.write'/);
  assert.match(scopes, /kicad_ipc_via_update: 'workstation\.write'/);
  assert.match(kicad, /ipcRoutingMutation/);
  assert.match(kicad, /--payload-b64/);
  assert.match(routing, /board\.create_items\(item\)/);
  assert.match(routing, /board\.update_items\(item\)/);
  assert.match(routing, /board\.remove_items\(item\)/);
  assert.match(routing, /rollback rejected routing create/);
  assert.match(routing, /rollback rejected track update/);
  assert.match(routing, /rollback rejected via update/);
  assert.match(routing, /VT_THROUGH/);
  assert.match(routing, /only through-via mutation is exposed in Phase 6/);
  assert.doesNotMatch(kicadTools, /kicad_ipc_routing_remove|kicad_ipc_zone_refill|kicad_ipc_autoroute|kicad_ipc_arc_track/);
  assert.doesNotMatch(routing, /board\.save\(/);
  assert.doesNotMatch(capabilities, /track\/via\/zone mutation, autorouting and implicit board save remain unavailable/);
});

test('v0.68 KiCad Phase 7 design review and visualization stay typed and non-autorouting', async () => {
  const kicadTools = await read('src/extensions/kicad/register.ts');
  const kicad = await read('src/adapters/engineering/kicad.ts');
  const review = await read('src/adapters/engineering/kicad-design-review.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  for (const tool of ['kicad_design_review', 'kicad_visual_export']) {
    assert.ok(kicadTools.includes(`server.registerTool('${tool}'`));
    assert.match(capabilities, new RegExp(tool));
  }
  assert.match(scopes, /kicad_design_review: 'workstation\.read'/);
  assert.match(scopes, /kicad_visual_export: 'workstation\.write'/);
  assert.match(kicadTools, /ctx\.runInWorkSession\(workSessionId/);
  assert.match(kicad, /prepareNewOutputDirectory/);
  assert.match(kicad, /fabricationManifest/);
  assert.match(kicad, /'sch', 'export', 'svg'/);
  assert.match(kicad, /'sch', 'export', 'pdf'/);
  assert.match(kicad, /'pcb', 'render'/);
  assert.match(kicad, /'pcb', 'export', 'step'/);
  assert.match(review, /longest-routed-net-ranking/);
  assert.match(review, /via-heavy-net-ranking/);
  assert.match(review, /missing-3d-model/);
  assert.doesNotMatch(kicadTools, /registerTool\('(?:kicad_.*autoroute|kicad_.*raw|kicad_visual_script)'/);
  assert.doesNotMatch(kicad, /--force/);
  assert.doesNotMatch(review, /spawn|execFile|child_process/);
  assert.match(capabilities, /Action Schema|KiCad Phase 7|kicad_design_review/);
});

test('v0.68 KiCad Phase 8 layout optimization planner stays read-only and geometry-evidence based', async () => {
  const kicadTools = await read('src/extensions/kicad/register.ts');
  const kicad = await read('src/adapters/engineering/kicad.ts');
  const layout = await read('src/adapters/engineering/kicad-layout-optimization.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  assert.ok(kicadTools.includes("server.registerTool('kicad_layout_optimize_plan'"));
  assert.match(scopes, /kicad_layout_optimize_plan: 'workstation\.read'/);
  assert.match(capabilities, /kicad_layout_optimize_plan/);
  assert.match(kicad, /'sch', 'export', 'netlist', '--format', 'kicadsexpr'/);
  assert.match(layout, /euclideanMstLength/);
  assert.match(layout, /net-weighted-centroid-pull/);
  assert.match(layout, /trackToMstRatio/);
  assert.match(layout, /schematic-pcb-net-mismatch/);
  assert.match(layout, /geometry-only candidates|geometryOnly/);
  assert.doesNotMatch(kicadTools, /registerTool\('(?:kicad_.*autoroute|kicad_.*raw|kicad_layout_apply)'/);
  assert.doesNotMatch(layout, /child_process|spawn|execFile|board\.save|writeFile/);
  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
});

test('v0.68 KiCad Phase 9 constraints review stays read-only and defers custom-rule authority to KiCad DRC', async () => {
  const kicadTools = await read('src/extensions/kicad/register.ts');
  const kicad = await read('src/adapters/engineering/kicad.ts');
  const constraints = await read('src/adapters/engineering/kicad-constraints-review.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  assert.ok(kicadTools.includes("server.registerTool('kicad_constraints_review'"));
  assert.match(scopes, /kicad_constraints_review: 'workstation\.read'/);
  assert.match(capabilities, /kicad_constraints_review/);
  assert.match(constraints, /hardMinimumFindings/);
  assert.match(constraints, /netClassDefaultDeviations/);
  assert.match(constraints, /catalog-only; KiCad DRC remains authoritative/);
  assert.match(constraints, /addsublayer/);
  assert.match(constraints, /128 \* 1024 \* 1024/);
  assert.match(constraints, /differentialPairs/);
  assert.doesNotMatch(kicadTools, /registerTool\('(?:kicad_.*rule_edit|kicad_.*constraints_apply|kicad_.*autoroute)'/);
  assert.doesNotMatch(constraints, /child_process|spawn|execFile|writeFile|board\.save/);
  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
});

test('v0.68 KiCad Phase 10 library intelligence resolves installed libraries without project mutation', async () => {
  const register = await read('src/extensions/kicad/register.ts');
  const adapter = await read('src/adapters/engineering/kicad.ts');
  const library = await read('src/adapters/engineering/kicad-library.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  assert.ok(register.includes("server.registerTool('kicad_library_lookup'"));
  assert.match(scopes, /kicad_library_lookup: 'workstation\.read'/);
  assert.match(library, /resolveKicadSymbol/);
  assert.match(library, /resolveKicadFootprint/);
  assert.match(library, /extendsChain/);
  assert.match(library, /footprintMatchesFilters/);
  assert.match(library, /alternates/);
  assert.match(adapter, /defaultKicadLibraryPaths/);
  assert.doesNotMatch(library, /writeFile|spawn|execFile|child_process/);
  assert.doesNotMatch(register, /kicad_library_(?:write|install|mutate|download)/);
  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
});

test('v0.68 KiCad Phase 11 schematic synthesis is Work-Session gated and round-trip verified', async () => {
  const register = await read('src/extensions/kicad/register.ts');
  const adapter = await read('src/adapters/engineering/kicad.ts');
  const synthesis = await read('src/adapters/engineering/kicad-schematic-synthesis.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  assert.ok(register.includes("server.registerTool('kicad_schematic_synthesize'"));
  assert.match(register, /ctx\.runInWorkSession\(workSessionId/);
  assert.match(scopes, /kicad_schematic_synthesize: 'workstation\.write'/);
  assert.match(adapter, /prepareNewOutputDirectory/);
  assert.match(adapter, /sch', 'export', 'netlist'/);
  assert.match(adapter, /verifyKicadSchematicNetlist/);
  assert.match(adapter, /output rejected/);
  assert.match(synthesis, /Unconnected power-input pins are not allowed/);
  assert.match(synthesis, /Pin-name guard failed/);
  assert.match(synthesis, /positive Y up/);
  assert.doesNotMatch(register, /rawSexpr|rawSchematic|rawArgs/);
  assert.doesNotMatch(synthesis, /child_process|spawn|execFile|writeFile/);
  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
});

test('v0.68 KiCad Phase 12 board synthesis is manifest-SHA gated and rollback-safe', async () => {
  const register = await read('src/extensions/kicad/register.ts');
  const adapter = await read('src/adapters/engineering/kicad.ts');
  const board = await read('src/adapters/engineering/kicad-board-synthesis.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  assert.ok(register.includes("server.registerTool('kicad_board_synthesize'"));
  assert.match(register, /expectedDesignManifestSha256/);
  assert.match(register, /ctx\.runInWorkSession\(workSessionId/);
  assert.match(scopes, /kicad_board_synthesize: 'workstation\.write'/);
  assert.match(adapter, /design manifest SHA mismatch/);
  assert.match(adapter, /schematicParity/);
  assert.match(adapter, /atomicReplace\(projectFile/);
  assert.match(adapter, /atomicReplace\(manifestPath/);
  assert.match(board, /canonicalKicadBoardNetName/);
  assert.match(board, /pinfunction/);
  assert.match(board, /pintype/);
  assert.match(board, /Edge\.Cuts/);
  assert.doesNotMatch(register, /rawPcb|rawBoard|rawSexpr/);
  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
});

test('v0.68 KiCad Phase 15 electrical review stays evidence-based and avoids fake SI/thermal claims', async () => {
  const register = await read('src/extensions/kicad/register.ts');
  const electrical = await read('src/adapters/engineering/kicad-electrical-review.ts');
  const adapter = await read('src/adapters/engineering/kicad.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');
  assert.ok(register.includes("server.registerTool('kicad_electrical_review'"));
  assert.match(scopes, /kicad_electrical_review: 'workstation\.read'/);
  assert.match(adapter, /async electricalReview/);
  assert.match(electrical, /COPPER_RESISTIVITY_OHM_M_20C/);
  assert.match(electrical, /impedance-solver-required/);
  assert.match(electrical, /No IPC-2152 ampacity\/temperature-rise claim is made/);
  assert.match(electrical, /No controlled-impedance claim is made without a field solver/);
  assert.doesNotMatch(electrical, /writeFile|spawn|execFile|child_process/);
  assert.doesNotMatch(register, /kicad_electrical_(?:apply|route|solve)/);
  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
});

test('v0.68 KiCad Phase 16 manufacturing package is Work-Session gated and production-output only', async () => {
  const register = await read('src/extensions/kicad/register.ts');
  const adapter = await read('src/adapters/engineering/kicad.ts');
  const manufacturing = await read('src/adapters/engineering/kicad-manufacturing.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  assert.ok(register.includes("server.registerTool('kicad_manufacturing_package'"));
  assert.match(register, /ctx\.runInWorkSession\(workSessionId/);
  assert.match(scopes, /kicad_manufacturing_package: 'workstation\.write'/);
  assert.match(adapter, /async manufacturingPackage/);
  assert.match(adapter, /pcb', 'export', 'gerbers'/);
  assert.match(adapter, /pcb', 'export', 'drill'/);
  assert.match(adapter, /pcb', 'export', 'pos'/);
  assert.match(adapter, /pcb', 'export', 'ipc2581'/);
  assert.match(adapter, /pcb', 'export', 'ipcd356'/);
  assert.match(adapter, /pcb', 'export', 'odb'/);
  assert.match(adapter, /pcb', 'export', 'step'/);
  assert.match(adapter, /assembly consistency rejected/);
  assert.match(adapter, /fabricationManifest/);
  assert.match(manufacturing, /missingCourtyardRefs/);
  assert.match(manufacturing, /dnpIncludedInPosition/);
  assert.doesNotMatch(register, /rawGerber|rawPlotArgs|rawManufacturingArgs/);
  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
});

test('v0.68 KiCad Phase 17 route planner is read-only, bounded and DRC-gated by construction', async () => {
  const register = await read('src/extensions/kicad/register.ts');
  const adapter = await read('src/adapters/engineering/kicad.ts');
  const planner = await read('src/adapters/engineering/kicad-route-plan.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  assert.ok(register.includes("server.registerTool('kicad_route_plan'"));
  assert.match(scopes, /kicad_route_plan: 'workstation\.read'/);
  assert.match(adapter, /async routePlan/);
  assert.match(planner, /class MinHeap/);
  assert.match(planner, /mstEdges/);
  assert.match(planner, /MAX_GRID_STATES/);
  assert.match(planner, /kicad_route_batch_apply/);
  assert.match(planner, /Controlled impedance, differential-pair coupling, RF, DDR/);
  assert.doesNotMatch(planner, /writeFile|spawn|execFile|child_process/);
  assert.doesNotMatch(register, /kicad_route_(?:raw|shell|autoroute_apply)/);
  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
});

test('v0.68 KiCad Phase 17 design agent composes typed stages and cannot certify specialized high-speed work', async () => {
  const register = await read('src/extensions/kicad/register.ts');
  const adapter = await read('src/adapters/engineering/kicad.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  assert.ok(register.includes("server.registerTool('kicad_design_agent_run'"));
  assert.match(register, /ctx\.runInWorkSession\(workSessionId/);
  assert.match(scopes, /kicad_design_agent_run: 'workstation\.write'/);
  for (const method of ['schematicSynthesize','semanticPlacementPlan','boardSynthesize','routePlan','routeBatchApply','validate','electricalReview','constraintsReview','designReview','visualExport','manufacturingPackage']) {
    assert.ok(adapter.includes(`this.${method}(`), `missing design-agent stage ${method}`);
  }
  assert.match(adapter, /needs-specialized-review/);
  assert.match(adapter, /targetImpedanceOhm/);
  assert.match(adapter, /intent\.kind === 'differential'/);
  assert.match(adapter, /intent\.kind === 'high_speed'/);
  assert.match(adapter, /status === 'complete'/);
  assert.doesNotMatch(register, /rawDesignSpec|rawKiCad|rawSexpr|shellCommand/);
  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
});

test('v0.62 Modbus RTU Phase 1 is bounded and read-only at the protocol surface', async () => {
  const modbusTools = await read('src/extensions/modbus/register.ts');
  const modbus = await read('src/adapters/engineering/modbus-rtu.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  for (const tool of ['modbus_rtu_provider_status', 'modbus_rtu_endpoint_status', 'modbus_rtu_read', 'modbus_rtu_probe']) {
    assert.match(modbusTools, new RegExp(`server\\.registerTool\\('${tool}'`));
    assert.match(capabilities, new RegExp(tool));
  }
  assert.match(scopes, /modbus_rtu_provider_status: 'workstation\.read'/);
  assert.match(scopes, /modbus_rtu_endpoint_status: 'workstation\.read'/);
  const modbusRtuAdapter = await read('src/adapters/engineering/modbus-rtu.ts');
  const endpointStatusBody = modbusRtuAdapter.match(/async endpointStatus\(port: string\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
  assert.doesNotMatch(endpointStatusBody, /assertEngineeringExecute/, 'endpointStatus must remain read-only');
  assert.match(scopes, /modbus_rtu_read: 'workstation\.read'/);
  assert.match(scopes, /modbus_rtu_probe: 'workstation\.read'/);
  assert.match(modbus, /supportedFunctions: \[1, 2, 3, 4\]/);
  assert.match(modbus, /withLease\(`serial:\$\{selected\}`, 'monitoring'/);
  assert.match(modbus, /Modbus probe accepts 1\.\.32 explicit unit IDs/);
  assert.match(modbus, /raw RTU frame injection/);
  assert.doesNotMatch(modbusTools, /modbus_rtu_write|modbus_rtu_raw|write_single_coil|write_single_register|write_multiple/);
  assert.doesNotMatch(modbus, /function:\s*5|function:\s*6|function:\s*15|function:\s*16/);
});

test('v0.63 network diagnostics remain bounded and read-only', async () => {
  const networkTools = await read('src/engineering/mcp/network-tools.ts');
  const network = await read('src/adapters/engineering/network-diagnostics.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  for (const tool of ['network_provider_status', 'network_interface_list', 'network_route_list', 'network_dns_lookup', 'network_ping', 'network_tcp_reachability']) {
    assert.match(networkTools, new RegExp(`server\\.registerTool\\('${tool}'`));
    assert.match(capabilities, new RegExp(tool));
    assert.match(scopes, new RegExp(`${tool}: 'workstation\\.read'`));
  }
  assert.match(network, /authority: 'read-only'/);
  assert.match(network, /IP configuration/);
  assert.match(network, /route mutation/);
  assert.match(network, /firewall mutation/);
  assert.doesNotMatch(networkTools, /network_route_add|network_route_delete|network_interface_set|network_firewall/);
  assert.doesNotMatch(network, /shell:\s*true/);
});

test('vendor hardening keeps watchpoint guarantees truthful and avoids duplicate OpenOCD verify', async () => {
  const debug = await read('src/adapters/engineering/debug-session.ts');
  const firmware = await read('src/adapters/engineering/firmware.ts');
  assert.match(debug, /kind: 'watchpoint', hardwareGuaranteed: access === 'read' \|\| access === 'access'/);
  assert.doesNotMatch(debug, /kind: 'hardware-watchpoint'/);
  assert.match(firmware, /program \{\$\{tclArtifact\}\} verify reset exit/);
  const deploy = firmware.slice(firmware.indexOf('async deployVerifyReset'), firmware.indexOf('async flash(', firmware.indexOf('async deployVerifyReset')));
  assert.doesNotMatch(deploy, /verify_image/);
});

test('v0.20 project_status is read-only coordination and cannot become an execution authority', async () => {
  const coreTools = await read('src/tools/core-tools.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');
  const coordination = await read('src/project-coordination.ts');

  assert.match(capabilities, /project\.multichat_status/);
  assert.match(capabilities, /project_status/);
  assert.match(scopes, /project_status: 'workstation\.read'/);

  const start = coreTools.indexOf("server.registerTool('project_status'");
  const end = coreTools.indexOf("server.registerTool('work_session_checkpoint'", start);
  assert.ok(start >= 0 && end > start);
  const tool = coreTools.slice(start, end);
  assert.match(tool, /readOnlyHint: true/);
  assert.match(tool, /ctx\.projectCoordination\.status/);
  assert.doesNotMatch(tool, /runInWorkSession|taskExecutor|execute_task|claimTask|task_claim|\.claim\(|acquire|withLease/);

  assert.match(coordination, /authority: 'coordination-only'/);
  assert.match(coordination, /executionActive: false/);
  assert.match(coordination, /kind: 'shared-worktree'/);
  assert.doesNotMatch(coordination, /startTask|finishTask|execute\(|acquire\(|withLease\(/);
});

test('v0.20 lifecycle preview remains read-only and cannot perform cleanup implicitly', async () => {
  const coreTools = await read('src/tools/core-tools.ts');
  const scopes = await read('src/security/request-principal.ts');

  assert.match(scopes, /work_session_lifecycle_preview: 'workstation\.read'/);
  const start = coreTools.indexOf("server.registerTool('work_session_lifecycle_preview'");
  const end = coreTools.indexOf("server.registerTool('project_status'", start);
  assert.ok(start >= 0 && end > start);
  const tool = coreTools.slice(start, end);
  assert.match(tool, /readOnlyHint: true/);
  assert.match(tool, /ctx\.workSessionLifecycle\.preview\(sessionId\)/);
  assert.doesNotMatch(tool, /ctx\.workSessionLifecycle\.close\(|worktreeManager\.cleanup\(|processes\.stop\(|resources\.release/);
});

test('v0.20 currentTask ownership label can be explicitly released without auto-claim semantics', async () => {
  const coreTools = await read('src/tools/core-tools.ts');
  const workSession = await read('src/work-session.ts');

  assert.match(coreTools, /currentTask: z\.string\(\)\.min\(1\)\.max\(512\)\.nullable\(\)\.optional\(\)/);
  assert.match(workSession, /currentTask\?: string \| null/);
  assert.match(workSession, /patch\.currentTask === null \? undefined/);
  assert.doesNotMatch(coreTools, /task_claim|autoClaim|auto_assign|autoAssign/);
});

test('STM32 IOC inspection is a bounded read-only typed surface', async () => {
  const tools = await read('src/extensions/stm32/register.ts');
  const adapter = await read('src/adapters/engineering/stm32-ioc.ts');
  const capabilities = await read('src/capabilities.ts');

  const start = tools.indexOf("server.registerTool('stm32_ioc_inspect'");
  const end = tools.indexOf("server.registerTool('stm32_svd_inspect'", start);
  assert.ok(start >= 0 && end > start);
  const block = tools.slice(start, end);
  assert.match(block, /readOnlyHint: true/);
  assert.match(block, /ctx\.engineering\.stm32Ioc\.inspect/);
  assert.doesNotMatch(block, /runInWorkSession|runner|process|shell|write|flash|reset/);
  assert.match(adapter, /MAX_IOC_BYTES = 4 \* 1024 \* 1024/);
  assert.match(adapter, /Multiple STM32 CubeMX \.ioc files/);
  assert.match(adapter, /iocFile must be a project-root \.ioc basename/);
  assert.match(capabilities, /'stm32_ioc_inspect'/);
});


test('STM32 SVD inspection is project-scoped, bounded and read-only', async () => {
  const tools = await read('src/extensions/stm32/register.ts');
  const adapter = await read('src/adapters/engineering/stm32-svd.ts');
  const capabilities = await read('src/capabilities.ts');
  const scopes = await read('src/security/request-principal.ts');

  const start = tools.indexOf("server.registerTool('stm32_svd_inspect'");
  assert.ok(start >= 0);
  const block = tools.slice(start);
  assert.match(block, /readOnlyHint: true/);
  assert.match(block, /ctx\.engineering\.stm32Svd\.inspect/);
  assert.doesNotMatch(block, /runInWorkSession|assertHardwareMutation|memoryWrite|firmware_flash|target_reset/);
  assert.match(adapter, /MAX_SVD_BYTES = 16 \* 1024 \* 1024/);
  assert.match(adapter, /SVD_XML_UNSAFE/);
  assert.match(adapter, /svdFile must be a project-relative \.svd path/);
  assert.match(capabilities, /'stm32_svd_inspect'/);
  assert.match(scopes, /stm32_svd_inspect: 'workstation\.read'/);
});

test('Ubuntu host reboot remains a typed owner-approved action rather than a generic Linux root shell', async () => {
  const privileged = await read('src/tools/privileged-tools.ts');
  const tuiAdmin = await read('src/tui/admin-requests.ts');
  const tuiCli = await read('src/tui-cli.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  assert.match(privileged, /server\.registerTool\('node_reboot_request'/);
  assert.match(privileged, /linuxHostRebootCommand\(\)/);
  assert.match(scopes, /node_reboot_request: 'workstation\.admin_request'/);
  assert.match(capabilities, /'node_reboot_request'/);
  assert.match(tuiAdmin, /'\/usr\/bin\/systemctl'/);
  assert.match(tuiAdmin, /\['--no-block', 'reboot'\]/);
  assert.match(tuiAdmin, /\['-k', '--', LINUX_SYSTEMCTL/);
  assert.doesNotMatch(tuiAdmin, /shell:\s*true/);
  assert.match(tuiAdmin, /NODE_BUSY/);
  assert.match(tuiCli, /Admin requests/);
  assert.match(tuiCli, /RWMCP only/);
  assert.match(tuiCli, /CONFIRM HOST REBOOT/);
});

test('Codex Account Broker is read-only, secret-safe and cannot become an auth-file mutation surface', async () => {
  const coreTools = await read('src/tools/core-tools.ts');
  const broker = await read('src/workers/codex-account-broker.ts');
  const provider = await read('src/workers/codex-worker-provider.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  assert.match(coreTools, /server\.registerTool\('codex_account_broker_status'/);
  assert.match(coreTools, /readOnlyHint: true/);
  assert.match(scopes, /codex_account_broker_status: 'workstation\.read'/);
  assert.match(capabilities, /agent\.codex_account_broker/);
  assert.match(broker, /codex_accounts\.json/);
  assert.match(broker, /codex_local_access\.json/);
  assert.match(broker, /RWMCP_COCKPIT_CODEX_API_KEY/);
  assert.match(broker, /model_provider=rwmcp_cockpit_pool/);
  assert.match(provider, /--ignore-user-config/);
  assert.doesNotMatch(broker, /auth\.json[^']*write|writeFile[^\n]*auth\.json/i);
  assert.doesNotMatch(broker, /decrypt|ciphertext.*read/i);
});

test('Antigravity worker uses official headless interfaces without credential extraction or global auto-approval', async () => {
  const provider = await read('src/workers/antigravity-worker-provider.ts');
  const coreTools = await read('src/tools/core-tools.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');
  const settings = await read('src/setup/settings.ts');

  assert.match(coreTools, /server\.registerTool\('antigravity_status'/);
  assert.match(scopes, /antigravity_status: 'workstation\.read'/);
  assert.match(capabilities, /agent\.antigravity_worker/);
  assert.match(settings, /antigravityEnabled: z\.boolean\(\)\.default\(false\)/);
  assert.match(provider, /--input-format', 'stream-json'/);
  assert.match(provider, /--output-format', 'stream-json'/);
  assert.match(provider, /'--sandbox'/);
  assert.match(provider, /event: 'user', message: \{ content: prompt \}/);
  assert.doesNotMatch(provider, /--dangerously-skip-permissions/);
  assert.doesNotMatch(provider, /keyring.*read|oauth.*token.*read|decrypt.*credential/i);
});

test('Keil remains a typed provider rather than an arbitrary command surface', async () => {
  const firmware = await read('src/adapters/engineering/firmware.ts');
  const profile = await read('src/adapters/engineering/project-profile.ts');

  assert.match(firmware, /discoverKeilUv4/);
  assert.match(firmware, /\['-j0', '-b', projectAbsolute, `-t\$\{target\}`, `-o\$\{logPath\}`\]/);
  assert.match(firmware, /project\.targets\?\.find/);
  assert.match(firmware, /Keil target '\$\{target\}'.*was not found in inspected \.uvprojx metadata/);
  assert.doesNotMatch(profile, /command:/);
  assert.doesNotMatch(profile, /args:/);
});


test('current runtime retains Work Session routing under Action Schema v26 and Keil shared outputs remain project-variant exclusive', async () => {
  const capabilities = await read('src/capabilities.ts');
  const coreTools = await read('src/tools/core-tools.ts');
  const engineeringTools = await read('src/tools/engineering-tools.ts');
  const contract = await read('src/engineering-workflow-contract.ts');
  const workflowExecution = await read('src/engineering-workflow-execution.ts');
  const firmware = await read('src/adapters/engineering/firmware.ts');

  assert.match(capabilities, /export const ACTION_SCHEMA_VERSION = 72;/);
  assert.match(coreTools, /work_session_create/);
  assert.match(coreTools, /work_session_resume/);
  assert.match(coreTools, /work_session_lifecycle_preview/);
  assert.match(coreTools, /work_session_close/);
  assert.match(coreTools, /work_session_worktree_prepare/);

  const resumeStart = coreTools.indexOf("server.registerTool('work_session_resume'");
  const resumeEnd = coreTools.indexOf("server.registerTool('work_session_list'", resumeStart);
  assert.ok(resumeStart >= 0 && resumeEnd > resumeStart);
  const resumeBlock = coreTools.slice(resumeStart, resumeEnd);
  assert.match(resumeBlock, /readOnlyHint: true/);
  assert.match(resumeBlock, /ctx\.workSessions\.inspect\(sessionId, true\)/);
  assert.match(resumeBlock, /ctx\.scopeWorkSession\(sessionId/);
  assert.match(resumeBlock, /ctx\.projectCoordination\.status/);
  assert.match(resumeBlock, /handoff:/);
  assert.doesNotMatch(resumeBlock, /ctx\.runInWorkSession\(sessionId/);
  assert.match(contract, /workSessionId: z\.string\(\)\.uuid\(\)\.optional\(\)/);
  assert.match(engineeringTools, /const \{ workSessionId, \.\.\.runtimeParameters \} = parsed/);
  assert.match(engineeringTools, /ctx\.runInWorkSession\(workSessionId/);
  assert.match(engineeringTools, /ctx\.engineering\.execution\.run\(workspace, projectPath, workflow, runtimeParameters\)/);
  assert.match(workflowExecution, /this\.workflowRuns\.begin\(workspace, projectPath, workflow\)/);
  assert.match(workflowExecution, /this\.workflowRuns\.finish\(run\.id/);
  assert.match(workflowExecution, /this\.nodeInterlocks\.acquireWorkflow/);

  assert.match(firmware, /project-variant:keil:\$\{workspace\}:\$\{projectPath\}:\$\{projectFile\}:\$\{target\}/);
  assert.match(firmware, /this\.resources\.withLease\(buildResourceId, 'building'/);
});

test('v0.16 quality learning foundation is evidence-gated and never exposes MCP approval', async () => {
  const capabilities = await read('src/capabilities.ts');
  const coreTools = await read('src/tools/core-tools.ts');
  const engineeringTools = await read('src/tools/engineering-tools.ts');
  const quality = await read('src/quality-learning.ts');
  const qualityPolicy = await read('src/quality-learning-policy.ts');
  const qualityKnowledge = await read('src/quality-knowledge.ts');
  const qualityReview = await read('src/quality-review.ts');
  const setupServer = await read('src/setup/setup-server.ts');
  const context = await read('src/context.ts');
  const workflowExecution = await read('src/engineering-workflow-execution.ts');

  assert.match(capabilities, /quality_learning\.telemetry/);
  assert.match(capabilities, /quality_learning\.knowledge/);
  assert.match(context, /qualityObservationReconciliationFailures/);
  assert.match(context, /Quality telemetry is advisory[\s\S]*qualityObservationReconciliationFailures \+= 1/);
  assert.match(workflowExecution, /this\.qualityObservations\.observe\(finished/);
  assert.match(coreTools, /qualityObservations: await ctx\.qualityObservations\.list\(20\)\.catch/);
  assert.match(quality, /pending-owner-review/);
  assert.match(quality, /ambiguous-outcome-evidence/);
  assert.match(quality, /implicit-work-session/);
  assert.match(quality, /runtime-reconciliation/);
  assert.match(quality, /promotionState: 'not-promoted'/);
  assert.match(quality, /active: false/);
  assert.match(qualityReview, /OwnerQualityReviewStore/);
  assert.match(qualityReview, /'approved' \| 'rejected' \| 'revoked'/);
  assert.match(qualityPolicy, /enabled: true/);
  assert.match(qualityPolicy, /retentionDays: 30/);
  assert.match(qualityPolicy, /minApprovedSamples: 3/);
  assert.match(qualityKnowledge, /recommendationOnly: true/);
  assert.match(qualityKnowledge, /executionActive: false/);
  assert.match(qualityKnowledge, /raw-shell-when-typed-workflow-exists/);
  assert.match(qualityKnowledge, /needs-revalidation/);
  assert.match(qualityKnowledge, /insufficient-approved-samples/);
  assert.match(setupServer, /\/api\/quality\/review/);
  assert.match(setupServer, /\/api\/quality\/settings/);
  assert.match(setupServer, /\/api\/quality\/knowledge/);
  assert.match(setupServer, /\/api\/quality\/history/);
  assert.match(setupServer, /authority: 'owner-local-only'/);
  assert.doesNotMatch(coreTools, /quality_(learning|review|knowledge)_(approve|reject|revoke|promote|activate|shadow)/);
  assert.doesNotMatch(engineeringTools, /quality_(learning|review|knowledge)_(approve|reject|revoke|promote|activate|shadow)/);
});


test('Phase 3 Task Graph exposes one bounded typed executor without becoming an authority source', async () => {
  const capabilities = await read('src/capabilities.ts');
  const coreTools = await read('src/tools/core-tools.ts');
  const scopes = await read('src/security/request-principal.ts');
  const taskGraph = await read('src/task-graph.ts');
  const workflowContract = await read('src/engineering-workflow-contract.ts');
  const workflowExecution = await read('src/engineering-workflow-execution.ts');
  const taskWorkflowExecution = await read('src/task-workflow-execution.ts');
  const taskAttempts = await read('src/task-attempt-store.ts');
  const schedulerAwareness = await read('src/scheduler-awareness.ts');
  const objectiveProgress = await read('src/objective-progress.ts');
  const context = await read('src/context.ts');

  assert.match(capabilities, /work_objective\.task_graph/);
  assert.match(capabilities, /work_objective_create/);
  assert.match(capabilities, /work_objective_inspect/);
  assert.match(capabilities, /work_objective_mutate/);
  assert.match(capabilities, /work_objective_summary/);
  assert.match(capabilities, /work_objective_schedule/);
  assert.match(capabilities, /work_objective_attempts/);
  assert.match(capabilities, /work_objective_execute_task/);
  assert.match(capabilities, /work_objective_cancel_task/);
  assert.match(capabilities, /work_objective_retry_task/);

  assert.match(coreTools, /work_objective_create/);
  assert.match(coreTools, /work_objective_inspect/);
  assert.match(coreTools, /work_objective_mutate/);
  assert.match(coreTools, /work_objective_summary/);
  assert.match(coreTools, /work_objective_schedule/);
  assert.match(coreTools, /work_objective_attempts/);
  assert.match(coreTools, /work_objective_execute_task/);
  assert.match(coreTools, /work_objective_cancel_task/);
  assert.match(coreTools, /work_objective_retry_task/);
  assert.match(coreTools, /planning-only/);
  assert.match(coreTools, /executionActive: false/);
  assert.match(coreTools, /ctx\.taskWorkflowExecution\.execute\(objectiveId, taskId\)/);
  assert.match(taskWorkflowExecution, /this\.taskExecutor\.execute/);
  assert.match(taskWorkflowExecution, /this\.workflowExecution\.run/);
  assert.match(taskWorkflowExecution, /TASK_WORKFLOW_NOT_SUCCEEDED/);
  assert.match(taskWorkflowExecution, /replayed: true/);
  assert.match(taskWorkflowExecution, /requestCancellation/);
  assert.match(taskWorkflowExecution, /retryTask/);
  assert.match(coreTools, /action: z\.literal\('add_task'\)/);
  assert.match(coreTools, /action: z\.literal\('replace_dependencies'\)/);

  const executeStart = coreTools.indexOf("server.registerTool('work_objective_execute_task'");
  const executeEnd = coreTools.indexOf("server.registerTool('work_objective_cancel_task'", executeStart);
  assert.ok(executeStart >= 0 && executeEnd > executeStart);
  const executeBlock = coreTools.slice(executeStart, executeEnd);
  assert.doesNotMatch(executeBlock, /shell_exec|program:|args:|host_fs|permission_|cross_node_transfer/);
  assert.doesNotMatch(coreTools, /action: z\.literal\('(start_task|finish_task|mark_running|mark_succeeded)'\)/);

  assert.match(scopes, /work_objective_create: 'workstation\.write'/);
  assert.match(scopes, /work_objective_inspect: 'workstation\.read'/);
  assert.match(scopes, /work_objective_mutate: 'workstation\.write'/);
  assert.match(scopes, /work_objective_summary: 'workstation\.read'/);
  assert.match(scopes, /work_objective_schedule: 'workstation\.read'/);
  assert.match(scopes, /work_objective_attempts: 'workstation\.read'/);
  assert.match(scopes, /work_objective_execute_task: 'workstation\.execute'/);
  assert.match(scopes, /work_objective_cancel_task: 'workstation\.execute'/);
  assert.match(scopes, /work_objective_retry_task: 'workstation\.execute'/);

  assert.match(taskGraph, /Task dependency cycle detected/);
  assert.match(taskGraph, /runtime-restarted-before-task-completion/);
  assert.match(taskGraph, /CONCURRENCY_KEY_REQUIRED/);
  assert.match(taskGraph, /EXECUTION_BINDING_REQUIRED/);
  assert.match(taskGraph, /OWNER_LOCAL_ONLY/);
  assert.match(workflowContract, /persistedWorkflowParametersSchema[\s\S]*transferTicket: true[\s\S]*relayDataBase64: true/);
  assert.match(workflowExecution, /this\.qualityObservations\.observe/);
  assert.match(taskAttempts, /class TaskAttemptStore/);
  assert.match(taskAttempts, /runtime-restarted-before-task-attempt-completion/);
  assert.match(coreTools, /ctx\.schedulerAwareness\.snapshot\(objectiveId, limit\)/);
  assert.match(schedulerAwareness, /waiting-resource/);
  assert.match(schedulerAwareness, /waiting-session/);
  assert.match(schedulerAwareness, /waiting-node/);
  assert.match(schedulerAwareness, /RESOURCE_BUSY/);
  assert.match(schedulerAwareness, /NODE_INTERLOCK_ACTIVE/);
  assert.match(schedulerAwareness, /resourceLeases/);
  assert.doesNotMatch(schedulerAwareness, /acquire\(|withLease\(|grant|permission|crossNode/);
  assert.match(coreTools, /ctx\.objectiveProgress\.summary\(objectiveId/);
  assert.match(objectiveProgress, /class ObjectiveProgressService/);
  assert.match(objectiveProgress, /mechanicallyDerived: true/);
  assert.match(objectiveProgress, /recommendation: false/);
  assert.match(objectiveProgress, /authority: 'read-only-summary'/);
  assert.match(objectiveProgress, /Math\.min\(options\.taskLimit \?\? 64, 128\)/);
  assert.doesNotMatch(objectiveProgress, /shell_exec|process_start|stdout|stderr|transcript|chain-of-thought/);
  assert.match(context, /new TaskAttemptStore/);
  assert.match(context, /reconciledTaskAttempts/);
  assert.match(context, /new TaskGraphStore/);
  assert.match(context, /reconcileInterrupted/);
  assert.match(context, /new DeterministicTaskScheduler/);
  assert.match(context, /new SchedulerAwarenessService/);
  assert.match(context, /new ObjectiveProgressService/);
  assert.match(context, /new EngineeringWorkflowExecutionService/);
  assert.match(context, /new TaskWorkflowExecutionService/);
});


test('v0.64 ESP32 Ubuntu tooling is project-bound, stable-device aware and excludes dangerous ROM surfaces', async () => {
  const tools = await read('src/extensions/esp32/register.ts');
  const sharedSchemas = await read('src/engineering/mcp-schemas.ts');
  const firmware = await read('src/adapters/engineering/firmware.ts');
  const metadata = await read('src/adapters/engineering/esp-idf-metadata.ts');
  const profile = await read('src/adapters/engineering/project-profile.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');
  const helper = await read('scripts/esp-idf-run.sh');

  assert.equal(helper.charCodeAt(0), '#'.charCodeAt(0));
  assert.match(helper, /^#!\/usr\/bin\/env bash/);
  assert.match(helper, /rwmcp_idf_path/);
  assert.match(helper, /rwmcp_idf_args/);
  assert.doesNotMatch(helper, /^\uFEFF/);

  assert.match(tools, /server\.registerTool\('esp32_preflight'/);
  assert.match(tools, /portSelector: serialDeviceSelectorSchema\.optional\(\)/);
  assert.match(sharedSchemas, /export const serialDeviceSelectorSchema/);
  assert.match(tools, /ctx\.engineering\.workflows\.esp32Preflight/);
  assert.match(scopes, /esp32_preflight: 'workstation\.execute'/);
  assert.match(capabilities, /engineering\.esp32/);
  assert.match(capabilities, /eFuse writes/);
  assert.match(capabilities, /erase-flash/);

  assert.match(metadata, /idfPath: scalar\(record, 'idf_path', 'idfPath'\)/);
  assert.match(profile, /espIdfPath\?: string/);
  assert.match(profile, /firmware\.espIdfPath/);
  assert.match(firmware, /Multiple ESP-IDF installations were found/);
  assert.match(firmware, /\['-B', selectedBuildDir, 'build'\]/);
  assert.match(firmware, /project-variant:esp-idf:/);
  assert.match(firmware, /this\.resources\.withLease\([\s\S]*'building'/);
  assert.match(firmware, /stable portSelector/);
  assert.match(firmware, /boundedFileIdentity/);
  assert.match(firmware, /flashManifest/);
  assert.match(firmware, /readyForBuild: buildBlockers\.length === 0/);
  assert.match(firmware, /flash-encryption keys/);

  assert.doesNotMatch(tools, /esp32_erase|esp32_efuse|esptool_raw|esp32_rom_command/);
});

test('v0.65 ESP-IDF environment provenance and maintenance stay typed behind the stable workflow envelope', async () => {
  const firmware = await read('src/adapters/engineering/firmware.ts');
  const profile = await read('src/adapters/engineering/project-profile.ts');
  const workflows = await read('src/adapters/engineering/workflow-engine.ts');
  const metadata = await read('src/adapters/engineering/esp-idf-metadata.ts');
  const capabilities = await read('src/capabilities.ts');
  const helperLinux = await read('scripts/esp-idf-run.sh');
  const helperWindows = await read('scripts/esp-idf-run.ps1');

  assert.match(profile, /interface EspIdfEnvironmentProfile/);
  assert.match(profile, /pythonEnvPath\?: string/);
  assert.match(profile, /skipCheckSubmodules\?: boolean/);
  assert.match(profile, /expectedPythonVersion\?: string/);
  assert.match(profile, /expectedCompilerPath\?: string/);
  assert.match(profile, /expectedCompilerVersion\?: string/);
  assert.match(profile, /espIdfEnvironmentSchema = z\.object/);
  const envSchemaStart = profile.indexOf('const espIdfEnvironmentSchema = z.object({');
  const envSchemaEnd = profile.indexOf('}).strict();', envSchemaStart);
  assert.ok(envSchemaStart >= 0 && envSchemaEnd > envSchemaStart);
  assert.doesNotMatch(profile.slice(envSchemaStart, envSchemaEnd), /z\.record/);

  for (const workflow of ['espidf.preflight', 'espidf.fullclean', 'espidf.reconfigure']) {
    assert.match(workflows, new RegExp(workflow.replace('.', '\\.' )));
  }
  assert.match(workflows, /this\.firmware\.espIdfMaintenance/);
  assert.match(workflows, /this\.firmware\.esp32Preflight/);
  assert.match(firmware, /action: 'fullclean' \| 'reconfigure'/);
  assert.match(firmware, /assertEspIdfBuildDirContained/);
  assert.match(firmware, /runtimeMismatches/);
  assert.match(firmware, /buildMismatches/);
  assert.match(firmware, /expectedCompilerVersion/);
  assert.match(metadata, /cCompiler: scalar\(record, 'c_compiler', 'cCompiler'\)/);

  assert.match(helperLinux, /--rwmcp-python-env-path/);
  assert.match(helperLinux, /--rwmcp-skip-check-submodules/);
  assert.match(helperLinux, /--rwmcp-print-provenance/);
  assert.match(helperLinux, /IDF_PYTHON_ENV_PATH/);
  assert.match(helperLinux, /IDF_TOOLS_PATH.*~\/\.espressif/);
  assert.match(helperWindows, /\[switch\]\$Provenance/);
  assert.match(helperWindows, /IDF_SKIP_CHECK_SUBMODULES/);
  assert.match(helperWindows, /IDF_TOOLS_PATH.*~\/\.espressif/);

  assert.match(capabilities, /v0\.65 extends/);
  assert.match(capabilities, /arbitrary environment maps/);
  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
  assert.doesNotMatch(workflows, /workflow === 'espidf\.(erase|efuse|raw)'/);
  assert.doesNotMatch(firmware, /async\s+(?:eraseFlash|writeEfuse|runRawEsptool)\s*\(/);
});


test('Camera Diagnostics Phase 2 keeps PTZ credentials owner-local and movement bounded', async () => {
  const register = await read('src/extensions/camera/register.ts');
  const store = await read('src/extensions/camera/profile-store.ts');
  const rtsp = await read('src/extensions/camera/rtsp-client.ts');
  const onvif = await read('src/extensions/camera/onvif-ptz.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  assert.match(register, /registerTool\('camera_provider_status'/);
  assert.match(register, /registerTool\('camera_profile_list'/);
  assert.match(register, /registerTool\('camera_profile_inspect'/);
  assert.match(register, /registerTool\('camera_rtsp_probe'/);
  assert.match(register, /registerTool\('camera_stream_metadata'/);

  assert.match(scopes, /camera_provider_status: 'workstation\.read'/);
  assert.match(scopes, /camera_profile_list: 'workstation\.read'/);
  assert.match(scopes, /camera_profile_inspect: 'workstation\.read'/);
  assert.match(scopes, /camera_rtsp_probe: 'workstation\.read'/);
  assert.match(scopes, /camera_stream_metadata: 'workstation\.execute'/);
  assert.match(scopes, /camera_ptz_status: 'workstation\.read'/);
  assert.match(scopes, /camera_ptz_move: 'workstation\.execute'/);
  assert.match(scopes, /camera_ptz_stop: 'workstation\.execute'/);
  assert.match(scopes, /camera_fleet_probe: 'workstation\.read'/);

  assert.match(capabilities, /engineering\.camera/);
  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
  assert.match(register, /registerTool\('camera_ptz_status'/);
  assert.match(register, /registerTool\('camera_ptz_move'/);
  assert.match(register, /registerTool\('camera_ptz_stop'/);
  assert.match(register, /registerTool\('camera_fleet_probe'/);
  assert.match(store, /passwordEnv/);
  assert.match(store, /toPublicProfile/);
  assert.doesNotMatch(register, /passwordEnv|username|password/);
  assert.doesNotMatch(register, /registerTool\('camera_(talk|snapshot|write|config)/);
  assert.match(onvif, /durationMs < 50 \|\| durationMs > 2_000/);
  assert.match(onvif, /await this\.stop\(profile, timeoutMs\)/);
  assert.match(onvif, /PasswordDigest/);
  assert.match(rtsp, /DESCRIBE/);
});


test('Media/Video Phase 1 stays typed, project-scoped and bounded', async () => {
  const register = await read('src/extensions/media/register.ts');
  const adapter = await read('src/extensions/media/media-adapter.ts');
  const store = await read('src/extensions/media/profile-store.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  assert.match(register, /registerTool\('media_provider_status'/);
  assert.match(register, /registerTool\('media_file_probe'/);
  assert.match(register, /registerTool\('media_transcode_plan'/);
  assert.match(register, /registerTool\('media_transcode'/);
  assert.match(register, /registerTool\('media_remotion_status'/);
  assert.match(register, /registerTool\('media_comfyui_status'/);

  assert.match(scopes, /media_provider_status: 'workstation\.read'/);
  assert.match(scopes, /media_file_probe: 'workstation\.execute'/);
  assert.match(scopes, /media_transcode_plan: 'workstation\.read'/);
  assert.match(scopes, /media_transcode: 'workstation\.execute'/);
  assert.match(scopes, /media_remotion_status: 'workstation\.read'/);
  assert.match(scopes, /media_comfyui_status: 'workstation\.read'/);

  assert.match(capabilities, /engineering\.media/);
  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
  assert.match(adapter, /ffmpeg/);
  assert.match(adapter, /ffprobe/);
  assert.match(adapter, /fail-if-exists/);
  assert.match(adapter, /partial-output cleanup|fs\.rm\(outputAbsolute/);
  assert.match(register, /ctx\.runInWorkSession/);
  assert.doesNotMatch(register, /rawArgs|commandLine|shellCommand/);
  assert.doesNotMatch(store, /password|username|tokenEnv|clientSecret/i);
});


test('Media/Video Phase 2 restricts ComfyUI submission to owner-local typed presets', async () => {
  const register = await read('src/extensions/media/register.ts');
  const jobs = await read('src/extensions/media/comfyui-jobs.ts');
  const workflowStore = await read('src/extensions/media/workflow-store.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  assert.match(register, /registerTool\('media_comfyui_preset_list'/);
  assert.match(register, /registerTool\('media_comfyui_job_plan'/);
  assert.match(register, /registerTool\('media_comfyui_job_submit'/);
  assert.match(register, /registerTool\('media_comfyui_job_status'/);

  assert.match(scopes, /media_comfyui_preset_list: 'workstation\.read'/);
  assert.match(scopes, /media_comfyui_job_plan: 'workstation\.read'/);
  assert.match(scopes, /media_comfyui_job_submit: 'workstation\.execute'/);
  assert.match(scopes, /media_comfyui_job_status: 'workstation\.read'/);

  assert.match(register, /ctx\.runInWorkSession/);
  assert.match(jobs, /POST/);
  assert.match(jobs, /\/prompt/);
  assert.match(jobs, /\/history\//);
  assert.match(workflowStore, /comfyui-presets\.json/);
  assert.match(workflowStore, /comfyui-workflows/);
  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
  assert.doesNotMatch(register, /workflowJson|rawWorkflow|arbitraryWorkflow/);
});


test('Media/Video Phase 3 imports only bounded durable ComfyUI artifacts', async () => {
  const register = await read('src/extensions/media/register.ts');
  const importer = await read('src/extensions/media/comfyui-artifacts.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  assert.match(register, /registerTool\('media_comfyui_artifact_plan'/);
  assert.match(register, /registerTool\('media_comfyui_artifact_import'/);
  assert.match(scopes, /media_comfyui_artifact_plan: 'workstation\.read'/);
  assert.match(scopes, /media_comfyui_artifact_import: 'workstation\.execute'/);
  assert.match(register, /ctx\.runInWorkSession/);
  assert.match(importer, /artifactIndex/);
  assert.match(importer, /type !== 'output'/);
  assert.match(importer, /fail-if-exists/);
  assert.match(importer, /createHash\('sha256'\)/);
  assert.match(importer, /fs\.rename\(temp, destinationAbsolute\)/);
  assert.match(importer, /fs\.rm\(temp/);
  assert.doesNotMatch(register, /sourceFilename|sourceSubfolder/);
  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
});

test('Media/Video Phase 4 renders only owner-local typed Remotion presets', async () => {
  const register = await read('src/extensions/media/register.ts');
  const renderer = await read('src/extensions/media/remotion-render.ts');
  const store = await read('src/extensions/media/remotion-store.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  assert.match(register, /registerTool\('media_remotion_preset_list'/);
  assert.match(register, /registerTool\('media_remotion_render_plan'/);
  assert.match(register, /registerTool\('media_remotion_render'/);
  assert.match(scopes, /media_remotion_preset_list: 'workstation\.read'/);
  assert.match(scopes, /media_remotion_render_plan: 'workstation\.read'/);
  assert.match(scopes, /media_remotion_render: 'workstation\.execute'/);
  assert.match(register, /ctx\.runInWorkSession/);
  assert.match(store, /remotion-presets\.json/);
  assert.match(renderer, /--overwrite=false/);
  assert.match(renderer, /--browser-executable=/);
  assert.match(renderer, /createHash\('sha256'\)/);
  assert.match(renderer, /mkdtemp/);
  assert.doesNotMatch(register, /entryPoint|rawArgs|commandLine|shellCommand/);
  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
});

test('Media/Video Phase 6 CapCut editing is typed, plan-hash gated and fail-closed', async () => {
  const register = await read('src/extensions/media/register.ts');
  const adapter = await read('src/extensions/media/capcut-draft.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  for (const name of ['media_capcut_status', 'media_capcut_project_list', 'media_capcut_project_inspect', 'media_capcut_edit_plan']) {
    assert.match(register, new RegExp(`registerTool\\('${name}'`));
    assert.ok(scopes.includes(`${name}: 'workstation.read'`));
  }
  assert.match(register, /registerTool\('media_capcut_edit'/);
  assert.match(scopes, /media_capcut_edit: 'workstation\.execute'/);
  assert.match(register, /expectedResultSha256: capcutSha256/);
  assert.match(register, /ctx\.runInWorkSession/);
  assert.match(adapter, /CapCut is running/);
  assert.match(adapter, /mirrorConsistent/);
  assert.match(adapter, /withLease\(resourceId, 'orchestrating'/);
  assert.match(adapter, /expectedResultSha256/);
  assert.match(adapter, /ROLLBACK_INCOMPLETE/);
  assert.doesNotMatch(register, /rawJson|jsonPatch|rawPatch/);
  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
  assert.match(capabilities, /CapCut Phase 6/);
});

test('Media/Video Phase 7 CapCut UI inspection stays semantic, read-only and app-bound', async () => {
  const register = await read('src/extensions/media/register.ts');
  const capcutUi = await read('src/extensions/media/capcut-ui.ts');
  const windowsUi = await read('src/adapters/windows-semantic-ui.ts');
  const helper = await read('scripts/ui/windows-ui-automation.ps1');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  assert.match(register, /registerTool\('media_capcut_ui_inspect'/);
  assert.match(scopes, /media_capcut_ui_inspect: 'workstation\.read'/);
  assert.match(register, /maxDepth: z\.number\(\)\.int\(\)\.min\(0\)\.max\(12\)/);
  assert.match(register, /maxNodes: z\.number\(\)\.int\(\)\.min\(1\)\.max\(1024\)/);
  assert.match(capcutUi, /installationInfo\(\)/);
  assert.match(capcutUi, /this\.ui\.inspect\(installation\.executable/);
  assert.match(windowsUi, /WindowsSemanticUiAdapter/);
  assert.match(windowsUi, /-MTA/);
  assert.match(helper, /UIAutomationClient/);
  assert.match(helper, /AutomationElement/);
  assert.match(helper, /UIA_ELEVATED_HELPER_REFUSED/);
  assert.doesNotMatch(helper, /SendKeys|SendInput|mouse_event|SetCursorPos|BoundingRectangle/i);
  assert.doesNotMatch(register, /registerTool\('(?:media_windows_ui|desktop_click|desktop_type|desktop_invoke|desktop_set_value)'/i);
  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
  assert.match(capabilities, /Phase 7 adds (?:a|the) Windows UI Automation substrate/);
});

test('Media/Video Phase 8 native CapCut export is version-bound, plan-hash gated and acceptance-verified', async () => {
  const register = await read('src/extensions/media/register.ts');
  const exporter = await read('src/extensions/media/capcut-native-export.ts');
  const profiles = await read('src/extensions/media/capcut-export-profile.ts');
  const draft = await read('src/extensions/media/capcut-draft.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  for (const name of ['media_capcut_export_profile_list', 'media_capcut_export_plan']) {
    assert.match(register, new RegExp(`registerTool\\('${name}'`));
    assert.ok(scopes.includes(`${name}: 'workstation.read'`));
  }
  assert.match(register, /registerTool\('media_capcut_export'/);
  assert.match(scopes, /media_capcut_export: 'workstation\.execute'/);
  assert.match(register, /expectedPlanSha256: capcutSha256/);
  assert.match(register, /ctx\.runInWorkSession/);

  assert.match(profiles, /capcut-export-profiles\.json/);
  assert.match(profiles, /appVersion/);
  assert.match(profiles, /\.strict\(\)/);
  assert.doesNotMatch(profiles, /\bx\s*:|\by\s*:|screenX|screenY|password|token|credential/i);

  assert.match(draft, /projectIdentity\(projectId/);
  assert.match(draft, /draft_meta_info\.json/);
  assert.match(exporter, /CAPCUT_EXPORT_PROFILE_MISMATCH/);
  assert.match(exporter, /activeProcess/);
  assert.match(exporter, /withLease\(resourceId, 'orchestrating'/);
  assert.match(exporter, /planned result|plan changed since review|expectedPlanSha256/i);
  assert.match(exporter, /output already exists|never overwrites/i);
  assert.match(exporter, /probeFile/);
  assert.match(exporter, /sha256File/);
  assert.match(exporter, /CAPCUT_EXPORT_CLEANUP_INCOMPLETE/);
  assert.doesNotMatch(exporter, /SendKeys|SendInput|mouse_event|SetCursorPos|screenX|screenY/i);

  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
  assert.match(capabilities, /Phase 8 adds owner-local semantic export profiles/);
});

test('Media/Video Phase 9 CapCut headless render is fixed-graph, plan-hash gated and fidelity-explicit', async () => {
  const register = await read('src/extensions/media/register.ts');
  const renderer = await read('src/extensions/media/capcut-headless-render.ts');
  const draft = await read('src/extensions/media/capcut-draft.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  assert.match(register, /registerTool\('media_capcut_headless_render_plan'/);
  assert.match(register, /registerTool\('media_capcut_headless_render'/);
  assert.match(scopes, /media_capcut_headless_render_plan: 'workstation\.read'/);
  assert.match(scopes, /media_capcut_headless_render: 'workstation\.execute'/);
  assert.match(register, /expectedPlanSha256: capcutSha256/);
  assert.match(register, /ctx\.runInWorkSession/);

  assert.match(draft, /headlessRenderModel\(projectId/);
  assert.match(draft, /headless-render-requires-one-visible-video-track/);
  assert.match(draft, /advanced-timeline-state/);
  assert.match(renderer, /ffmpeg-capcut-subset-v1/);
  assert.match(renderer, /supported-subset-not-pixel-identical-to-capcut/);
  assert.match(renderer, /withLease\(resourceId, 'orchestrating'/);
  assert.match(renderer, /CONFLICT: CapCut headless render plan changed since review/);
  assert.match(renderer, /probeFile/);
  assert.match(renderer, /sha256File/);
  assert.match(renderer, /filter_complex/);
  assert.match(renderer, /textfile=/);
  assert.match(renderer, /finally[\s\S]{0,500}rm\(outputAbsolute/);
  assert.doesNotMatch(register, /rawFfmpeg|ffmpegArgs|filterGraph/);
  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
  assert.match(capabilities, /Phases 1-10 provide/);
});

test('Media/Video Phase 10 generic edit recipe is project-scoped, source-hash bound and fixed-graph', async () => {
  const register = await read('src/extensions/media/register.ts');
  const editor = await read('src/extensions/media/video-edit.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');

  assert.match(register, /registerTool\('media_video_edit_plan'/);
  assert.match(register, /registerTool\('media_video_edit'/);
  assert.match(scopes, /media_video_edit_plan: 'workstation\.read'/);
  assert.match(scopes, /media_video_edit: 'workstation\.execute'/);
  assert.match(register, /expectedPlanSha256: capcutSha256/);
  assert.match(register, /ctx\.runInWorkSession/);
  assert.match(register, /recipe: videoEditRecipe/);
  assert.doesNotMatch(register, /rawFfmpeg|ffmpegArgs|filterGraph|shellCommand/);

  assert.match(editor, /resolveExistingProjectPath/);
  assert.match(editor, /probeFile/);
  assert.match(editor, /sha256File/);
  assert.match(editor, /CapCutHeadlessRenderAdapter/);
  assert.match(editor, /typed-video-edit-v1/);
  assert.match(editor, /clips\.length < 1 \|\| recipe\.clips\.length > 64/);
  assert.doesNotMatch(editor, /child_process|spawn\(|execFile\(|shell:\s*true/);

  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
  assert.match(capabilities, /Phase 10 adds a generic project-scoped typed video-edit recipe/);
});

test('MQTT and industrial extensions stay project-agnostic and profile-driven', async () => {
  const mqttRegister = await read('src/extensions/mqtt/register.ts');
  const mqttObserver = await read('src/extensions/mqtt/json-observer.ts');
  const industrialStore = await read('src/extensions/industrial/profile-store.ts');
  const industrialAdapter = await read('src/extensions/industrial/industrial-adapter.ts');
  const capabilities = await read('src/capabilities.ts');
  for (const source of [mqttRegister, mqttObserver, industrialStore, industrialAdapter]) {
    assert.doesNotMatch(source, /AUBOT|B300|liftSensorStatus|mqtt-agv|mqtt_agv/i);
  }
  assert.match(mqttRegister, /registerTool\('mqtt_json_observe'/);
  assert.match(industrialStore, /kind: z\.literal\('mqtt-topic'\)/);
  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
});

test('CANopen Phase 2/3 exposes only bounded read-only semantic and passive analysis diagnostics', async () => {
  const register = await read('src/extensions/canopen/register.ts');
  const eds = await read('src/extensions/canopen/eds.ts');
  const analysis = await read('src/extensions/canopen/analysis.ts');
  const builtin = await read('src/extensions/builtin.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');
  for (const name of ['canopen_capture_analyze', 'canopen_eds_inspect', 'canopen_eds_profile', 'canopen_object_lookup', 'canopen_capture_semantic_decode']) {
    assert.match(register, new RegExp(`registerTool\\('${name}'`));
    assert.ok(scopes.includes(`${name}: 'workstation.read'`));
    assert.ok(capabilities.includes(`'${name}'`));
  }
  assert.match(register, /new CanopenEds\(ctx\.paths\)/);
  assert.match(eds, /resolveExistingProjectPath/);
  assert.match(eds, /MAX_BYTES = 2 \* 1024 \* 1024/);
  assert.match(eds, /MAX_WARNINGS = 64/);
  assert.match(eds, /explicitSubIndex/);
  assert.match(analysis, /analyzeCanopenFrames/);
  assert.match(analysis, /Evidence-only cadence statistics/);
  assert.match(analysis, /completed-expedited/);
  assert.doesNotMatch(analysis, /laser|b300|aubot/i);
  assert.match(builtin, /id: 'domain\.canopen'/);
  assert.doesNotMatch(builtin, /id: 'domain\.canopen'[\s\S]{0,160}platforms: \['linux'\]/);
  assert.match(capabilities, /ACTION_SCHEMA_VERSION = 72/);
  assert.match(capabilities, /ENGINEERING_API_VERSION = 5/);
  assert.doesNotMatch(register, /canopen_(?:send|transmit|configure|lss)/);
});
