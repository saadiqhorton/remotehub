import { api, setUnauthorizedHandler } from './api.js';
import { ICONS, el, svgIcon } from './dom.js';
import { TerminalSurface, FileSession, DesktopSession } from './session-surface.js';
import { agentFeatures, agentStatus, hostActions, discoverAction, discoveryResultLines, confirmPrompt } from './host-actions.js';

const $ = (id) => document.getElementById(id);

const state = {
  hosts: [],
  sessions: [],
  activeId: null,
  filter: '',
  focus: localStorage.getItem('rh-focus') === '1',
  theme: localStorage.getItem('rh-theme') === 'light' ? 'light' : 'dark',
  setupRequired: false,
  editingHost: null,
  issuedAgentToken: null,
  agentTrust: null, // SAA-317: { fingerprint, keyType } of a new host key the owner must accept
  agentPoll: null,
  launcherIndex: 0,
  pendingCloseId: null,
  logoutBusy: false,
  owner: false, // SAA-306: signed in as the owner (owner-only host actions)
  discovery: {}, // SAA-306: per host id { busy, lines }
};

const LIVE_STATES = new Set(['connecting', 'verify', 'authenticating']);

// ── Theme & focus ────────────────────────────────────────────────

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('rh-theme', theme);
  $('theme-btn').textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
  for (const session of state.sessions) session.setTheme(theme);
}

function applyFocus(focus) {
  state.focus = focus;
  localStorage.setItem('rh-focus', focus ? '1' : '0');
  $('workspace').classList.toggle('focus', focus);
  const button = $('focus-btn');
  button.setAttribute('aria-pressed', String(focus));
  button.textContent = focus ? 'Show computers' : 'Focus terminal';
  activeSession()?.scheduleFit();
}

// ── Auth ─────────────────────────────────────────────────────────

function showAuth(setupRequired, notice) {
  dismissLogoutDialog(false);
  dismissCloseDialog(false);
  disposeAllSessions();
  if (state.agentPoll) {
    clearInterval(state.agentPoll);
    state.agentPoll = null;
  }
  state.setupRequired = setupRequired;
  state.owner = false;
  state.discovery = {};
  // SAA-306: drop the signed-in host list (and its owner-only buttons) from the DOM.
  state.hosts = [];
  $('host-list').replaceChildren();
  $('boot').hidden = true;
  $('app-view').hidden = true;
  $('auth-view').hidden = false;
  $('setup-code-field').hidden = !setupRequired;
  $('confirm-field').hidden = !setupRequired;
  $('auth-title').textContent = setupRequired ? 'Set up RemoteHub.' : 'Your machines, one tab away.';
  $('auth-lede').textContent = setupRequired
    ? "Create the owner password. You'll use it to log in to RemoteHub from any device on your network."
    : 'Log in to open terminals on your network.';
  $('password-label').textContent = setupRequired ? 'New owner password' : 'Password';
  $('auth-password').autocomplete = setupRequired ? 'new-password' : 'current-password';
  $('auth-submit').textContent = setupRequired ? 'Create owner account' : 'Log in';
  $('auth-form').reset();
  setAuthError(notice);
  (setupRequired ? $('setup-code') : $('auth-password')).focus();
}

function setAuthError(message) {
  $('auth-error').hidden = !message;
  $('auth-error').textContent = message || '';
}

async function submitAuth(event) {
  event.preventDefault();
  const password = $('auth-password').value;
  const submit = $('auth-submit');
  setAuthError('');

  if (state.setupRequired) {
    if (password.length < 10) return setAuthError('Choose a password with at least 10 characters.');
    if (password !== $('auth-confirm').value) return setAuthError("The two passwords don't match.");
  } else if (!password) {
    return setAuthError('Enter your password.');
  }

  submit.disabled = true;
  try {
    if (state.setupRequired) {
      await api('/api/auth/setup', { method: 'POST', body: { setupCode: $('setup-code').value, password } });
    } else {
      await api('/api/auth/login', { method: 'POST', body: { password } });
    }
    $('auth-form').reset();
    await enterApp();
  } catch (error) {
    setAuthError(error.message);
    $('auth-password').select();
  } finally {
    submit.disabled = false;
  }
}

async function logout() {
  if (state.logoutBusy) return;
  if (liveCount()) {
    openLogoutDialog();
    return;
  }
  await confirmLogout();
}

