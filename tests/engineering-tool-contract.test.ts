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

test('v0.51 extends NotebookLM command automation and advances Action Schema v24 while retaining Engineering API v5', async () => {
  const capabilities = await read('src/capabilities.ts');
  assert.match(capabilities, /export const ACTION_SCHEMA_VERSION = 24;/);
  assert.match(capabilities, /export const ENGINEERING_API_VERSION = 5;/);
  assert.match(capabilities, /export const SERVER_VERSION = '0\.51\.0';/);
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
  const officeTools = await read('src/tools/office-tools.ts');
  for (const tool of ['firmware_memory_report', 'debug_locals', 'debug_rtos_tasks', 'debug_cortexm_exception_frame', 'debug_disassemble', 'debug_watchpoint_add', 'ros2_node_info', 'ros2_topic_hz', 'ros2_topic_bw', 'ros2_tf_lookup', 'ros2_lifecycle_get', 'ros2_lifecycle_set', 'ros2_action_info', 'kicad_provider_status', 'kicad_board_stats', 'kicad_drc', 'kicad_erc', 'kicad_validate', 'kicad_bom_report', 'stm32_svd_inspect']) {
    assert.match(engineeringTools, new RegExp(`server\\.registerTool\\('${tool}'`));
  }
  for (const tool of ['excel_inspect', 'excel_edit', 'powerpoint_inspect', 'powerpoint_edit']) {
    assert.match(officeTools, new RegExp(`server\\.registerTool\\('${tool}'`));
  }
  assert.match(capabilities, /export const BUILD_CHANNEL = 'stable'/);
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
  assert.match(navigation, /group: 'Home'/);
  assert.match(navigation, /group: 'Tools'/);
  assert.match(app, /renderOverviewSummary/);
  assert.match(app, /overview-refresh/);
  assert.match(views, /How should AI work\?/);
  assert.match(views, /More routing combinations/);
  assert.match(views, /What you can do/);
  assert.match(views, /Advanced access scopes/);
  assert.match(views, /Advanced multi-node transfers/);
  assert.match(views, /security-primary-grid/);
  assert.match(views, /security-admin-section/);
  assert.match(views, /Show command hash/);
  assert.match(views, /Multi-agent objective flow/);
  assert.match(views, /work_objective_execute_wave/);
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
  const engineeringTools = await read('src/tools/engineering-tools.ts');
  const ros2 = await read('src/adapters/engineering/ros2.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');
  for (const tool of ['ros2_node_info', 'ros2_topic_hz', 'ros2_topic_bw', 'ros2_tf_lookup', 'ros2_lifecycle_get', 'ros2_lifecycle_list', 'ros2_lifecycle_set', 'ros2_action_info']) {
    assert.match(engineeringTools, new RegExp(`server\\.registerTool\\('${tool}'`));
    assert.match(scopes, new RegExp(`${tool}: 'workstation\\.(?:read|execute)'`));
    assert.match(capabilities, new RegExp(tool));
  }
  assert.match(ros2, /\['topic', 'hz', name, '--window'/);
  assert.match(ros2, /\['topic', 'bw', name, '--window'/);
  assert.match(ros2, /\['run', 'tf2_ros', 'tf2_echo'/);
  assert.match(engineeringTools, /z\.enum\(\['configure', 'cleanup', 'activate', 'deactivate', 'shutdown'\]\)/);
  assert.doesNotMatch(engineeringTools, /ros2_action_send_goal|ros2_shell|ros2_command/);
  assert.match(capabilities, /Action goal dispatch is intentionally deferred until RWMCP can guarantee goal-handle cancellation on timeout/);
});

test('v0.44 KiCad professional tools expose typed temporary diagnostics without arbitrary plugins', async () => {
  const engineeringTools = await read('src/tools/engineering-tools.ts');
  const kicad = await read('src/adapters/engineering/kicad.ts');
  const scopes = await read('src/security/request-principal.ts');
  const capabilities = await read('src/capabilities.ts');
  for (const tool of ['kicad_provider_status', 'kicad_board_stats', 'kicad_drc', 'kicad_erc', 'kicad_validate', 'kicad_bom_report']) {
    assert.match(engineeringTools, new RegExp(`server\\.registerTool\\('${tool}'`));
    assert.match(scopes, new RegExp(`${tool}: 'workstation\\.read'`));
    assert.match(capabilities, new RegExp(tool));
  }
  assert.match(kicad, /'sch', 'export', 'bom'/);
  assert.match(kicad, /'Reference,Value,Footprint,QUANTITY,DNP'/);
  assert.doesNotMatch(engineeringTools, /kicad_script|kicad_plugin|python-bom/);
  assert.match(capabilities, /arbitrary BOM plugins\/scripts/);
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
  const tools = await read('src/tools/engineering-tools.ts');
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
  const tools = await read('src/tools/engineering-tools.ts');
  const adapter = await read('src/adapters/engineering/stm32-svd.ts');
  const capabilities = await read('src/capabilities.ts');
  const scopes = await read('src/security/request-principal.ts');

  const start = tools.indexOf("server.registerTool('stm32_svd_inspect'");
  const end = tools.indexOf("server.registerTool('firmware_project_inspect'", start);
  assert.ok(start >= 0 && end > start);
  const block = tools.slice(start, end);
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


test('current runtime retains Work Session routing under Action Schema v24 and Keil shared outputs remain project-variant exclusive', async () => {
  const capabilities = await read('src/capabilities.ts');
  const coreTools = await read('src/tools/core-tools.ts');
  const engineeringTools = await read('src/tools/engineering-tools.ts');
  const contract = await read('src/engineering-workflow-contract.ts');
  const workflowExecution = await read('src/engineering-workflow-execution.ts');
  const firmware = await read('src/adapters/engineering/firmware.ts');

  assert.match(capabilities, /export const ACTION_SCHEMA_VERSION = 24;/);
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
