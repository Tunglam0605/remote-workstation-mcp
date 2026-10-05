import { deriveNotifications } from './model.js';
import { t } from './i18n.js';
import './translations-views.js';
import { button, el, emptyState, field, requestError, resource, section, selectValue, text } from './view-primitives.js';
import { createCapabilityViews } from './capability-views.js';
import { isLinuxApprovableRequest, linuxApprovalPrompt } from './admin-approval-view.js';
import { createSystemAccessViews } from './system-access-views.js';
import { createExecutionView } from './execution-view.js';

export function createViews({ api, store, openModal, openPage = (_page, title, content) => { openModal(title, content); return content; }, openExecutionConsole = () => {}, toast, refresh }) {
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
    if (item.loading) content.append(el('p', { class: 'moon-muted', text: t('Loading current stateâ€¦') }));
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


  const { openWork, openEngineering, openOffice, openWeb } = createCapabilityViews({
    live,
    pageRoot,
    unavailable,
    actions,
    openExecutionConsole
  });

  const { openSystem, openAccess } = createSystemAccessViews({
    live,
    pageRoot,
    unavailable,
    actions,
    mutate,
    openSettings,
    openUpdates
  });

  const { openExecution } = createExecutionView({
    live,
    pageRoot,
    unavailable,
    mutate,
    actions
  });

  function openDevices() {
    const pairing = live('pairing'); const multi = live('multiNode'); const content = pageRoot('Devices', 'Devices & connections', 'See trusted workstations and manage multi-node connections only when you need them.'); unavailable('pairing', content); if (!pairing) return content;
    const devices = section('Paired devices', 'Pairing records do not report device liveness.');
    if (!(pairing.devices || []).length) devices.append(emptyState('No paired devices.'));
    for (const device of pairing.devices || []) {
      const row = el('article', { class: 'moon-row' },
        el('div', { class: 'device-row-header' },
          el('strong', { text: text(device.name || device.hostname) }),
          el('span', { class: 'pill info', text: `${text(device.platform)} Â· ${text(device.version)}` })
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
    const pairingDetails = el('details', { class: 'agent-advanced device-advanced' }, el('summary', { text: t('Pair a new device') }));
    pairingDetails.append(pairingSection);
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
      pairingDetails.append(bootstrap);
    }
    content.append(pairingDetails);
    if (multi) {
      const multiSection = section('Multi-node transfer', t('Required scope: {scope}. Configuration consistency: {consistent}.', { scope: text(multi.requiredScope), consistent: text(multi.configurationConsistent) }), 'moon-page-full');
      const enabled = el('input', { type: 'checkbox', checked: multi.enabled });
      multiSection.append(field('Enable multi-node', enabled), actions(button('Apply multi-node setting', async () => { if (!confirm(t('Change multi-node transfer availability?'))) return; await mutate('/api/multi-node/enabled', { enabled: enabled.checked }, ['multiNode'], 'Multi-node setting saved.'); openDevices(); }, 'primary-button')));
      const grants = multi.grants || [];
      if (grants.length) {
        const grantList = el('div', { class: 'moon-grant-list' });
        for (const grant of grants) grantList.append(el('article', { class: 'moon-row grant-row' }, el('div', { class: 'grant-info' }, el('strong', { text: text(grant.id) }), el('span', { text: `${text(grant.sourceNodeId)} â†’ ${text(grant.destinationNodeId)}` })), actions(button('Remove grant', async () => { if (!confirm(t('Remove grant {id}?', { id: text(grant.id) }))) return; await mutate(`/api/multi-node/grants/${encodeURIComponent(grant.id)}`, undefined, ['multiNode'], 'Grant removed.', 'DELETE'); openDevices(); }, 'secondary-button danger-button'))));
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
      const multiDetails = el('details', { class: 'agent-advanced device-advanced' }, el('summary', { text: t('Advanced multi-node transfers') }));
      multiDetails.append(multiSection); content.append(multiDetails);
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
      const loading = el('p', { class: 'moon-muted', text: t('Loading recovery controlsâ€¦') }); content.append(loading);
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
    const toolPackChoices = [['camera', 'Camera'], ['canopen', 'CANopen'], ['media', 'Media / video'], ['industrial', 'Industrial protocols']];
    const toolPacks = new Set(settings.openaiToolPacks || []);
    const toolPackList = el('div', { class: 'moon-check-grid' });
    for (const [id, label] of toolPackChoices) toolPackList.append(field(label, el('input', { type: 'checkbox', value: id, checked: toolPacks.has(id) })));
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
      scopeList,
      el('h4', { class: 'moon-subheading', text: t('OpenAI tool packs') }),
      el('p', { class: 'moon-muted', text: t('Baseline tools stay available. Enable only the specialist packs you need; changing packs requires a managed runtime restart.') }),
      toolPackList
    );
    config.append(actions(button('Save runtime settings', async () => { if (!confirm(t('Save runtime settings?'))) return; try { const runtimeApiKey = key.value || undefined; const result = await mutate('/api/save', { mcpPort: Number(mcpPort.value), controlPort: controlPort.value ? Number(controlPort.value) : undefined, workspaceRoot: workspaceRoot.value, tunnelId: tunnelId.value || undefined, organizationId: orgId.value || undefined, cloudflaredManaged: managedTunnel.checked, httpScopes: [...scopeList.querySelectorAll('input:checked')].map((input) => input.value), openaiToolPacks: [...toolPackList.querySelectorAll('input:checked')].map((input) => input.value), runtimeApiKey, ...(runtimeApiKey ? { storeRuntimeApiKey: true } : {}) }, ['status', 'runtime', 'permissions'], 'Runtime settings saved.'); if (result?.restartRequired) toast(t('Tool-pack changes were saved. Restart the managed runtime to activate them.')); } finally { key.value = ''; } }, 'primary-button'), button('Install tunnel client', async () => { if (!confirm(t('Install the secure tunnel client on this host?'))) return; await mutate('/api/install-tunnel-client', {}, ['status', 'runtime'], 'Tunnel client installation requested.'); }), button('Delete stored key', async () => { if (!confirm(t('Delete the stored runtime API key?'))) return; await mutate('/api/runtime-key', undefined, ['status'], 'Stored runtime key deleted.', 'DELETE'); }, 'secondary-button danger-button')));
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

  function openNotifications() {
    const content = el('div', { class: 'moon-view' });
    openModal(t('Notifications'), content);
    const notices = deriveNotifications(store.getState());
    const platform = live('status')?.platform;
    if (!notices.length) notices.push({ title: t('No current notifications.'), description: '' });
    for (const notice of notices) {
      const row = el('article', { class: 'moon-row' },
        el('strong', { text: text(notice.title) }),
        notice.description && el('span', { text: text(notice.description) })
      );
      const item = notice.adminRequest;
      if (item?.state === 'pending') {
        row.append(el('details', { class: 'security-request-hash' },
          el('summary', { text: t('Review request details') }),
          el('code', { text: [item.program, ...(item.args || [])].join(' ') }),
          el('code', { text: text(item.commandHash) })
        ));
        const requestActions = [button('Deny', async () => {
          if (!confirm(t('Deny this admin request?'))) return;
          await mutate(`/api/admin/requests/${encodeURIComponent(item.id)}/deny`, undefined, ['admin'], 'Request denied.');
          openNotifications();
        }, 'secondary-button danger-button')];
        if (/^win/i.test(String(platform || ''))) {
          requestActions.unshift(button('Approve + UAC', async () => {
            if (!confirm(t('Approve this exact command and trigger UAC?'))) return;
            await mutate(`/api/admin/requests/${encodeURIComponent(item.id)}/approve`, { expectedCommandHash: item.commandHash }, ['admin'], 'UAC approval requested.');
            openNotifications();
          }, 'primary-button'));
        } else if (/^linux/i.test(String(platform || '')) && isLinuxApprovableRequest(item)) {
          requestActions.unshift(button('Approve', async () => {
            if (!confirm(t(linuxApprovalPrompt(item)))) return;
            await mutate(`/api/admin/requests/${encodeURIComponent(item.id)}/approve`, { expectedCommandHash: item.commandHash }, ['admin'], 'System authorization requested.');
            openNotifications();
          }, 'primary-button'));
        }
        row.append(actions(...requestActions));
      }
      content.append(row);
    }
    return content;
  }
  function openProfile() { const status = live('status'); const content = el('div', { class: 'moon-view' }); openModal(t('Local owner session'), content); content.append(el('p', { text: t('Node: {name}', { name: text(status?.identity?.name) }) }), el('p', { text: t('Platform: {platform}', { platform: text(status?.platform) }) }), el('p', { class: 'moon-muted', text: t('This interface operates through the local, authenticated Control Center.') })); return content; }
  function openDevice(card) { const content = el('div', { class: 'moon-view' }); openModal(text(card?.name || t('Device')), content); for (const spec of card?.specs || []) content.append(el('p', { text: `${text(spec.label)}: ${text(spec.value)}` })); return content; }
  function open(page) {
    ({
      Work: openWork,
      Agents: openExecution,
      Execution: openExecution,
      Engineering: openEngineering,
      Office: openOffice,
      Web: openWeb,
      Devices: openDevices,
      Security: openAccess,
      Access: openAccess,
      System: openSystem,
      Updates: openUpdates,
      Settings: openSettings
    }[page] || (() => {}))();
  }
  return { open, openDevice, openNotifications, openProfile };
}