function ensureLogoutDialog() {
  let dialog = $('logout-dialog');
  if (dialog) return dialog;
  dialog = el('dialog', {
    id: 'logout-dialog',
    class: 'dialog logout-dialog',
    'aria-labelledby': 'logout-title',
    'aria-describedby': 'logout-consequence',
  },
  el('div', { class: 'logout-card' },
    el('div', { class: 'logout-content' },
      el('header', { class: 'logout-head' },
        el('span', { class: 'label logout-kicker' }, 'Log out / RemoteHub'),
        el('h2', { id: 'logout-title' }, 'Log out and disconnect?'),
        el('p', { id: 'logout-consequence', class: 'logout-consequence' }, ''),
      ),
      el('section', { class: 'logout-sessions', 'aria-label': 'Terminal sessions that will close' },
      el('ul', { id: 'logout-session-list', class: 'logout-session-list' }),
      ),
    ),
    el('footer', { class: 'logout-actions' },
      el('button', { type: 'button', class: 'btn', id: 'logout-cancel-btn', onclick: () => dismissLogoutDialog(true) }, 'Stay connected'),
      el('button', { type: 'button', class: 'btn btn-primary', id: 'logout-confirm-btn', onclick: confirmLogout }, 'Disconnect & log out →'),
    ),
  ));
  document.body.append(dialog);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    dismissLogoutDialog(true);
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dismissLogoutDialog(true);
  });
  return dialog;
}

function openLogoutDialog() {
  const dialog = ensureLogoutDialog();
  refreshLogoutDialog();
  if (!dialog.open) dialog.showModal();
  $('logout-cancel-btn').focus();
}

function refreshLogoutDialog() {
  const dialog = $('logout-dialog');
  if (!dialog) return;
  const sessions = state.sessions;
  const count = sessions.length;
  const terminalOnly = sessions.every((session) => !session.surfaceType || session.surfaceType === 'terminal');
  $('logout-consequence').textContent = `Logging out closes ${count}${terminalOnly ? ' terminal' : ''} ${count === 1 ? 'session' : 'sessions'}. You’ll need to log in again to reconnect.`;
  $('logout-session-list').replaceChildren(...sessions.map((session) =>
    el('li', { class: 'logout-session' },
      el('span', { class: 'logout-session-name' },
        el('span', { class: 'dot', 'data-state': session.state === 'ready' ? 'ready' : LIVE_STATES.has(session.state) ? 'connecting' : 'idle', 'aria-hidden': 'true' }),
        session.label,
      ),
      el('code', {}, session.endpoint),
    ),
  ));
  const confirm = $('logout-confirm-btn');
  const cancel = $('logout-cancel-btn');
  confirm.disabled = state.logoutBusy;
  cancel.disabled = state.logoutBusy;
  $('logout-btn').disabled = state.logoutBusy;
}

function dismissLogoutDialog(restoreFocus) {
  if (state.logoutBusy && restoreFocus) return;
  const dialog = $('logout-dialog');
  if (dialog?.open) dialog.close();
  if (restoreFocus && !$('app-view').hidden) $('logout-btn').focus();
}

async function confirmLogout() {
  if (state.logoutBusy) return;
  state.logoutBusy = true;
  refreshLogoutDialog();
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } finally {
    showAuth(false);
    state.logoutBusy = false;
    $('logout-btn').disabled = false;
  }
}

async function checkAuth() {
  try {
    const auth = await api('/api/auth/state');
    if (!auth.authenticated) showAuth(auth.setupRequired, 'Your session expired. Log in again.');
  } catch {
    // Network trouble is already shown in the tab.
  }
}

// ── App ──────────────────────────────────────────────────────────

async function enterApp() {
  $('boot').hidden = true;
  $('auth-view').hidden = true;
  $('app-view').hidden = false;
  state.owner = true;
  await loadHosts();
  startAgentPoll();
  render();
}

async function loadHosts() {
  const [{ hosts }, desktopEnabled] = await Promise.all([api('/api/hosts'), desktopServerEnabled()]);
  for (const host of hosts) Object.assign(host, { desktopServerEnabled: desktopEnabled, desktopProtocols: state.desktopProtocols }); // SAA-305
  state.hosts = hosts.sort((a, b) => a.name.localeCompare(b.name));
}

// SAA-303: Desktop is usable only when the server has GUACD_ENABLED on.
async function desktopServerEnabled() {
  try {
    const { guacd, protocols } = await api('/api/desktop/status');
    state.desktopProtocols = protocols ?? null; // SAA-305: which plugins guacd has
    return Boolean(guacd && guacd.status !== 'disabled');
  } catch {
    return false;
  }
}

function activeSession() {
  return state.sessions.find((session) => session.id === state.activeId) || null;
}

function liveCount() {
  return state.sessions.filter((session) => session.state === 'ready').length;
}

function hostState(host) {
  const sessions = state.sessions.filter((session) => session.host.id === host.id && (!session.surfaceType || session.surfaceType === 'terminal'));
  if (sessions.some((session) => session.state === 'ready')) return 'ready';
  if (sessions.some((session) => LIVE_STATES.has(session.state))) return 'connecting';
  return 'idle';
}

