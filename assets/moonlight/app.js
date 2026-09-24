import { createApi } from '/assets/moonlight/api.js';
import { createStore } from '/assets/moonlight/store.js';
import { deriveActivities, deriveCards, deriveMetrics, deriveNotifications } from '/assets/moonlight/model.js';
import { createViews } from '/assets/moonlight/views.js';
import { NAVIGATION, canonicalPage, pageFromHash, routeForPage } from '/assets/moonlight/navigation.js';
import { createThemeController } from '/assets/moonlight/themes.js';
import { getLanguage, onLanguageChange, registerTranslations, setLanguage, t } from '/assets/moonlight/i18n.js';
import translations from '/assets/moonlight/translations-shell.js';
import { CONTROL_CENTER_TIME_ZONE, greetingSource } from '/assets/moonlight/time.js';

registerTranslations(translations);

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const tokenMeta = $('meta[name="rwmcp-setup-token"]');
const token = tokenMeta?.content;
tokenMeta?.remove();
const usableToken = token && token !== '__RWMCP_SETUP_TOKEN__' ? token : null;
const readKey = 'moonlight-read-notifications';
let toastTimer;
let executionContext = null;
let executionPending = false;
let greetingSignature = '';

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value == null) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = String(value);
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, String(value));
  }
  for (const child of children.flat()) if (child != null) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  return node;
}

function icon(name) { return element('i', { 'data-lucide': name }); }
function paintIcons() { globalThis.lucide?.createIcons?.(); }
function renderNavigation() {
  const root = $('#main-nav');
  root.replaceChildren();
  for (const item of NAVIGATION) {
    const button = element('button', {
      class: `nav-item${item.id === activePage ? ' active' : ''}`,
      type: 'button',
      'data-page': item.id,
      'data-route': item.route,
      title: item.children?.length ? item.children.map((child) => tr(child)).join(' · ') : tr(item.label),
      onclick: () => navigate(item.id)
    }, icon(item.icon), element('span', { text: tr(item.label) }));
    if (item.id === 'System') button.append(element('span', { class: 'badge', hidden: '' }));
    root.append(button);
  }
  paintIcons();
}
function renderGreeting(now = new Date()) {
  const source = greetingSource(now);
  const signature = `${getLanguage()}:${source}`;
  if (signature === greetingSignature) return;
  greetingSignature = signature;
  $('.greeting h1').replaceChildren(
    document.createTextNode(`${tr(source)} `),
    element('span', { text: tr('Engineer!') })
  );
}
function text(value) { return value == null || value === '' ? '—' : String(value); }
const tr = (source, params) => t(source, params);
function readIds() { try { return new Set(JSON.parse(localStorage.getItem(readKey) || '[]')); } catch { return new Set(); } }
function saveRead(ids) { try { localStorage.setItem(readKey, JSON.stringify([...ids])); } catch {} }
function toast(message) { const node = $('#toast'); node.textContent = message; node.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.hidden = true; }, 3400); }

const unavailableResources = () => Object.fromEntries(['status', 'capabilities', 'runtime', 'execution', 'antigravity', 'pairing', 'multiNode', 'permissions', 'updates', 'admin', 'console'].map((key) => [key, { data: null, error: new Error('Setup token unavailable'), loading: false, loadedAt: null }]));
const api = usableToken ? createApi(usableToken) : null;
const store = api ? createStore(api, { consolePath: '/api/execution' }) : { getState: unavailableResources, subscribe: () => () => {}, refresh: async () => {}, start: () => {}, stop: () => {} };

const modal = $('#modal');
modal.setAttribute('aria-labelledby', 'modal-title');
function openModal(title, content) {
  modal.classList.remove('theme-dialog');
  $('#modal-title').textContent = title;
  const root = $('#modal-content');
  root.replaceChildren();
  if (typeof content === 'string') root.textContent = content;
  else if (content) root.append(content);
  paintIcons();
  if (!modal.open) modal.showModal();
  return root;
}

function closeMenu() { document.body.classList.remove('menu-open'); $('#menu-toggle').setAttribute('aria-expanded', 'false'); $('#scrim').hidden = true; }

