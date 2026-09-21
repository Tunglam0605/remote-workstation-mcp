import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.js';
import {
  engineeringWorkflowIdSchema,
  legacyWorkflowOverridesSchema,
  profileProjectSchema,
  workflowParametersSchema,
  workflowRuntimeParametersSchema
} from '../engineering-workflow-contract.js';
import { decodeCortexMFault } from '../adapters/engineering/fault-decode.js';
import { audited } from '../security/audit.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

const workspacePath = z.object({ workspace: z.string().min(1), projectPath: z.string().default('.') });
const debugSession = z.object({ id: z.string().uuid(), workSessionId: z.string().uuid().optional() });

export function registerEngineeringTools(server: McpServer, ctx: AppContext): void {
  const workflowId = engineeringWorkflowIdSchema;
  const legacyWorkflowOverrides = legacyWorkflowOverridesSchema;
  const workflowRuntimeParameters = workflowRuntimeParametersSchema;
  const workflowParameters = workflowParametersSchema;
  const profileProject = profileProjectSchema;

  server.registerTool('engineering_project_inspect', {
    description: 'Inspect project markers, artifacts, attached hardware, canonical .rwmcp/project.yaml profile and available high-level workflows in one read-only call.',
    inputSchema: profileProject,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath }) => result(await audited(ctx.audit, 'engineering_project_inspect', workspace, () => ctx.engineering.workflows.inspect(workspace, projectPath))));

  server.registerTool('engineering_profile_init', {
    description: 'Create a versioned .rwmcp/project.yaml profile from project auto-detection plus explicit firmware/ROS 2 defaults. This replaces repeated per-chat environment, probe, port and build discovery.',
    inputSchema: profileProject.extend({
      id: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(),
      name: z.string().min(1).max(160).optional(),
      kind: z.enum(['stm32', 'esp-idf', 'ros2', 'mixed', 'generic']).optional(),
      overwrite: z.boolean().default(false),
      profile: z.record(z.string(), z.unknown()).optional(),
      firmware: z.object({
        buildProvider: z.enum(['auto', 'esp-idf', 'cmake', 'make', 'keil']).optional(),
        buildDir: z.string().min(1).optional(),
        flashProvider: z.enum(['auto', 'openocd', 'esp-idf']).optional(),
        artifact: z.string().min(1).optional(),
        port: z.string().min(1).optional(),
        probeSerial: z.string().min(1).optional(),
        targetConfig: z.string().min(1).optional(),
        adapterSpeedKhz: z.number().int().min(50).max(24000).optional(),
        keilProject: z.string().min(1).max(512).optional(),
        keilTarget: z.string().min(1).max(160).optional(),
        defaultVariant: z.string().min(1).max(80).optional(),
        variants: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
        monitor: z.object({
          port: z.string().min(1).optional(),
          baudRate: z.number().int().min(300).max(12_000_000).optional(),
          expectText: z.string().min(1).max(512).optional(),
          expectTimeoutMs: z.number().int().min(100).max(120_000).optional()
        }).optional()
      }).optional(),
      ros2: z.object({
        distro: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),
        cwd: z.string().min(1).optional(),
        workspaceSetup: z.string().min(1).optional(),
        domainId: z.number().int().min(0).max(232).optional(),
        build: z.object({
          symlinkInstall: z.boolean().optional(),
          mergeInstall: z.boolean().optional(),
          packagesSelect: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/)).max(50).optional()
        }).optional()
      }).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, ...options }) => result(await audited(ctx.audit, 'engineering_profile_init', workspace, () => ctx.engineering.workflows.initProfile(workspace, projectPath, options))));

  server.registerTool('engineering_workflow_list', {
    description: 'List high-level typed platform and engineering workflows available for the selected workspace/project scope. Platform workflows use the same stable envelope without requiring a new top-level action.',
    inputSchema: profileProject,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath }) => result(await audited(ctx.audit, 'engineering_workflow_list', workspace, () => ctx.engineering.workflows.list(workspace, projectPath))));

  server.registerTool('engineering_workflow_plan', {
    description: 'Resolve a high-level platform or engineering workflow into typed steps and concrete defaults without executing the mutating operation.',
    inputSchema: profileProject.extend({ workflow: workflowId, parameters: workflowParameters, overrides: legacyWorkflowOverrides.optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath, workflow, parameters, overrides }) => {
    const parsed = workflowRuntimeParameters.parse({ ...(overrides ?? {}), ...parameters });
    const { workSessionId, ...runtimeParameters } = parsed;
    return result(await audited(ctx.audit, 'engineering_workflow_plan', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.workflows.plan(workspace, projectPath, workflow as never, runtimeParameters))
    ));
  });

  server.registerTool('engineering_workflow_run', {
    description: 'Run one approved high-level platform or engineering workflow. Backend operations are generated by typed RWMCP adapters; arbitrary shell recipes are not accepted.',
    inputSchema: profileProject.extend({ workflow: workflowId, parameters: workflowParameters, overrides: legacyWorkflowOverrides.optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, workflow, parameters, overrides }) => {
    const parsed = workflowRuntimeParameters.parse({ ...(overrides ?? {}), ...parameters });
    const { workSessionId, ...runtimeParameters } = parsed;
    return result(await audited(ctx.audit, 'engineering_workflow_run', workspace, () =>
      ctx.runInWorkSession(workSessionId, () =>
        ctx.engineering.execution.run(workspace, projectPath, workflow, runtimeParameters)
      )
    ));
  });

  server.registerTool('hardware_list', {
    description: 'Discover serial ports and supported debug probes such as ST-Link without mutating hardware.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result({ devices: await audited(ctx.audit, 'hardware_list', undefined, () => ctx.engineering.hardware.list()) }));

  server.registerTool('hardware_inspect', {
    description: 'Inspect one discovered hardware device by stable discovery id.',
    inputSchema: z.object({ id: z.string().min(1) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id }) => result(await audited(ctx.audit, 'hardware_inspect', undefined, () => ctx.engineering.hardware.inspect(id))));

  server.registerTool('hardware_session_status', {
    description: 'List active engineering resource leases such as serial, flashing or debugging ownership.',
    inputSchema: z.object({ workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workSessionId }) => result({ leases: await audited(ctx.audit, 'hardware_session_status', undefined, () =>
    ctx.runInWorkSession(workSessionId, () => ctx.engineering.resources.list())
  ) }));

  server.registerTool('serial_open', {
    description: 'Open a bounded caller-owned serial monitor session. Opening is non-destructive but unavailable in Read Only mode.',
    inputSchema: z.object({ port: z.string().min(1), baudRate: z.number().int().min(300).max(12_000_000), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ port, baudRate, workSessionId }) => result(await audited(ctx.audit, 'serial_open', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.serial.open(port, baudRate)))));

  server.registerTool('serial_read', {
    description: 'Read incremental UTF-8 output from a caller-owned serial session using a byte cursor.',
    inputSchema: z.object({ id: z.string().uuid(), cursor: z.number().int().nonnegative().default(0), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, cursor, workSessionId }) => result(await audited(ctx.audit, 'serial_read', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.serial.read(id, cursor)))));

  server.registerTool('serial_wait_for_text', {
    description: 'Wait for a bounded UTF-8 marker in a caller-owned serial session. Useful for boot/readiness acceptance without repeated polling from ChatGPT.',
    inputSchema: z.object({
      id: z.string().uuid(),
      expectedText: z.string().min(1).max(512),
      timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
      cursor: z.number().int().nonnegative().default(0),
      workSessionId: z.string().uuid().optional()
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ id, expectedText, timeoutMs, cursor, workSessionId }) => result(
    await audited(ctx.audit, 'serial_wait_for_text', undefined, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.serial.waitForText(id, expectedText, timeoutMs, cursor))
    )
  ));

  server.registerTool('serial_write', {
    description: 'Write bounded data to a caller-owned serial session. Requires hardware-mutation permission unless the owner explicitly relaxes serial-write policy.',
    inputSchema: z.object({ id: z.string().uuid(), data: z.string(), encoding: z.enum(['utf8', 'hex', 'base64']).default('utf8'), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ id, data, encoding, workSessionId }) => result(await audited(ctx.audit, 'serial_write', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.serial.write(id, data, encoding)))));

  server.registerTool('serial_close', {
    description: 'Close a caller-owned serial session and release its hardware resource lease.',
    inputSchema: z.object({ id: z.string().uuid(), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, workSessionId }) => result(await audited(ctx.audit, 'serial_close', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.serial.close(id)))));

  server.registerTool('terminal_start', {
    description: 'Start a true PTY/ConPTY terminal in an authorized workspace. The requested executable remains subject to process.allowExecutables.',
    inputSchema: z.object({ workspace: z.string(), program: z.string().min(1), args: z.array(z.string()).max(500).default([]), cwd: z.string().default('.'), cols: z.number().int().min(20).max(500).default(120), rows: z.number().int().min(5).max(200).default(30), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, program, args, cwd, cols, rows, workSessionId }) => result(await audited(ctx.audit, 'terminal_start', workspace, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.terminals.start(workspace, program, args, cwd, cols, rows)))));

  server.registerTool('terminal_read', {
    description: 'Read incremental output from a caller-owned PTY/ConPTY session.',
    inputSchema: z.object({ id: z.string().uuid(), cursor: z.number().int().nonnegative().default(0), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, cursor, workSessionId }) => result(await audited(ctx.audit, 'terminal_read', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.terminals.read(id, cursor)))));

  server.registerTool('terminal_write', {
    description: 'Write bounded interactive input to a caller-owned PTY/ConPTY session.',
    inputSchema: z.object({ id: z.string().uuid(), data: z.string(), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ id, data, workSessionId }) => result(await audited(ctx.audit, 'terminal_write', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.terminals.write(id, data)))));

  server.registerTool('terminal_resize', {
    description: 'Resize a caller-owned PTY/ConPTY terminal.',
    inputSchema: z.object({ id: z.string().uuid(), cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, cols, rows, workSessionId }) => result(await audited(ctx.audit, 'terminal_resize', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.terminals.resize(id, cols, rows)))));

  server.registerTool('terminal_stop', {
    description: 'Stop a caller-owned PTY/ConPTY terminal session.',
    inputSchema: z.object({ id: z.string().uuid(), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, workSessionId }) => result(await audited(ctx.audit, 'terminal_stop', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.terminals.stop(id)))));

  server.registerTool('stm32_ioc_inspect', {
    description: 'Read a bounded STM32 CubeMX .ioc file and return typed MCU/package, project/toolchain, clock-frequency, pin/signal/label and peripheral-parameter metadata without running CubeMX or project code.',
    inputSchema: workspacePath.extend({ iocFile: z.string().min(1).max(255).regex(/^[^\\/]+\.ioc$/i).optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath, iocFile }) => result(await audited(ctx.audit, 'stm32_ioc_inspect', workspace, () => ctx.engineering.stm32Ioc.inspect(workspace, projectPath, iocFile))));

  server.registerTool('firmware_project_inspect', {
    description: 'Detect firmware/project family and build framework from project markers without executing project code.',
    inputSchema: workspacePath,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath }) => result(await audited(ctx.audit, 'firmware_project_inspect', workspace, () => ctx.engineering.firmware.inspect(workspace, projectPath))));

  server.registerTool('firmware_artifacts', {
    description: 'Discover bounded ELF/AXF/HEX/BIN/MAP firmware artifacts under a project.',
    inputSchema: workspacePath,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath }) => result({ artifacts: await audited(ctx.audit, 'firmware_artifacts', workspace, () => ctx.engineering.firmware.listArtifacts(workspace, projectPath)) }));

  server.registerTool('firmware_provider_status', {
    description: 'Preflight the constrained firmware provider and report availability, version and intentionally unavailable dangerous surfaces.',
    inputSchema: z.object({ provider: z.enum(['openocd', 'keil']).default('openocd') }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ provider }) => result(await audited(ctx.audit, 'firmware_provider_status', undefined, () => ctx.engineering.firmware.providerStatus(provider))));

  server.registerTool('firmware_build', {
    description: 'Build a detected firmware project using a typed ESP-IDF, CMake, Make or Keil provider. Backend argv is generated by RWMCP, not supplied as a shell command.',
    inputSchema: z.object({ workspace: z.string(), projectPath: z.string().default('.'), provider: z.enum(['auto', 'esp-idf', 'cmake', 'make', 'keil']).default('auto'), buildDir: z.string().default('build'), keilProject: z.string().optional(), keilTarget: z.string().optional(), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, provider, buildDir, keilProject, keilTarget, workSessionId }) => result(await audited(ctx.audit, 'firmware_build', workspace, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.firmware.build(workspace, projectPath, provider, buildDir, keilProject, keilTarget)))));

  const flashSchema = z.object({
    workspace: z.string(), projectPath: z.string().default('.'), artifact: z.string().optional(),
    provider: z.enum(['auto', 'openocd', 'esp-idf']).default('auto'), port: z.string().optional(),
    probeSerial: z.string().optional(), targetConfig: z.string().optional(), adapterSpeedKhz: z.number().int().min(50).max(24000).optional(),
    workSessionId: z.string().uuid().optional()
  });

  server.registerTool('firmware_flash_plan', {
    description: 'Create a read-only explicit firmware flash plan including provider, artifact, target and locked hardware resource. No flash is performed.',
    inputSchema: flashSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workSessionId, ...args }) => result(await audited(ctx.audit, 'firmware_flash_plan', args.workspace, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.firmware.flashPlan(args)))));

  server.registerTool('firmware_flash', {
    description: 'Execute a constrained firmware flash plan with verify. Requires hardware-mutation permission; mass erase, Option Bytes/eFuse and arbitrary backend commands are not exposed.',
    inputSchema: flashSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workSessionId, ...args }) => result(await audited(ctx.audit, 'firmware_flash', args.workspace, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.firmware.flash(args)))));

  server.registerTool('firmware_verify', {
    description: 'Verify an explicit STM32 ELF/AXF/HEX artifact against target flash through constrained OpenOCD.',
    inputSchema: z.object({ workspace: z.string(), projectPath: z.string().default('.'), artifact: z.string().min(1), probeSerial: z.string().optional(), targetConfig: z.string().optional(), adapterSpeedKhz: z.number().int().min(50).max(24000).optional(), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ workSessionId, ...args }) => result(await audited(ctx.audit, 'firmware_verify', args.workspace, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.firmware.verify(args)))));

  server.registerTool('target_reset', {
    description: 'Reset an STM32 target through constrained OpenOCD. Requires hardware-mutation permission.',
    inputSchema: z.object({ workspace: z.string(), projectPath: z.string().default('.'), probeSerial: z.string().optional(), targetConfig: z.string().optional(), adapterSpeedKhz: z.number().int().min(50).max(24000).optional(), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workSessionId, ...args }) => result(await audited(ctx.audit, 'target_reset', args.workspace, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.firmware.reset(args)))));

  server.registerTool('debug_capabilities', {
    description: 'Report available constrained OpenOCD/GDB-MI debug backends and intentionally unavailable dangerous surfaces.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'debug_capabilities', undefined, () => ctx.engineering.debug.capabilities())));

  server.registerTool('debug_session_start', {
    description: 'Start an owner-scoped loopback-only OpenOCD + GDB/MI debug session for an explicit ELF/AXF and optional ST-Link serial.',
    inputSchema: z.object({ workspace: z.string(), projectPath: z.string().default('.'), symbols: z.string().min(1), probeSerial: z.string().min(1), targetConfig: z.string().optional(), adapterSpeedKhz: z.number().int().min(50).max(24000).optional(), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workSessionId, ...args }) => result(await audited(ctx.audit, 'debug_session_start', args.workspace, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.debug.start(args)))));

  server.registerTool('debug_session_list', {
    description: 'List caller-owned debug sessions.', inputSchema: z.object({ workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workSessionId }) => result({ sessions: await audited(ctx.audit, 'debug_session_list', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.debug.list())) }));

  server.registerTool('debug_halt', { description: 'Interrupt and halt the target in a caller-owned debug session.', inputSchema: debugSession, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({ id, workSessionId }) => result(await audited(ctx.audit, 'debug_halt', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.debug.halt(id)))));
  server.registerTool('debug_resume', { description: 'Resume target execution in a caller-owned debug session.', inputSchema: debugSession, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({ id, workSessionId }) => result(await audited(ctx.audit, 'debug_resume', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.debug.resume(id)))));
  server.registerTool('debug_step', { description: 'Single-step into source/instruction execution and wait for the next stopped event.', inputSchema: debugSession, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({ id, workSessionId }) => result(await audited(ctx.audit, 'debug_step', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.debug.step(id, 'step')))));
  server.registerTool('debug_next', { description: 'Step over and wait for the next stopped event.', inputSchema: debugSession, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({ id, workSessionId }) => result(await audited(ctx.audit, 'debug_next', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.debug.step(id, 'next')))));

  server.registerTool('debug_stack', {
    description: 'Read a bounded stack trace from a caller-owned halted debug session.',
    inputSchema: z.object({ id: z.string().uuid(), maxFrames: z.number().int().min(1).max(64).default(16), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, maxFrames, workSessionId }) => result({ frames: await audited(ctx.audit, 'debug_stack', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.debug.stack(id, maxFrames))) }));

  server.registerTool('debug_registers', { description: 'Read target register values through GDB/MI.', inputSchema: debugSession, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, async ({ id, workSessionId }) => result({ registers: await audited(ctx.audit, 'debug_registers', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.debug.registers(id))) }));

  server.registerTool('debug_variable', {
    description: 'Evaluate one safe variable/member/index expression; arbitrary GDB expressions are rejected.',
    inputSchema: z.object({ id: z.string().uuid(), expression: z.string().min(1).max(256), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, expression, workSessionId }) => result(await audited(ctx.audit, 'debug_variable', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.debug.variable(id, expression)))));

  server.registerTool('debug_breakpoint_add', {
    description: 'Add one hardware breakpoint at a function or basename:line location.',
    inputSchema: z.object({ id: z.string().uuid(), location: z.string().min(1).max(256), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ id, location, workSessionId }) => result(await audited(ctx.audit, 'debug_breakpoint_add', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.debug.addBreakpoint(id, location)))));

  server.registerTool('debug_breakpoint_remove', {
    description: 'Remove one breakpoint by GDB breakpoint number.',
    inputSchema: z.object({ id: z.string().uuid(), number: z.number().int().min(1).max(9999), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, number, workSessionId }) => result(await audited(ctx.audit, 'debug_breakpoint_remove', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.debug.removeBreakpoint(id, number)))));

  server.registerTool('debug_memory_read', {
    description: 'Read at most 4096 bytes of target memory through GDB/MI. Memory writes are intentionally not exposed.',
    inputSchema: z.object({ id: z.string().uuid(), address: z.number().int().min(0).max(0xffffffff), length: z.number().int().min(1).max(4096), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, address, length, workSessionId }) => result(await audited(ctx.audit, 'debug_memory_read', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.debug.memoryRead(id, address, length)))));

  server.registerTool('debug_fault_snapshot', {
    description: 'Read Cortex-M core/fault registers from a halted debug session and decode HardFault/MemManage/BusFault/UsageFault state.',
    inputSchema: debugSession,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, workSessionId }) => result(await audited(ctx.audit, 'debug_fault_snapshot', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.debug.faultSnapshot(id)))));

  server.registerTool('fault_decode', {
    description: 'Decode supplied Cortex-M SCB fault registers without connecting to hardware.',
    inputSchema: z.object({ cfsr: z.number().int().min(0).max(0xffffffff), hfsr: z.number().int().min(0).max(0xffffffff), dfsr: z.number().int().min(0).max(0xffffffff).optional(), mmfar: z.number().int().min(0).max(0xffffffff).optional(), bfar: z.number().int().min(0).max(0xffffffff).optional(), afsr: z.number().int().min(0).max(0xffffffff).optional(), shcsr: z.number().int().min(0).max(0xffffffff).optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async args => result(await audited(ctx.audit, 'fault_decode', undefined, async () => decodeCortexMFault(args))));

  server.registerTool('debug_session_stop', { description: 'Stop a caller-owned debug session and release the debug probe.', inputSchema: debugSession, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({ id, workSessionId }) => result(await audited(ctx.audit, 'debug_session_stop', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.debug.stop(id)))));

  const rosWorkspace = z.object({ workspace: z.string(), cwd: z.string().default('.') });
  server.registerTool('ros2_build', {
    description: 'Build a ROS 2 workspace with typed colcon options. No arbitrary colcon or shell arguments are accepted.',
    inputSchema: z.object({
      workspace: z.string(),
      cwd: z.string().default('.'),
      distro: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),
      domainId: z.number().int().min(0).max(232).optional(),
      symlinkInstall: z.boolean().default(true),
      mergeInstall: z.boolean().default(false),
      packagesSelect: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/)).max(50).default([])
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, cwd, distro, domainId, symlinkInstall, mergeInstall, packagesSelect }) => result(
    await audited(ctx.audit, 'ros2_build', workspace, () => ctx.engineering.ros2.build(
      workspace,
      cwd,
      distro || domainId !== undefined ? { distro, domainId } : undefined,
      { symlinkInstall, mergeInstall, packagesSelect }
    ))
  ));

  server.registerTool('ros2_topic_info', {
    description: 'Read verbose ROS 2 topic endpoint/QoS information for one absolute topic name.',
    inputSchema: z.object({ workspace: z.string(), topic: z.string(), cwd: z.string().default('.') }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, topic, cwd }) => result(
    await audited(ctx.audit, 'ros2_topic_info', workspace, () => ctx.engineering.ros2.topicInfo(workspace, topic, cwd))
  ));

  server.registerTool('ros2_node_list', { description: 'List ROS 2 nodes using bounded ros2cli execution.', inputSchema: rosWorkspace, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, async ({ workspace, cwd }) => result({ nodes: await audited(ctx.audit, 'ros2_node_list', workspace, () => ctx.engineering.ros2.nodeList(workspace, cwd)) }));
  server.registerTool('ros2_topic_list', { description: 'List ROS 2 topics and reported types.', inputSchema: rosWorkspace, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, async ({ workspace, cwd }) => result({ topics: await audited(ctx.audit, 'ros2_topic_list', workspace, () => ctx.engineering.ros2.topicList(workspace, cwd)) }));
  server.registerTool('ros2_topic_echo', { description: 'Echo one ROS 2 topic message with --once and a bounded timeout.', inputSchema: z.object({ workspace: z.string(), topic: z.string(), cwd: z.string().default('.'), timeoutMs: z.number().int().min(500).max(60_000).default(10_000) }), annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false } }, async ({ workspace, topic, cwd, timeoutMs }) => result(await audited(ctx.audit, 'ros2_topic_echo', workspace, () => ctx.engineering.ros2.topicEchoOnce(workspace, topic, cwd, timeoutMs))));
  server.registerTool('ros2_service_list', { description: 'List ROS 2 services and reported types.', inputSchema: rosWorkspace, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, async ({ workspace, cwd }) => result({ services: await audited(ctx.audit, 'ros2_service_list', workspace, () => ctx.engineering.ros2.serviceList(workspace, cwd)) }));
  server.registerTool('ros2_service_call', { description: 'Call one explicitly named ROS 2 service with structured JSON payload. Requires hardware-mutation permission.', inputSchema: z.object({ workspace: z.string(), service: z.string(), type: z.string(), request: z.unknown().default({}), cwd: z.string().default('.') }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({ workspace, service, type, request, cwd }) => result(await audited(ctx.audit, 'ros2_service_call', workspace, () => ctx.engineering.ros2.serviceCall(workspace, service, type, request, cwd))));
  server.registerTool('ros2_action_list', { description: 'List ROS 2 actions and reported types.', inputSchema: rosWorkspace, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, async ({ workspace, cwd }) => result({ actions: await audited(ctx.audit, 'ros2_action_list', workspace, () => ctx.engineering.ros2.actionList(workspace, cwd)) }));
  server.registerTool('ros2_param_list', { description: 'List parameters for one ROS 2 node.', inputSchema: z.object({ workspace: z.string(), node: z.string(), cwd: z.string().default('.') }), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, async ({ workspace, node, cwd }) => result({ parameters: await audited(ctx.audit, 'ros2_param_list', workspace, () => ctx.engineering.ros2.paramList(workspace, node, cwd)) }));
  server.registerTool('ros2_param_get', { description: 'Read one ROS 2 parameter.', inputSchema: z.object({ workspace: z.string(), node: z.string(), parameter: z.string(), cwd: z.string().default('.') }), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, async ({ workspace, node, parameter, cwd }) => result(await audited(ctx.audit, 'ros2_param_get', workspace, () => ctx.engineering.ros2.paramGet(workspace, node, parameter, cwd))));
  server.registerTool('ros2_param_set', { description: 'Set one ROS 2 parameter. Requires hardware-mutation permission.', inputSchema: z.object({ workspace: z.string(), node: z.string(), parameter: z.string(), value: z.string(), cwd: z.string().default('.') }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({ workspace, node, parameter, value, cwd }) => result(await audited(ctx.audit, 'ros2_param_set', workspace, () => ctx.engineering.ros2.paramSet(workspace, node, parameter, value, cwd))));
  server.registerTool('ros2_bag_record', { description: 'Start a caller-owned ros2 bag record process for explicit topics. Stop it with process_stop.', inputSchema: z.object({ workspace: z.string(), topics: z.array(z.string()).min(1).max(100), output: z.string(), cwd: z.string().default('.'), workSessionId: z.string().uuid().optional() }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({ workspace, topics, output, cwd, workSessionId }) => result(await audited(ctx.audit, 'ros2_bag_record', workspace, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.ros2.bagRecord(workspace, topics, output, cwd)))));

  const dockerBase = z.object({ workspace: z.string(), cwd: z.string().default('.') });
  server.registerTool('container_list', { description: 'List Docker containers with structured JSON output.', inputSchema: dockerBase.extend({ all: z.boolean().default(true) }), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, async ({ workspace, cwd, all }) => result({ containers: await audited(ctx.audit, 'container_list', workspace, () => ctx.engineering.docker.list(workspace, all, cwd)) }));
  server.registerTool('container_inspect', { description: 'Inspect one Docker container and return bounded structured risk classification for host-level privileges, namespaces, mounts, devices and daemon context.', inputSchema: dockerBase.extend({ container: z.string() }), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, async ({ workspace, cwd, container }) => result({ inspect: await audited(ctx.audit, 'container_inspect', workspace, () => ctx.engineering.docker.inspect(workspace, container, cwd)) }));
  server.registerTool('container_logs', { description: 'Read bounded Docker container logs.', inputSchema: dockerBase.extend({ container: z.string(), tail: z.number().int().min(1).max(5000).default(200) }), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, async ({ workspace, cwd, container, tail }) => result(await audited(ctx.audit, 'container_logs', workspace, () => ctx.engineering.docker.logs(workspace, container, tail, cwd))));
  server.registerTool('container_start', { description: 'Start one Docker container under dedicated container lifecycle policy. High-risk containers additionally require full_control plus explicit local owner allowHighRisk policy.', inputSchema: dockerBase.extend({ container: z.string() }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({ workspace, cwd, container }) => result(await audited(ctx.audit, 'container_start', workspace, () => ctx.engineering.docker.start(workspace, container, cwd))));
  server.registerTool('container_stop', { description: 'Stop one Docker container under dedicated container lifecycle policy. High-risk containers additionally require full_control plus explicit local owner allowHighRisk policy.', inputSchema: dockerBase.extend({ container: z.string(), timeoutSeconds: z.number().int().min(0).max(120).default(10) }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({ workspace, cwd, container, timeoutSeconds }) => result(await audited(ctx.audit, 'container_stop', workspace, () => ctx.engineering.docker.stop(workspace, container, timeoutSeconds, cwd))));
  server.registerTool('container_exec', { description: 'Execute one argv-only program inside a container under dedicated container-exec policy; shell/interpreter hosts remain blocked. High-risk containers require full_control plus explicit local owner allowHighRisk policy.', inputSchema: dockerBase.extend({ container: z.string(), program: z.string(), args: z.array(z.string()).max(100).default([]) }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({ workspace, cwd, container, program, args }) => result(await audited(ctx.audit, 'container_exec', workspace, () => ctx.engineering.docker.exec(workspace, container, program, args, cwd))));
  server.registerTool('image_build', { description: 'Build a Docker image from an authorized workspace context under dedicated image-build policy. Remote Docker daemons are classified high risk and require full_control plus explicit local owner allowHighRisk policy.', inputSchema: z.object({ workspace: z.string(), contextPath: z.string().default('.'), tag: z.string().optional() }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({ workspace, contextPath, tag }) => result(await audited(ctx.audit, 'image_build', workspace, () => ctx.engineering.docker.imageBuild(workspace, contextPath, tag))));
}
