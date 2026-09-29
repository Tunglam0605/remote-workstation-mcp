import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../../context.js';
import { audited } from '../../security/audit.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

export function registerRos2Tools(server: McpServer, ctx: AppContext): void {
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
}
