import { t } from './i18n.js';
import { button, el, field, section, selectValue, text } from './view-primitives.js';

export function createExecutionView({ live, pageRoot, unavailable, mutate, actions }) {
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
    const executionExperience = policy.executionExperience || {};
    const timelineExperience = executionExperience.timeline || {};
    const cancellationExperience = executionExperience.cancellation || {};
    const cancellableProviders = new Set(cancellationExperience.providerIds || []);
    const stageTimelineAvailable = timelineExperience.tool === 'work_objective_execution_timeline';
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
    const peerCard = (title, ready, enabled, preference, capacity, note, badges = []) => {
      const stateText = !enabled ? 'Not selected' : ready ? 'Ready' : 'Unavailable';
      const tone = !enabled ? 'muted' : ready ? 'success' : 'warning';
      const capabilityRow = el('div', { class: 'agent-provider-capabilities' },
        ...badges.map((badge) => el('span', { class: 'agent-capability-badge', text: t(badge) }))
      );
      return el('article', { class: `agent-provider-card ${ready && enabled ? 'ready' : 'offline'}` },
        el('header', { class: 'agent-provider-header' }, el('div', {}, el('span', { class: 'agent-provider-kicker', text: t('Execution target') }), el('h4', { text: title })), el('span', { class: `pill ${tone}`, text: t(stateText) })),
        capabilityRow,
        el('div', { class: 'agent-provider-facts agent-simple-facts' },
          el('div', {}, el('span', { text: t('Best for') }), el('strong', { text: t(preference) })),
          el('div', {}, el('span', { text: t('Capacity') }), el('strong', { text: t(text(capacity)) }))
        ),
        el('p', { class: 'moon-muted', text: t(note) })
      );
    };
    const workerBadges = (providerId) => [
      ...(cancellableProviders.has(providerId) ? ['Safe cancel'] : []),
      ...(stageTimelineAvailable ? ['Stage timeline'] : [])
    ];
    peerGrid.append(
      peerCard('RWMCP Direct', true, allowedTargets.has('rwmcp-direct'), 'Workstation / Office / deterministic work', 'Local', 'Direct typed workstation execution. Always local when the selected mode allows it.', ['Deterministic', 'Direct']),
      peerCard('OpenAI Codex', codexReady, allowedTargets.has('codex-local'), 'Code / backend / engineering', codexCapacity, codexReady ? 'Codex is ready for bounded Work Session tasks.' : (broker.effectiveBackend === 'blocked' ? broker.pool?.detail || 'Account routing is unavailable.' : codex.detail || 'Codex is not ready.'), workerBadges('codex-local')),
      peerCard('Google Antigravity', antigravityReady, allowedTargets.has('antigravity-local'), 'Frontend / UI', antiCapacity, antigravityReady ? 'Antigravity is ready for bounded Work Session tasks.' : (antigravity?.detail || 'Antigravity is not ready.'), workerBadges('antigravity-local'))
    );
    peers.append(peerGrid);
    content.append(peers);
  
    const activity = section(
      'Agent activity & control',
      'Execution evidence is stage-based and mechanically derived. The system does not invent percentage progress for AI workers.',
      'moon-page-full agent-activity-section'
    );
    const stageLabels = ['Started', 'Current target', 'Fallback / result', 'Final outcome'];
    const stageFlow = el('div', { class: 'agent-stage-flow' },
      ...stageLabels.flatMap((label, index) => [
        el('div', { class: 'agent-stage-node' },
          el('span', { class: 'agent-stage-index', text: String(index + 1) }),
          el('strong', { text: t(label) })
        ),
        ...(index < stageLabels.length - 1 ? [el('span', { class: 'agent-stage-arrow', text: '?' })] : [])
      ])
    );
    const safeCancelEnabled = cancellableProviders.has('codex-local') || cancellableProviders.has('antigravity-local');
    const activityCards = el('div', { class: 'agent-activity-grid' },
      el('article', { class: 'agent-activity-card' },
        el('div', { class: 'agent-activity-card-head' },
          el('span', { class: `pill ${safeCancelEnabled ? 'success' : 'muted'}`, text: t(safeCancelEnabled ? 'Safe cancel' : 'Legacy runtime') }),
          el('strong', { text: t('Stop a running AI task safely') })
        ),
        el('p', { text: t(safeCancelEnabled
          ? 'Codex and Antigravity can receive a cancellation request that aborts the active provider process tree. The final task state is recorded only after the provider exits.'
          : 'This runtime does not advertise cancellable AI worker dispatches yet.') })
      ),
      el('article', { class: 'agent-activity-card' },
        el('div', { class: 'agent-activity-card-head' },
          el('span', { class: `pill ${stageTimelineAvailable ? 'success' : 'muted'}`, text: t(stageTimelineAvailable ? 'Stage timeline' : 'Legacy runtime') }),
          el('strong', { text: t('See what target actually handled the task') })
        ),
        el('p', { text: t(stageTimelineAvailable
          ? 'The durable timeline records the planned target, current provider, safe fallback evidence, cancellation requests, and the final outcome without fake percentages.'
          : 'Detailed execution timeline metadata is not available on this runtime.') })
      )
    );
    const ownershipNote = el('div', { class: 'agent-activity-boundary' },
      el('span', { class: 'agent-preference-icon' }, el('i', { 'data-lucide': 'shield-check' })),
      el('div', {},
        el('strong', { text: t('Work Session privacy boundary') }),
        el('p', { text: t(stageTimelineAvailable
          ? 'Detailed per-task execution history stays inside the caller-owned ChatGPT Work Session. Use work_objective_execution_timeline there; the owner-local Control Center intentionally does not expose another session?s timeline.'
          : 'Detailed Work Session execution history remains scoped to the caller that owns that session.') })
      )
    );
    activity.append(stageFlow, activityCards, ownershipNote);
    content.append(activity);
  
    const chatOverride = el('input', { type: 'checkbox', checked: settings.allowChatOverride });
    const fallback = selectValue(settings.targetPolicy?.fallback || (settings.codexFallback === 'stop' ? 'stop' : 'rwmcp-direct'), [['rwmcp-direct', 'Return to RWMCP'], ['stop', 'Stop worker routing']]);
    const codexModel = el('input', { value: settings.codexModel || 'gpt-6-sol', placeholder: 'gpt-6-sol' });
    const antiModel = el('input', { value: settings.antigravityModel || '', placeholder: t('Provider configured model') });
    const codexAgentsEnabled = el('input', { type: 'checkbox', checked: settings.codexAgentsEnabled });
    const codexSkillsEnabled = el('input', { type: 'checkbox', checked: settings.codexSkillsEnabled });
    const codexBudget = settings.targetPolicy?.budgets?.['codex-local'] || {};
    const antiBudget = settings.targetPolicy?.budgets?.['antigravity-local'] || {};
    const maxSession = el('input', { type: 'number', min: '0', value: codexBudget.maxTasksPerSession ?? settings.maxCodexTasksPerSession ?? '' });
    const maxDay = el('input', { type: 'number', min: '0', value: codexBudget.maxTasksPerDay ?? settings.maxCodexTasksPerDay ?? '' });
    const antiMaxSession = el('input', { type: 'number', min: '0', value: antiBudget.maxTasksPerSession ?? '' });
    const antiMaxDay = el('input', { type: 'number', min: '0', value: antiBudget.maxTasksPerDay ?? '' });
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
        field('Max Antigravity tasks / session', antiMaxSession, '0 means unlimited.'), field('Max Antigravity tasks / day', antiMaxDay, '0 means unlimited.'),
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
          targetPolicy: {
            fallback: fallback.value,
            budgets: {
              'codex-local': {
                maxTasksPerSession: maxSession.value === '' ? 0 : Number(maxSession.value),
                maxTasksPerDay: maxDay.value === '' ? 0 : Number(maxDay.value)
              },
              'antigravity-local': {
                maxTasksPerSession: antiMaxSession.value === '' ? 0 : Number(antiMaxSession.value),
                maxTasksPerDay: antiMaxDay.value === '' ? 0 : Number(antiMaxDay.value)
              }
            }
          },
          // v0.41 compatibility projection retained for one release line.
          codexFallback: fallback.value === 'stop' ? 'stop' : 'rwmcp-only',
          maxCodexTasksPerSession: maxSession.value === '' ? 0 : Number(maxSession.value),
          maxCodexTasksPerDay: maxDay.value === '' ? 0 : Number(maxDay.value),
          codexAccountBroker: { enabled: brokerEnabled.checked, mode: brokerMode.value }
        };
        const result = await mutate('/api/execution-policy', body, ['execution', 'antigravity'], 'AI routing settings saved.');
        if (result?.restartRequired) toast(t('Saved. Restart the managed runtime to activate provider-level changes.'));
        openExecution();
      }, 'primary-button')
    ));
    return content;
  }

  return { openExecution };
}
