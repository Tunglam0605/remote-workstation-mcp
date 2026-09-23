import { deriveNotifications } from './model.js';
import { t } from './i18n.js';
import './translations-views.js';

const text = (value) => value == null || value === '' ? '—' : String(value);

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value == null) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (name === 'checked') node.checked = Boolean(value);
    else node.setAttribute(name, value);
  }
  for (const child of children.flat()) if (child != null) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  return node;
}

function resource(store, name) { return store.getState?.()[name] || {}; }
function section(title, description, extraClass = '') {
  const header = el('header', { class: 'moon-section-header' },
    el('h3', { text: t(title) }),
    description && el('p', { text: t(description) })
  );
  return el('section', { class: `moon-section ${extraClass}`.trim() }, header);
}
function field(label, control, hint, extraClass = '') {
  return el('label', { class: `moon-field ${extraClass}`.trim() },
    el('span', { text: t(label) }),
    control,
    hint && el('small', { text: t(hint) })
  );
}
function button(label, handler, className = 'secondary-button') {
  return el('button', {
    type: 'button',
    class: className,
    text: t(label),
    onclick: (event) => {
      const control = event.currentTarget;
      control.disabled = true;
      void Promise.resolve(handler(event)).catch(() => {}).finally(() => { control.disabled = false; });
    }
  });
}
function selectValue(value, choices) {
  const select = el('select');
  for (const [id, label] of choices) select.append(el('option', { value: id, text: t(label), selected: id === value ? '' : null }));
  return select;
}
function requestError(error) { return error?.message || t('The control center rejected this request.'); }
function emptyState(message) { return el('div', { class: 'moon-empty' }, el('p', { class: 'moon-muted', text: t(message) })); }