function render() {
  renderHosts();
  renderTabs();
  refreshCloseDialog();
  refreshLogoutDialog();
  renderEmpty();
  const total = state.sessions.length;
  const live = liveCount();
  $('session-count').textContent = total
    ? `${total} ${total === 1 ? 'session' : 'sessions'} · ${live} live`
    : 'No sessions';
}

function agentLine(host) {
  const status = agentStatus(host);
  if (status.state === 'none') return null;
  return el(
    'span',
    { class: 'host-agent', 'data-agent': status.state, title: [status.summary, ...agentFeatures(host)].join('\n') },
    el('span', { class: 'dot', 'data-state': status.connected ? 'ready' : 'idle', 'aria-hidden': 'true' }),
    `Agent · ${status.summary}`,
  );
}

function agentServerUrl() {
  const ws = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${ws}://${window.location.host}`;
}

function refreshAgentDialog() {
  const host = state.editingHost;
  const box = $('host-agent');
  if (!box) return;
  if (!host) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const status = agentStatus(host);
  $('host-agent-status-label').textContent = status.label;
  const details = $('host-agent-details');
  if (details) {
    const features = agentFeatures(host);
    const lines = [status.details.join(' · '), features.length ? `The agent adds: ${features.join(', ')}` : status.connected ? '' : 'The agent isn’t connected, so it adds nothing right now.'].filter(Boolean);
    details.textContent = lines.join(' — ');
    details.hidden = lines.length === 0;
  }
  $('host-agent-status').querySelector('.dot').dataset.state = status.connected ? 'ready' : 'idle';
  $('issue-agent-btn').textContent = status.registered ? 'Replace agent key' : 'Create agent key';
  $('revoke-agent-btn').hidden = !status.registered;
  const tokenBox = $('host-agent-token');
  if (state.issuedAgentToken) {
    tokenBox.hidden = false;
    $('host-agent-token-value').textContent = state.issuedAgentToken;
    $('host-agent-command').textContent =
      `remotehub-agent --mode persistent --server ${agentServerUrl()} --host-id ${host.id} --token ${state.issuedAgentToken}`;
  } else {
    tokenBox.hidden = true;
    $('host-agent-token-value').textContent = '';
    $('host-agent-command').textContent = '';
  }
}

function startAgentPoll() {
  if (state.agentPoll) return;
  state.agentPoll = setInterval(async () => {
    if ($('app-view').hidden) return;
    try {
      await loadHosts();
      if (state.editingHost) {
        state.editingHost = state.hosts.find((host) => host.id === state.editingHost.id) || state.editingHost;
        refreshAgentDialog();
      }
      render();
    } catch {
      // Surface errors stay on the open session; a missed poll is not fatal.
    }
  }, 4000);
}

function renderHosts() {
  const query = state.filter.trim().toLowerCase();
  const hosts = state.hosts.filter((host) =>
    !query || [host.name, host.address, host.username].some((value) => value.toLowerCase().includes(query)),
  );
  $('host-count').textContent = String(state.hosts.length).padStart(2, '0');
  const current = activeSession()?.host.id;

  const items = hosts.map((host) => {
    const open = state.sessions.some((session) => session.host.id === host.id);
    return el(
      'li',
      { class: ['host', open && 'open', current === host.id && 'current'].filter(Boolean).join(' ') },
      el(
        'button',
        { type: 'button', class: 'host-main', title: hostActions(host)[0].enabled ? `Open ${host.name}` : hostActions(host)[0].reason, disabled: !hostActions(host)[0].enabled, onclick: () => openHost(host) },
        el('span', { class: 'dot', 'data-state': hostState(host) }),
        el(
          'span',
          { class: 'host-text' },
          el('span', { class: 'host-name' }, host.name),
          el('span', { class: 'host-meta' }, `${host.username}@${host.address}${host.port === 22 ? '' : `:${host.port}`}`),
          agentLine(host),
        ),
      ),
      el(
        'span',
        { class: 'host-actions' },
        el('button', { type: 'button', class: 'icon-btn', title: 'New session', 'aria-label': `New session on ${host.name}`, disabled: !hostActions(host)[0].enabled, onclick: () => newSession(host) }, svgIcon(ICONS.plus)),
        el('button', { type: 'button', class: 'icon-btn', title: 'Edit computer', 'aria-label': `Edit ${host.name}`, onclick: () => openHostDialog(host) }, svgIcon(ICONS.edit)),
      ),
      el('div', { class: 'host-capabilities', 'aria-label': `Actions for ${host.name}` },
        ...hostActions(host).map((action) => el('button', {
          type: 'button', class: 'host-capability', disabled: !action.enabled,
          title: action.reason || `Open ${action.label} on ${host.name}`,
          'aria-label': action.enabled ? `${action.label} on ${host.name}` : `${action.label} unavailable: ${action.reason}`,
          onclick: () => openSurface(host, action.type),
        }, action.label)),
      ),
      ...discoveryControls(host),
    );
  });

  if (!items.length) {
    items.push(el('li', { class: 'hint' }, state.hosts.length ? 'No computers match that filter.' : 'No computers yet.'));
  }
  $('host-list').replaceChildren(...items);
}

