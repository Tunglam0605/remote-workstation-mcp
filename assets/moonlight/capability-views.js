import { t } from './i18n.js';
import { button, el, emptyState, section, text } from './view-primitives.js';

export function createCapabilityViews({ live, pageRoot, unavailable, actions, openExecutionConsole }) {
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
    const content = capabilityDomain(
      'Work',
      'Work & projects',
      'Create or resume Work Sessions, inspect files and Git, and run permitted project tasks from one place.',
      ['work_session.', 'project.', 'project_session_group.', 'work_objective.', 'task.', 'filesystem.', 'git.'],
      'No work-management capabilities are currently advertised by the backend.',
      [button('Open Execution Console', () => openExecutionConsole(), 'primary-button')]
    );

    const flow = section(
      'Multi-agent objective flow',
      'A large objective can be decomposed into a bounded dependency graph, routed to the right execution target, and advanced one scheduler-safe wave at a time.',
      'moon-page-full work-orchestration-section'
    );
    const steps = [
      ['01', 'Objective', 'ChatGPT defines the goal and acceptance boundary.'],
      ['02', 'Decompose', 'The plan is persisted atomically as a DAG.'],
      ['03', 'DAG tasks', 'Dependencies decide what becomes ready next.'],
      ['04', 'Route', 'Policy and task affinity choose an allowed target.'],
      ['05', 'Execute wave', 'Only one bounded ready wave runs per call.'],
      ['06', 'Acceptance', 'ChatGPT reviews evidence before continuing.']
    ];
    const flowTrack = el('div', { class: 'work-objective-flow' });
    steps.forEach(([index, title, note], position) => {
      flowTrack.append(el('div', { class: 'work-objective-step' },
        el('span', { class: 'work-objective-index', text: index }),
        el('div', {}, el('strong', { text: t(title) }), el('small', { text: t(note) }))
      ));
      if (position < steps.length - 1) flowTrack.append(el('span', { class: 'work-objective-arrow', text: '→' }));
    });
    flow.append(flowTrack);

    const guarantees = el('div', { class: 'work-objective-guarantees' });
    for (const [title, note] of [
      ['Atomic DAG', 'Invalid keys, dependencies, cycles, or target policy reject the whole decomposition without partial tasks.'],
      ['Policy-aware routing', 'Frontend/UI prefers Antigravity, coding/debug prefers Codex, and deterministic typed work stays with RWMCP.'],
      ['Bounded wave', 'One execute-wave call never loops the objective to completion, so acceptance remains between waves.'],
      ['Worktree safe', 'AI workers sharing one Work Session worktree are serialized; compatible deterministic work may run in parallel.']
    ]) {
      guarantees.append(el('article', { class: 'work-objective-guarantee' },
        el('strong', { text: t(title) }),
        el('p', { text: t(note) })
      ));
    }
    flow.append(guarantees);

    const routing = el('div', { class: 'work-objective-routing' },
      el('article', { class: 'work-target-card' },
        el('span', { class: 'pill info', text: 'Antigravity' }),
        el('strong', { text: t('Interface & visual work') }),
        el('p', { text: t('Preferred for frontend and visual UX tasks when the effective policy allows it.') })
      ),
      el('article', { class: 'work-target-card' },
        el('span', { class: 'pill info', text: 'Codex' }),
        el('strong', { text: t('Code & debugging') }),
        el('p', { text: t('Preferred for backend, implementation, review, debugging, and engineering code work.') })
      ),
      el('article', { class: 'work-target-card' },
        el('span', { class: 'pill success', text: 'RWMCP' }),
        el('strong', { text: t('Deterministic execution') }),
        el('p', { text: t('Typed workstation, build, test, Office, and engineering workflows remain deterministic and policy-gated.') })
      )
    );
    flow.append(routing);

    flow.append(el('div', { class: 'work-objective-boundary' },
      el('strong', { text: t('Work Session privacy boundary') }),
      el('p', { text: t('Detailed objective, task, route, attempt, and timeline state stays inside the caller-owned ChatGPT Work Session. The owner-local Control Center explains the orchestration model without exposing another session’s task data.') })
    ));

    flow.append(el('details', { class: 'agent-advanced work-objective-technical' },
      el('summary', { text: t('Technical details') }),
      el('div', { class: 'work-objective-tool-grid' },
        el('code', { text: 'work_objective_decompose' }),
        el('code', { text: 'work_objective_execute_wave' }),
        el('code', { text: 'work_objective_schedule' }),
        el('code', { text: 'work_objective_execution_timeline' })
      )
    ));
    content.append(flow);
    return content;
  }

  function openEngineering() {
    return capabilityDomain('Engineering', 'Engineering tools', 'Build, flash, debug, inspect hardware, work with ROS 2, and run typed engineering diagnostics.', ['engineering.', 'build.diagnostics', 'code.semantic'], 'No engineering capabilities are currently advertised by the backend.');
  }

  function openOffice() {
    return capabilityDomain('Office', 'Office tools', 'Inspect and edit Word, Excel, and PowerPoint files with safe typed operations.', ['office.'], 'No Office capabilities are currently advertised by the backend.');
  }

  function openWeb() {
    return capabilityDomain('Web', 'Web & NotebookLM', 'Use managed browser sessions and supported web workflows such as NotebookLM from one place.', ['web.'], 'No web automation capabilities are currently advertised by the backend.');
  }

  return { openWork, openEngineering, openOffice, openWeb };
}
