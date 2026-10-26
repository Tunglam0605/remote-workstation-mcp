import { t } from './i18n.js';
import { button, el, emptyState, field, section, selectValue, text } from './view-primitives.js';
import { isLinuxApprovableRequest, linuxApprovalPrompt } from './admin-approval-view.js';

export function createSystemAccessViews({
  live,
  pageRoot,
  unavailable,
  actions,
  mutate,
  openSettings,
  openUpdates
}) {
  function openSystem() {
    const content = pageRoot(
      'System',
      'System & updates',
      'Check runtime health, update versions, recovery, diagnostics, and local platform maintenance.'
    );
    const runtime = live('runtime');
    const updates = live('updates');
    const status = live('status');
  
    const runtimeSection = section('Runtime & recovery', 'Manage the local runtime, secure tunnel, and recovery settings without mixing them with application capabilities.');
    runtimeSection.append(el('div', { class: 'detail-grid' },
      el('div', { class: 'detail-item' }, el('span', { text: t('Runtime') }), el('strong', { text: t(runtime?.running ? 'Online' : 'Unavailable') })),
      el('div', { class: 'detail-item' }, el('span', { text: t('Platform') }), el('strong', { text: text(status?.platform) }))
    ), actions(button('Open runtime & recovery', () => openSettings(), 'primary-button')));
    content.append(runtimeSection);
  
    const updateSection = section('Updates', 'Platform updates stay under System instead of occupying a top-level navigation slot.');
    updateSection.append(el('div', { class: 'detail-grid' },
      el('div', { class: 'detail-item' }, el('span', { text: t('Installed') }), el('strong', { text: text(updates?.installedVersion) })),
      el('div', { class: 'detail-item' }, el('span', { text: t('Latest') }), el('strong', { text: text(updates?.latestVersion) }))
    ), actions(button('Open updates', () => openUpdates())));
    content.append(updateSection);
    return content;
  }

  function openAccess() {
    const state = live('permissions');
    const ultimate = live('ultimate');
    const admin = live('admin');
    const platform = live('status')?.platform;
    const content = pageRoot('Access', 'Security & access', 'Control permissions, temporary full-control sessions, and administrative approvals without exposing advanced scopes unless you need them.');
    unavailable('permissions', content);
    if (!state) return content;
  
    const requests = admin?.requests || [];
    const pendingRequests = requests.filter((item) => item.state === 'pending');
    const lease = state.lease;
    const modeLabel = t({ read_only: 'Read only', workspace: 'Workspace', full_control: 'Full control' }[state.mode] || state.mode);
  
    const summary = el('div', { class: 'security-summary moon-page-full' },
      el('div', { class: 'security-summary-item' },
        el('span', { text: t('Permission mode') }),
        el('strong', { text: modeLabel }),
        el('small', { text: t('Current owner policy') })
      ),
      el('div', { class: 'security-summary-item' },
        el('span', { text: t('Full-control lease') }),
        el('strong', { text: lease?.active ? t('Active') : t('Inactive') }),
        el('small', { text: lease?.active ? t('{seconds} seconds remaining', { seconds: text(lease.remainingSeconds) }) : t('No active lease') })
      ),
      el('div', { class: `security-summary-item${pendingRequests.length ? ' needs-attention' : ''}` },
        el('span', { text: t('Admin requests') }),
        el('strong', { text: text(pendingRequests.length) }),
        el('small', { text: pendingRequests.length ? t('Waiting for review') : t('Nothing pending') })
      )
    );
    content.append(summary);
  
    const primary = el('div', { class: 'security-primary-grid moon-page-full' });
  
    const mode = selectValue(state.mode, [['read_only', 'Read only'], ['workspace', 'Workspace'], ['full_control', 'Full control']]);
    const modeSection = section('Permission mode', 'Choose the normal permission level for this workstation. The backend remains authoritative and may require a restart.', 'security-primary-card');
    modeSection.append(
      field('Current mode', mode),
      el('div', { class: 'security-mode-note' },
        el('span', { class: 'pill info', text: modeLabel }),
        el('p', { text: t('Use the least privilege that still allows the work you need.') })
      ),
      actions(button('Apply mode', async () => {
        const nextModeLabel = t({ read_only: 'Read only', workspace: 'Workspace', full_control: 'Full control' }[mode.value] || mode.value);
        if (!confirm(t('Apply {mode} permissions?', { mode: nextModeLabel }))) return;
        await mutate('/api/permissions/mode', { mode: mode.value }, ['permissions'], 'Permission mode saved.');
        openAccess();
      }, 'primary-button'))
    );
  
    const leaseSection = section('Full-control lease', 'Request a temporary elevated session only when a task genuinely needs full-control tools.', 'security-primary-card');
    const leaseStatusClass = lease?.active ? 'moon-status security-lease-status active' : 'moon-status inactive security-lease-status';
    leaseSection.append(el('div', { class: leaseStatusClass },
      el('strong', { text: lease?.active ? t('Lease active') : t('No active lease') }),
      el('span', { text: lease?.active ? t('{seconds} seconds remaining', { seconds: text(lease.remainingSeconds) }) : t('Request a temporary lease when required.') })
    ));
    const duration = selectValue('30', [['10', '10 minutes'], ['30', '30 minutes'], ['60', '60 minutes']]);
    leaseSection.append(
      field('Duration', duration),
      actions(lease?.active
        ? button('Revoke lease', async () => {
            if (!confirm(t('Revoke the active full-control lease?'))) return;
            await mutate('/api/permissions/lease', undefined, ['permissions'], 'Lease revoked.', 'DELETE');
            openAccess();
          }, 'secondary-button danger-button')
        : button('Request lease', async () => {
            if (!confirm(t('Request a full-control lease?'))) return;
            await mutate('/api/permissions/lease', { ttlMinutes: Number(duration.value) }, ['permissions'], 'Lease requested.');
            openAccess();
          }, 'primary-button'))
    );
  
    primary.append(modeSection, leaseSection);
    content.append(primary);

    const ultimateSection = section(
      'Ultimate Control 4H',
      'Owner-local, scoped automation consent for approved project workflows. It does not provide OS Administrator/root rights or bypass ChatGPT app approvals.',
      'moon-page-full security-ultimate-section'
    );
    if (!ultimate) {
      ultimateSection.append(el('p', { class: 'moon-muted', text: t('Ultimate status unavailable; activation is disabled.') }));
      unavailable('ultimate', ultimateSection);
    } else if (ultimate.platformSupported === false) {
      ultimateSection.append(el('p', { class: 'moon-status warning', text: t('Ultimate Control activation is available on Windows only. This Linux runtime remains on its existing release.') }));
    } else {
      const ultimateLabel = el('strong', { text: t(ultimate.active ? 'Ultimate active' : 'Ultimate inactive') });
      const ultimateRemaining = el('span', { text: ultimate.active
          ? t('{seconds} seconds remaining', { seconds: text(ultimate.remainingSeconds) })
          : t('Maximum session is four hours. No automatic renewal.') });
      const ultimateBanner = el('div', { class: ultimate.active ? 'moon-status active' : 'moon-status inactive' }, ultimateLabel, ultimateRemaining);
      ultimateSection.append(ultimateBanner);
      // Store refreshes every five seconds; keep the open Access page accurate
      // without replacing its form fields or resetting the owner's selections.
      const statusTimer = setInterval(() => {
        if (!content.isConnected) { clearInterval(statusTimer); return; }
        const status = live('ultimate');
        if (!status) return;
        const wallRemaining = status.expiresAt ? Math.max(0, Math.ceil((Date.parse(status.expiresAt) - Date.now()) / 1000)) : 0;
        const remaining = status.active ? Math.min(Math.max(0, Number(status.remainingSeconds) || 0), wallRemaining) : 0;
        const active = status.active && remaining > 0;
        ultimateBanner.className = active ? 'moon-status active' : 'moon-status inactive';
        ultimateLabel.textContent = t(active ? 'Ultimate active' : 'Ultimate inactive');
        ultimateRemaining.textContent = active
          ? t('{seconds} seconds remaining', { seconds: text(remaining) })
          : t('Expired or revoked; no new protected workflow may start.');
      }, 1000);
      if (ultimate.permanentFullAccessWarning) ultimateSection.append(el('p', {
        class: 'moon-status warning',
        text: t('Warning: persistent Full control remains enabled in the base policy after Ultimate expires or is revoked. Change Permission mode separately if necessary.')
      }));
      if (ultimate.active) {
        const activeScope = ultimate.scope || {};
        ultimateSection.append(
          el('p', { class: 'moon-muted', text: t('Approved operations: {value}', { value: (activeScope.operations || []).join(', ') }) }),
          el('p', { class: 'moon-muted', text: t('Approved workspaces: {value}', { value: (activeScope.workspaces || []).join(', ') }) }),
          actions(button('Revoke Ultimate immediately', async () => {
            if (!confirm(t('Revoke this exact Ultimate automation consent now?'))) return;
            await mutate('/api/ultimate', undefined, ['ultimate'], 'Ultimate revoked.', 'DELETE');
            openAccess();
          }, 'secondary-button danger-button'))
        );
      } else {
        const allowedWorkspaces = Array.isArray(ultimate.availableWorkspaces) ? ultimate.availableWorkspaces : [];
        const allowedGrants = Array.isArray(ultimate.availableTransferGrants) ? ultimate.availableTransferGrants : [];
        const ultimateDuration = selectValue('30', [['30', '30 minutes'], ['60', '1 hour'], ['120', '2 hours'], ['240', '4 hours']]);
        const ultimateWorkspace = selectValue(allowedWorkspaces[0]?.id || '', allowedWorkspaces.map(item => [item.id, `${item.name} (${item.id})`]));
        const ultimateOperation = selectValue('artifact_verify', [
          ['artifact_verify', 'Verify artifact'], ['workspace_add', 'Import project'],
          ['build', 'Approved build'], ['test', 'Approved test'], ['transfer', 'Authorized cross-node transfer']
        ]);
        const ultimateProfile = el('input', { type: 'text', maxlength: '128', placeholder: t('Owner-approved profile ID (build/test only)') });
        const ultimateGrant = selectValue(allowedGrants[0]?.id || '', allowedGrants.map(item => [item.id, `${item.id} (${item.sourceNodeId} → ${item.destinationNodeId})`]));
        const ultimateWorkSession = el('input', { type: 'text', maxlength: '128', placeholder: t('Optional exact Work Session ID') });
        const operationNote = el('small', { class: 'moon-muted', text: t('Choose one typed operation. Existing workspace permissions, workflow profiles and transfer grants still apply.') });
        ultimateSection.append(
          field('Duration (hard maximum 4h)', ultimateDuration),
          field('Allowed workspace', ultimateWorkspace),
          field('Allowed operation', ultimateOperation),
          field('Approved toolchain profile ID', ultimateProfile),
          field('Existing bilateral transfer grant', ultimateGrant),
          field('Work Session restriction', ultimateWorkSession),
          operationNote
        );
        const activate = button('Activate scoped Ultimate', async () => {
          const operation = ultimateOperation.value;
          const profileId = ultimateProfile.value.trim();
          const grantId = ultimateGrant.value;
          const sessionId = ultimateWorkSession.value.trim();
          if ((operation === 'build' || operation === 'test') && !profileId) {
            alert(t('Enter an existing approved profile ID.')); return;
          }
          if (operation === 'transfer' && !grantId) {
            alert(t('Configure a bilateral transfer grant locally before activation.')); return;
          }
          const scope = {
            operations: [operation],
            workspaces: [ultimateWorkspace.value],
            profileIds: operation === 'build' || operation === 'test' ? [profileId] : [],
            transferGrantIds: operation === 'transfer' ? [grantId] : [],
            ...(sessionId ? { workSessionId: sessionId } : {})
          };
          if (!confirm(t('Activate bounded Ultimate for exactly {operation} in workspace {workspace} for {minutes} minutes?', {
            operation, workspace: ultimateWorkspace.value, minutes: ultimateDuration.value
          }))) return;
          await mutate('/api/ultimate/activate', { durationMinutes: Number(ultimateDuration.value), scope }, ['ultimate'], 'Ultimate activated.');
          openAccess();
        }, 'primary-button');
        activate.disabled = allowedWorkspaces.length === 0;
        ultimateSection.append(actions(activate));
      }
    }
    content.append(ultimateSection);
  
    const scopeChoices = [['workstation.read', 'Read'], ['workstation.write', 'Write'], ['workstation.execute', 'Execute'], ['workstation.admin_request', 'Admin request'], ['workstation.full_control', 'Full control'], ['workstation.cross_node_transfer', 'Cross-node transfer']];
    const scopes = new Set(state.httpScopes || []);
    const scopeDetails = el('details', { class: 'agent-advanced security-advanced security-advanced-full moon-page-full' },
      el('summary', { text: t('Advanced access scopes') })
    );
    const scopeSection = section('HTTP scopes', 'Only change raw scopes and local gates when you understand why a specific integration needs them.', 'security-scope-section');
    const scopeList = el('div', { class: 'moon-check-grid' });
    for (const [id, label] of scopeChoices) {
      const box = el('input', { type: 'checkbox', value: id, checked: scopes.has(id) });
      scopeList.append(field(label, box));
    }
    const hostFs = el('input', { type: 'checkbox', checked: state.allowHostFilesystem });
    const rawShell = el('input', { type: 'checkbox', checked: state.allowRawShell });
    const localGates = el('div', { class: 'moon-toggle-grid' }, field('Allow host filesystem', hostFs), field('Allow raw shell', rawShell));
    scopeSection.append(scopeList, localGates, actions(button('Save scopes', async () => {
      const httpScopes = [...scopeList.querySelectorAll('input:checked')].map((input) => input.value);
      if (!confirm(t('Save the selected access scopes?'))) return;
      await mutate('/api/permissions/config', { httpScopes, allowHostFilesystem: hostFs.checked, allowRawShell: rawShell.checked }, ['permissions'], 'Access scopes saved.');
      openAccess();
    }, 'primary-button')));
    scopeDetails.append(scopeSection);
    content.append(scopeDetails);
  
    const adminSection = section('Admin requests', 'Review the exact command and reason before authorizing an elevated action.', 'moon-page-full security-admin-section');
    const adminSummary = el('div', { class: 'security-admin-summary' },
      el('div', {},
        el('strong', { text: pendingRequests.length ? t('{count} pending request(s)', { count: pendingRequests.length }) : t('No pending requests') }),
        el('span', { text: t('Only approve requests you recognize and expect.') })
      )
    );
    adminSection.append(adminSummary);
    if (!requests.length) adminSection.append(emptyState('No pending admin requests.'));
    const requestList = el('div', { class: 'security-admin-list' });
    for (const item of requests) {
      const row = el('article', { class: `security-admin-request${item.state === 'pending' ? ' pending' : ''}` },
        el('div', { class: 'security-admin-request-head' },
          el('div', { class: 'security-admin-program' },
            el('strong', { text: text(item.program) }),
            el('span', { text: text(item.reason) })
          ),
          el('span', { class: `pill ${item.state === 'pending' ? 'warning' : 'info'}`, text: t(text(item.state)) })
        ),
        el('details', { class: 'security-request-hash' },
          el('summary', { text: t('Show command hash') }),
          el('code', { text: text(item.commandHash) })
        )
      );
      if (item.state === 'pending') {
        const requestActions = [button('Deny', async () => {
          if (!confirm(t('Deny this admin request?'))) return;
          await mutate(`/api/admin/requests/${encodeURIComponent(item.id)}/deny`, undefined, ['admin'], 'Request denied.');
          openAccess();
        }, 'secondary-button danger-button')];
        if (/^win/i.test(String(platform || ''))) {
          requestActions.unshift(button('Approve + UAC', async () => {
            if (!confirm(t('Approve this exact command and trigger UAC?'))) return;
            await mutate(`/api/admin/requests/${encodeURIComponent(item.id)}/approve`, { expectedCommandHash: item.commandHash }, ['admin'], 'UAC approval requested.');
            openAccess();
          }, 'primary-button'));
        } else if (/^linux/i.test(String(platform || '')) && isLinuxApprovableRequest(item)) {
          requestActions.unshift(button('Approve', async () => {
            if (!confirm(t(linuxApprovalPrompt(item)))) return;
            await mutate(`/api/admin/requests/${encodeURIComponent(item.id)}/approve`, { expectedCommandHash: item.commandHash }, ['admin'], 'System authorization requested.');
            openAccess();
          }, 'primary-button'));
          row.append(el('small', { class: 'moon-muted', text: t('Linux approval uses the local desktop authorization agent and remains restricted to supported typed actions.') }));
        } else {
          row.append(el('small', { class: 'moon-muted', text: t('Only supported typed actions can be approved from Control Center on this platform.') }));
        }
        row.append(actions(...requestActions));
      }
      requestList.append(row);
    }
    adminSection.append(requestList);
    content.append(adminSection);
    return content;
  }

  return { openSystem, openAccess };
}