function renderTabs() {
  const seen = new Map();
  const tabs = state.sessions.map((session) => {
    const key = `${session.host.id}:${session.surfaceType || 'terminal'}`;
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    const active = session.id === state.activeId;
    const dotState = session.state === 'ready' ? 'ready' : LIVE_STATES.has(session.state) ? 'connecting' : 'idle';
    return el(
      'div',
      { class: `tab${active ? ' active' : ''}`, 'data-surface-type': session.surfaceType || 'terminal' },
      el(
        'button',
        {
          type: 'button',
          class: 'tab-btn',
          role: 'tab',
          'aria-selected': String(active),
          'aria-controls': `pane-${session.id}`,
          onclick: () => activate(session.id),
        },
        el('span', { class: 'dot', 'data-state': dotState }),
        el('span', {}, count > 1 ? `${session.label} ${count}` : session.label),
      ),
      el('button', { type: 'button', class: 'tab-close', 'data-session-close': session.id, 'aria-label': `Close ${session.label}`, onclick: () => closeSession(session.id) }, '×'),
    );
  });
  $('tabs').replaceChildren(...tabs);
}

function renderEmpty() {
  const empty = $('empty-state');
  if (state.sessions.length) {
    empty.hidden = true;
    return;
  }
  empty.hidden = false;
  const hasHosts = state.hosts.length > 0;
  empty.replaceChildren(
    el('span', { class: 'label' }, hasHosts ? 'Ready' : 'Getting started'),
    el('h2', {}, hasHosts ? 'Pick a machine.' : 'Add your first machine.'),
    el(
      'p',
      {},
      hasHosts
        ? 'Choose a computer from the list, or press Ctrl ⇧ K to jump to one. Each connection opens in its own tab.'
        : "RemoteHub opens SSH terminals to computers on your network using their username and password. Passwords are typed when you connect and are never saved.",
    ),
    el(
      'ol',
      { class: 'steps' },
      el('li', {}, el('b', {}, '01'), el('span', {}, 'Add a computer')),
      el('li', {}, el('b', {}, '02'), el('span', {}, 'Enter its password')),
      el('li', {}, el('b', {}, '03'), el('span', {}, 'Work in the terminal')),
    ),
    ...(hasHosts ? [] : [el('div', {}, el('button', { type: 'button', class: 'btn btn-primary', onclick: () => openHostDialog() }, '+ Add computer'))]),
  );
}

// ── Sessions ─────────────────────────────────────────────────────

function openHost(host) {
  openSurface(host, 'terminal');
}

// SAA-306: owner-only "Check desktop options" button and its per-backend results.
function discoveryControls(host) {
  if (!state.owner) return [];
  const entry = state.discovery[host.id] || {};
  const action = discoverAction(host, { busy: entry.busy });
  return [el('div', { class: 'host-discover' },
    el('button', { type: 'button', class: 'host-discover-btn', disabled: !action.enabled, title: action.reason,
      'aria-label': `${action.label} for ${host.name}`, onclick: () => checkDesktopOptions(host) }, action.label),
    ...(entry.lines?.length ? [el('ul', { class: 'host-discover-results', role: 'status' }, ...entry.lines.map((line) => el('li', {}, line)))] : []),
    ...(entry.confirm ? [el('div', { class: 'host-discover-confirm', role: 'alertdialog', 'aria-label': `Confirm desktop address for ${host.name}` },
      el('p', {}, confirmPrompt(entry.confirm)),
      el('button', { type: 'button', class: 'host-discover-confirm-btn', onclick: () => confirmDiscoveredDesktop(host) }, `Confirm ${entry.confirm.address}:${entry.confirm.port} and open`),
      el('button', { type: 'button', class: 'host-discover-cancel-btn', onclick: () => { state.discovery[host.id] = { ...entry, confirm: null }; renderHosts(); } }, 'Cancel'))] : []),
  )];
}

async function checkDesktopOptions(host) {
  if (!state.owner || state.discovery[host.id]?.busy) return;
  state.discovery[host.id] = { busy: true, lines: state.discovery[host.id]?.lines };
  renderHosts();
  try {
    const { host: updated } = await api(`/api/hosts/${host.id}/desktop/discover`, { method: 'POST' });
    const merged = mergeHost(updated);
    state.discovery[host.id] = { busy: false, lines: discoveryResultLines(merged) };
  } catch (error) {
    state.discovery[host.id] = { busy: false, lines: discoveryResultLines(host, error) };
  }
  render();
}

function mergeHost(updated) {
  const index = state.hosts.findIndex((h) => h.id === updated.id);
  const merged = { ...updated, desktopServerEnabled: state.hosts[index]?.desktopServerEnabled, desktopProtocols: state.desktopProtocols };
  if (index !== -1) state.hosts[index] = merged;
  return merged;
}

