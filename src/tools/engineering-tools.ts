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
const serialDeviceSelector = z.object({
  deviceId: z.string().min(1).max(512).optional(),
  serialNumber: z.string().min(1).max(256).optional(),
  vendorId: z.string().regex(/^(?:0x)?[A-Fa-f0-9]{4}$/).optional(),
  productId: z.string().regex(/^(?:0x)?[A-Fa-f0-9]{4}$/).optional(),
  manufacturer: z.string().min(1).max(160).optional(),
  nameContains: z.string().min(1).max(160).optional()
}).strict().refine(
  value => Boolean(value.deviceId || value.serialNumber || (value.vendorId && value.productId)),
  { message: 'Serial selector requires deviceId, serialNumber, or both vendorId and productId.' }
);
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
        espIdfPath: z.string().min(1).max(1024).optional(),
        flashProvider: z.enum(['auto', 'openocd', 'esp-idf']).optional(),
        artifact: z.string().min(1).optional(),
        port: z.string().min(1).optional(),
        portSelector: serialDeviceSelector.optional(),
        probeSerial: z.string().min(1).optional(),
        targetConfig: z.string().min(1).optional(),
        adapterSpeedKhz: z.number().int().min(50).max(24000).optional(),
        keilProject: z.string().min(1).max(512).optional(),
        keilTarget: z.string().min(1).max(160).optional(),
        defaultVariant: z.string().min(1).max(80).optional(),
        variants: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
        monitor: z.object({
          port: z.string().min(1).optional(),
          selector: serialDeviceSelector.optional(),
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

  const canInterfaceName = z.string().min(1).max(15).regex(/^[A-Za-z0-9_.:-]+$/);
  const canFilter = z.object({
    id: z.number().int().min(0).max(0x1fffffff),
    mask: z.number().int().min(0).max(0x1fffffff),
    extended: z.boolean().default(false)
  }).strict();

  server.registerTool('can_provider_status', {
    description: 'Inspect bounded SocketCAN provider availability. This is read-only and never configures interfaces or transmits frames.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'can_provider_status', undefined, () => ctx.engineering.can.providerStatus())));

  server.registerTool('can_interface_list', {
    description: 'List Linux SocketCAN CAN/vcan interfaces with bounded state, bit-timing, error-counter and packet statistics. No interface configuration is changed.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result({ interfaces: await audited(ctx.audit, 'can_interface_list', undefined, () => ctx.engineering.can.listInterfaces()) }));

  server.registerTool('can_interface_status', {
    description: 'Inspect one explicit Linux SocketCAN CAN/vcan interface using machine-readable iproute2 netlink output.',
    inputSchema: z.object({ interface: canInterfaceName }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ interface: interfaceName }) => result(await audited(ctx.audit, 'can_interface_status', undefined, () => ctx.engineering.can.interfaceStatus(interfaceName))));

  server.registerTool('can_capture', {
    description: 'Capture a bounded read-only SocketCAN traffic sample from one explicit interface using candump. Supports up to 32 typed CAN-ID/mask filters, at most 1000 frames and a bounded inactivity timeout. Frame transmission, replay and interface mutation are not exposed.',
    inputSchema: z.object({
      interface: canInterfaceName,
      count: z.number().int().min(1).max(1000).default(100),
      inactivityTimeoutMs: z.number().int().min(100).max(30_000).default(2_000),
      filters: z.array(canFilter).max(32).default([]),
      includeErrorFrames: z.boolean().default(false)
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ interface: interfaceName, count, inactivityTimeoutMs, filters, includeErrorFrames }) => result(
    await audited(ctx.audit, 'can_capture', undefined, () => ctx.engineering.can.capture(interfaceName, { count, inactivityTimeoutMs, filters, includeErrorFrames }))
  ));

  const modbusSerialOptions = {
    baudRate: z.number().int().min(300).max(12_000_000).default(9600),
    dataBits: z.union([z.literal(7), z.literal(8)]).default(8),
    parity: z.enum(['none', 'even', 'odd']).default('even'),
    stopBits: z.union([z.literal(1), z.literal(2)]).default(1),
    timeoutMs: z.number().int().min(50).max(30_000).default(1000)
  };
  const modbusReadFunction = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

  server.registerTool('modbus_rtu_provider_status', {
    description: 'Inspect bounded Modbus RTU provider availability. Phase 1 exposes read-only Modbus functions 01/02/03/04 only; write functions and raw frame injection are unavailable.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'modbus_rtu_provider_status', undefined, () => ctx.engineering.modbusRtu.providerStatus())));

  server.registerTool('modbus_rtu_endpoint_status', {
    description: 'Inspect one explicit serial endpoint for Modbus RTU use without opening a protocol session or modifying the device.',
    inputSchema: z.object({ port: z.string().min(1).max(512) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ port }) => result(await audited(ctx.audit, 'modbus_rtu_endpoint_status', undefined, () => ctx.engineering.modbusRtu.endpointStatus(port))));

  server.registerTool('modbus_rtu_read', {
    description: 'Perform one bounded Modbus RTU read request on an explicit serial port and Unit ID using only function 01, 02, 03 or 04. Validates CRC, response identity, exception frames and protocol quantity limits. No Modbus write function is exposed.',
    inputSchema: z.object({
      port: z.string().min(1).max(512),
      unitId: z.number().int().min(1).max(247),
      function: modbusReadFunction,
      address: z.number().int().min(0).max(65535),
      quantity: z.number().int().min(1).max(2000),
      ...modbusSerialOptions
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ port, unitId, function: fn, address, quantity, baudRate, dataBits, parity, stopBits, timeoutMs }) =>
    result(await audited(ctx.audit, 'modbus_rtu_read', undefined, () => ctx.engineering.modbusRtu.read(
      port, unitId, fn, address, quantity, { baudRate, dataBits, parity, stopBits, timeoutMs }
    ))));

  server.registerTool('modbus_rtu_probe', {
    description: 'Probe 1-32 explicit Modbus RTU Unit IDs using one bounded read-only function (01/02/03/04) and one address. The tool does not scan unspecified IDs and never writes device state.',
    inputSchema: z.object({
      port: z.string().min(1).max(512),
      unitIds: z.array(z.number().int().min(1).max(247)).min(1).max(32),
      function: modbusReadFunction.default(3),
      address: z.number().int().min(0).max(65535).default(0),
      ...modbusSerialOptions
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ port, unitIds, function: fn, address, baudRate, dataBits, parity, stopBits, timeoutMs }) =>
    result(await audited(ctx.audit, 'modbus_rtu_probe', undefined, () => ctx.engineering.modbusRtu.probe(
      port, unitIds, { function: fn, address, baudRate, dataBits, parity, stopBits, timeoutMs }
    ))));

  const networkHost = z.string().min(1).max(253);

  server.registerTool('network_provider_status', {
    description: 'Inspect cross-platform typed network-diagnostics provider availability. Read-only only; network configuration, route/firewall mutation and packet injection are unavailable.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'network_provider_status', undefined, () => ctx.engineering.network.providerStatus())));

  server.registerTool('network_interface_list', {
    description: 'List bounded local network interface/address metadata using the host networking API. This is read-only and does not change interface state.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'network_interface_list', undefined, () => ctx.engineering.network.interfaceList())));

  server.registerTool('network_route_list', {
    description: 'List the host routing table through a fixed machine-readable platform command. No route mutation or arbitrary command input is exposed.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => result(await audited(ctx.audit, 'network_route_list', undefined, () => ctx.engineering.network.routeList())));

  server.registerTool('network_dns_lookup', {
    description: 'Resolve one bounded hostname using the host DNS resolver and return IPv4/IPv6 addresses. URLs, raw resolver commands and DNS configuration changes are not accepted.',
    inputSchema: z.object({ host: networkHost, family: z.union([z.literal(0), z.literal(4), z.literal(6)]).default(0) }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ host, family }) => result(await audited(ctx.audit, 'network_dns_lookup', undefined, () => ctx.engineering.network.dnsLookup(host, family))));

  server.registerTool('network_ping', {
    description: 'Run a bounded ICMP reachability probe to one validated hostname/IP. Count and timeout are bounded; no raw ping arguments are accepted.',
    inputSchema: z.object({
      host: networkHost,
      count: z.number().int().min(1).max(20).default(4),
      timeoutMs: z.number().int().min(100).max(30_000).default(2_000)
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ host, count, timeoutMs }) => result(await audited(ctx.audit, 'network_ping', undefined, () => ctx.engineering.network.ping(host, { count, timeoutMs }))));

  server.registerTool('network_tcp_reachability', {
    description: 'Test a bounded TCP connect to one validated hostname/IP and explicit port. It opens no listener, sends no application payload, and returns only connection reachability evidence.',
    inputSchema: z.object({
      host: networkHost,
      port: z.number().int().min(1).max(65535),
      timeoutMs: z.number().int().min(50).max(30_000).default(2_000)
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ host, port, timeoutMs }) => result(await audited(ctx.audit, 'network_tcp_reachability', undefined, () => ctx.engineering.network.tcpReachability(host, port, { timeoutMs }))));

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

  server.registerTool('stm32_svd_inspect', {
    description: 'Inspect a project-scoped CMSIS-SVD file and return bounded STM32 device, peripheral, register, cluster and bit-field metadata without connecting to target hardware or allowing register writes.',
    inputSchema: workspacePath.extend({ svdFile: z.string().min(1).max(1024) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath, svdFile }) => result(await audited(ctx.audit, 'stm32_svd_inspect', workspace, () => ctx.engineering.stm32Svd.inspect(workspace, projectPath, svdFile))));

  server.registerTool('esp32_preflight', {
    description: 'Preflight one ESP32/ESP-IDF project on the current host. Project profile defaults are honored for ESP-IDF root, build directory and stable serial identity; explicit arguments only override those defaults. No flash or target mutation is performed.',
    inputSchema: workspacePath.extend({
      buildDir: z.string().min(1).max(512).optional(),
      espIdfPath: z.string().min(1).max(1024).optional(),
      port: z.string().min(1).max(512).optional(),
      portSelector: serialDeviceSelector.optional()
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, buildDir, espIdfPath, port, portSelector }) =>
    result(await audited(ctx.audit, 'esp32_preflight', workspace, () => ctx.engineering.workflows.esp32Preflight(
      workspace, projectPath, { buildDir, espIdfPath, port, portSelector }
    ))));

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

  server.registerTool('firmware_memory_report', {
    description: 'Analyze one ELF/AXF firmware artifact with an allowlisted size/nm toolchain and return bounded Flash/RAM totals, sections and largest symbols without executing project code or touching target hardware.',
    inputSchema: workspacePath.extend({ artifact: z.string().min(1).max(1024).optional(), topSymbols: z.number().int().min(1).max(100).default(25) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath, artifact, topSymbols }) => result(await audited(ctx.audit, 'firmware_memory_report', workspace, () => ctx.engineering.firmware.memoryReport(workspace, projectPath, artifact, topSymbols))));

  server.registerTool('firmware_provider_status', {
    description: 'Preflight the constrained firmware provider and report availability, version and intentionally unavailable dangerous surfaces.',
    inputSchema: z.object({ provider: z.enum(['openocd', 'keil']).default('openocd') }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ provider }) => result(await audited(ctx.audit, 'firmware_provider_status', undefined, () => ctx.engineering.firmware.providerStatus(provider))));

  server.registerTool('firmware_build', {
    description: 'Build a detected firmware project using a typed ESP-IDF, CMake, Make or Keil provider. Backend argv is generated by RWMCP, not supplied as a shell command.',
    inputSchema: z.object({ workspace: z.string(), projectPath: z.string().default('.'), provider: z.enum(['auto', 'esp-idf', 'cmake', 'make', 'keil']).default('auto'), buildDir: z.string().default('build'), espIdfPath: z.string().min(1).max(1024).optional(), keilProject: z.string().optional(), keilTarget: z.string().optional(), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, provider, buildDir, espIdfPath, keilProject, keilTarget, workSessionId }) => result(await audited(ctx.audit, 'firmware_build', workspace, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.firmware.build(workspace, projectPath, provider, buildDir, keilProject, keilTarget, espIdfPath)))));

  const flashSchema = z.object({
    workspace: z.string(), projectPath: z.string().default('.'), artifact: z.string().optional(),
    provider: z.enum(['auto', 'openocd', 'esp-idf']).default('auto'), port: z.string().optional(),
    portSelector: serialDeviceSelector.optional(), buildDir: z.string().min(1).max(512).default('build'), espIdfPath: z.string().min(1).max(1024).optional(),
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
    inputSchema: z.object({ workspace: z.string(), projectPath: z.string().default('.'), symbols: z.string().min(1), probeSerial: z.string().min(1), targetConfig: z.string().optional(), adapterSpeedKhz: z.number().int().min(50).max(24000).optional(), rtosAwareness: z.enum(['none', 'auto', 'freertos']).default('none'), workSessionId: z.string().uuid().optional() }),
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

  server.registerTool('debug_locals', {
    description: 'Read bounded local variables from the currently selected halted stack frame through GDB/MI.',
    inputSchema: z.object({ id: z.string().uuid(), maxVariables: z.number().int().min(1).max(128).default(64), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, maxVariables, workSessionId }) => result({ variables: await audited(ctx.audit, 'debug_locals', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.debug.locals(id, maxVariables))) }));

  server.registerTool('debug_rtos_tasks', {
    description: 'Read bounded target-provided RTOS/thread inventory through the documented GDB/MI -thread-info contract. RWMCP does not infer FreeRTOS TCB layout or parse target-specific human-readable details.',
    inputSchema: z.object({ id: z.string().uuid(), maxTasks: z.number().int().min(1).max(256).default(128), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, maxTasks, workSessionId }) => result(await audited(ctx.audit, 'debug_rtos_tasks', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.debug.rtosTasks(id, maxTasks)))));

  server.registerTool('debug_disassemble', {
    description: 'Read bounded disassembly around the current PC or one explicit 32-bit address through GDB/MI. No arbitrary GDB command or memory write is exposed.',
    inputSchema: z.object({ id: z.string().uuid(), address: z.number().int().min(0).max(0xffffffff).optional(), beforeBytes: z.number().int().min(0).max(256).default(32), afterBytes: z.number().int().min(2).max(512).default(96), maxInstructions: z.number().int().min(1).max(256).default(128), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, address, beforeBytes, afterBytes, maxInstructions, workSessionId }) => result(await audited(ctx.audit, 'debug_disassemble', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.debug.disassemble(id, { address, beforeBytes, afterBytes, maxInstructions })))));

  server.registerTool('debug_watchpoint_add', {
    description: 'Add one hardware data watchpoint for a safe variable/member/index expression. Access mode is bounded to write, read, or access.',
    inputSchema: z.object({ id: z.string().uuid(), expression: z.string().min(1).max(256), access: z.enum(['write', 'read', 'access']).default('write'), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ id, expression, access, workSessionId }) => result(await audited(ctx.audit, 'debug_watchpoint_add', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.debug.addWatchpoint(id, expression, access)))));

  server.registerTool('debug_watchpoint_remove', {
    description: 'Remove one GDB hardware watchpoint by its bounded breakpoint/watchpoint number.',
    inputSchema: z.object({ id: z.string().uuid(), number: z.number().int().min(1).max(9999), workSessionId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, number, workSessionId }) => result(await audited(ctx.audit, 'debug_watchpoint_remove', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.debug.removeWatchpoint(id, number)))));

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

  server.registerTool('debug_cortexm_exception_frame', {
    description: 'Decode the architectural Cortex-M stacked exception frame from a caller-owned halted debug session. EXC_RETURN selects MSP/PSP and basic versus extended floating-point context; target memory is read only.',
    inputSchema: debugSession,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, workSessionId }) => result(await audited(ctx.audit, 'debug_cortexm_exception_frame', undefined, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.debug.exceptionFrame(id)))));

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

  server.registerTool('ros2_node_info', {
    description: 'Inspect publishers, subscribers, services and actions attached to one explicit ROS 2 node.',
    inputSchema: z.object({ workspace: z.string(), node: z.string().min(1).max(256), cwd: z.string().default('.') }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, node, cwd }) => result(await audited(ctx.audit, 'ros2_node_info', workspace, () => ctx.engineering.ros2.nodeInfo(workspace, node, cwd))));

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
  server.registerTool('ros2_topic_hz', {
    description: 'Measure a bounded ROS 2 topic frequency sample. The diagnostic subprocess is terminated after timeout and only bounded rate statistics are returned.',
    inputSchema: z.object({ workspace: z.string(), topic: z.string().min(1).max(256), cwd: z.string().default('.'), timeoutMs: z.number().int().min(1000).max(20000).default(5000), window: z.number().int().min(2).max(10000).default(100) }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, topic, cwd, timeoutMs, window }) => result(await audited(ctx.audit, 'ros2_topic_hz', workspace, () => ctx.engineering.ros2.topicHz(workspace, topic, cwd, timeoutMs, window))));

  server.registerTool('ros2_topic_bw', {
    description: 'Measure a bounded ROS 2 topic bandwidth sample and normalize throughput/message sizes to bytes.',
    inputSchema: z.object({ workspace: z.string(), topic: z.string().min(1).max(256), cwd: z.string().default('.'), timeoutMs: z.number().int().min(1000).max(20000).default(5000), window: z.number().int().min(2).max(10000).default(100) }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, topic, cwd, timeoutMs, window }) => result(await audited(ctx.audit, 'ros2_topic_bw', workspace, () => ctx.engineering.ros2.topicBandwidth(workspace, topic, cwd, timeoutMs, window))));

  server.registerTool('ros2_tf_lookup', {
    description: 'Sample one TF2 transform between explicit frame names through tf2_echo with a bounded diagnostic timeout.',
    inputSchema: z.object({ workspace: z.string(), sourceFrame: z.string().min(1).max(256), targetFrame: z.string().min(1).max(256), cwd: z.string().default('.'), timeoutMs: z.number().int().min(1000).max(20000).default(4000) }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, sourceFrame, targetFrame, cwd, timeoutMs }) => result(await audited(ctx.audit, 'ros2_tf_lookup', workspace, () => ctx.engineering.ros2.tfLookup(workspace, sourceFrame, targetFrame, cwd, timeoutMs))));

  server.registerTool('ros2_lifecycle_get', {
    description: 'Read the current lifecycle state of one explicit ROS 2 lifecycle node.',
    inputSchema: z.object({ workspace: z.string(), node: z.string().min(1).max(256), cwd: z.string().default('.') }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, node, cwd }) => result(await audited(ctx.audit, 'ros2_lifecycle_get', workspace, () => ctx.engineering.ros2.lifecycleGet(workspace, node, cwd))));

  server.registerTool('ros2_lifecycle_list', {
    description: 'List available lifecycle transitions for one explicit ROS 2 lifecycle node.',
    inputSchema: z.object({ workspace: z.string(), node: z.string().min(1).max(256), cwd: z.string().default('.') }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, node, cwd }) => result(await audited(ctx.audit, 'ros2_lifecycle_list', workspace, () => ctx.engineering.ros2.lifecycleList(workspace, node, cwd))));

  server.registerTool('ros2_lifecycle_set', {
    description: 'Request one allowlisted ROS 2 lifecycle transition. This is a hardware/runtime mutation and requires execute authority.',
    inputSchema: z.object({ workspace: z.string(), node: z.string().min(1).max(256), transition: z.enum(['configure', 'cleanup', 'activate', 'deactivate', 'shutdown']), cwd: z.string().default('.') }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, node, transition, cwd }) => result(await audited(ctx.audit, 'ros2_lifecycle_set', workspace, () => ctx.engineering.ros2.lifecycleSet(workspace, node, transition, cwd))));

  server.registerTool('ros2_service_list', { description: 'List ROS 2 services and reported types.', inputSchema: rosWorkspace, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, async ({ workspace, cwd }) => result({ services: await audited(ctx.audit, 'ros2_service_list', workspace, () => ctx.engineering.ros2.serviceList(workspace, cwd)) }));
  server.registerTool('ros2_service_call', { description: 'Call one explicitly named ROS 2 service with structured JSON payload. Requires hardware-mutation permission.', inputSchema: z.object({ workspace: z.string(), service: z.string(), type: z.string(), request: z.unknown().default({}), cwd: z.string().default('.') }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({ workspace, service, type, request, cwd }) => result(await audited(ctx.audit, 'ros2_service_call', workspace, () => ctx.engineering.ros2.serviceCall(workspace, service, type, request, cwd))));
  server.registerTool('ros2_action_list', { description: 'List ROS 2 actions and reported types.', inputSchema: rosWorkspace, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, async ({ workspace, cwd }) => result({ actions: await audited(ctx.audit, 'ros2_action_list', workspace, () => ctx.engineering.ros2.actionList(workspace, cwd)) }));
  server.registerTool('ros2_action_info', {
    description: 'Inspect clients and servers for one explicit ROS 2 action without sending a goal.',
    inputSchema: z.object({ workspace: z.string(), action: z.string().min(1).max(256), cwd: z.string().default('.') }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, action, cwd }) => result(await audited(ctx.audit, 'ros2_action_info', workspace, () => ctx.engineering.ros2.actionInfo(workspace, action, cwd))));

  server.registerTool('ros2_param_list', { description: 'List parameters for one ROS 2 node.', inputSchema: z.object({ workspace: z.string(), node: z.string(), cwd: z.string().default('.') }), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, async ({ workspace, node, cwd }) => result({ parameters: await audited(ctx.audit, 'ros2_param_list', workspace, () => ctx.engineering.ros2.paramList(workspace, node, cwd)) }));
  server.registerTool('ros2_param_get', { description: 'Read one ROS 2 parameter.', inputSchema: z.object({ workspace: z.string(), node: z.string(), parameter: z.string(), cwd: z.string().default('.') }), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, async ({ workspace, node, parameter, cwd }) => result(await audited(ctx.audit, 'ros2_param_get', workspace, () => ctx.engineering.ros2.paramGet(workspace, node, parameter, cwd))));
  server.registerTool('ros2_param_set', { description: 'Set one ROS 2 parameter. Requires hardware-mutation permission.', inputSchema: z.object({ workspace: z.string(), node: z.string(), parameter: z.string(), value: z.string(), cwd: z.string().default('.') }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({ workspace, node, parameter, value, cwd }) => result(await audited(ctx.audit, 'ros2_param_set', workspace, () => ctx.engineering.ros2.paramSet(workspace, node, parameter, value, cwd))));
  server.registerTool('ros2_bag_record', { description: 'Start a caller-owned ros2 bag record process for explicit topics. Stop it with process_stop.', inputSchema: z.object({ workspace: z.string(), topics: z.array(z.string()).min(1).max(100), output: z.string(), cwd: z.string().default('.'), workSessionId: z.string().uuid().optional() }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({ workspace, topics, output, cwd, workSessionId }) => result(await audited(ctx.audit, 'ros2_bag_record', workspace, () => ctx.runInWorkSession(workSessionId, () => ctx.engineering.ros2.bagRecord(workspace, topics, output, cwd)))));

  const kicadProject = z.object({ workspace: z.string().min(1), projectPath: z.string().default('.') });
  const kicadEditSelector = {
    uuid: z.string().uuid().optional(),
    reference: z.string().regex(/^[A-Za-z][A-Za-z0-9._+-]{0,31}$/).optional()
  };
  const kicadEditOperation = z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('schematic_symbol_property'),
      ...kicadEditSelector,
      property: z.enum(['Value', 'Footprint', 'Datasheet']),
      value: z.string().max(512)
    }).strict().refine(value => Boolean(value.uuid || value.reference), { message: 'uuid or reference is required' }),
    z.object({
      kind: z.literal('schematic_symbol_flags'),
      ...kicadEditSelector,
      inBom: z.boolean().optional(),
      onBoard: z.boolean().optional()
    }).strict()
      .refine(value => Boolean(value.uuid || value.reference), { message: 'uuid or reference is required' })
      .refine(value => value.inBom !== undefined || value.onBoard !== undefined, { message: 'inBom and/or onBoard is required' }),
    z.object({
      kind: z.literal('pcb_footprint_property'),
      ...kicadEditSelector,
      property: z.enum(['Value', 'Reference']),
      value: z.string().max(512)
    }).strict().refine(value => Boolean(value.uuid || value.reference), { message: 'uuid or reference is required' }),
    z.object({
      kind: z.literal('pcb_footprint_move'),
      ...kicadEditSelector,
      x: z.number().finite().min(-100000).max(100000),
      y: z.number().finite().min(-100000).max(100000),
      rotation: z.number().finite().min(-100000).max(100000).optional()
    }).strict().refine(value => Boolean(value.uuid || value.reference), { message: 'uuid or reference is required' }),
    z.object({
      kind: z.literal('pcb_footprint_attributes'),
      ...kicadEditSelector,
      boardOnly: z.boolean().optional(),
      excludeFromBom: z.boolean().optional(),
      excludeFromPosFiles: z.boolean().optional()
    }).strict()
      .refine(value => Boolean(value.uuid || value.reference), { message: 'uuid or reference is required' })
      .refine(value => value.boardOnly !== undefined || value.excludeFromBom !== undefined || value.excludeFromPosFiles !== undefined, { message: 'at least one footprint attribute is required' }),
    z.object({
      kind: z.literal('pcb_footprint_copper'),
      ...kicadEditSelector,
      clearance: z.number().finite().min(0).max(100).optional(),
      zoneConnect: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional()
    }).strict()
      .refine(value => Boolean(value.uuid || value.reference), { message: 'uuid or reference is required' })
      .refine(value => value.clearance !== undefined || value.zoneConnect !== undefined, { message: 'clearance and/or zoneConnect is required' })
  ]);


  server.registerTool('kicad_ipc_prepare', {
    description: 'Prepare KiCad IPC on Windows in a bounded way. Detects the installed KiCad major version, requires KiCad/PCB Editor to be closed, backs up the matching kicad_common.json, and only enables api.enable_server. No other KiCad preference or Python package is modified.',
    inputSchema: kicadProject.extend({ workSessionId: z.string().uuid() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId }) =>
    result(await audited(ctx.audit, 'kicad_ipc_prepare', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.ipcPrepare(workspace, projectPath))
    )));

  server.registerTool('kicad_ipc_status', {
    description: 'Inspect readiness for the official KiCad IPC API and kicad-python (kipy) without modifying a design. Reports KiCad version support, Python/package availability, GUI-vs-headless requirements, live connection state, and whether a PCB is open.',
    inputSchema: kicadProject,
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath }) => result(await audited(ctx.audit, 'kicad_ipc_status', workspace, () => ctx.engineering.kicad.ipcStatus(workspace, projectPath))));

  server.registerTool('kicad_ipc_board_inspect', {
    description: 'Inspect the currently open KiCad PCB through the official IPC API. The live board must resolve to the explicit authorized project board path. Returns a SHA-256 fingerprint and bounded footprint UUID/reference/position/rotation metadata without modifying or saving the design.',
    inputSchema: kicadProject.extend({
      board: z.string().min(1).max(1024),
      maxItems: z.number().int().min(1).max(2000).default(500)
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, board, maxItems }) =>
    result(await audited(ctx.audit, 'kicad_ipc_board_inspect', workspace, () => ctx.engineering.kicad.ipcBoardInspect(workspace, projectPath, board, maxItems))));

  server.registerTool('kicad_ipc_footprint_move', {
    description: 'Move one footprint in the currently open KiCad PCB through the official IPC API. Requires Work Session ownership and the exact live board SHA-256 fingerprint. RWMCP groups the live edit into an undo step, runs DRC against before/after snapshots, and automatically restores the prior footprint pose if active errors, unconnected items, or schematic-parity findings regress. The board is intentionally left unsaved.',
    inputSchema: kicadProject.extend({
      workSessionId: z.string().uuid(),
      board: z.string().min(1).max(1024),
      expectedBoardSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      uuid: z.string().uuid().optional(),
      reference: z.string().regex(/^[A-Za-z][A-Za-z0-9._+-]{0,31}$/).optional(),
      xMm: z.number().finite().min(-100000).max(100000),
      yMm: z.number().finite().min(-100000).max(100000),
      rotationDeg: z.number().finite().min(-100000).max(100000).optional()
    }).refine(value => Boolean(value.uuid || value.reference), { message: 'uuid or reference is required' }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId, board, expectedBoardSha256, uuid, reference, xMm, yMm, rotationDeg }) =>
    result(await audited(ctx.audit, 'kicad_ipc_footprint_move', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.ipcFootprintMove(
        workspace,
        projectPath,
        board,
        expectedBoardSha256,
        { ...(uuid ? { uuid } : {}), ...(reference ? { reference } : {}) },
        xMm,
        yMm,
        rotationDeg
      ))
    )));

  server.registerTool('kicad_ipc_footprint_update', {
    description: 'Update one live KiCad PCB footprint through official IPC with typed production-safe fields only: Value, lock state, exclude-from-BOM, exclude-from-position-files, DNP, and not-in-schematic. Requires Work Session ownership and exact live board SHA-256; performs one undo commit, DRC before/after acceptance, rollback on regression, and never saves the board implicitly.',
    inputSchema: kicadProject.extend({
      workSessionId: z.string().uuid(),
      board: z.string().min(1).max(1024),
      expectedBoardSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      uuid: z.string().uuid().optional(),
      reference: z.string().regex(/^[A-Za-z][A-Za-z0-9._+-]{0,31}$/).optional(),
      update: z.object({
        value: z.string().max(512).optional(),
        locked: z.boolean().optional(),
        excludeFromBom: z.boolean().optional(),
        excludeFromPosFiles: z.boolean().optional(),
        doNotPopulate: z.boolean().optional(),
        notInSchematic: z.boolean().optional()
      }).strict().refine(value => Object.keys(value).length > 0, { message: 'at least one update field is required' })
    }).refine(value => Boolean(value.uuid || value.reference), { message: 'uuid or reference is required' }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId, board, expectedBoardSha256, uuid, reference, update }) =>
    result(await audited(ctx.audit, 'kicad_ipc_footprint_update', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.ipcFootprintUpdate(
        workspace,
        projectPath,
        board,
        expectedBoardSha256,
        { ...(uuid ? { uuid } : {}), ...(reference ? { reference } : {}) },
        update
      ))
    )));

  const kicadBatchPlacement = z.object({
    uuid: z.string().uuid().optional(),
    reference: z.string().regex(/^[A-Za-z][A-Za-z0-9._+-]{0,31}$/).optional(),
    xMm: z.number().finite().min(-100000).max(100000),
    yMm: z.number().finite().min(-100000).max(100000),
    rotationDeg: z.number().finite().min(-100000).max(100000).optional()
  }).strict().refine(value => Boolean(value.uuid || value.reference), { message: 'uuid or reference is required' });

  server.registerTool('kicad_ipc_batch_place', {
    description: 'Place 1-32 live KiCad PCB footprints in one official IPC commit/undo step. Requires Work Session ownership and exact live-board SHA-256, rejects duplicate or locked targets, validates DRC before/after the whole batch, restores every original pose on regression, and leaves the board unsaved.',
    inputSchema: kicadProject.extend({
      workSessionId: z.string().uuid(),
      board: z.string().min(1).max(1024),
      expectedBoardSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      placements: z.array(kicadBatchPlacement).min(1).max(32)
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId, board, expectedBoardSha256, placements }) =>
    result(await audited(ctx.audit, 'kicad_ipc_batch_place', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.ipcBatchPlace(
        workspace,
        projectPath,
        board,
        expectedBoardSha256,
        placements
      ))
    )));

  const kicadRoutingPoint = z.object({
    xMm: z.number().finite().min(-100000).max(100000),
    yMm: z.number().finite().min(-100000).max(100000)
  }).strict();
  const kicadNetName = z.string().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/.test(value), { message: 'netName contains control characters' });
  const kicadCopperLayer = z.string().regex(/^(?:F\.Cu|B\.Cu|In[1-9][0-9]?\.Cu)$/);

  server.registerTool('kicad_ipc_routing_inspect', {
    description: 'Inspect live KiCad routing through the official IPC API without modifying or saving the board. Returns exact live-board SHA-256 plus bounded nets, straight/arc tracks, vias and zones with UUIDs, geometry, widths, layers, lock state and zone fill metadata.',
    inputSchema: kicadProject.extend({
      board: z.string().min(1).max(1024),
      maxItems: z.number().int().min(1).max(2000).default(1000)
    }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, board, maxItems }) =>
    result(await audited(ctx.audit, 'kicad_ipc_routing_inspect', workspace, () =>
      ctx.engineering.kicad.ipcRoutingInspect(workspace, projectPath, board, maxItems)
    )));

  server.registerTool('kicad_ipc_track_add', {
    description: 'Add one straight copper track segment through official KiCad IPC. Requires Work Session ownership, exact live-board SHA-256, explicit existing net and copper layer, bounded geometry/width, per-board lease, DRC non-regression, compensating removal on rejection, and no implicit save.',
    inputSchema: kicadProject.extend({
      workSessionId: z.string().uuid(),
      board: z.string().min(1).max(1024),
      expectedBoardSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      netName: kicadNetName,
      layerName: kicadCopperLayer,
      start: kicadRoutingPoint,
      end: kicadRoutingPoint,
      widthMm: z.number().finite().min(0.01).max(20),
      locked: z.boolean().optional()
    }).refine(value => value.start.xMm !== value.end.xMm || value.start.yMm !== value.end.yMm, { message: 'track endpoints must differ' }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId, board, expectedBoardSha256, netName, layerName, start, end, widthMm, locked }) =>
    result(await audited(ctx.audit, 'kicad_ipc_track_add', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.ipcTrackAdd(
        workspace, projectPath, board, expectedBoardSha256,
        { netName, layerName, start, end, widthMm, ...(locked !== undefined ? { locked } : {}) }
      ))
    )));

  server.registerTool('kicad_ipc_track_update', {
    description: 'Update one existing straight live KiCad track by UUID. Typed fields are net, copper layer, start/end point, width and lock. Arc tracks and netless tracks are rejected. Requires Work Session ownership and exact board SHA; DRC failure/regression restores the original track and the board remains unsaved.',
    inputSchema: kicadProject.extend({
      workSessionId: z.string().uuid(),
      board: z.string().min(1).max(1024),
      expectedBoardSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      uuid: z.string().uuid(),
      update: z.object({
        netName: kicadNetName.optional(),
        layerName: kicadCopperLayer.optional(),
        start: kicadRoutingPoint.optional(),
        end: kicadRoutingPoint.optional(),
        widthMm: z.number().finite().min(0.01).max(20).optional(),
        locked: z.boolean().optional()
      }).strict().refine(value => Object.keys(value).length > 0, { message: 'at least one track update field is required' })
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId, board, expectedBoardSha256, uuid, update }) =>
    result(await audited(ctx.audit, 'kicad_ipc_track_update', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.ipcTrackUpdate(
        workspace, projectPath, board, expectedBoardSha256, { uuid, ...update }
      ))
    )));

  server.registerTool('kicad_ipc_via_add', {
    description: 'Add one through-via through official KiCad IPC. Requires an explicit existing net, position, diameter and drill with drill < diameter. Blind/buried/micro vias are intentionally not exposed. Work Session, exact SHA, board lease, DRC acceptance, compensating removal and no implicit save apply.',
    inputSchema: kicadProject.extend({
      workSessionId: z.string().uuid(),
      board: z.string().min(1).max(1024),
      expectedBoardSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      netName: kicadNetName,
      position: kicadRoutingPoint,
      diameterMm: z.number().finite().min(0.1).max(20),
      drillMm: z.number().finite().min(0.05).max(10),
      locked: z.boolean().optional()
    }).refine(value => value.drillMm < value.diameterMm, { message: 'drillMm must be smaller than diameterMm' }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId, board, expectedBoardSha256, netName, position, diameterMm, drillMm, locked }) =>
    result(await audited(ctx.audit, 'kicad_ipc_via_add', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.ipcViaAdd(
        workspace, projectPath, board, expectedBoardSha256,
        { netName, position, diameterMm, drillMm, ...(locked !== undefined ? { locked } : {}) }
      ))
    )));

  server.registerTool('kicad_ipc_via_update', {
    description: 'Update one existing through-via by UUID. Typed fields are net, position, diameter, drill and lock. Netless or non-through vias are rejected. Requires Work Session ownership and exact board SHA; DRC failure/regression restores the original via and the board remains unsaved.',
    inputSchema: kicadProject.extend({
      workSessionId: z.string().uuid(),
      board: z.string().min(1).max(1024),
      expectedBoardSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      uuid: z.string().uuid(),
      update: z.object({
        netName: kicadNetName.optional(),
        position: kicadRoutingPoint.optional(),
        diameterMm: z.number().finite().min(0.1).max(20).optional(),
        drillMm: z.number().finite().min(0.05).max(10).optional(),
        locked: z.boolean().optional()
      }).strict().refine(value => Object.keys(value).length > 0, { message: 'at least one via update field is required' })
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId, board, expectedBoardSha256, uuid, update }) =>
    result(await audited(ctx.audit, 'kicad_ipc_via_update', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.ipcViaUpdate(
        workspace, projectPath, board, expectedBoardSha256, { uuid, ...update }
      ))
    )));

  server.registerTool('kicad_provider_status', {
    description: 'Inspect the resolved KiCad CLI provider/version without modifying project files.',
    inputSchema: kicadProject,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath }) => result(await audited(ctx.audit, 'kicad_provider_status', workspace, () => ctx.engineering.kicad.version(workspace, projectPath))));

  server.registerTool('kicad_board_stats', {
    description: 'Export bounded JSON board statistics for one explicit .kicad_pcb file into a temporary report; project sources are not saved or upgraded.',
    inputSchema: kicadProject.extend({ board: z.string().min(1).max(1024) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath, board }) => result(await audited(ctx.audit, 'kicad_board_stats', workspace, () => ctx.engineering.kicad.boardStats(workspace, projectPath, board))));

  server.registerTool('kicad_drc', {
    description: 'Run KiCad PCB Design Rule Check (DRC) into a temporary JSON report and return bounded structured violations without editing the board.',
    inputSchema: kicadProject.extend({ board: z.string().min(1).max(1024) }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, board }) => result(await audited(ctx.audit, 'kicad_drc', workspace, () => ctx.engineering.kicad.drc(workspace, projectPath, board))));

  server.registerTool('kicad_erc', {
    description: 'Run KiCad schematic Electrical Rules Check (ERC) into a temporary JSON report and return bounded structured violations without editing the schematic.',
    inputSchema: kicadProject.extend({ schematic: z.string().min(1).max(1024) }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, schematic }) => result(await audited(ctx.audit, 'kicad_erc', workspace, () => ctx.engineering.kicad.erc(workspace, projectPath, schematic))));

  server.registerTool('kicad_validate', {
    description: 'Run bounded ERC and/or DRC for explicit KiCad source files in parallel without source mutation.',
    inputSchema: kicadProject.extend({ schematic: z.string().min(1).max(1024).optional(), board: z.string().min(1).max(1024).optional() }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, schematic, board }) => {
    if (!schematic && !board) throw new Error('kicad_validate requires schematic and/or board.');
    return result(await audited(ctx.audit, 'kicad_validate', workspace, () => ctx.engineering.kicad.validate(workspace, projectPath, { ...(schematic ? { schematic } : {}), ...(board ? { board } : {}), jobsets: [] })));
  });

  server.registerTool('kicad_bom_report', {
    description: 'Export a bounded temporary schematic BOM with a fixed field contract (Refs, Value, Footprint, Qty, DNP) and return a typed report. No BOM plugin or arbitrary script is executed.',
    inputSchema: kicadProject.extend({ schematic: z.string().min(1).max(1024), maxRows: z.number().int().min(1).max(5000).default(500) }),
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, schematic, maxRows }) => result(await audited(ctx.audit, 'kicad_bom_report', workspace, () => ctx.engineering.kicad.bomReport(workspace, projectPath, schematic, maxRows))));

  server.registerTool('kicad_edit_inspect', {
    description: 'Inspect one explicit KiCad schematic/board as an editing target. Returns SHA-256 optimistic-concurrency identity plus bounded symbol/footprint UUID, reference, value and placement metadata without modifying the file.',
    inputSchema: kicadProject.extend({
      file: z.string().min(1).max(1024),
      maxItems: z.number().int().min(1).max(2000).default(500)
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace, projectPath, file, maxItems }) =>
    result(await audited(ctx.audit, 'kicad_edit_inspect', workspace, () => ctx.engineering.kicad.inspectEditable(workspace, projectPath, file, maxItems))));

  server.registerTool('kicad_edit', {
    description: 'Apply 1-32 typed KiCad Phase-1 edits transactionally. Requires an exact expected SHA-256, holds a file lease, patches only supported schematic symbol properties or PCB footprint properties/placement, validates a project-scoped working copy with ERC/DRC against the pre-edit baseline, then commits atomically with a backup only when acceptance passes. Arbitrary S-expression, net/track/via/zone edits and scripts are not accepted.',
    inputSchema: kicadProject.extend({
      workSessionId: z.string().uuid(),
      file: z.string().min(1).max(1024),
      expectedSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      operations: z.array(kicadEditOperation).min(1).max(32)
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ workspace, projectPath, workSessionId, file, expectedSha256, operations }) =>
    result(await audited(ctx.audit, 'kicad_edit', workspace, () =>
      ctx.runInWorkSession(workSessionId, () => ctx.engineering.kicad.transactionalEdit(workspace, projectPath, file, expectedSha256, operations))
    )));

  const dockerBase = z.object({ workspace: z.string(), cwd: z.string().default('.') });
  server.registerTool('container_list', { description: 'List Docker containers with structured JSON output.', inputSchema: dockerBase.extend({ all: z.boolean().default(true) }), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, async ({ workspace, cwd, all }) => result({ containers: await audited(ctx.audit, 'container_list', workspace, () => ctx.engineering.docker.list(workspace, all, cwd)) }));
  server.registerTool('container_inspect', { description: 'Inspect one Docker container and return bounded structured risk classification for host-level privileges, namespaces, mounts, devices and daemon context.', inputSchema: dockerBase.extend({ container: z.string() }), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, async ({ workspace, cwd, container }) => result({ inspect: await audited(ctx.audit, 'container_inspect', workspace, () => ctx.engineering.docker.inspect(workspace, container, cwd)) }));
  server.registerTool('container_logs', { description: 'Read bounded Docker container logs.', inputSchema: dockerBase.extend({ container: z.string(), tail: z.number().int().min(1).max(5000).default(200) }), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, async ({ workspace, cwd, container, tail }) => result(await audited(ctx.audit, 'container_logs', workspace, () => ctx.engineering.docker.logs(workspace, container, tail, cwd))));
  server.registerTool('container_start', { description: 'Start one Docker container under dedicated container lifecycle policy. High-risk containers additionally require full_control plus explicit local owner allowHighRisk policy.', inputSchema: dockerBase.extend({ container: z.string() }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({ workspace, cwd, container }) => result(await audited(ctx.audit, 'container_start', workspace, () => ctx.engineering.docker.start(workspace, container, cwd))));
  server.registerTool('container_stop', { description: 'Stop one Docker container under dedicated container lifecycle policy. High-risk containers additionally require full_control plus explicit local owner allowHighRisk policy.', inputSchema: dockerBase.extend({ container: z.string(), timeoutSeconds: z.number().int().min(0).max(120).default(10) }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({ workspace, cwd, container, timeoutSeconds }) => result(await audited(ctx.audit, 'container_stop', workspace, () => ctx.engineering.docker.stop(workspace, container, timeoutSeconds, cwd))));
  server.registerTool('container_exec', { description: 'Execute one argv-only program inside a container under dedicated container-exec policy; shell/interpreter hosts remain blocked. High-risk containers require full_control plus explicit local owner allowHighRisk policy.', inputSchema: dockerBase.extend({ container: z.string(), program: z.string(), args: z.array(z.string()).max(100).default([]) }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({ workspace, cwd, container, program, args }) => result(await audited(ctx.audit, 'container_exec', workspace, () => ctx.engineering.docker.exec(workspace, container, program, args, cwd))));
  server.registerTool('image_build', { description: 'Build a Docker image from an authorized workspace context under dedicated image-build policy. Remote Docker daemons are classified high risk and require full_control plus explicit local owner allowHighRisk policy.', inputSchema: z.object({ workspace: z.string(), contextPath: z.string().default('.'), tag: z.string().optional() }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({ workspace, contextPath, tag }) => result(await audited(ctx.audit, 'image_build', workspace, () => ctx.engineering.docker.imageBuild(workspace, contextPath, tag))));
}
