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

  function capabilityDomain(page, title, description, prefixes, emptyMessage, extraActions = []) {
    const content = pageRoot(page, title, description);
    unavailable('capabilities', content);
    const entries = capabilityEntries(prefixes);
    const summary = section('Capability groups', 'Capabilities are discovered from the running backend. Provider and implementation details stay below the domain layer.', 'moon-page-full');
    if (!entries.length) summary.append(emptyState(emptyMessage));
    for (const item of entries) {
      const tools = Array.isArray(item.tools) ? item.tools : [];
      summary.append(el('article', { class: 'moon-row' },
        el('div', { class: 'device-row-header' },
          el('strong', { text: text(item.id) }),
          el('span', { class: `pill ${item.status === 'available' ? 'success' : 'warning'}`, text: t(text(item.status || 'Unavailable')) })
        ),
        el('span', { text: t('{count} typed tools', { count: tools.length }) }),
        item.note && el('small', { class: 'moon-muted', text: text(item.note) })
      ));
    }
    if (extraActions.length) summary.append(actions(...extraActions));
    content.append(summary);
    return content;
  }

  function openWork() {
    return capabilityDomain(
      'Work',
      'Work',
      'Projects, Work Sessions, tasks, objectives, and artifacts belong here. Execution providers stay separate under Agents.',
      ['work_session.', 'project.', 'project_session_group.', 'work_objective.', 'task.', 'filesystem.', 'git.'],
      'No work-management capabilities are currently advertised by the backend.',
      [button('Open Execution Console', () => openExecutionConsole(), 'primary-button')]
    );
  }

  function openEngineering() {
    return capabilityDomain(
      'Engineering',
      'Engineering',
      'Hardware, firmware, debugging, ROS 2, containers, build diagnostics, and engineering workflows.',
      ['engineering.', 'build.diagnostics', 'code.semantic'],
      'No engineering capabilities are currently advertised by the backend.'
    );
  }

  function openOffice() {
    return capabilityDomain(
      'Office',
      'Office',
      'Word, Excel, and PowerPoint capabilities stay in one Office domain while OOXML and COM remain implementation details.',
      ['office.'],
      'No Office capabilities are currently advertised by the backend.'
    );
  }

  function openWeb() {
    return capabilityDomain(
      'Web',
      'Web',
      'Managed browsers, Existing Chrome, and site adapters such as NotebookLM belong to one web automation domain.',
      ['web.'],
      'No web automation capabilities are currently advertised by the backend.'
    );
  }

  function openSystem() {
    const content = pageRoot(
      'System',
      'System',
      'Runtime, updates, recovery, diagnostics, and local platform maintenance.'
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
    const content = pageRoot('Execution', 'Unified Three-Target Orchestrator', 'RWMCP, Codex, and Antigravity are peer execution targets at the routing layer. Task affinity sets preference; owner policy, readiness, and safe handoff rules decide fallback.');
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
      ? t('{remaining} / {limit} session tasks remaining', {
          remaining: Math.max(0, codexSessionLimit - codexSessionUsed),
          limit: codexSessionLimit
        })
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
      auto: 'Auto / Smart',
      'rwmcp-only': 'RWMCP only',
      'codex-only': 'Codex only',
      'antigravity-only': 'Antigravity only',
      'rwmcp-codex': 'RWMCP + Codex',
      'rwmcp-antigravity': 'RWMCP + Antigravity',
      'codex-antigravity': 'Codex + Antigravity',
      'all-three': 'All three'
    };
    const targetMembers = {
      auto: ['rwmcp-direct', 'codex-local', 'antigravity-local'],
      'rwmcp-only': ['rwmcp-direct'],
      'codex-only': ['codex-local'],
      'antigravity-only': ['antigravity-local'],
      'rwmcp-codex': ['rwmcp-direct', 'codex-local'],
      'rwmcp-antigravity': ['rwmcp-direct', 'antigravity-local'],
      'codex-antigravity': ['codex-local', 'antigravity-local'],
      'all-three': ['rwmcp-direct', 'codex-local', 'antigravity-local']
    };
    const allowedTargets = new Set(targetMembers[selectedTargetMode] || targetMembers.auto);
    const sourceLabels = { 'owner-default': 'Owner default', 'work-session-override': 'ChatGPT Work Session override', 'fallback-latch': 'Automatic fallback' };
    const effective = status.effectiveMode || settings.defaultMode || 'rwmcp-only';
    const routeText = status.fallbackActive
      ? 'The affected Work Session is latched to direct RWMCP after worker exhaustion; reset only after the provider issue is understood.'
      : 'Affinity selects a preferred peer target. A safe failure may hand off to the next allowed target; permissions and worktree ownership are never widened automatically.';

    const route = section('Global route', 'Owner target set plus the current safety ceiling. Work Session overrides can further change a session only when owner policy allows them.', 'moon-page-full agent-route-section');
    route.append(el('div', { class: 'agent-route-banner' },
      el('div', { class: 'agent-route-main' },
        el('span', { class: `pill ${status.fallbackActive ? 'warning' : 'success'}`, text: t(status.fallbackActive ? 'Fallback active' : 'Policy active') }),
        el('div', {}, el('strong', { text: t(targetModeLabels[selectedTargetMode] || selectedTargetMode) }), el('p', { text: t(routeText) }))
      ),
      el('div', { class: 'agent-route-meta' },
        el('span', { text: `${t('Source')}: ${t(sourceLabels[status.source] || text(status.source))}` }),
        el('span', { text: `${t('Execution target set')}: ${t(targetModeLabels[selectedTargetMode] || selectedTargetMode)}` }),
        el('span', { text: `${t('Safety ceiling')}: ${t(text(effective))}` }),
        el('span', { text: `${t('Chat overrides')}: ${settings.allowChatOverride ? t('Allowed') : t('Locked by owner')}` }),
        el('span', { text: `${t('Active overrides')}: ${text(status.activeSessionOverrides ?? 0)}` })
      )
    ));
    if (status.fallbackActive) route.append(el('p', { class: 'moon-warning', text: t('Fallback active: {reason}', { reason: text(status.fallbackReason) }) }));
    content.append(route);

    const affinity = section(
      'Task affinity & fallback',
      'All three targets are replaceable execution choices at the router layer. Affinity is preference, not a hard capability lock; safe handoff uses the next allowed target.',
      'moon-page-full'
    );
    const chainCard = (title, subtitle, steps) => el('article', { class: 'agent-affinity-card' },
      el('div', { class: 'agent-affinity-head' },
        el('strong', { text: t(title) }),
        el('span', { class: 'moon-muted', text: t(subtitle) })
      ),
      el('div', { class: 'agent-route-chain' },
        ...steps.flatMap((step, index) => [
          el('span', { class: `agent-route-step ${step.kind || ''}`, text: t(step.label) }),
          ...(index < steps.length - 1 ? [el('span', { class: 'agent-route-arrow', text: '?' })] : [])
        ])
      )
    );
    affinity.append(
      el('div', { class: 'agent-affinity-grid' },
        chainCard('Frontend / UI', 'Antigravity preferred', [
          { label: 'Antigravity', kind: 'preferred' },
          { label: 'Codex', kind: 'fallback-worker' },
          { label: 'RWMCP', kind: 'direct' }
        ]),
        chainCard('Backend / Code / Engineering', 'Codex preferred', [
          { label: 'Codex', kind: 'preferred' },
          { label: 'Antigravity', kind: 'fallback-worker' },
          { label: 'RWMCP', kind: 'direct' }
        ]),
        chainCard('Read / Workstation / Deterministic', 'RWMCP preferred', [
          { label: 'RWMCP', kind: 'preferred direct' },
          { label: 'Codex', kind: 'fallback-worker' },
          { label: 'Antigravity', kind: 'fallback-worker' }
        ])
      ),
      el('p', { class: 'moon-muted', text: t('Capacity, quota, authentication, and availability failures can hand off immediately. Ordinary AI failures may hand off only while isolated worktree ownership remains clean; dirty worktrees fail closed for review.') })
    );
    content.append(affinity);

    const targetSet = section('Execution target set', 'Choose which peer targets the router may use. Auto / Smart keeps all three available and applies task affinity automatically.', 'moon-page-full');
    const targetModes = [
      ['auto', 'Auto / Smart', 'All three targets are available. Affinity selects the preferred target and safe fallback order.'],
      ['rwmcp-only', 'RWMCP only', 'Deterministic typed workstation execution only.'],
      ['codex-only', 'Codex only', 'Bounded Codex worker execution only.'],
      ['antigravity-only', 'Antigravity only', 'Bounded Antigravity worker execution only.'],
      ['rwmcp-codex', 'RWMCP + Codex', 'Use deterministic RWMCP and Codex; Antigravity is excluded.'],
      ['rwmcp-antigravity', 'RWMCP + Antigravity', 'Use deterministic RWMCP and Antigravity; Codex is excluded.'],
      ['codex-antigravity', 'Codex + Antigravity', 'Use both AI workers; direct RWMCP is excluded from normal routing.'],
      ['all-three', 'All three', 'Explicitly allow RWMCP, Codex, and Antigravity together with affinity ordering.']
    ];
    const targetGrid = el('div', { class: 'agent-routing-grid' });
    const targetInputs = [];
    for (const [id, title, description] of targetModes) {
      const input = el('input', { type: 'radio', name: 'execution-target-mode', value: id, checked: id === selectedTargetMode });
      targetInputs.push(input);
      targetGrid.append(el('label', { class: `agent-strategy-card${id === selectedTargetMode ? ' selected' : ''}` }, input,
        el('div', {}, el('strong', { text: t(title) }), el('p', { text: t(description) }))
      ));
      input.addEventListener('change', () => targetGrid.querySelectorAll('.agent-strategy-card').forEach((card) => card.classList.toggle('selected', card.querySelector('input')?.checked)));
    }
    targetSet.append(targetGrid, el('p', { class: 'moon-muted', text: t('Target selection changes routing eligibility only. Each target keeps its own sandbox, permission, quota, and workstation security boundaries.') }));
    content.append(targetSet);

    const peers = section('Execution targets & capacity', 'RWMCP, Codex, and Antigravity are peers for routing selection, while their underlying execution mechanisms remain deliberately different.', 'moon-page-full');
    const peerGrid = el('div', { class: 'agent-provider-grid' });
    const peerCard = (kind, title, ready, enabled, facts, note) => el('article', { class: `agent-provider-card ${ready ? 'ready' : 'offline'}` },
      el('header', { class: 'agent-provider-header' },
        el('div', {}, el('span', { class: 'agent-provider-kicker', text: t(kind) }), el('h4', { text: title })),
        el('span', { class: `pill ${ready ? 'success' : 'warning'}`, text: t(ready ? 'Ready' : enabled ? 'Unavailable' : 'Excluded') })
      ),
      el('div', { class: 'agent-provider-facts' }, ...facts.filter(Boolean).map(([label, value]) => el('div', {}, el('span', { text: t(label) }), el('strong', { text: t(text(value)) })) )),
      el('p', { class: 'moon-muted', text: t(enabled ? note : 'Excluded by the selected execution target set.') })
    );
    peerGrid.append(
      peerCard('Deterministic peer ? workstation preferred', 'RWMCP Direct', true, allowedTargets.has('rwmcp-direct'), [
        ['Mechanism', 'Typed deterministic tools'],
        ['Preferred for', 'Read / workstation / Office / build / test'],
        ['Fallback', 'Codex ? Antigravity'],
        ['Authority', 'Authenticated workstation policy']
      ], 'RWMCP is always locally available as a deterministic execution mechanism when the target set permits it.'),
      peerCard('General-purpose AI ? engineering preferred', 'OpenAI Codex', codexReady, allowedTargets.has('codex-local'), [
        ['Version', codex.version],
        ['Model', settings.codexModel || 'gpt-6-sol'],
        ['Preferred for', 'Backend / code / engineering'],
        ['Capacity', codexCapacity],
        ['Fallback', 'Antigravity ? RWMCP'],
        ['Account routing', broker.effectiveBackend || broker.mode || settings.codexAccountBroker?.mode]
      ], codexReady ? 'Codex is ready for bounded general-purpose Work Session tasks.' : (broker.effectiveBackend === 'blocked' ? broker.pool?.detail || 'Account routing is unavailable.' : codex.detail || 'Codex is not ready.')),
      peerCard('General-purpose AI ? UI preferred', 'Google Antigravity', antigravityReady, allowedTargets.has('antigravity-local'), [
        ['Version', antigravity?.version],
        ['Model', antigravity?.model?.label || antigravity?.model?.id || settings.antigravityModel || 'Provider default'],
        ['Preferred for', 'Frontend / UI'],
        ['Capacity', antiCapacity],
        ['Fallback', 'Codex ? RWMCP'],
        ['Sandbox', antigravity?.available ? 'Required' : 'Unavailable']
      ], antigravityReady ? 'Antigravity is ready for bounded general-purpose Work Session tasks.' : (antigravity?.detail || 'Antigravity is not ready.'))
    );
    peers.append(peerGrid);
    content.append(peers);

    const chatOverride = el('input', { type: 'checkbox', checked: settings.allowChatOverride });
    const fallback = selectValue(settings.codexFallback || 'rwmcp-only', [['rwmcp-only', 'Return to RWMCP'], ['stop', 'Stop worker routing']]);
    const behavior = section('Fallback behavior', 'Session override and legacy fallback-latch controls remain safety mechanisms; they never grant unavailable provider authority.', 'moon-page-full');
    behavior.append(el('div', { class: 'agent-behavior-grid' },
      field('Work Session override', chatOverride, 'Allows bounded per-session routing overrides when the owner enables this control.'),
      field('When AI targets are exhausted', fallback, 'RWMCP fallback latches only the affected Work Session after allowed AI targets are exhausted; Stop leaves the task blocked.')
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
      el('div', {}, el('strong', { text: t('Owner policy') }), el('span', { text: t('Target-set changes affect future routing; provider enablement is derived by the runtime to avoid contradictory states.') })),
      button('Save Agent Control', async () => {
        if (!confirm(t('Save this execution policy?'))) return;
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