function openSurface(host, surfaceType = 'terminal') {
  const action = hostActions(host).find((item) => item.type === surfaceType);
  if (!action?.enabled) return;
  // SAA-306: Desktop enabled by discovery: save settings from the preference first. A port
  // the owner has not saved needs an explicit confirmation of the exact address:port.
  if (action.needsSetup && action.confirm) {
    if (!state.owner) return;
    state.discovery[host.id] = { ...(state.discovery[host.id] || {}), busy: false, confirm: action.confirm };
    return renderHosts();
  }
  if (action.needsSetup) return setUpDiscoveredDesktop(host);
  const existing = [...state.sessions].reverse().find((session) => session.host.id === host.id && (session.surfaceType || 'terminal') === surfaceType);
  if (existing) activate(existing.id);
  else newSession(host, surfaceType);
}

function confirmDiscoveredDesktop(host) {
  const confirm = state.discovery[host.id]?.confirm;
  if (!state.owner || !confirm) return;
  state.discovery[host.id] = { ...state.discovery[host.id], confirm: null };
  return setUpDiscoveredDesktop(host, confirm);
}

async function setUpDiscoveredDesktop(host, confirm = null) {
  try {
    const body = { preference: host.desktopPreference || 'auto', ...(confirm ? { confirm: { protocol: confirm.protocol, address: confirm.address, port: confirm.port } } : {}) };
    const { host: updated } = await api(`/api/hosts/${host.id}/desktop`, { method: 'PUT', body });
    const merged = mergeHost(updated);
    // Refresh the card: the saved choice is no longer "not saved; confirm on first use".
    if (merged.desktopDiscovery) state.discovery[host.id] = { busy: false, lines: discoveryResultLines(merged) };
    else delete state.discovery[host.id];
    render();
    if (merged.desktop?.protocol) openSurface(merged, 'desktop');
  } catch (error) {
    state.discovery[host.id] = { busy: false, lines: [error.message || 'Could not set up Desktop.'] };
    render();
  }
}

function newSession(host, surfaceType = 'terminal') {
  let session;
  if (surfaceType === 'terminal') {
    session = new TerminalSurface({
      host,
      theme: state.theme,
      onChange: render,
      onClose: (id) => closeSession(id, { force: true }),
      onEditHost: (target) => openHostDialog(state.hosts.find((h) => h.id === target.id) || target),
      onConnectionLost: checkAuth,
    });
  } else if (surfaceType === 'files') {
    session = new FileSession({
      host,
      theme: state.theme,
      onChange: render,
      onClose: (id) => closeSession(id, { force: true }),
      onEditHost: (target) => openHostDialog(state.hosts.find((h) => h.id === target.id) || target),
      onConnectionLost: checkAuth,
    });
  } else if (surfaceType === 'desktop') {
    session = new DesktopSession({
      host,
      onChange: render,
      onClose: (id) => closeSession(id, { force: true }),
      onConnectionLost: checkAuth,
      // SAA-306: "Set up agent" in the missing-service help opens the host dialog, which holds
      // the existing agent registration and temporary-helper controls.
      onSetUpAgent: (target) => openHostDialog(state.hosts.find((h) => h.id === target.id) || target),
    });
  } else {
    throw new Error(`Unknown session surface: ${surfaceType}`);
  }
  session.mount($('stage'));
  state.sessions.push(session);
  activate(session.id);
}

function activate(id) {
  state.activeId = id;
  for (const session of state.sessions) {
    if (session.id === id) session.show();
    else session.hide();
  }
  render();
}

function closeSession(id, { force = false, confirmed = false } = {}) {
  const index = state.sessions.findIndex((session) => session.id === id);
  if (index === -1) return;
  const session = state.sessions[index];
  if (!confirmed && !force && session.surfaceType !== 'files' && session.surfaceType !== 'desktop' && session.state === 'ready') {
    openCloseDialog(session);
    return;
  }
  const restoreFocusAfterRemoval = confirmed || state.pendingCloseId === id;
  if (state.pendingCloseId === id) dismissCloseDialog(false);
  session.dispose();
  state.sessions.splice(index, 1);
  if (state.activeId === id) {
    const next = state.sessions[index] || state.sessions[index - 1];
    state.activeId = null;
    if (next) return activate(next.id);
  }
  render();
  if (restoreFocusAfterRemoval && state.activeId !== id) {
    if (activeSession()) activeSession().focus();
    else $('launcher-btn').focus();
  }
}

