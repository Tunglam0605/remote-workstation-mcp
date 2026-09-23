const dash = '—';
const value = (candidate) => candidate === undefined || candidate === null || candidate === '' ? dash : String(candidate);
const resource = (resources, key) => resources?.[key] ?? { data: null, error: new Error('Not loaded') };
const unavailable = (entry) => Boolean(entry.error) || !entry.data || typeof entry.data.error === 'string';
const specs = (items) => items.map(([icon, label, entry]) => ({ icon, label, value: value(entry) }));

function statusFor(entry, positive, negative = 'Offline') {
  if (unavailable(entry)) return { status: 'Unavailable', tone: 'muted' };
  if (positive === undefined) return { status: 'Unavailable', tone: 'muted' };
  return positive ? { status: 'Online', tone: 'success' } : { status: negative, tone: negative === 'Unavailable' ? 'muted' : 'danger' };
}

function card(id, name, type, current, description, details, source) {
  return { id, name, type, status: current.status, tone: current.tone, description, specs: specs(details), source };
}

function providerStatus(entry, provider, enabled) {
  if (unavailable(entry)) return { status: 'Unavailable', tone: 'muted' };
  if (provider?.installed !== true || provider?.available === false) return { status: 'Unavailable', tone: 'muted' };
  if (provider?.authenticated !== true) return { status: 'Sign in required', tone: 'warning' };
  if (enabled === false) return { status: 'Disabled', tone: 'muted' };
  if (enabled !== true) return { status: 'Unavailable', tone: 'muted' };
  return { status: 'Online', tone: 'success' };
}

export function deriveCards(resources) {
  const status = resource(resources, 'status');
  const runtime = resource(resources, 'runtime');
  const execution = resource(resources, 'execution');
  const antigravity = resource(resources, 'antigravity');
  const pairing = resource(resources, 'pairing');
  const statusData = unavailable(status) ? {} : status.data;
  const runtimeData = unavailable(runtime) ? {} : runtime.data;
  const executionData = unavailable(execution) ? {} : execution.data;
  const antigravityData = unavailable(antigravity) ? {} : antigravity.data;
  const cards = [
    card('local-host', statusData.identity?.name ?? statusData.recommendedAppName ?? 'Local Host', 'Host', statusFor(status, !unavailable(status)), 'Configured local Control Center host', [['monitor', 'Platform', statusData.platform], ['server', 'Runtime', runtimeData.running === true ? 'Running' : runtimeData.running === false ? 'Stopped' : null], ['radio', 'Tunnel', runtimeData.tunnelReady === true ? 'Ready' : runtimeData.tunnelReady === false ? 'Not ready' : null]], 'status')
  ];
  if (!unavailable(pairing)) {
    for (const device of pairing.data.devices ?? []) {
      if (!device?.id) continue;
      if (!device.pairedAt || device.revokedAt) continue;
      cards.push(card(`device:${device.id}`, device.name ?? device.hostname ?? device.id, 'Paired node', { status: 'Unavailable', tone: 'muted' }, 'Backend does not expose node liveness', [['monitor', 'Platform', device.platform], ['clock-3', 'Last seen', device.lastSeenAt]], 'pairing'));
    }
  }
  cards.push(
    card('codex', 'Codex', 'Provider', providerStatus(execution, executionData.codex, executionData.status?.codexEnabled), 'Codex provider availability', [['terminal', 'Version', executionData.codex?.version], ['key-round', 'Authentication', executionData.codex?.authenticated === true ? 'Authenticated' : executionData.codex?.authenticated === false ? 'Not authenticated' : null]], 'execution'),
    card('antigravity', 'Antigravity', 'Provider', providerStatus(antigravity, antigravityData, executionData.settings?.antigravityEnabled), 'Antigravity provider availability', [['sparkles', 'Version', antigravityData.version], ['cpu', 'Model', antigravityData.model?.label ?? antigravityData.model?.id]], 'antigravity'),
    card('health', 'System Health', 'Health', statusFor(runtime, runtimeData.mcpHealthy, 'Unhealthy'), 'Managed runtime and tunnel health', [['heart-pulse', 'MCP', runtimeData.mcpHealthy === true ? 'Healthy' : runtimeData.mcpHealthy === false ? 'Unhealthy' : null], ['network', 'Connection', runtimeData.connectionState], ['radio', 'Tunnel', runtimeData.tunnelReady === true ? 'Ready' : runtimeData.tunnelReady === false ? 'Not ready' : null]], 'runtime')
  );
  return cards;
}