export function createViews({ api, store, openModal, openPage = (_page, title, content) => { openModal(title, content); return content; }, toast, refresh }) {
  async function mutate(path, body, keys, message, method = 'POST', timeoutMs = 180_000) {
    try {
      const result = await api.request(path, { method, body, timeoutMs });
      await refresh(keys);
      toast(t(message || 'Saved.'));
      return result;
    } catch (error) { toast(requestError(error)); throw error; }
  }
  function live(name) { return resource(store, name).data; }
  function unavailable(name, content) {
    const item = resource(store, name);
    if (item.loading) content.append(el('p', { class: 'moon-muted', text: t('Loading current state…') }));
    else if (item.error) content.append(el('p', { class: 'moon-error', text: `${t('Unavailable')}: ${requestError(item.error)}` }));
  }
  function actions(...nodes) { return el('div', { class: 'modal-actions' }, nodes); }
  function pageRoot(page, title, description) {
    const content = el('div', { class: `moon-page moon-page-${page.toLowerCase()}` },
      el('header', { class: 'moon-page-header' },
        el('p', { class: 'moon-page-kicker', text: t('Control Center') }),
        el('h1', { text: t(title) }),
        el('p', { class: 'moon-page-desc', text: t(description) })
      )
    );
    openPage(page, t(title), content);
    return content;
  }

  function openAccess() {
    const state = live('permissions'); const admin = live('admin'); const platform = live('status')?.platform;
    const content = pageRoot('Access', 'Access & owner controls', 'Review local owner permissions, leases, and approval requests.'); unavailable('permissions', content);
    if (!state) return content;
    const mode = selectValue(state.mode, [['read_only', 'Read only'], ['workspace', 'Workspace'], ['full_control', 'Full control']]);
    const modeSection = section('Permission mode', 'The backend is authoritative and may require a restart.');
    modeSection.append(field('Current mode', mode), actions(button('Apply mode', async () => {
      const modeLabel = t({ read_only: 'Read only', workspace: 'Workspace', full_control: 'Full control' }[mode.value] || mode.value);
      if (!confirm(t('Apply {mode} permissions?', { mode: modeLabel }))) return;
      await mutate('/api/permissions/mode', { mode: mode.value }, ['permissions'], 'Permission mode saved.'); openAccess();
    }, 'primary-button'))); content.append(modeSection);
    const scopeChoices = [['workstation.read', 'Read'], ['workstation.write', 'Write'], ['workstation.execute', 'Execute'], ['workstation.admin_request', 'Admin request'], ['workstation.full_control', 'Full control'], ['workstation.cross_node_transfer', 'Cross-node transfer']];
    const scopes = new Set(state.httpScopes || []); const scopeSection = section('HTTP scopes', 'Choose only the scopes required for this local owner session.');
    const scopeList = el('div', { class: 'moon-check-grid' });
    for (const [id, label] of scopeChoices) { const box = el('input', { type: 'checkbox', value: id, checked: scopes.has(id) }); scopeList.append(field(label, box)); }
    const hostFs = el('input', { type: 'checkbox', checked: state.allowHostFilesystem }); const rawShell = el('input', { type: 'checkbox', checked: state.allowRawShell });
    const localGates = el('div', { class: 'moon-toggle-grid' }, field('Allow host filesystem', hostFs), field('Allow raw shell', rawShell));
    scopeSection.append(scopeList, localGates, actions(button('Save scopes', async () => {
      const httpScopes = [...scopeList.querySelectorAll('input:checked')].map((input) => input.value);
      if (!confirm(t('Save the selected access scopes?'))) return;
      await mutate('/api/permissions/config', { httpScopes, allowHostFilesystem: hostFs.checked, allowRawShell: rawShell.checked }, ['permissions'], 'Access scopes saved.'); openAccess();
    }, 'primary-button'))); content.append(scopeSection);
    const leaseSection = section('Full-control lease', 'A lease is permitted only when the backend local gate is enabled.');
    const lease = state.lease;
    const leaseStatusClass = lease?.active ? 'moon-status' : 'moon-status inactive';
    leaseSection.append(el('p', { class: leaseStatusClass, text: lease?.active ? t('Active · {seconds} seconds remaining', { seconds: text(lease.remainingSeconds) }) : t('No active lease.') }));
    const duration = selectValue('30', [['10', '10 minutes'], ['30', '30 minutes'], ['60', '60 minutes']]);
    leaseSection.append(field('Duration', duration), actions(lease?.active ? button('Revoke lease', async () => { if (!confirm(t('Revoke the active full-control lease?'))) return; await mutate('/api/permissions/lease', undefined, ['permissions'], 'Lease revoked.', 'DELETE'); openAccess(); }, 'secondary-button danger-button') : button('Request lease', async () => { if (!confirm(t('Request a full-control lease?'))) return; await mutate('/api/permissions/lease', { ttlMinutes: Number(duration.value) }, ['permissions'], 'Lease requested.'); openAccess(); }, 'primary-button'))); content.append(leaseSection);
    const requests = admin?.requests || []; const adminSection = section('Admin requests', 'Review the exact command hash before authorizing the Windows UAC flow.');
    if (!requests.length) adminSection.append(emptyState('No pending admin requests.'));
    for (const item of requests) {
      const row = el('article', { class: 'moon-row' },
        el('div', { class: 'admin-request-header' },
          el('strong', { text: text(item.program) }),
          el('span', { class: `pill ${item.state === 'pending' ? 'warning' : 'info'}`, text: `${text(item.state)} · ${text(item.reason)}` })
        ),
        el('code', { text: text(item.commandHash) })
      );
      if (item.state === 'pending') {
        const requestActions = [button('Deny', async () => { if (!confirm(t('Deny this admin request?'))) return; await mutate(`/api/admin/requests/${encodeURIComponent(item.id)}/deny`, undefined, ['admin'], 'Request denied.'); openAccess(); }, 'secondary-button danger-button')];
        if (/^win/i.test(String(platform || ''))) requestActions.unshift(button('Approve + UAC', async () => { if (!confirm(t('Approve this exact command and trigger UAC?'))) return; await mutate(`/api/admin/requests/${encodeURIComponent(item.id)}/approve`, { expectedCommandHash: item.commandHash }, ['admin'], 'UAC approval requested.'); openAccess(); }, 'primary-button'));
        else row.append(el('small', { class: 'moon-muted', text: t('Approval is available through the platform owner interface.') }));
        row.append(actions(...requestActions));
      }
      adminSection.append(row);
    } content.append(adminSection); return content;
  }

  function openExecution() {
    const policy = live('execution');
    const antigravity = live('antigravity');
    const content = pageRoot('Execution', 'Agent Control', 'Choose how ChatGPT may route bounded implementation work to RWMCP, Codex, and Antigravity.');
    unavailable('execution', content);
    if (!policy) return content;

    const settings = policy.settings || {};
    const status = policy.status || {};
    const codex = policy.codex || {};
    const broker = policy.accountBroker || settings.codexAccountBroker || {};
    const codexAvailable = Boolean(codex.installed && codex.authenticated);
    const antigravityAvailable = Boolean(antigravity?.available && antigravity?.authenticated);
    const codexReady = Boolean(settings.codexEnabled && codexAvailable && broker.effectiveBackend !== 'blocked');
    const antigravityReady = Boolean(settings.antigravityEnabled && antigravityAvailable);
    const modeLabels = { 'rwmcp-only': 'RWMCP only', 'codex-only': 'Codex first', both: 'Hybrid' };
    const sourceLabels = { 'owner-default': 'Owner default', 'work-session-override': 'ChatGPT Work Session override', 'fallback-latch': 'Automatic fallback' };
    const effective = status.effectiveMode || settings.defaultMode || 'rwmcp-only';
    const routeText = effective === 'rwmcp-only'
      ? 'Without a Work Session override, ChatGPT uses RWMCP directly for coding work.'
      : effective === 'codex-only'
        ? 'ChatGPT may delegate bounded implementation tasks to Codex.'
        : 'ChatGPT may combine direct RWMCP control with bounded coding workers.';

    const route = section('Global route', 'This shows the owner-level route; Work Sessions can have different routes when overrides are allowed. Session fallbacks are not shown here.', 'moon-page-full agent-route-section');
    route.append(el('div', { class: 'agent-route-banner' },
      el('div', { class: 'agent-route-main' },
        el('span', { class: `pill ${status.fallbackActive ? 'warning' : 'success'}`, text: t(status.fallbackActive ? 'Fallback active' : 'Policy active') }),
        el('div', {}, el('strong', { text: t(modeLabels[effective] || effective) }), el('p', { text: t(routeText) }))
      ),
      el('div', { class: 'agent-route-meta' },
        el('span', { text: `${t('Source')}: ${t(sourceLabels[status.source] || text(status.source))}` }),
        el('span', { text: `${t('Chat overrides')}: ${settings.allowChatOverride ? t('Allowed') : t('Locked by owner')}` }),
        el('span', { text: `${t('Active overrides')}: ${text(status.activeSessionOverrides ?? 0)}` })
      )
    ));
    if (status.fallbackActive) route.append(el('p', { class: 'moon-warning', text: t('Fallback active: {reason}', { reason: text(status.fallbackReason) }) }));
    content.append(route);

    const strategy = section('Default strategy', 'Pick the normal route. ChatGPT can only override it per Work Session when you allow that below.', 'moon-page-full');
    const selectedMode = settings.defaultMode || status.configuredMode || 'rwmcp-only';
    const strategies = [
      ['rwmcp-only', 'RWMCP only', 'Lowest worker usage. ChatGPT operates through typed RWMCP tools only.'],
      ['codex-only', 'Codex first', 'Use Codex for bounded coding tasks; RWMCP remains the control plane.'],
      ['both', 'Hybrid', 'Let ChatGPT choose direct RWMCP or bounded workers per task.']
    ];
    const strategyGrid = el('div', { class: 'agent-strategy-grid' });
    for (const [id, title, description] of strategies) {
      const input = el('input', { type: 'radio', name: 'execution-strategy', value: id, checked: id === selectedMode });
      strategyGrid.append(el('label', { class: `agent-strategy-card${id === selectedMode ? ' selected' : ''}` }, input,
        el('div', {}, el('strong', { text: t(title) }), el('p', { text: t(description) }))
      ));
      input.addEventListener('change', () => strategyGrid.querySelectorAll('.agent-strategy-card').forEach((card) => card.classList.toggle('selected', card.querySelector('input')?.checked)));
    }
    strategy.append(strategyGrid);
    content.append(strategy);

    const codexEnabled = el('input', { type: 'checkbox', checked: settings.codexEnabled });
    const antiEnabled = el('input', { type: 'checkbox', checked: settings.antigravityEnabled });
    const providers = section('Workers', 'Enable only the workers you want ChatGPT to be able to use. Availability never grants extra workstation authority.', 'moon-page-full');
    const providerGrid = el('div', { class: 'agent-provider-grid' });
    const providerCard = (kind, title, ready, enabledControl, facts, note) => el('article', { class: `agent-provider-card ${ready ? 'ready' : 'offline'}` },
      el('header', { class: 'agent-provider-header' },
        el('div', {}, el('span', { class: 'agent-provider-kicker', text: t(kind) }), el('h4', { text: title })),
        el('span', { class: `pill ${ready ? 'success' : 'warning'}`, text: t(ready ? 'Ready' : enabledControl.checked ? 'Unavailable' : 'Disabled') })
      ),
      el('div', { class: 'agent-provider-facts' }, ...facts.filter(Boolean).map(([label, value]) => el('div', {}, el('span', { text: t(label) }), el('strong', { text: t(text(value)) })) )),
      el('p', { class: 'moon-muted', text: t(enabledControl.checked ? note : 'Worker is disabled by owner policy.') }),
      el('label', { class: 'agent-enable-row' }, enabledControl, el('span', { text: t('Allow ChatGPT to use this worker') }))
    );
    providerGrid.append(
      providerCard('Coding worker', 'OpenAI Codex', codexReady, codexEnabled, [
        ['Version', codex.version],
        ['Model', settings.codexModel || 'gpt-6-sol'],
        ['Account routing', broker.effectiveBackend || broker.mode || settings.codexAccountBroker?.mode]
      ], codexReady ? 'Codex is authenticated and ready for bounded Work Session tasks.' : (broker.effectiveBackend === 'blocked' ? broker.pool?.detail || 'Account routing is unavailable.' : codex.detail || 'Codex is not ready.')),
      providerCard('UI / frontend worker', 'Google Antigravity', antigravityReady, antiEnabled, [
        ['Version', antigravity?.version],
        ['Model', antigravity?.model?.label || antigravity?.model?.id || settings.antigravityModel || 'Provider default'],
        ['Sandbox', antigravity?.available ? 'Required' : 'Unavailable']
      ], antigravityReady ? 'Antigravity is authenticated and constrained by the configured sandbox policy.' : (antigravity?.detail || 'Antigravity is not ready.'))
    );
    providers.append(providerGrid);
    content.append(providers);

    const chatOverride = el('input', { type: 'checkbox', checked: settings.allowChatOverride });
    const fallback = selectValue(settings.codexFallback || 'rwmcp-only', [['rwmcp-only', 'Return to RWMCP'], ['stop', 'Stop Codex dispatch']]);
    const behavior = section('ChatGPT behavior', 'These controls define what ChatGPT may change temporarily and what happens when Codex reaches a limit.', 'moon-page-full');
    behavior.append(el('div', { class: 'agent-behavior-grid' },
      field('Work Session override', chatOverride, 'Allows ChatGPT to choose RWMCP only, Codex first, or Hybrid for one isolated Work Session.'),
      field('When Codex reaches a limit', fallback, 'RWMCP fallback switches the affected route; Stop rejects Codex dispatch without switching routes.')
    ));
    content.append(behavior);

    const codexModel = el('input', { value: settings.codexModel || 'gpt-6-sol', placeholder: 'gpt-6-sol' });
    const antiModel = el('input', { value: settings.antigravityModel || '', placeholder: t('Provider configured model') });
    const codexAgentsEnabled = el('input', { type: 'checkbox', checked: settings.codexAgentsEnabled });
    const codexSkillsEnabled = el('input', { type: 'checkbox', checked: settings.codexSkillsEnabled });
    const maxSession = el('input', { type: 'number', min: '0', value: settings.maxCodexTasksPerSession ?? '' });
    const maxDay = el('input', { type: 'number', min: '0', value: settings.maxCodexTasksPerDay ?? '' });
    const brokerEnabled = el('input', { type: 'checkbox', checked: settings.codexAccountBroker?.enabled });
    const brokerMode = selectValue(settings.codexAccountBroker?.mode || 'native', [['native', 'Native'], ['cockpit-api-pool', 'Cockpit API pool']]);
    const advanced = section('Advanced', 'Model overrides, budgets, agent features, and recovery controls.', 'moon-page-full');
    const details = el('details', { class: 'agent-advanced' }, el('summary', { text: t('Show advanced worker settings') }));
    details.append(el('div', { class: 'moon-form-grid agent-advanced-grid' },
      field('Codex model', codexModel),
      field('Antigravity model', antiModel),
      field('Enable Codex EAS agents', codexAgentsEnabled),
      field('Share Codex skills with RWMCP workers', codexSkillsEnabled),
      field('Max Codex tasks / session', maxSession, '0 means unlimited.'),
      field('Max Codex tasks / day', maxDay, '0 means unlimited.'),
      field('Enable account broker', brokerEnabled),
      field('Broker mode', brokerMode)
    ));
    details.append(el('div', { class: 'agent-danger-zone' },
      el('div', {}, el('strong', { text: t('Recovery actions') }), el('p', { class: 'moon-muted', text: t('Use these only when a fallback latch or stale Work Session override needs to be cleared.') })),
      actions(
        button('Reset fallback', async () => { await mutate('/api/execution-policy/fallback-reset', {}, ['execution'], 'Fallback reset.'); openExecution(); }),
        button('Clear overrides', async () => { if (!confirm(t('Clear all active execution overrides?'))) return; await mutate('/api/execution-policy/clear-overrides', {}, ['execution'], 'Overrides cleared.'); openExecution(); }, 'secondary-button danger-button')
      )
    ));
    advanced.append(details);
    content.append(advanced);

    content.append(el('div', { class: 'agent-save-bar moon-page-full' },
      el('div', {}, el('strong', { text: t('Owner policy') }), el('span', { text: t('Changes affect future worker routing; provider/runtime changes may require a managed restart.') })),
      button('Save Agent Control', async () => {
        if (!confirm(t('Save this execution policy?'))) return;
        const selected = content.querySelector('input[name="execution-strategy"]:checked')?.value || 'rwmcp-only';
        const body = {
          defaultMode: selected,
          codexEnabled: codexEnabled.checked,
          codexModel: codexModel.value,
          codexAgentsEnabled: codexAgentsEnabled.checked,
          codexSkillsEnabled: codexSkillsEnabled.checked,
          antigravityEnabled: antiEnabled.checked,
          antigravityModel: antiModel.value,
          allowChatOverride: chatOverride.checked,
          codexFallback: fallback.value,
          maxCodexTasksPerSession: maxSession.value === '' ? undefined : Number(maxSession.value),
          maxCodexTasksPerDay: maxDay.value === '' ? undefined : Number(maxDay.value),
          codexAccountBroker: { enabled: brokerEnabled.checked, mode: brokerMode.value }
        };
        const result = await mutate('/api/execution-policy', body, ['execution', 'antigravity'], 'Execution policy saved.');
        if (result?.restartRequired) toast(t('Saved. Restart the managed runtime to activate provider-level changes.'));
        openExecution();
      }, 'primary-button')
    ));
    return content;
  }
  function openDevices() {
    const pairing = live('pairing'); const multi = live('multiNode'); const content = pageRoot('Devices', 'Devices & multi-node', 'Pair trusted devices and manage explicit transfer grants.'); unavailable('pairing', content); if (!pairing) return content;
    const devices = section('Paired devices', 'Pairing records do not report device liveness.');
    if (!(pairing.devices || []).length) devices.append(emptyState('No paired devices.'));
    for (const device of pairing.devices || []) {
      const row = el('article', { class: 'moon-row' },
        el('div', { class: 'device-row-header' },
          el('strong', { text: text(device.name || device.hostname) }),
          el('span', { class: 'pill info', text: `${text(device.platform)} · ${text(device.version)}` })
        ),
        el('small', { class: 'moon-muted', text: t('Last seen: {value}', { value: text(device.lastSeenAt) }) })
      );
      if (!device.revokedAt) row.append(actions(button('Revoke device', async () => { if (!confirm(t('Revoke {name}?', { name: text(device.name || device.hostname) }))) return; await mutate(`/api/devices/${encodeURIComponent(device.id)}/revoke`, undefined, ['pairing'], 'Device revoked.', 'POST'); openDevices(); }, 'secondary-button danger-button')));
      devices.append(row);
    }
    content.append(devices);
    const name = el('input', { placeholder: t('Optional device name') });
    const host = selectValue('', [['', 'Manual pairing code'], ...(pairing.bootstrapHosts || []).map((item) => [item.id, `${item.name || item.hostname} (${item.hostname})`])]);
    const ttl = selectValue('600', [['60', '1 minute'], ['600', '10 minutes'], ['3600', '1 hour']]);
    const pairingSection = section('Create pairing code', 'Pairing codes are shown only here and are never saved by the browser.');
    pairingSection.append(field('Requested name', name), field('Bootstrap host', host), field('Expires in', ttl));
    pairingSection.append(actions(button('Create code', async () => { const result = await mutate('/api/devices/pairing-code', { requestedName: name.value || undefined, bootstrapHostId: host.value || undefined, ttlSeconds: Number(ttl.value) }, ['pairing'], 'Pairing code created.'); const codeBox = el('div', { class: 'moon-secret' }, el('strong', { text: t('Pairing code (copy now)') }), el('code', { text: text(result.code) }), el('small', { text: t('Expires {value}', { value: text(result.expiresAt) }) })); pairingSection.append(codeBox); }, 'primary-button')));
    content.append(pairingSection);
    if ((pairing.bootstrapHosts || []).length) {
      const bootstrap = section('Bootstrap an SSH host', 'Send an already-created pairing code to a configured SSH bootstrap host. The credential is never displayed.');
      const bootstrapHost = selectValue(pairing.bootstrapHosts[0]?.id, pairing.bootstrapHosts.map((item) => [item.id, `${item.name || item.hostname} (${item.hostname})`]));
      const bootstrapCode = el('input', { type: 'password', autocomplete: 'one-time-code', placeholder: t('Pairing code') });
      const bootstrapName = el('input', { placeholder: t('Optional device name') });
      bootstrap.append(field('SSH host', bootstrapHost), field('Pairing code', bootstrapCode), field('Device name', bootstrapName), actions(button('Bootstrap SSH host', async () => {
        if (!bootstrapCode.value) { toast(t('Enter a pairing code.')); return; }
        if (!confirm(t('Deliver this pairing credential to the selected SSH host?'))) return;
        try { await mutate('/api/devices/bootstrap-ssh', { hostId: bootstrapHost.value, code: bootstrapCode.value, name: bootstrapName.value || undefined }, ['pairing'], 'SSH bootstrap completed.'); openDevices(); }
        finally { bootstrapCode.value = ''; }
      }, 'primary-button')));
      content.append(bootstrap);
    }
    if (multi) {
      const multiSection = section('Multi-node transfer', t('Required scope: {scope}. Configuration consistency: {consistent}.', { scope: text(multi.requiredScope), consistent: text(multi.configurationConsistent) }), 'moon-page-full');
      const enabled = el('input', { type: 'checkbox', checked: multi.enabled });
      multiSection.append(field('Enable multi-node', enabled), actions(button('Apply multi-node setting', async () => { if (!confirm(t('Change multi-node transfer availability?'))) return; await mutate('/api/multi-node/enabled', { enabled: enabled.checked }, ['multiNode'], 'Multi-node setting saved.'); openDevices(); }, 'primary-button')));
      const grants = multi.grants || [];
      if (grants.length) {
        const grantList = el('div', { class: 'moon-grant-list' });
        for (const grant of grants) grantList.append(el('article', { class: 'moon-row grant-row' }, el('div', { class: 'grant-info' }, el('strong', { text: text(grant.id) }), el('span', { text: `${text(grant.sourceNodeId)} → ${text(grant.destinationNodeId)}` })), actions(button('Remove grant', async () => { if (!confirm(t('Remove grant {id}?', { id: text(grant.id) }))) return; await mutate(`/api/multi-node/grants/${encodeURIComponent(grant.id)}`, undefined, ['multiNode'], 'Grant removed.', 'DELETE'); openDevices(); }, 'secondary-button danger-button'))));
        multiSection.append(grantList);
      }
      const grantId = el('input', { placeholder: t('Grant ID') }); const source = el('input', { placeholder: t('Source node ID') }); const destination = el('input', { placeholder: t('Destination node ID') }); const sourceWorkspace = el('input', { placeholder: t('Source workspace') }); const destinationWorkspace = el('input', { placeholder: t('Destination workspace') }); const extensions = el('input', { placeholder: '.zip, .json', value: '.zip' });
      const addGrantForm = el('div', { class: 'moon-form-grid' },
        field('Grant ID', grantId),
        field('Allowed extensions', extensions, 'Comma-separated extensions, for example .zip or .json.'),
        field('Source node', source),
        field('Destination node', destination),
        field('Source workspace', sourceWorkspace),
        field('Destination workspace', destinationWorkspace)
      );
      multiSection.append(el('h4', { class: 'moon-subheading', text: t('Add grant') }), addGrantForm, actions(button('Add transfer grant', async () => { const allowedExtensions = extensions.value.split(',').map((item) => item.trim()).filter(Boolean); if (!allowedExtensions.length) { toast(t('Provide at least one allowed extension.')); return; } if (!confirm(t('Add this cross-node transfer grant?'))) return; await mutate('/api/multi-node/grants', { id: grantId.value, sourceNodeId: source.value, destinationNodeId: destination.value, sourceWorkspace: sourceWorkspace.value, destinationWorkspace: destinationWorkspace.value, sourcePathPrefixes: ['.'], destinationBasePaths: ['.'], allowedExtensions, maxBytes: 536870912, transports: ['direct'] }, ['multiNode'], 'Transfer grant added.'); openDevices(); }, 'primary-button')));
      content.append(multiSection);
    }
    return content;
  }

  function openUpdates() {
    const state = live('updates'); const updateResource = resource(store, 'updates'); const content = pageRoot('Updates', 'Updates', 'Inspect and control the local platform updater.'); unavailable('updates', content); if (!state) return content;
    const updateState = state.updateAvailable === true ? 'Update available' : state.updateAvailable === false ? 'Current' : 'Unavailable';
    const detail = section('Installed version', 'Update information comes from the platform updater.', 'moon-page-full');
    detail.append(el('div', { class: 'detail-grid' }, el('div', { class: 'detail-item' }, el('span', { text: t('Installed') }), el('strong', { text: text(state.installedVersion) })), el('div', { class: 'detail-item' }, el('span', { text: t('Latest') }), el('strong', { text: text(state.latestVersion) })), el('div', { class: 'detail-item' }, el('span', { text: t('Status') }), el('strong', { class: state.updateAvailable ? 'text-warning' : 'text-success', text: t(updateState) })), el('div', { class: 'detail-item' }, el('span', { text: t('Updater') }), el('strong', { text: t(state.enabled === true ? 'Enabled' : state.enabled === false ? 'Disabled' : 'Unavailable') }))));
    detail.append(el('p', { class: updateResource.error ? 'moon-error' : 'moon-message-box', text: updateResource.error ? `${t('Unavailable')}: ${requestError(updateResource.error)}` : text(state.message) }));
    detail.append(actions(button('Check now', async () => { await mutate('/api/update/check', {}, ['updates'], 'Update check complete.'); openUpdates(); }, 'primary-button'), button(state.enabled ? 'Disable automatic updates' : 'Enable automatic updates', async () => { if (!confirm(t('Change automatic update setting?'))) return; await mutate('/api/update/config', { enabled: !state.enabled }, ['updates'], 'Updater setting saved.'); openUpdates(); }), button('Install available update', async () => { if (!confirm(t('Start the platform update? This may restart managed services.'))) return; const result = await mutate('/api/update/install', {}, ['updates'], 'Update request submitted.'); if (result.transaction) detail.append(el('pre', { class: 'moon-transaction', text: JSON.stringify(result.transaction, null, 2) })); }, state.updateAvailable ? 'primary-button' : 'secondary-button')));
    content.append(detail); return content;
  }

  function openSettings() {
    const status = live('status'); const runtime = live('runtime'); const content = pageRoot('Settings', 'Settings & recovery', 'Manage local runtime, secure tunnel, and recovery configuration.'); unavailable('status', content);
    if (!status) {
      const loading = el('p', { class: 'moon-muted', text: t('Loading recovery controls…') }); content.append(loading);
      void api.request('/api/recovery/status', { timeoutMs: 180_000 }).then((recoveryStatus) => {
        loading.remove(); const settings = recoveryStatus.settings || {};
        const tunnel = el('input', { value: settings.tunnelId ?? '' });
        const organization = el('input', { value: settings.organizationId ?? '' });
        const key = el('input', { type: 'password', autocomplete: 'new-password', placeholder: t('Optional key for this recovery request') });
        const recovery = section('Recovery control center', 'Normal status is unavailable. These controls use the local recovery endpoint.', 'moon-page-full');
        recovery.append(el('div', { class: 'moon-form-grid' }, field('Tunnel ID', tunnel), field('Organization ID', organization), field('Runtime API key', key)), actions(button('Test recovery connection', async () => { try { const result = await api.request('/api/recovery/test', { method: 'POST', body: { tunnelId: tunnel.value || undefined, runtimeApiKey: key.value || undefined }, timeoutMs: 180_000 }); toast(result.ok ? t('Recovery connection succeeded.') : text(result.message)); } catch (error) { toast(requestError(error)); } finally { key.value = ''; } }, 'primary-button'), button('Apply recovery settings', async () => { if (!confirm(t('Apply recovery settings and request reconnect?'))) return; try { await mutate('/api/recovery/apply', { tunnelId: tunnel.value || undefined, organizationId: organization.value || undefined, runtimeApiKey: key.value || undefined, reconnect: true }, ['status', 'runtime'], 'Recovery settings applied.'); } finally { key.value = ''; } })));
        content.append(recovery);
      }).catch((error) => { loading.textContent = `${t('Recovery status unavailable')}: ${requestError(error)}`; loading.className = 'moon-error'; });
      return content;
    }
    const settings = status.settings || {};
    const appearance = section('Appearance', 'This preference stays in this browser and contains no credentials.');
    const reduced = el('input', { type: 'checkbox', checked: document.body.classList.contains('reduce-motion') });
    appearance.append(field('Reduce motion', reduced), actions(button('Save appearance', () => { document.body.classList.toggle('reduce-motion', reduced.checked); localStorage.setItem('moonlight-reduce-motion', reduced.checked ? '1' : '0'); toast(t('Appearance saved.')); }, 'primary-button')));
    content.append(appearance);

    const runtimeMode = selectValue(runtime?.mode === 'Local' ? 'Local' : 'OpenAI', [['OpenAI', 'OpenAI tunnel'], ['Local', 'Local only']]);
    const lifecycle = section('Managed runtime', t('Current state: {state}. Lifecycle operations are local owner actions.', { state: t(runtime?.running ? 'running' : 'stopped or unavailable') }));
    lifecycle.append(
      field('Runtime mode', runtimeMode),
      actions(
        ...['Start', 'Stop', 'Restart', 'RegisterStartup', 'UnregisterStartup'].map((action) => button(action.replace(/([A-Z])/g, ' $1').trim(), async () => {
          const actionLabel = action.replace(/([A-Z])/g, ' $1').trim();
          if (!confirm(t('{action} the managed runtime in {mode} mode?', { action: t(actionLabel), mode: runtimeMode.value }))) return;
          await mutate('/api/runtime/action', { action, mode: runtimeMode.value }, ['runtime', 'status'], t('{action} request submitted.', { action: t(actionLabel) })); openSettings();
        }, action === 'Start' || action === 'Restart' ? 'primary-button' : 'secondary-button'))
      )
    );
    content.append(lifecycle);

    const mcpPort = el('input', { type: 'number', value: settings.mcpPort ?? '' });
    const controlPort = el('input', { type: 'number', value: settings.controlPort ?? '' });
    const workspaceRoot = el('input', { value: settings.workspaceRoot ?? '' });
    const tunnelId = el('input', { value: settings.tunnelId ?? '' });
    const orgId = el('input', { value: settings.organizationId ?? '' });
    const managedTunnel = el('input', { type: 'checkbox', checked: settings.cloudflaredManaged });
    const key = el('input', { type: 'password', autocomplete: 'new-password', placeholder: t('Leave blank to keep existing key') });
    const storeKey = el('input', { type: 'checkbox', checked: true, disabled: '' });
    const scopeChoices = [['workstation.read', 'Read'], ['workstation.write', 'Write'], ['workstation.execute', 'Execute'], ['workstation.admin_request', 'Admin request'], ['workstation.full_control', 'Full control'], ['workstation.cross_node_transfer', 'Cross-node transfer']];
    const scopes = new Set(settings.httpScopes || []);
    const scopeList = el('div', { class: 'moon-check-grid' });
    for (const [id, label] of scopeChoices) scopeList.append(field(label, el('input', { type: 'checkbox', value: id, checked: scopes.has(id) })));
    const config = section('Runtime configuration', 'Runtime keys are submitted once to the local control center and are not retained by this view.');
    const configGrid = el('div', { class: 'moon-form-grid' },
      field('MCP port', mcpPort),
      field('Control port', controlPort),
      field('Tunnel ID', tunnelId),
      field('Organization ID', orgId)
    );
    config.append(
      configGrid,
      field('Workspace root', workspaceRoot),
      field('Managed Cloudflare tunnel', managedTunnel),
      field('Runtime API key', key),
      field('Store runtime key securely', storeKey, 'The backend accepts supplied keys only for secure storage.'),
      el('h4', { class: 'moon-subheading', text: t('HTTP scopes') }),
      scopeList
    );
    config.append(actions(button('Save runtime settings', async () => { if (!confirm(t('Save runtime settings?'))) return; try { const runtimeApiKey = key.value || undefined; await mutate('/api/save', { mcpPort: Number(mcpPort.value), controlPort: controlPort.value ? Number(controlPort.value) : undefined, workspaceRoot: workspaceRoot.value, tunnelId: tunnelId.value || undefined, organizationId: orgId.value || undefined, cloudflaredManaged: managedTunnel.checked, httpScopes: [...scopeList.querySelectorAll('input:checked')].map((input) => input.value), runtimeApiKey, ...(runtimeApiKey ? { storeRuntimeApiKey: true } : {}) }, ['status', 'runtime', 'permissions'], 'Runtime settings saved.'); } finally { key.value = ''; } }, 'primary-button'), button('Install tunnel client', async () => { if (!confirm(t('Install the secure tunnel client on this host?'))) return; await mutate('/api/install-tunnel-client', {}, ['status', 'runtime'], 'Tunnel client installation requested.'); }), button('Delete stored key', async () => { if (!confirm(t('Delete the stored runtime API key?'))) return; await mutate('/api/runtime-key', undefined, ['status'], 'Stored runtime key deleted.', 'DELETE'); }, 'secondary-button danger-button')));
    content.append(config);

    const recoveryKey = el('input', { type: 'password', autocomplete: 'new-password', placeholder: t('Optional key for this probe only') });
    const recoveryTunnel = el('input', { value: settings.tunnelId ?? '' });
    const recoveryOrg = el('input', { value: settings.organizationId ?? '' });
    const recovery = section('First-run & recovery', t('Runtime: {state}. Test or apply only to the local owner control center.', { state: t(runtime?.running ? 'running' : 'unavailable') }));
    const recoveryGrid = el('div', { class: 'moon-form-grid' },
      field('Tunnel ID', recoveryTunnel),
      field('Organization ID', recoveryOrg)
    );
    recovery.append(
      recoveryGrid,
      field('Runtime API key', recoveryKey),
      actions(button('Test recovery connection', async () => { try { const response = await api.request('/api/recovery/test', { method: 'POST', body: { tunnelId: recoveryTunnel.value || undefined, runtimeApiKey: recoveryKey.value || undefined }, timeoutMs: 180_000 }); toast(response.ok ? t('Recovery connection succeeded.') : text(response.message)); } catch (error) { toast(requestError(error)); } finally { recoveryKey.value = ''; } }, 'primary-button'), button('Apply recovery settings', async () => { if (!confirm(t('Apply recovery settings and request reconnect?'))) return; try { await mutate('/api/recovery/apply', { tunnelId: recoveryTunnel.value || undefined, organizationId: recoveryOrg.value || undefined, runtimeApiKey: recoveryKey.value || undefined, reconnect: true }, ['status', 'runtime'], 'Recovery settings applied.'); } finally { recoveryKey.value = ''; } }))
    );
    content.append(recovery);

    if (status.onboardingRequired) {
      const bootstrapTunnel = el('input', { value: settings.tunnelId ?? '' });
      const bootstrapKey = el('input', { type: 'password', autocomplete: 'new-password', placeholder: t('Required for first-run bootstrap') });
      const bootstrap = section('First-run bootstrap', 'Bootstrap writes the local workstation configuration. Submit only after you have the tunnel ID and runtime API key.');
      bootstrap.append(field('Tunnel ID', bootstrapTunnel), field('Runtime API key', bootstrapKey), actions(button('Bootstrap workstation', async () => { if (!bootstrapTunnel.value || !bootstrapKey.value) { toast(t('Tunnel ID and runtime API key are required.')); return; } if (!confirm(t('Bootstrap this local workstation?'))) return; try { await mutate('/api/bootstrap', { tunnelId: bootstrapTunnel.value, runtimeApiKey: bootstrapKey.value }, ['status', 'runtime'], 'Bootstrap completed.'); } finally { bootstrapKey.value = ''; } }, 'primary-button')));
      content.append(bootstrap);
    }
    return content;
  }

  function openNotifications() { const content = el('div', { class: 'moon-view' }); openModal(t('Notifications'), content); const notices = deriveNotifications(store.getState()); if (!notices.length) notices.push({ title: t('No current notifications.'), description: '' }); content.append(...notices.map((notice) => el('article', { class: 'moon-row' }, el('strong', { text: text(notice.title) }), notice.description && el('span', { text: text(notice.description) })))); return content; }
  function openProfile() { const status = live('status'); const content = el('div', { class: 'moon-view' }); openModal(t('Local owner session'), content); content.append(el('p', { text: t('Node: {name}', { name: text(status?.identity?.name) }) }), el('p', { text: t('Platform: {platform}', { platform: text(status?.platform) }) }), el('p', { class: 'moon-muted', text: t('This interface operates through the local, authenticated Control Center.') })); return content; }
  function openDevice(card) { const content = el('div', { class: 'moon-view' }); openModal(text(card?.name || t('Device')), content); for (const spec of card?.specs || []) content.append(el('p', { text: `${text(spec.label)}: ${text(spec.value)}` })); return content; }
  function open(page) { ({ Access: openAccess, Execution: openExecution, Devices: openDevices, Updates: openUpdates, Settings: openSettings }[page] || (() => {}))(); }
  return { open, openDevice, openNotifications, openProfile };
}