function ensureCloseDialog() {
  let dialog = $('close-session-dialog');
  if (dialog) return dialog;

  dialog = el(
    'dialog',
    { id: 'close-session-dialog', class: 'dialog close-session-dialog', 'aria-labelledby': 'close-session-title', 'aria-describedby': 'close-session-consequence' },
    el('div', { class: 'close-session-card bracketed' },
      el('div', { class: 'close-session-head' },
        el('span', { class: 'label' }, 'Close terminal'),
        el('h2', { id: 'close-session-title' }, ''),
      ),
      el('div', { class: 'close-session-meta' },
        el('span', { class: 'label close-session-status' },
          el('span', { class: 'dot', 'data-state': 'ready', 'aria-hidden': 'true' }),
          'Connected',
        ),
        el('p', { class: 'close-session-endpoint' }, el('code', { id: 'close-session-endpoint' }, '')),
      ),
      el('p', { id: 'close-session-consequence', class: 'close-session-consequence' }, 'Closing this terminal ends its SSH connection. You can open a new session from the computer list.'),
      el('footer', { class: 'close-session-actions' },
        el('button', { type: 'button', class: 'btn', id: 'keep-session-btn', onclick: () => dismissCloseDialog(true) }, 'Keep session'),
        el('button', { type: 'button', class: 'btn btn-primary', id: 'disconnect-session-btn', onclick: confirmCloseSession }, 'Disconnect →'),
      ),
    ),
  );
  document.body.append(dialog);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    dismissCloseDialog(true);
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dismissCloseDialog(true);
  });
  return dialog;
}

function openCloseDialog(session) {
  const dialog = ensureCloseDialog();
  state.pendingCloseId = session.id;
  $('close-session-title').textContent = `Disconnect from ${session.label}?`;
  $('close-session-endpoint').textContent = session.endpoint;
  if (!dialog.open) dialog.showModal();
  $('keep-session-btn').focus();
}

function refreshCloseDialog() {
  if (!state.pendingCloseId) return;
  const session = state.sessions.find(({ id }) => id === state.pendingCloseId);
  if (!session || session.state !== 'ready') {
    dismissCloseDialog(true);
    return;
  }
  $('close-session-title').textContent = `Disconnect from ${session.label}?`;
  $('close-session-endpoint').textContent = session.endpoint;
}

function dismissCloseDialog(restoreFocus) {
  const id = state.pendingCloseId;
  state.pendingCloseId = null;
  const dialog = $('close-session-dialog');
  if (dialog?.open) dialog.close();
  if (!restoreFocus || !id) return;
  const closeButton = [...document.querySelectorAll('.tab-close')]
    .find((button) => button.getAttribute('data-session-close') === id);
  if (closeButton) closeButton.focus();
  else if (activeSession()) activeSession().focus();
  else $('launcher-btn').focus();
}

function confirmCloseSession() {
  const id = state.pendingCloseId;
  if (!id) return;
  const session = state.sessions.find((candidate) => candidate.id === id);
  state.pendingCloseId = null;
  $('close-session-dialog').close();
  if (session?.state === 'ready') closeSession(id, { confirmed: true });
}

function disposeAllSessions() {
  for (const session of state.sessions) session.dispose();
  state.sessions = [];
  state.activeId = null;
}

// ── Host dialog ──────────────────────────────────────────────────

function openHostDialog(host = null) {
  state.editingHost = host;
  state.issuedAgentToken = null;
  resetAgentInstall();
  const form = $('host-form');
  form.reset();
  form.elements.name.value = host?.name || '';
  form.elements.address.value = host?.address || '';
  form.elements.port.value = host?.port || 22;
  form.elements.username.value = host?.username || '';
  $('host-dialog-kicker').textContent = host ? 'Edit computer' : 'New computer';
  $('host-dialog-title').textContent = host ? host.name : 'Add a machine';
  $('host-save-btn').textContent = host ? 'Save changes' : 'Save computer';
  $('delete-host-btn').hidden = !host;
  $('host-fingerprint').hidden = !host?.knownHost;
  $('host-fingerprint-value').textContent = host?.knownHost ? host.knownHost.fingerprint : '';
  refreshAgentDialog();
  setHostError('');
  $('host-dialog').showModal();
  form.elements.name.focus();
}

function setHostError(message) {
  $('host-error').hidden = !message;
  $('host-error').textContent = message || '';
}

async function saveHost(event) {
  event.preventDefault();
  const form = $('host-form');
  const body = {
    name: form.elements.name.value,
    address: form.elements.address.value,
    port: form.elements.port.value,
    username: form.elements.username.value,
  };
  const editing = state.editingHost;
  $('host-save-btn').disabled = true;
  try {
    const { host } = editing
      ? await api(`/api/hosts/${editing.id}`, { method: 'PUT', body })
      : await api('/api/hosts', { method: 'POST', body });
    await loadHosts();
    for (const session of state.sessions) if (session.host.id === host.id) session.updateHost(host);
    $('host-dialog').close();
    render();
  } catch (error) {
    setHostError(error.message);
  } finally {
    $('host-save-btn').disabled = false;
  }
}