let activePage = 'Overview';
function openPage(page, title, content) {
  activePage = canonicalPage(page);
  $('#overview').hidden = true;
  const outlet = $('#page-outlet'); outlet.hidden = false; outlet.replaceChildren(content);
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === activePage));
  return content;
}
function showOverview() {
  activePage = 'Overview';
  $('#page-outlet').hidden = true;
  $('#overview').hidden = false;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === 'Overview'));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  $('#search').value = '';
  searchCards();
}
function navigate(page, { updateHash = true } = {}) {
  const requested = page || 'Overview';
  const target = canonicalPage(requested);
  closeMenu();
  if (target === 'Overview') showOverview();
  else views.open(requested);
  if (updateHash) {
    const hash = `#${routeForPage(target)}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }
}
const views = createViews({ api: api ?? { request: async () => { throw new Error('Setup token unavailable'); } }, store, openModal, openPage, openExecutionConsole: openConsoleSelection, toast, refresh: (keys) => store.refresh(keys) });
const themes = createThemeController({ openModal, toast });

function spec(card, label) { return card.specs.find((item) => item.label === label)?.value; }
function imageLogo(className, source) { return element('span', { class: `device-logo ${className}` }, element('img', { alt: '', src: source })); }
function logo(card) {
  if (card.id === 'codex') return imageLogo('codex-logo', '/assets/moonlight/assets/openai.svg');
  if (card.id === 'antigravity') return element('span', { class: 'device-logo antigravity-logo', text: 'Λ' });
  if (card.type === 'Host') {
    const platform = spec(card, 'Platform');
    if (/linux|ubuntu/i.test(platform)) return imageLogo('ubuntu-logo', '/assets/moonlight/assets/ubuntu.svg');
    if (!/win/i.test(platform)) return element('span', { class: 'device-logo' }, icon('monitor'));
    const logo = element('span', { class: 'device-logo' });
    const windows = element('span', { class: 'windows-logo' });
    for (let index = 0; index < 4; index += 1) windows.append(element('i'));
    logo.append(windows); return logo;
  }
  if (card.type === 'Health') return element('span', { class: 'device-logo health-logo' }, icon('activity'));
  if (card.type === 'Paired node' && /linux|ubuntu/i.test(spec(card, 'Platform'))) return imageLogo('ubuntu-logo', '/assets/moonlight/assets/ubuntu.svg');
  return element('span', { class: 'device-logo' }, icon('monitor'));
}

function renderCards(cards) {
  const root = $('#devices'); root.replaceChildren();
  for (const card of cards) {
    const button = element('button', { class: 'device-card', type: 'button', 'data-card-id': card.id, 'aria-label': tr('View {name} details', { name: text(card.name) }), onclick: () => views.openDevice(card) });
    const status = element('span', { class: `status ${card.tone}`, text: tr(card.status), title: tr(card.status) });
    if (card.tone === 'success') status.prepend(element('span', { class: 'tiny-dot' }));
    const title = element('div', {}, element('h2', { text: card.name, title: card.name }), status);
    button.append(element('div', { class: 'device-head' }, logo(card), title), element('div', { class: 'device-description' }, element('span', { text: tr(card.description), title: tr(card.description) }), icon('chevron-right')));
    const specs = element('div', { class: 'specs' });
    for (const item of card.specs) specs.append(element('div', { class: 'spec-row' }, icon(item.icon), element('span', { text: tr(item.label), title: tr(item.label) }), element('span', { class: 'value', text: item.value, title: item.value })));
    button.append(specs); root.append(button);
  }
  searchCards(); paintIcons();
}

function renderMetrics(metrics, resources) {
  const root = $('#metrics'); root.replaceChildren();
  for (const metric of metrics) root.append(element('div', {}, element('strong', { text: metric.value }), element('span', { text: tr(metric.label) })));
  const mode = resources.execution?.data?.status?.effectiveMode ?? resources.execution?.data?.settings?.defaultMode;
  $('#execution-mode').textContent = text(mode);
}

function activityTime(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp); return Number.isNaN(date.getTime()) ? text(timestamp) : new Intl.DateTimeFormat(getLanguage() === 'vi' ? 'vi-VN' : 'en-GB', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function renderActivities(activities) {
  const root = $('#activities'); root.replaceChildren();
  if (!activities.length) root.append(element('p', { class: 'moon-muted', text: tr('No recent backend activity.') }));
  for (const activity of activities.slice(0, 4)) {
    const description = tr(activity.type === 'admin' ? 'Admin request {state}' : 'Update transaction {state}', { state: tr(text(activity.state)) });
    root.append(element('div', { class: 'activity-row' }, element('span', { class: 'dot' }), element('span', { class: 'time', text: activityTime(activity.timestamp) }), element('span', { class: 'activity-device' }, icon(activity.type === 'admin' ? 'shield-check' : 'activity'), element('span', { text: tr(text(activity.type)) })), element('span', { class: 'complete', text: tr(text(activity.state)) }), element('span', { class: 'description', text: description, title: description }), element('span', { class: 'duration', text: '—' })));
  }
  paintIcons();
}

function renderNotifications(notifications) {
  const root = $('#messages'); root.replaceChildren();
  if (!notifications.length) root.append(element('p', { class: 'moon-muted', text: tr('No current system messages.') }));
  for (const notice of notifications.slice(0, 5)) {
    const level = notice.level === 'error' ? 'warning' : notice.level;
    root.append(element('div', { class: `message-row ${level}` }, element('span', { class: 'dot' }), element('span', { text: tr(notice.read ? 'Read' : 'Now') }), element('span', { class: `pill ${level}`, text: tr(text(notice.level)) }), element('span', { class: 'message-text', text: tr(notice.title), title: notice.description })));
  }
  const unread = notifications.filter((notice) => !notice.read).length;
  const badge = $('.notification-button .badge'); badge.textContent = String(unread); badge.hidden = unread === 0;
  $('#notifications').setAttribute('aria-label', tr('Notifications, {count} unread', { count: unread }));
}

function renderConsole(resources) {
  const catalogue = resources.console?.data;
  const status = $('#console-status');
  const available = Boolean(catalogue?.operations?.includes('session-create'));
  const source = available ? 'Ready' : resources.console?.loading ? 'Loading' : 'Unavailable';
  $('#console-status-text').dataset.source = source; $('#console-status-text').textContent = tr(source);
  status.className = `pill ${available ? 'ready success' : resources.console?.loading ? 'warning' : 'muted'}`;
  const quick = $('#quick-commands'); quick.replaceChildren();
  if (!available) quick.append(element('span', { text: tr(resources.console?.loading ? 'Loading execution catalogue…' : 'Execution catalogue unavailable.') }));
  else {
    quick.append(element('span', { text: tr('Permitted operations:') }), element('button', { type: 'button', text: tr('Choose operation'), onclick: openConsoleSelection }), element('button', { type: 'button', text: tr('Git status'), onclick: openConsoleSelection }));
  }
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts.slice(0, 2).map((part) => part[0]).join('').toUpperCase() : '—';
}

function renderIdentity(resources) {
  const status = resources.status?.data;
  const identity = status?.identity;
  const name = identity?.name ?? status?.recommendedAppName;
  const profile = $('#profile'); profile.textContent = initials(name); profile.setAttribute('aria-label', name ? tr('{name} profile', { name }) : tr('Local Control Center profile'));
  const footer = $('#sidebar-status'); footer.replaceChildren();
  if (status?.version || name) {
    footer.append(element('span', { text: text(status.version) }), element('span', { class: 'tiny-dot' }), element('span', { text: text(name) }));
  }
}

function render() {
  const resources = store.getState();
  const cards = deriveCards(resources);
  const notices = deriveNotifications(resources, readIds());
  renderCards(cards); renderMetrics(deriveMetrics(resources), resources); renderActivities(deriveActivities(resources)); renderNotifications(notices); renderConsole(resources); renderIdentity(resources);
}

function localizeShell() {
  document.documentElement.lang = getLanguage();
  $$('.nav-item').forEach((item) => { const span = $('span', item); if (span) span.textContent = tr(item.dataset.page); const nav = NAVIGATION.find((entry) => entry.id === item.dataset.page); if (nav) item.title = nav.children?.length ? nav.children.map((child) => tr(child)).join(' · ') : tr(nav.label); });
  $('#language-toggle').textContent = getLanguage() === 'vi' ? 'EN' : 'VI'; $('#language-toggle').setAttribute('aria-label', tr('Language'));
  $('#search').placeholder = tr('Search workstations, devices, commands…'); $('#search').setAttribute('aria-label', tr('Search workstations, devices, commands…'));
  $('#no-results').textContent = tr('No matching workstations. Try “Ubuntu” or “Windows”.');
  $$('.shell-copy').forEach((node) => { node.textContent = tr(node.dataset.source || node.textContent); });
  $$('[data-shell-aria-label]').forEach((node) => node.setAttribute('aria-label', tr(node.dataset.shellAriaLabel)));
  $$('[data-shell-placeholder]').forEach((node) => node.setAttribute('placeholder', tr(node.dataset.shellPlaceholder)));
  $('#menu-toggle').setAttribute('aria-label', tr('Toggle navigation')); $('#scrim').setAttribute('aria-label', tr('Close navigation'));
  $('.sidebar nav').setAttribute('aria-label', tr('Main navigation')); $('.side-brand small').textContent = tr('Always Within Reach'); $('#sidebar-status').setAttribute('aria-label', tr('Live local Control Center'));
  $('#appearance').setAttribute('aria-label', tr('Appearance settings')); $('#close-modal').setAttribute('aria-label', tr('Close dialog'));
  const location = $('.location'); if (location.lastChild) location.lastChild.textContent = ` ${tr('Hanoi, Vietnam')}`;
  const leadingText = (selector, source) => { const node = $(selector); const child = [...node.childNodes].find((item) => item.nodeType === Node.TEXT_NODE); if (child) child.textContent = tr(source); else node.textContent = tr(source); };
  leadingText('.console-panel .panel-heading h2', 'Execution Console'); $('.console-panel .panel-heading p').textContent = tr('Choose a backend-permitted operation for a selected node');
  $('.console-panel .sr-only').textContent = tr('Selected permitted operation'); $('#command').setAttribute('placeholder', tr('Select a permitted operation…')); $('.run-button').setAttribute('aria-label', tr('Choose a permitted operation'));
  leadingText('.mode-panel .panel-heading h2', 'Execution Mode'); $('.mode-panel .panel-heading p').textContent = tr('Live execution policy from the local Control Center');
  $('.activities-panel .panel-heading h2').textContent = tr('Recent Activities'); $('.activities-panel .panel-heading p').textContent = tr('Latest activity across all workstations'); leadingText('#all-activities', 'View all');
  $('.messages-panel .panel-heading h2').textContent = tr('System Messages'); leadingText('#all-messages', 'View all'); $('.page-footer > span:first-child').textContent = tr('Connected to your possibilities');
  $('#console-status-text').textContent = tr($('#console-status-text').dataset.source || 'Unavailable');
  $('.greeting>p').textContent = tr('Welcome back,'); renderGreeting(); $('.greeting .subtitle').textContent = tr('Your remote workstations. Always within reach.');
  $$('#countdown small').forEach((node, index) => { node.textContent = tr(['DAYS', 'HOURS', 'MINUTES', 'SECONDS'][index]); });
  if (activePage !== 'Overview') views.open(activePage); else render();
}

function searchCards() {
  const query = $('#search').value.trim().toLowerCase(); let visible = 0;
  for (const card of $$('.device-card')) { const matches = !query || card.textContent.toLowerCase().includes(query); card.hidden = !matches; if (matches) visible += 1; }
  $('#no-results').hidden = visible > 0;
}

function openConsoleSelection() {
  const catalogue = store.getState().console;
  const content = element('div', { class: 'moon-view' });
  if (catalogue.loading && !catalogue.data) content.append(element('p', { class: 'moon-muted', text: tr('Loading the permitted execution catalogue…') }));
  else if (catalogue.error || !catalogue.data) content.append(element('p', { class: 'moon-error', text: tr('Execution catalogue unavailable: {message}', { message: text(catalogue.error?.message) }) }), element('div', { class: 'modal-actions' }, element('button', { type: 'button', class: 'secondary-button', text: tr('Retry'), onclick: async () => { await store.refresh(['console']); openConsoleSelection(); } })));
  else renderExecutionSelection(content, catalogue.data);
  openModal(tr('Execution Console'), content);
}

function chosenOption(select, values, key = 'id') { return values.find((value) => value[key] === select.value) ?? values[0]; }
function renderExecutionSelection(content, catalogue) {
  const node = catalogue.node ?? {};
  const workspaces = Array.isArray(catalogue.workspaces) ? catalogue.workspaces : [];
  const tasks = Array.isArray(catalogue.tasks) ? catalogue.tasks : [];
  const sessions = Array.isArray(catalogue.sessions) ? catalogue.sessions : [];
  if (!workspaces.length || !catalogue.operations?.includes('session-create')) {
    content.append(element('p', { class: 'moon-muted', text: tr('The backend did not expose a runnable workspace and task catalogue.') })); return;
  }
  const workspace = element('select', { 'aria-label': tr('Workspace') }); for (const item of workspaces) workspace.append(element('option', { value: item.id, text: `${text(item.name)}${item.readOnly ? ` ${tr('(read only)')}` : ''}` }));
  const project = element('select', { 'aria-label': tr('Project') });
  const projectChoices = (item) => Array.isArray(item.projectPaths) ? item.projectPaths.map((path) => ({ id: path, label: path })) : [];
  const refreshProjects = () => { const selected = chosenOption(workspace, workspaces); project.replaceChildren(); for (const entry of projectChoices(selected)) project.append(element('option', { value: entry.id, text: entry.label })); if (executionContext?.session?.capsule?.project?.workspace === selected.id && executionContext.session.capsule.project.projectPath) project.value = executionContext.session.capsule.project.projectPath; };
  const sessionWorkspace = executionContext?.session?.capsule?.project?.workspace;
  if (sessionWorkspace && workspaces.some((item) => item.id === sessionWorkspace)) workspace.value = sessionWorkspace;
  workspace.addEventListener('change', refreshProjects); refreshProjects();
  const task = element('select', { 'aria-label': tr('Permitted task') }); for (const item of tasks) task.append(element('option', { value: item.name, text: item.name }));
  const session = element('select', { 'aria-label': tr('Session') });
  session.append(element('option', { value: '', text: tr('Create or select a session') }));
  const sessionChoices = executionContext?.session && !sessions.some((item) => item.id === executionContext.session.id) ? [executionContext.session, ...sessions] : sessions;
  for (const item of sessionChoices) session.append(element('option', { value: item.id, text: item.id }));
  if (executionContext?.session?.id) session.value = executionContext.session.id;
  session.addEventListener('change', () => {
    const existing = sessionChoices.find((item) => item.id === session.value);
    executionContext = existing ? { catalogue, session: existing, process: null, cursors: {} } : null;
    $('#command').value = existing ? tr('Session selected · choose a permitted task') : '';
    openConsoleSelection();
  });
  const note = element('p', { class: 'moon-muted', text: tr('Only the local node, backend-listed workspace, and backend-listed task profile can be selected.') });
  const create = element('button', { type: 'button', class: 'secondary-button', text: tr('Create session'), disabled: executionPending ? '' : null, onclick: async () => {
    if (executionPending) return;
    executionPending = true; create.disabled = true;
    const selected = chosenOption(workspace, workspaces);
    try {
      const selectedProject = chosenOption(project, projectChoices(selected));
      if (!selectedProject) { toast(tr('The backend did not expose a selectable project path.')); return; }
      const result = await api.request('/api/execution', { method: 'POST', body: { op: 'session-create', nodeId: node.id, workspace: selected.id, projectPath: selectedProject.id } });
      executionContext = { catalogue, workspace: selected, session: result.session, process: null, cursors: {}, output: '' };
      $('#command').value = tr('Session created · choose a permitted task');
      await store.refresh(['console']); executionPending = false; toast(tr('Execution session created.')); openConsoleSelection();
    } catch (error) { toast(error.message || String(error)); } finally { executionPending = false; create.disabled = false; }
  } });
  const run = element('button', { type: 'button', class: 'primary-button', text: tr('Run permitted task'), disabled: executionContext?.session && tasks.length && !executionPending ? null : '', onclick: async () => {
    if (executionPending) return;
    executionPending = true; run.disabled = true;
    const selected = chosenOption(task, tasks, 'name');
    try {
      const result = await api.request('/api/execution', { method: 'POST', body: { op: 'task-run', nodeId: node.id, sessionId: executionContext.session.id, profile: selected.name } });
      executionContext.process = result.process; executionContext.cursors = {}; executionContext.output = ''; $('#terminal-output').hidden = true; $('#command').value = selected.name; executionPending = false; toast(tr('Permitted task started.')); openConsoleSelection(); await readProcessOutput();
    } catch (error) { toast(error.message || String(error)); } finally { executionPending = false; run.disabled = false; }
  } });
  const gitStatus = element('button', { type: 'button', class: 'secondary-button', text: tr('Read Git status'), disabled: executionContext?.session && catalogue.operations.includes('git-status') ? null : '', onclick: () => runGitStatus() });
  const policy = catalogue.executionPolicy ?? catalogue.policy ?? {};
  const sessionPolicy = catalogue.sessionExecutionPolicies?.[executionContext?.session?.id] ?? policy;
  const policySection = element('div', { class: 'detail-grid' }, element('div', { class: 'detail-item' }, element('span', { text: tr('Configured policy') }), element('strong', { text: text(sessionPolicy.configuredMode ?? policy.configuredMode) })), element('div', { class: 'detail-item' }, element('span', { text: tr('Effective policy') }), element('strong', { text: text(sessionPolicy.effectiveMode ?? policy.effectiveMode) })));
  const openPolicy = element('button', { type: 'button', class: 'secondary-button', text: tr('View execution policy'), onclick: () => views.open('Execution') });
  content.append(element('p', { text: tr('Node: {name}', { name: text(node.name) }) }), policySection, element('label', { class: 'settings-row' }, element('span', { text: tr('Workspace') }), workspace), element('label', { class: 'settings-row' }, element('span', { text: tr('Project') }), project), element('label', { class: 'settings-row' }, element('span', { text: tr('Session') }), session), element('label', { class: 'settings-row' }, element('span', { text: tr('Permitted task') }), task), note, element('div', { class: 'modal-actions' }, create, run, gitStatus, openPolicy));
  if (executionContext?.process) {
    const read = element('button', { type: 'button', class: 'secondary-button', text: tr('Read output'), onclick: readProcessOutput });
    const stop = element('button', { type: 'button', class: 'secondary-button', text: tr('Stop process'), onclick: stopProcess });
    content.append(element('p', { class: 'moon-status', text: tr('Process status: {status}', { status: text(executionContext.process.status ?? executionContext.process.state) }) }), element('div', { class: 'modal-actions' }, read, stop));
  }
}

async function runGitStatus() {
  if (!executionContext?.session) return;
  try {
    const result = await api.request('/api/execution', { method: 'POST', body: { op: 'git-status', nodeId: executionContext.catalogue.node.id, sessionId: executionContext.session.id } });
    const output = $('#terminal-output'); output.hidden = false; output.textContent = typeof result.status === 'string' ? result.status : JSON.stringify(result.status ?? result, null, 2);
  } catch (error) { toast(error.message || String(error)); }
}

async function readProcessOutput() {
  if (!executionContext?.process) return;
  const { catalogue, session, process, cursors } = executionContext;
  try {
    const result = await api.request('/api/execution', { method: 'POST', body: { op: 'process-read', nodeId: catalogue.node.id, sessionId: session.id, processId: process.id, stdoutCursor: cursors.stdout, stderrCursor: cursors.stderr } });
    executionContext.process = result.process ?? process;
    executionContext.cursors = { stdout: result.stdout?.nextCursor, stderr: result.stderr?.nextCursor };
    const added = [result.stdout?.text, result.stderr?.text].filter(Boolean).join('');
    const limit = Number(executionContext.catalogue?.limits?.maxOutputBytes) || 65536;
    executionContext.output = `${executionContext.output || ''}${added}`.slice(-limit);
    const output = $('#terminal-output'); output.hidden = false; output.textContent = executionContext.output || tr('No output is available yet.');
  } catch (error) { toast(error.message || String(error)); }
}

async function stopProcess() {
  if (!executionContext?.process) return;
  const { catalogue, session, process } = executionContext;
  try {
    const result = await api.request('/api/execution', { method: 'POST', body: { op: 'process-stop', nodeId: catalogue.node.id, sessionId: session.id, processId: process.id } });
    executionContext.process = result.process ?? process; toast(tr('Stop request submitted.')); await readProcessOutput(); openConsoleSelection();
  } catch (error) { toast(error.message || String(error)); }
}

function openActivityHistory() {
  const content = element('div', { class: 'moon-view' });
  const activities = deriveActivities(store.getState());
  if (!activities.length) content.append(element('p', { class: 'moon-muted', text: tr('No backend activity history is currently available.') }));
  for (const activity of activities) content.append(element('article', { class: 'moon-row' }, element('strong', { text: tr(activity.type === 'admin' ? 'Admin request {state}' : 'Update transaction {state}', { state: tr(text(activity.state)) }) }), element('span', { text: `${tr(text(activity.state))} · ${activityTime(activity.timestamp)}` })));
  openModal(tr('Recent activity'), content);
}

function tick() {
  const now = new Date();
  const locale = getLanguage() === 'vi' ? 'vi-VN' : 'en-US';
  $('#clock').textContent = `${new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: CONTROL_CENTER_TIME_ZONE }).format(now)}  ${new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone: CONTROL_CENTER_TIME_ZONE }).format(now)}`;
  renderGreeting(now);
  const seconds = Math.max(0, Math.floor((Date.parse('2026-09-25T18:00:00+07:00') - now.getTime()) / 1000));
  const values = [Math.floor(seconds / 86400), Math.floor(seconds % 86400 / 3600), Math.floor(seconds % 3600 / 60), seconds % 60];
  $$('#countdown b').forEach((node, index) => { node.textContent = String(values[index]).padStart(2, '0'); });
}

$('#close-modal').addEventListener('click', () => modal.close());
modal.addEventListener('click', (event) => { if (event.target === modal) modal.close(); });
$('#search').addEventListener('input', searchCards);
$('#notifications').addEventListener('click', () => { const ids = readIds(); deriveNotifications(store.getState()).forEach((notice) => ids.add(notice.id)); saveRead(ids); render(); views.openNotifications(); });
$('#appearance').addEventListener('click', () => themes.show());
$('#profile').addEventListener('click', () => views.openProfile());
$('#all-activities').addEventListener('click', openActivityHistory);
$('#all-messages').addEventListener('click', () => views.openNotifications());
$('#command-form').addEventListener('submit', (event) => { event.preventDefault(); openConsoleSelection(); });
$('#menu-toggle').addEventListener('click', () => { if (window.innerWidth > 700) return; const open = document.body.classList.toggle('menu-open'); $('#menu-toggle').setAttribute('aria-expanded', String(open)); $('#scrim').hidden = !open; });
$('#scrim').addEventListener('click', closeMenu);
window.addEventListener('hashchange', () => navigate(pageFromHash(location.hash), { updateHash: false }));
$('#language-toggle').addEventListener('click', () => setLanguage(getLanguage() === 'vi' ? 'en' : 'vi'));
document.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#search').focus(); } if (event.key === 'Escape') closeMenu(); });

try { document.body.classList.toggle('reduce-motion', localStorage.getItem('moonlight-reduce-motion') === '1'); } catch {}
renderNavigation(); store.subscribe(render); onLanguageChange(localizeShell); localizeShell(); navigate(pageFromHash(location.hash), { updateHash: false }); tick(); setInterval(tick, 1000); if (api) store.start(); else toast(tr('Moonlight could not initialize because the page token is unavailable.'));
paintIcons();

export { openActivityHistory, openConsoleSelection, openModal, render };
