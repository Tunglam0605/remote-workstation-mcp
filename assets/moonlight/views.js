import { deriveNotifications } from './model.js';
import { t } from './i18n.js';
import './translations-views.js';

const text = (value) => value == null || value === '' ? 'â€”' : String(value);

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


  function capabilityEntries(prefixes) {
    const state = live('capabilities');
    const entries = Array.isArray(state?.capabilities) ? state.capabilities : [];
    return entries
      .filter((item) => prefixes.some((prefix) => String(item?.id || '').startsWith(prefix)))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  function capabilityLabel(id) {
    const value = String(id || '');
    const known = [
      ['office.word', 'Word'], ['office.excel', 'Excel'], ['office.powerpoint', 'PowerPoint'],
      ['web.notebooklm', 'NotebookLM'], ['web.existing_chrome', 'Existing Chrome'], ['web.browser', 'Browser automation'], ['web.automation', 'Browser automation'],
      ['engineering.hardware', 'Hardware'], ['engineering.firmware', 'Firmware'], ['engineering.debug', 'Debugging'], ['engineering.ros2', 'ROS 2'], ['engineering.container', 'Containers'], ['engineering.workflow', 'Engineering workflows'],
      ['build.diagnostics', 'Build diagnostics'], ['code.semantic', 'Code intelligence'],
      ['work_session.', 'Work Sessions'], ['project_session_group.', 'Project coordination'], ['project.', 'Projects'], ['work_objective.', 'Objectives & tasks'], ['task.', 'Tasks'], ['filesystem.', 'Files'], ['git.', 'Git']
    ];
    const matched = known.find(([prefix]) => value.startsWith(prefix));
    if (matched) return matched[1];
    const readable = value.replace(/^[^.]+\./, '').replace(/[._-]+/g, ' ').trim();
    return readable ? readable.charAt(0).toUpperCase() + readable.slice(1) : value;
  }

  function capabilityDomain(page, title, description, prefixes, emptyMessage, extraActions = []) {
    const content = pageRoot(page, title, description);
    unavailable('capabilities', content);
    const entries = capabilityEntries(prefixes);
    const available = entries.filter((item) => item.status === 'available').length;
    const summary = section('What you can do', 'This page shows the capabilities available on this workstation. Technical IDs and provider notes stay collapsed unless you need them.', 'moon-page-full capability-friendly-section');
    summary.append(el('div', { class: 'capability-summary-strip' },
      el('div', {}, el('strong', { text: text(available) }), el('span', { text: t('available groups') })),
      el('div', {}, el('strong', { text: text(entries.reduce((total, item) => total + (Array.isArray(item.tools) ? item.tools.length : 0), 0)) }), el('span', { text: t('typed actions') }))
    ));
    if (extraActions.length) summary.append(actions(...extraActions));
    if (!entries.length) summary.append(emptyState(emptyMessage));
    const grid = el('div', { class: 'capability-friendly-grid' });
    for (const item of entries) {
      const tools = Array.isArray(item.tools) ? item.tools : [];
      const details = el('details', { class: 'capability-technical' }, el('summary', { text: t('Technical details') }));
      details.append(
        el('code', { text: text(item.id) }),
        item.note && el('p', { class: 'moon-muted', text: text(item.note) })
      );
      grid.append(el('article', { class: 'capability-friendly-card' },
        el('div', { class: 'device-row-header' },
          el('strong', { text: t(capabilityLabel(item.id)) }),
          el('span', { class: `pill ${item.status === 'available' ? 'success' : 'warning'}`, text: t(item.status === 'available' ? 'Ready' : text(item.status || 'Unavailable')) })
        ),
        el('p', { text: t('{count} typed actions available', { count: tools.length }) }),
        details
      ));
    }
    summary.append(grid);
    content.append(summary);
    return content;
  }

  function openWork() {
    return capabilityDomain(
      'Work',
      'Work & projects',
      'Create or resume Work Sessions, inspect files and Git, and run permitted project tasks from one place.',
      ['work_session.', 'project.', 'project_session_group.', 'work_objective.', 'task.', 'filesystem.', 'git.'],
      'No work-management capabilities are currently advertised by the backend.',
      [button('Open Execution Console', () => openExecutionConsole(), 'primary-button')]
    );
  }

  function openEngineering() {
    return capabilityDomain(
      'Engineering',
      'Engineering tools',
      'Build, flash, debug, inspect hardware, work with ROS 2, and run typed engineering diagnostics.',
      ['engineering.', 'build.diagnostics', 'code.semantic'],
      'No engineering capabilities are currently advertised by the backend.'
    );
  }

  function openOffice() {
    return capabilityDomain(
      'Office',
      'Office tools',
      'Inspect and edit Word, Excel, and PowerPoint files with safe typed operations.',
      ['office.'],
      'No Office capabilities are currently advertised by the backend.'
    );
  }

  function openWeb() {
    return capabilityDomain(
      'Web',
      'Web & NotebookLM',
      'Use managed browser sessions and supported web workflows such as NotebookLM from one place.',
      ['web.'],
      'No web automation capabilities are currently advertised by the backend.'
    );
  }

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
    const state = live('permissions'); const admin = live('admin'); const platform = live('status')?.platform;
    const content = pageRoot('Access', 'Security & access', 'Control permissions and approvals. Full-control options remain explicit and owner-managed.'); unavailable('permissions', content);
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
    leaseSection.append(el('p', { class: leaseStatusClass, text: lease?.active ? t('Active Â· {seconds} seconds remaining', { seconds: text(lease.remainingSeconds) }) : t('No active lease.') }));
    const duration = selectValue('30', [['10', '10 minutes'], ['30', '30 minutes'], ['60', '60 minutes']]);
    leaseSection.append(field('Duration', duration), actions(lease?.active ? button('Revoke lease', async () => { if (!confirm(t('Revoke the active full-control lease?'))) return; await mutate('/api/permissions/lease', undefined, ['permissions'], 'Lease revoked.', 'DELETE'); openAccess(); }, 'secondary-button danger-button') : button('Request lease', async () => { if (!confirm(t('Request a full-control lease?'))) return; await mutate('/api/permissions/lease', { ttlMinutes: Number(duration.value) }, ['permissions'], 'Lease requested.'); openAccess(); }, 'primary-button'))); content.append(leaseSection);
    const requests = admin?.requests || []; const adminSection = section('Admin requests', 'Review the exact command hash before authorizing the Windows UAC flow.');
    if (!requests.length) adminSection.append(emptyState('No pending admin requests.'));
    for (const item of requests) {
      const row = el('article', { class: 'moon-row' },
        el('div', { class: 'admin-request-header' },
          el('strong', { text: text(item.program) }),
          el('span', { class: `pill ${item.state === 'pending' ? 'warning' : 'info'}`, text: `${text(item.state)} Â· ${text(item.reason)}` })
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
    const content = pageRoot('Execution', 'How should AI work?', 'Choose the simple mode you want. Auto / Smart is recommended; technical routing controls stay available when you need them.');
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
    const antiQuotaBuckets = (antigravity?.quotaGroups || []).flatMap((group) => group?.buckets || []);
    const antiWeekly = antiQuotaBuckets.find((bucket) => bucket?.window === 'weekly');
    const antiCapacity = Number.isFinite(antiWeekly?.remainingFraction)
      ? t('{percent}% weekly remaining', { percent: Math.round(Number(antiWeekly.remainingFraction) * 100) })
      : t('Quota telemetry unavailable');
    const codexSessionLimit = Number(status.maxCodexTasksPerSession || 0);
    const codexSessionUsed = Number(status.codexTasksThisSession || 0);
    const codexCapacity = codexSessionLimit > 0
      ? t('{remaining} / {limit} session tasks remaining', { remaining: Math.max(0, codexSessionLimit - codexSessionUsed), limit: codexSessionLimit })
      : t('No Codex task cap');

    const inferTargetMode = () => {
      if (settings.targetMode) return settings.targetMode;
      if (settings.workerRoutingProfile === 'direct' || settings.defaultMode === 'rwmcp-only') return 'rwmcp-only';
      if (settings.workerRoutingProfile === 'smart' && settings.codexEnabled && settings.antigravityEnabled) return 'auto';
      if (settings.defaultMode === 'codex-only') return 'codex-only';
      if (settings.workerRoutingProfile === 'codex-assisted') return 'rwmcp-codex';
      if (settings.codexEnabled && settings.antigravityEnabled) return 'auto';
      if (settings.codexEnabled) return 'rwmcp-codex';
      if (settings.antigravityEnabled) return 'rwmcp-antigravity';
      return 'rwmcp-only';
    };
    const selectedTargetMode = inferTargetMode();
    const targetModeLabels = {
      auto: 'Auto / Smart', 'rwmcp-only': 'RWMCP only', 'codex-only': 'Codex only', 'antigravity-only': 'Antigravity only',
      'rwmcp-codex': 'RWMCP + Codex', 'rwmcp-antigravity': 'RWMCP + Antigravity', 'codex-antigravity': 'Codex + Antigravity', 'all-three': 'All three'
    };
    const targetMembers = {
      auto: ['rwmcp-direct', 'codex-local', 'antigravity-local'], 'rwmcp-only': ['rwmcp-direct'], 'codex-only': ['codex-local'], 'antigravity-only': ['antigravity-local'],
      'rwmcp-codex': ['rwmcp-direct', 'codex-local'], 'rwmcp-antigravity': ['rwmcp-direct', 'antigravity-local'], 'codex-antigravity': ['codex-local', 'antigravity-local'], 'all-three': ['rwmcp-direct', 'codex-local', 'antigravity-local']
    };
    const allowedTargets = new Set(targetMembers[selectedTargetMode] || targetMembers.auto);

    if (status.fallbackActive) {
      content.append(el('div', { class: 'agent-simple-alert moon-page-full' },
        el('span', { class: 'pill warning', text: t('Fallback active') }),
        el('div', {}, el('strong', { text: t('AI workers are temporarily bypassed for a Work Session.') }), el('p', { text: t('RWMCP remains available. Open Technical details to review or reset the fallback after the provider issue is understood.') }))
      ));
    }

    const simple = section('Choose how work is routed', 'Most users should keep Auto / Smart. You can still force one execution target when you need predictable behavior.', 'moon-page-full agent-simple-mode-section');
    const commonModes = [
      ['auto', 'Auto / Smart', 'Recommended', 'Automatically picks the best target for each task and falls back safely when needed.'],
      ['rwmcp-only', 'RWMCP only', '', 'Use deterministic workstation tools only. Best when you want direct, predictable execution.'],
      ['codex-only', 'Codex only', '', 'Send bounded implementation work only to Codex.'],
      ['antigravity-only', 'Antigravity only', '', 'Send bounded implementation work only to Antigravity.']
    ];
    const advancedModes = [
      ['rwmcp-codex', 'RWMCP + Codex', 'Use RWMCP and Codex; Antigravity is excluded.'],
      ['rwmcp-antigravity', 'RWMCP + Antigravity', 'Use RWMCP and Antigravity; Codex is excluded.'],
      ['codex-antigravity', 'Codex + Antigravity', 'Use both AI workers; direct RWMCP is excluded from normal routing.'],
      ['all-three', 'All three', 'Explicitly allow all three targets with task affinity ordering.']
    ];
    const makeModeCard = (id, title, badge, description) => {
      const input = el('input', { type: 'radio', name: 'execution-target-mode', value: id, checked: id === selectedTargetMode });
      const heading = el('div', { class: 'agent-mode-title' }, el('strong', { text: t(title) }));
      if (badge) heading.append(el('span', { class: 'agent-mode-badge', text: t(badge) }));
      const card = el('label', { class: `agent-strategy-card agent-simple-choice${id === selectedTargetMode ? ' selected' : ''}` }, input,
        el('div', {}, heading, el('p', { text: t(description) }))
      );
      input.addEventListener('change', () => content.querySelectorAll('.agent-strategy-card').forEach((node) => node.classList.toggle('selected', node.querySelector('input')?.checked)));
      return card;
    };
    const commonGrid = el('div', { class: 'agent-routing-grid agent-common-grid' });
    for (const [id, title, badge, description] of commonModes) commonGrid.append(makeModeCard(id, title, badge, description));
    const more = el('details', { class: 'agent-advanced agent-more-modes', open: advancedModes.some(([id]) => id === selectedTargetMode) ? '' : null },
      el('summary', { text: t('More routing combinations') })
    );
    const moreGrid = el('div', { class: 'agent-routing-grid agent-more-grid' });
    for (const [id, title, description] of advancedModes) moreGrid.append(makeModeCard(id, title, '', description));
    more.append(moreGrid, el('p', { class: 'moon-muted agent-more-note', text: t('These combinations are for advanced routing needs. They do not widen provider permissions or workstation authority.') }));
    simple.append(commonGrid, more);
    content.append(simple);

    const preferences = section('What happens automatically', 'Auto / Smart uses task affinity as a preference, not a hard capability lock. If the preferred target cannot safely continue, the router can use the next allowed target.', 'moon-page-full');
    const prefCard = (iconName, title, lead, fallback) => el('article', { class: 'agent-preference-card' },
      el('span', { class: 'agent-preference-icon' }, el('i', { 'data-lucide': iconName })),
      el('div', {}, el('strong', { text: t(title) }), el('p', { text: t(lead) }), el('small', { text: t('Fallback: {chain}', { chain: fallback }) }))
    );
    preferences.append(el('div', { class: 'agent-preference-grid' },
      prefCard('palette', 'Frontend / UI', 'Antigravity is preferred for interface and visual work.', 'Codex ? RWMCP'),
      prefCard('code-2', 'Code / Engineering', 'Codex is preferred for backend, code, debugging, and engineering work.', 'Antigravity ? RWMCP'),
      prefCard('monitor-cog', 'Workstation / Office', 'RWMCP is preferred for deterministic workstation, Office, build, test, and read operations.', 'Codex ? Antigravity')
    ));
    content.append(preferences);

    const peers = section('Available execution targets', 'These are the three execution targets the router can use. Selection changes routing eligibility; each target keeps its own security boundary.', 'moon-page-full');
    const peerGrid = el('div', { class: 'agent-provider-grid agent-simple-provider-grid' });
    const peerCard = (title, ready, enabled, preference, capacity, note) => {
      const stateText = !enabled ? 'Not selected' : ready ? 'Ready' : 'Unavailable';
      const tone = !enabled ? 'muted' : ready ? 'success' : 'warning';
      return el('article', { class: `agent-provider-card ${ready && enabled ? 'ready' : 'offline'}` },
        el('header', { class: 'agent-provider-header' }, el('div', {}, el('span', { class: 'agent-provider-kicker', text: t('Execution target') }), el('h4', { text: title })), el('span', { class: `pill ${tone}`, text: t(stateText) })),
        el('div', { class: 'agent-provider-facts agent-simple-facts' },
          el('div', {}, el('span', { text: t('Best for') }), el('strong', { text: t(preference) })),
          el('div', {}, el('span', { text: t('Capacity') }), el('strong', { text: t(text(capacity)) }))
        ),
        el('p', { class: 'moon-muted', text: t(note) })
      );
    };
    peerGrid.append(
      peerCard('RWMCP Direct', true, allowedTargets.has('rwmcp-direct'), 'Workstation / Office / deterministic work', 'Local', 'Direct typed workstation execution. Always local when the selected mode allows it.'),
      peerCard('OpenAI Codex', codexReady, allowedTargets.has('codex-local'), 'Code / backend / engineering', codexCapacity, codexReady ? 'Codex is ready for bounded Work Session tasks.' : (broker.effectiveBackend === 'blocked' ? broker.pool?.detail || 'Account routing is unavailable.' : codex.detail || 'Codex is not ready.')),
      peerCard('Google Antigravity', antigravityReady, allowedTargets.has('antigravity-local'), 'Frontend / UI', antiCapacity, antigravityReady ? 'Antigravity is ready for bounded Work Session tasks.' : (antigravity?.detail || 'Antigravity is not ready.'))
    );
    peers.append(peerGrid);
    content.append(peers);

    const chatOverride = el('input', { type: 'checkbox', checked: settings.allowChatOverride });
    const fallback = selectValue(settings.codexFallback || 'rwmcp-only', [['rwmcp-only', 'Return to RWMCP'], ['stop', 'Stop worker routing']]);
    const codexModel = el('input', { value: settings.codexModel || 'gpt-6-sol', placeholder: 'gpt-6-sol' });
    const antiModel = el('input', { value: settings.antigravityModel || '', placeholder: t('Provider configured model') });
    const codexAgentsEnabled = el('input', { type: 'checkbox', checked: settings.codexAgentsEnabled });
    const codexSkillsEnabled = el('input', { type: 'checkbox', checked: settings.codexSkillsEnabled });
    const maxSession = el('input', { type: 'number', min: '0', value: settings.maxCodexTasksPerSession ?? '' });
    const maxDay = el('input', { type: 'number', min: '0', value: settings.maxCodexTasksPerDay ?? '' });
    const brokerEnabled = el('input', { type: 'checkbox', checked: settings.codexAccountBroker?.enabled });
    const brokerMode = selectValue(settings.codexAccountBroker?.mode || 'native', [['native', 'Native'], ['cockpit-api-pool', 'Cockpit API pool']]);
    const sourceLabels = { 'owner-default': 'Owner default', 'work-session-override': 'ChatGPT Work Session override', 'fallback-latch': 'Automatic fallback' };
    const effective = status.effectiveMode || settings.defaultMode || 'rwmcp-only';

    const technical = section('Technical details', 'Advanced routing, provider, budget, override, and recovery controls. Normal use does not require changing these settings.', 'moon-page-full');
    const technicalDetails = el('details', { class: 'agent-advanced agent-technical-details' }, el('summary', { text: t('Show technical details') }));
    technicalDetails.append(
      el('div', { class: 'agent-technical-summary' },
        el('div', {}, el('span', { text: t('Source') }), el('strong', { text: t(sourceLabels[status.source] || text(status.source)) })),
        el('div', {}, el('span', { text: t('Selected mode') }), el('strong', { text: t(targetModeLabels[selectedTargetMode] || selectedTargetMode) })),
        el('div', {}, el('span', { text: t('Safety ceiling') }), el('strong', { text: t(text(effective)) })),
        el('div', {}, el('span', { text: t('Active overrides') }), el('strong', { text: text(status.activeSessionOverrides ?? 0) }))
      ),
      el('div', { class: 'moon-form-grid agent-advanced-grid' },
        field('Work Session override', chatOverride, 'Allows bounded per-session routing overrides when the owner enables this control.'),
        field('When AI targets are exhausted', fallback, 'Return to direct RWMCP or stop worker routing when allowed AI targets are exhausted.'),
        field('Codex model', codexModel), field('Antigravity model', antiModel),
        field('Enable Codex EAS agents', codexAgentsEnabled), field('Share Codex skills with RWMCP workers', codexSkillsEnabled),
        field('Max Codex tasks / session', maxSession, '0 means unlimited.'), field('Max Codex tasks / day', maxDay, '0 means unlimited.'),
        field('Enable account broker', brokerEnabled), field('Broker mode', brokerMode)
      ),
      el('div', { class: 'agent-danger-zone' },
        el('div', {}, el('strong', { text: t('Recovery actions') }), el('p', { class: 'moon-muted', text: t('Use these only when a fallback latch or stale Work Session override needs to be cleared.') })),
        actions(
          button('Reset fallback', async () => { await mutate('/api/execution-policy/fallback-reset', {}, ['execution'], 'Fallback reset.'); openExecution(); }),
          button('Clear overrides', async () => { if (!confirm(t('Clear all active execution overrides?'))) return; await mutate('/api/execution-policy/clear-overrides', {}, ['execution'], 'Overrides cleared.'); openExecution(); }, 'secondary-button danger-button')
        )
      )
    );
    technical.append(technicalDetails);
    content.append(technical);

    content.append(el('div', { class: 'agent-save-bar moon-page-full' },
      el('div', {}, el('strong', { text: t('AI routing') }), el('span', { text: t('Your simple choice controls future routing. Technical settings remain unchanged unless you edit them.') })),
      button('Save AI settings', async () => {
        if (!confirm(t('Save these AI routing settings?'))) return;
        const body = {
          targetMode: content.querySelector('input[name="execution-target-mode"]:checked')?.value || selectedTargetMode,
          codexModel: codexModel.value,
          codexAgentsEnabled: codexAgentsEnabled.checked,
          codexSkillsEnabled: codexSkillsEnabled.checked,
          antigravityModel: antiModel.value,
          allowChatOverride: chatOverride.checked,
          codexFallback: fallback.value,
          maxCodexTasksPerSession: maxSession.value === '' ? undefined : Number(maxSession.value),
          maxCodexTasksPerDay: maxDay.value === '' ? undefined : Number(maxDay.value),
          codexAccountBroker: { enabled: brokerEnabled.checked, mode: brokerMode.value }
        };
        const result = await mutate('/api/execution-policy', body, ['execution', 'antigravity'], 'AI routing settings saved.');
        if (result?.restartRequired) toast(t('Saved. Restart the managed runtime to activate provider-level changes.'));
        openExecution();
      }, 'primary-button')
    ));
    return content;
  }

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