export function deriveNotifications(resources, readIds = new Set()) {
  const notifications = [];
  const runtime = resource(resources, 'runtime');
  const execution = resource(resources, 'execution');
  const updates = resource(resources, 'updates');
  const admin = resource(resources, 'admin');
  const executionData = unavailable(execution) ? {} : execution.data;
  const updatesData = unavailable(updates) ? {} : updates.data;
  const adminData = unavailable(admin) ? {} : admin.data;
  const add = (id, level, title, description) => notifications.push({ id, level, title, description, read: readIds.has(id) });
  if (runtime.error || typeof runtime.data?.error === 'string') add('runtime-unavailable', 'error', 'Runtime unavailable', runtime.error?.message ?? runtime.data.error);
  if (executionData.status?.fallbackActive) add('codex-fallback', 'warning', 'Codex fallback active', executionData.status.fallbackReason ?? 'Execution policy selected a fallback.');
  if (updatesData.updateAvailable === true) add('update-available', 'info', 'Update available', [updatesData.installedVersion, updatesData.latestVersion].filter(Boolean).join(' → ') || 'A managed update is available.');
  for (const request of adminData.requests ?? []) if (request.state === 'pending' && request.id) add(`admin:${request.id}`, 'warning', 'Admin approval pending', request.program ?? 'An administrative action needs approval.');
  return notifications;
}

export function deriveMetrics(resources) {
  const execution = resource(resources, 'execution');
  const status = unavailable(execution) ? undefined : execution.data.status;
  return [
    ['Codex tasks today', value(status?.codexTasksToday)], ['Codex tasks this session', value(status?.codexTasksThisSession)], ['Daily limit', status?.maxCodexTasksPerDay === 0 ? 'Unlimited' : value(status?.maxCodexTasksPerDay)], ['Session limit', status?.maxCodexTasksPerSession === 0 ? 'Unlimited' : value(status?.maxCodexTasksPerSession)]
  ].map(([label, metricValue]) => ({ label, value: metricValue }));
}

export function deriveActivities(resources) {
  const activities = [];
  const admin = resource(resources, 'admin');
  const updates = resource(resources, 'updates');
  for (const request of (unavailable(admin) ? [] : admin.data.requests ?? [])) {
    if (!request?.id) continue;
    const events = [
      ['created', request.createdAt], ['approved', request.approvedAt], ['denied', request.deniedAt], ['started', request.startedAt], [request.state, request.result?.finishedAt]
    ];
    for (const [event, timestamp] of events) {
      if (typeof timestamp !== 'string' || !timestamp) continue;
      activities.push({ id: `admin:${request.id}:${event}`, type: 'admin', state: event === 'created' ? request.state : event, timestamp, description: event === 'created' ? `Admin request ${request.state}` : `Admin request ${event}` });
    }
  }
  const transaction = unavailable(updates) ? undefined : updates.data.transaction;
  if (transaction && typeof transaction.state === 'string' && typeof transaction.updatedAt === 'string' && transaction.updatedAt) {
    activities.push({ id: `update:${transaction.state}:${transaction.updatedAt}`, type: 'update', state: transaction.state, timestamp: transaction.updatedAt, description: `Update transaction ${transaction.state}` });
  }
  return activities.sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)));
}