async function deleteHost() {
  const host = state.editingHost;
  if (!host || !window.confirm(`Delete ${host.name}? Open sessions stay connected until you close them.`)) return;
  try {
    await api(`/api/hosts/${host.id}`, { method: 'DELETE' });
    await loadHosts();
    $('host-dialog').close();
    render();
  } catch (error) {
    setHostError(error.message);
  }
}

async function forgetFingerprint() {
  const host = state.editingHost;
  if (!host) return;
  try {
    await api(`/api/hosts/${host.id}/fingerprint`, { method: 'DELETE' });
    await loadHosts();
    state.editingHost = state.hosts.find((h) => h.id === host.id) || null;
    $('host-fingerprint').hidden = true;
    render();
  } catch (error) {
    setHostError(error.message);
  }
}

async function issueAgentCredential() {
  const host = state.editingHost;
  if (!host) return;
  $('issue-agent-btn').disabled = true;
  try {
    const issued = await api(`/api/hosts/${host.id}/agent`, { method: 'POST' });
    state.issuedAgentToken = issued.token;
    await loadHosts();
    state.editingHost = state.hosts.find((item) => item.id === host.id) || issued.host;
    refreshAgentDialog();
    render();
  } catch (error) {
    setHostError(error.message);
  } finally {
    $('issue-agent-btn').disabled = false;
  }
}

async function revokeAgentCredential() {
  const host = state.editingHost;
  if (!host || !window.confirm(`Remove the agent key for ${host.name}? The agent on that computer will disconnect and needs a new key to connect again.`)) return;
  $('revoke-agent-btn').disabled = true;
  try {
    await api(`/api/hosts/${host.id}/agent`, { method: 'DELETE' });
    state.issuedAgentToken = null;
    await loadHosts();
    state.editingHost = state.hosts.find((item) => item.id === host.id) || { ...host, agent: { registered: false, connected: false } };
    refreshAgentDialog();
    render();
  } catch (error) {
    setHostError(error.message);
  } finally {
    $('revoke-agent-btn').disabled = false;
  }
}

// ── One-click agent install (SAA-317) ────────────────────────────

function setAgentInstallError(message) {
  $('agent-install-error').hidden = !message;
  $('agent-install-error').textContent = message || '';
}

function renderAgentTrust() {
  const trust = state.agentTrust;
  $('agent-install-trust').hidden = !trust;
  if (trust) {
    $('agent-install-trust').textContent = `First time connecting to this computer. Its fingerprint is ${trust.fingerprint} (${trust.keyType}). Check it matches before trusting it.`;
  }
  $('agent-install-submit').textContent = trust ? 'Trust and install' : 'Install';
}

function openAgentInstall() {
  if (!state.editingHost) return;
  $('agent-install-done').hidden = true;
  setAgentInstallError('');
  $('agent-install-form').hidden = false;
  $('agent-install-password').focus();
}

function cancelAgentInstall() {
  $('agent-install-password').value = '';
  state.agentTrust = null;
  renderAgentTrust();
  setAgentInstallError('');
  $('agent-install-form').hidden = true;
}

function resetAgentInstall() {
  $('agent-install-password').value = '';
  state.agentTrust = null;
  renderAgentTrust();
  setAgentInstallError('');
  $('agent-install-form').hidden = true;
  $('agent-install-done').hidden = true;
  $('agent-install-done').textContent = '';
}

async function submitAgentInstall(event) {
  event.preventDefault();
  const host = state.editingHost;
  const input = $('agent-install-password');
  const password = input.value;
  // The typed password never stays in the field, whatever the outcome.
  input.value = '';
  if (!host) return;
  if (!password) {
    setAgentInstallError('Enter the SSH password for this computer.');
    input.focus();
    return;
  }
  const trust = state.agentTrust;
  const submit = $('agent-install-submit');
  const install = $('install-agent-btn');
  submit.disabled = true;
  install.disabled = true;
  setAgentInstallError('');
  let result;
  try {
    const body = { password, serverUrl: agentServerUrl() };
    if (trust) body.acceptFingerprint = trust.fingerprint;
    result = await api(`/api/hosts/${host.id}/agent/install`, { method: 'POST', body });
  } catch (error) {
    if (error.data?.code === 'hostkey-new') {
      state.agentTrust = { fingerprint: error.data.fingerprint, keyType: error.data.keyType };
      renderAgentTrust();
      $('agent-install-form').hidden = false;
      input.focus();
    } else {
      setAgentInstallError(error.message);
    }
    return;
  } finally {
    submit.disabled = false;
    install.disabled = false;
  }
  state.agentTrust = null;
  renderAgentTrust();
  $('agent-install-form').hidden = true;
  $('agent-install-done').textContent = result.message;
  $('agent-install-done').hidden = false;
  // The install is done either way; if this refresh fails, the dialog's poll catches up.
  await loadHosts().catch(() => {});
  state.editingHost = state.hosts.find((item) => item.id === host.id) || result.host;
  refreshAgentDialog();
  render();
}

// ── Launcher ─────────────────────────────────────────────────────

function launcherMatches() {
  const query = $('launcher-input').value.trim().toLowerCase();
  return state.hosts.filter((host) =>
    !query || [host.name, host.address, host.username].some((value) => value.toLowerCase().includes(query)),
  );
}

function renderLauncher() {
  const matches = launcherMatches();
  state.launcherIndex = Math.min(state.launcherIndex, Math.max(0, matches.length - 1));
  const items = matches.map((host, index) =>
    el(
      'li',
      {},
      el(
        'button',
        {
          type: 'button',
          class: 'launcher-item',
          role: 'option',
          'aria-selected': String(index === state.launcherIndex),
          onclick: () => launch(host),
          onmousemove: () => {
            if (state.launcherIndex !== index) {
              state.launcherIndex = index;
              renderLauncher();
            }
          },
        },
        el('b', {}, host.name),
        el('span', {}, `${host.username}@${host.address}`),
      ),
    ),
  );
  if (!items.length) {
    items.push(el('li', { class: 'launcher-empty' }, state.hosts.length ? 'No matching computers.' : 'No computers yet. Add one first.'));
  }
  $('launcher-list').replaceChildren(...items);
}

function openLauncher() {
  if ($('app-view').hidden || $('launcher-dialog').open || $('host-dialog').open || $('close-session-dialog')?.open || $('logout-dialog')?.open) return;
  $('launcher-input').value = '';
  state.launcherIndex = 0;
  renderLauncher();
  $('launcher-dialog').showModal();
  $('launcher-input').focus();
}

function launch(host) {
  $('launcher-dialog').close();
  openHost(host);
}

function launcherKeys(event) {
  const matches = launcherMatches();
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!matches.length) return;
    const step = event.key === 'ArrowDown' ? 1 : -1;
    state.launcherIndex = (state.launcherIndex + step + matches.length) % matches.length;
    renderLauncher();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (matches[state.launcherIndex]) launch(matches[state.launcherIndex]);
  }
}

// ── Wiring ───────────────────────────────────────────────────────

function wire() {
  $('auth-form').addEventListener('submit', submitAuth);
  $('logout-btn').addEventListener('click', logout);
  $('theme-btn').addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark'));
  $('focus-btn').addEventListener('click', () => applyFocus(!state.focus));
  $('launcher-btn').addEventListener('click', openLauncher);
  $('add-host-btn').addEventListener('click', () => openHostDialog());
  $('host-filter').addEventListener('input', (event) => {
    state.filter = event.target.value;
    renderHosts();
  });

  $('host-form').addEventListener('submit', saveHost);
  $('host-cancel-btn').addEventListener('click', () => $('host-dialog').close());
  $('delete-host-btn').addEventListener('click', deleteHost);
  $('forget-fingerprint-btn').addEventListener('click', forgetFingerprint);
  $('issue-agent-btn').addEventListener('click', issueAgentCredential);
  $('revoke-agent-btn').addEventListener('click', revokeAgentCredential);
  $('install-agent-btn').addEventListener('click', openAgentInstall);
  $('agent-install-submit').addEventListener('click', submitAgentInstall);
  $('agent-install-cancel').addEventListener('click', cancelAgentInstall);
  // Enter in this field must not submit the host form around it (no nested forms in the dialog).
  $('agent-install-password').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submitAgentInstall(event);
  });
  $('host-dialog').addEventListener('close', () => {
    resetAgentInstall(); // the typed password does not outlive the dialog
    activeSession()?.focus();
  });

  $('launcher-input').addEventListener('input', () => {
    state.launcherIndex = 0;
    renderLauncher();
  });
  $('launcher-input').addEventListener('keydown', launcherKeys);
  $('launcher-dialog').addEventListener('click', (event) => {
    if (event.target === $('launcher-dialog')) $('launcher-dialog').close();
  });
  $('launcher-dialog').addEventListener('close', () => activeSession()?.focus());

  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openLauncher();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (liveCount()) event.preventDefault();
  });

  setUnauthorizedHandler(() => showAuth(false, 'Your session expired. Log in again.'));
}

async function boot() {
  wire();
  applyTheme(state.theme);
  applyFocus(state.focus);

  // xterm measures glyphs when it opens, so the web font has to be ready first.
  try {
    await Promise.all([document.fonts.load('14px "Space Mono"'), document.fonts.load('700 14px "Space Mono"')]);
  } catch {
    // Fall back to system monospace.
  }

  try {
    const auth = await api('/api/auth/state');
    if (auth.authenticated) await enterApp();
    else showAuth(auth.setupRequired);
  } catch (error) {
    $('boot').textContent = error.message;
  }
}

boot();
