import { el } from './dom.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_PATH = 4096;
// Leave room for the server's 30-second search deadline and its final reply.
const SEARCH_REPLY_TIMEOUT_MS = 35_000;
const DIRECTORY_POLL_INTERVAL_MS = 5_000;
const DIRECTORY_POLL_MAX_DELAY_MS = 200_000;
// SFTP operations have a 30-second server deadline; allow time for its reply.
const DIRECTORY_POLL_REPLY_TIMEOUT_MS = 35_000;
// Agent change events for the visible directory are coalesced for this long, then
// answered with one quiet SFTP re-list (SAA-298). SFTP stays the source of truth.
const LIVE_REFRESH_DELAY_MS = 100;

let counter = 0;

// Ancestor crumbs for an absolute path. "." is the unresolved home directory.
export function crumbList(path) {
  if (!path || path === '.') return [{ label: path === '.' ? '…' : '—', path: path || '' }];
  const items = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of String(path).split('/').filter(Boolean)) {
    acc += `/${part}`;
    items.push({ label: part, path: acc });
  }
  return items;
}

export function parentPath(path) {
  if (typeof path !== 'string' || path === '' || path === '/' || path === '.') return null;
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const slash = trimmed.lastIndexOf('/');
  if (slash <= 0) return '/';
  return trimmed.slice(0, slash);
}

export function joinPath(dir, name) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..') return null;
  if (name.includes('/') || name.includes('\\') || CONTROL.test(name)) return null;
  if (dir === '/') return `/${name}`;
  if (typeof dir !== 'string' || !dir.startsWith('/') || CONTROL.test(dir)) return null;
  const base = dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
  return `${base}/${name}`;
}

export function formatSize(entry) {
  if (!entry || entry.type === 'dir') return '—';
  const size = typeof entry.size === 'number' && entry.size > 0 ? entry.size : 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) {
    const kb = size / 1024;
    return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)} KB`;
  }
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const TRANSFER_CHUNK_BYTES = 64 * 1024;

export function transferStateLabel(state) {
  if (state === 'queued') return 'Queued';
  if (state === 'transferring') return 'Transferring';
  if (state === 'complete') return 'Complete';
  if (state === 'error') return 'Error';
  return 'Cancelled';
}

export function transferPercent(transfer) {
  if (!transfer) return 0;
  if (transfer.state === 'complete') return 100;
  const total = Number(transfer.total) || 0;
  if (!total) return 0;
  const raw = Math.floor((Math.max(0, Number(transfer.loaded) || 0) / total) * 100);
  if (transfer.state === 'transferring') return Math.min(99, raw);
  return Math.min(100, Math.max(0, raw));
}

function transferBytes(transfer) {
  const loaded = formatSize({ type: 'file', size: Math.max(0, Number(transfer.loaded) || 0) });
  const total = formatSize({ type: 'file', size: Math.max(0, Number(transfer.total) || 0) });
  return `${loaded} / ${total}`;
}

function transferValueText(transfer) {
  return `${transferStateLabel(transfer.state)}, ${formatSize({ type: 'file', size: transfer.loaded || 0 })} of ${formatSize({ type: 'file', size: transfer.total || 0 })}, ${transferPercent(transfer)} percent`;
}

function transferNote(transfer) {
  if (transfer.state === 'queued') return 'Waiting. This file will stream in chunks.';
  if (transfer.state === 'transferring') return 'Streaming in chunks.';
  if (transfer.state === 'complete') {
    return transfer.kind === 'upload'
      ? 'Upload finished. The file was written in chunks.'
      : 'Download finished. The file was read in chunks.';
  }
  if (transfer.state === 'error') {
    const why = transfer.message ? `${transfer.message} ` : '';
    return `${why}The folder listing was not changed.`;
  }
  return 'Cancelled. The folder listing was not changed.';
}

function canUseSavePicker() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}

// The picker grants the handle. This browser still rejects createWritable unless the
// readwrite permission is claimed before the click that opened the picker expires.
async function openDownloadWritable(handle) {
  if (typeof window.focus === 'function') window.focus();
  const mode = { mode: 'readwrite' };
  if (typeof handle.queryPermission === 'function') {
    let permission = await handle.queryPermission(mode);
    if (permission !== 'granted' && typeof handle.requestPermission === 'function') {
      permission = await handle.requestPermission(mode);
    }
    if (permission !== 'granted') {
      const error = new Error('Permission was not granted');
      error.name = 'NotAllowedError';
      throw error;
    }
  }
  return handle.createWritable();
}

function fileBaseName(name) {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim();
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export function formatModified(mtime) {
  if (!mtime) return '—';
  const date = new Date(mtime);
  if (Number.isNaN(date.getTime())) return '—';
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day} ${MONTHS[date.getMonth()]} ${date.getFullYear()}  ${hours}:${minutes}`;
}

export function sortEntries(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => entry && typeof entry.name === 'string');
  const rank = (type) => (type === 'dir' ? 0 : type === 'symlink' ? 1 : 2);
  return [...list].sort((a, b) =>
    rank(a.type) - rank(b.type) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  );
}

export function textLines(text) {
  const normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const stripped = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  if (stripped === '') return [];
  return stripped.split('\n');
}

function readStatus(code) {
  if (code === 'denied') return 'denied';
  if (code === 'not-found') return 'missing';
  if (code === 'binary') return 'binary';
  if (code === 'too-large') return 'large';
  return 'error';
}

function fileCopy(file) {
  if (file.status === 'loading') return { kicker: 'Read only', title: 'Reading this file.', detail: file.path };
  if (file.status === 'denied') return { kicker: 'Permission denied', title: 'This account cannot read the file.', detail: 'The folder listing is unchanged.' };
  if (file.status === 'missing') return { kicker: 'Not found', title: 'This file is no longer at this path.', detail: 'Nothing was loaded.' };
  if (file.status === 'binary') return { kicker: 'Binary', title: 'This file is not text.', detail: 'RemoteHub will not place these bytes on the page.' };
  if (file.status === 'large') return { kicker: 'Too large', title: 'This file is over the view limit.', detail: 'Nothing from this file was loaded into this page.' };
  if (file.status === 'ended') return { kicker: 'Disconnected', title: 'The Files connection ended.', detail: 'Close this view to return to the folder.' };
  return { kicker: 'Files', title: file.message || 'The file could not be read.', detail: file.path };
}

function typeLabel(type) {
  if (type === 'dir') return 'folder';
  if (type === 'symlink') return 'symlink';
  return type === 'file' ? 'file' : 'other';
}

function absolutePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH) return null;
  if (!path.startsWith('/') || CONTROL.test(path)) return null;
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * One files tab = one SFTP session. Directory navigation is the path itself:
 * ancestor crumbs and Backspace move up, a directory or symlink opens, a file selects.
 * States match the terminal so the tab dot stays honest.
 */
// Splits a name around the first case-insensitive match so the hit can be marked.
function markMatch(name, query) {
  const at = name.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return [name];
  const end = at + query.length;
  return [name.slice(0, at), el('mark', { class: 'files-match' }, name.slice(at, end)), name.slice(end)].filter(Boolean);
}

export class FileSession {
  constructor({ host, theme, onChange, onClose, onEditHost, onConnectionLost } = {}) {
    this.id = `f${++counter}`;
    this.host = host;
    this.theme = theme || 'dark';
    this.surfaceType = 'files';
    this.state = 'password';
    this.everReady = false;
    this.ws = null;
    this.view = 'idle';
    this.path = '';
    this.entries = [];
    this.selected = -1;
    this.pending = null;
    this.opSeq = 0;
    this.notice = '';
    this.mutation = null;
    this.mutationForm = null;
    this.reconcileSelection = null;
    this.search = null;
    this.file = null;
    this.transfers = [];
    this.transferSeq = 0;
    this.transferNotice = '';
    this.refreshQueued = false;
    this.pollTimer = null;
    this.pollFailures = 0;
    this.pollRowNodes = new Map();
    // Live updates through the host's agent: the directory the bridge was asked to
    // watch, the directory the agent confirmed, and a queued refresh.
    this.watchRequested = null;
    this.livePath = null;
    this.liveDirty = false;
    this.liveTimer = null;
    this.liveSource = null;
    // SAA-299 temporary helper: offered only when the server has helper builds.
    this.helper = { available: false, state: 'idle', platform: '' };
    this.onVisibilityChange = () => {
      if (document.hidden) this.stopPolling();
      else this.schedulePolling();
      this.syncWatch();
    };
    if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', this.onVisibilityChange);
    this.errorMessage = '';
    this.endedReason = '';
    this.mismatch = null;
    this.finalMessage = false;
    this.callbacks = {
      onChange: onChange || (() => {}),
      onClose: onClose || (() => {}),
      onEditHost: onEditHost || (() => {}),
      onConnectionLost: onConnectionLost || (() => {}),
    };

    this.heading = el('span', { class: 'files-host' }, host.name);
    this.addressEl = el('span', { class: 'files-endpoint' }, this.endpoint);
    this.countEl = el('span', { class: 'files-count' }, '—');
    this.liveBadge = el('span', { class: 'files-live', title: 'Changes on the computer appear automatically' }, 'Live');
    this.liveBadge.hidden = true;
    // Shown while a temporary helper runs, so it is never mistaken for an installed agent.
    this.helperChip = el('span', { class: 'files-helper', title: 'A temporary connection runs on this computer for this visit only. It is deleted when you stop it or close Files.' });
    this.helperChip.hidden = true;
    this.helperButton = el('button', { type: 'button', class: 'btn btn-small files-helper-toggle', onclick: () => this.toggleHelper() }, 'Start a temporary connection for this visit');
    this.helperButton.hidden = true;
    this.crumbsEl = el('nav', { class: 'files-crumbs', 'aria-label': 'Path' });
    this.searchInputId = `files-search-${this.id}`;
    this.searchHintId = `files-search-hint-${this.id}`;
    this.searchHint = el('p', { class: 'files-search-hint', id: this.searchHintId, role: 'status' });
    this.searchHint.hidden = true;
    this.searchInput = el('input', {
      id: this.searchInputId,
      type: 'search',
      name: 'q',
      placeholder: 'Name, in this folder and below',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: '255',
      'aria-describedby': this.searchHintId,
      oninput: () => {
        if (this.searchInput.value === '' && this.search) this.clearSearch();
      },
      onkeydown: (event) => {
        if (event.key !== 'Escape' || !this.search) return;
        event.preventDefault();
        event.stopPropagation?.();
        this.clearSearch();
      },
    });
    this.searchSubmit = el('button', { type: 'submit', class: 'btn btn-small' }, 'Search');
    this.searchCancel = el('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => this.clearSearch() }, 'Cancel');
    this.searchForm = el(
      'form',
      { class: 'files-search', role: 'search', onsubmit: (event) => this.startSearch(event) },
      el('label', { class: 'label', for: this.searchInputId }, 'Find'),
      this.searchInput,
      this.searchSubmit,
      this.searchCancel,
      this.searchHint,
    );
    this.mkdirButton = el('button', { type: 'button', class: 'btn btn-small', onclick: () => this.beginMutation('mkdir') }, '+ New folder');
    this.refreshButton = el('button', { type: 'button', class: 'btn btn-small', onclick: () => this.refreshListing() }, 'Refresh');
    this.mutationToolbar = el('div', { class: 'files-mutation-toolbar' }, this.mkdirButton, this.refreshButton);
    this.listEl = el('div', { class: 'files-list', tabindex: '0', role: 'presentation', 'aria-label': 'Folder contents' });
    this.readerEl = el('section', { class: 'files-reader', role: 'region', 'aria-label': 'File' });
    this.readerEl.hidden = true;
    this.closeEl = null;
    this.footPath = el('span', { class: 'files-foot-path' });
    this.footStatus = el('span', { class: 'files-foot-status' });
    this.fileInput = el('input', {
      class: 'visually-hidden',
      type: 'file',
      multiple: true,
      tabindex: '-1',
      'aria-label': 'Choose files to upload',
      onchange: (event) => {
        const picked = [...(event.target?.files || [])];
        event.target.value = '';
        this.queueUploads(picked);
      },
    });
    this.uploadButton = el('button', {
      type: 'button',
      class: 'btn btn-small',
      onclick: () => this.fileInput.click(),
    }, 'Upload');
    this.downloadButton = el('button', {
      type: 'button',
      class: 'btn btn-small btn-primary',
      onclick: () => this.queueDownload(),
    }, 'Download');
    this.clearButton = el('button', {
      type: 'button',
      class: 'btn btn-small',
      'aria-label': 'Clear finished transfers',
      onclick: () => this.clearFinished(),
    }, 'Clear');
    this.dockCount = el('span', { class: 'dock-count' }, '00');
    this.dockNotice = el('p', { class: 'xfer-notice', role: 'status' });
    this.dockNotice.hidden = true;
    this.dockList = el('div', { class: 'dock-list' });
    this.dropCaption = el('p', { class: 'drop-caption', 'aria-hidden': 'true' }, 'Drop to upload');
    this.dockEl = el(
      'section',
      { class: 'dock', 'aria-label': 'Transfers' },
      el(
        'div',
        { class: 'dock-head' },
        el('span', { class: 'label' }, 'Transfers'),
        el('span', { class: 'files-actions' }, this.uploadButton, this.fileInput, this.downloadButton, this.clearButton),
        this.dockCount,
      ),
      this.dockNotice,
      this.dockList,
    );
    this.bindDrop(this.listEl);
    this.bindDrop(this.dockEl);
    this.filesRoot = el(
      'div',
      { class: 'files-browser' },
      el('div', { class: 'files-meta' }, el('span', { class: 'label' }, 'Files'), this.heading, this.addressEl, this.countEl, this.liveBadge, this.helperChip, this.helperButton),
      this.crumbsEl,
      this.searchForm,
      this.mutationToolbar,
      this.readerEl,
      this.listEl,
      this.dockEl,
      el('div', { class: 'files-foot' }, this.footPath, this.footStatus),
    );
    this.renderDock();
    this.overlay = el('div', { class: 'overlay' });
    this.pane = el(
      'div',
      { class: 'pane bracketed files-pane', role: 'tabpanel', id: `pane-${this.id}`, tabindex: '-1' },
      this.filesRoot,
      this.overlay,
    );
    this.pane.addEventListener('keydown', (event) => this.onListKey(event));
    this.renderPasswordPrompt();
  }

  get label() {
    return `${this.host.name} · Files`;
  }

  get endpoint() {
    return `${this.host.username}@${this.host.address}${this.host.port === 22 ? '' : `:${this.host.port}`}`;
  }

  get hasForegroundRequest() {
    return Boolean(this.pending && !this.pending.poll);
  }

  mount(stage) {
    stage.append(this.pane);
  }

  show() {
    this.pane.classList.add('active');
    this.focus();
    this.schedulePolling();
    this.syncWatch();
  }

  hide() {
    this.pane.classList.remove('active');
    this.stopPolling(true);
    this.syncWatch();
  }

  focus() {
    if (!this.pane.classList.contains('active')) return;
    if (!this.overlay.hidden) {
      const field = typeof this.overlay.querySelector === 'function' ? this.overlay.querySelector('input, .btn-primary') : null;
      if (field) {
        field.focus();
        return;
      }
    }
    if (this.state === 'ready' && this.file) {
      this.focusReader();
      return;
    }
    if (this.state === 'ready') {
      this.focusRow();
      return;
    }
    this.pane.focus();
  }

  setTheme(theme) {
    this.theme = theme || 'dark';
  }

  updateHost(host) {
    this.host = host;
    this.heading.textContent = host.name;
    this.addressEl.textContent = this.endpoint;
    this.callbacks.onChange();
  }

  scheduleFit() {}

  setState(state) {
    this.state = state;
    this.syncChrome();
    this.callbacks.onChange();
  }

  syncChrome() {
    this.filesRoot.hidden = this.state !== 'ready' && this.view !== 'ended';
  }

  dispose() {
    this.stopPolling();
    this.pane.classList.remove('active');
    this.syncWatch();
    if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', this.onVisibilityChange);
    this.disconnect();
    this.pane.remove();
  }

  send(message) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(message));
  }

  nextOp() {
    this.opSeq += 1;
    return this.opSeq;
  }

  connect(password) {
    this.disconnect();
    this.finalMessage = false;
    this.setState('connecting');
    this.renderProgress(`Connecting to ${this.host.address}…`);

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws/files`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let secret = password;

    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'connect', hostId: this.host.id, password: secret }));
      secret = null;
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      if (typeof event.data !== 'string') {
        this.acceptDownloadChunk(event.data);
        return;
      }
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.handleControl(message);
    };
    ws.onclose = (event) => {
      secret = null;
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.finalMessage) return;
      if (event.code === 4001) return;
      if (this.state === 'ready' || this.everReady) this.renderEnded('Lost the connection to the RemoteHub server.');
      else {
        this.renderPasswordPrompt("Couldn't open a file connection. Your RemoteHub login may have expired.");
        this.callbacks.onConnectionLost();
      }
    };
  }

  handleControl(message) {
    switch (message.t) {
      case 'status':
        if (message.s === 'connecting') this.renderProgress(`Connecting to ${this.host.address}…`);
        if (message.s === 'authenticating') {
          this.setState('authenticating');
          this.renderProgress(`Logging in as ${this.host.username}…`);
        }
        if (message.s === 'ready') this.onReady();
        break;
      case 'hostkey':
        if (message.status === 'new') this.renderHostKeyPrompt(message);
        if (message.status === 'mismatch') this.mismatch = message;
        break;
      case 'search-progress':
        if (this.pending?.op !== 'search' || message.id !== this.pending.id || !this.search) break;
        this.search.entries = sortEntries(message.entries).filter((entry) => absolutePath(entry.path));
        this.search.scanned = Number(message.scanned) || 0;
        this.renderBrowser();
        break;
      case 'result':
        this.onResult(message);
        break;
      case 'transfer':
        this.onTransfer(message);
        break;
      case 'error':
        if (message.id != null && message.id === this.mutation?.picker?.pending?.id) this.finishMoveBrowse(message, true);
        else if (message.id != null && this.transferById(message.id)) this.onTransferError(message);
        else if (message.id != null && this.pending && message.id === this.pending.id) this.onOpError(message);
        else if (message.id == null) this.onConnectionError(message);
        break;
      case 'watch-status':
        this.onWatchStatus(message);
        break;
      case 'helper-status':
        this.onHelperStatus(message);
        break;
      case 'fs-event':
        if (message.path === this.livePath && message.path === this.path) this.queueLiveRefresh();
        break;
      case 'closed':
        this.finalMessage = true;
        this.renderEnded(message.reason);
        break;
      default:
        break;
    }
  }

  onReady() {
    this.everReady = true;
    this.pollFailures = 0;
    this.mismatch = null;
    this.clearSearch(false);
    this.overlay.hidden = true;
    this.overlay.classList.remove('overlay-dock');
    this.overlay.replaceChildren();
    this.path = '.';
    this.entries = [];
    this.selected = -1;
    this.notice = '';
    this.file = null;
    this.view = 'loading';
    this.clearMutation();
    this.setState('ready');
    this.renderBrowser();
    this.pending = { id: this.nextOp(), path: '.', op: 'realpath' };
    this.send({ t: 'realpath', id: this.pending.id, path: '.' });
    this.focus();
  }

  onResult(message) {
    if (message.id === this.mutation?.picker?.pending?.id && message.op === 'list') {
      this.finishMoveBrowse(message);
      return;
    }
    if (!this.pending || message.id !== this.pending.id || message.op !== this.pending.op) return;
    const isPoll = this.pending.poll === true;
    if (this.mutation?.busy && message.id === this.mutation.id) {
      const action = this.mutation;
      this.pending = null;
      this.refreshQueued = false;
      this.clearMutation();
      this.reconcileSelection = action.action === 'mkdir' || action.action === 'rename' ? action.draft : null;
      this.reconcileNotice = `${this.mutationLabel(action.action)} complete. Folder refreshed.`;
      this.notice = `${this.mutationLabel(action.action)} complete. Refreshing folder…`;
      this.mutationFocus = 'row';
      this.refreshListing();
      this.renderBrowser();
      return;
    }
    if (message.op === 'search') {
      clearTimeout(this.pending.timer);
      this.pending = null;
      if (!this.search) return;
      this.search.status = 'complete';
      this.search.entries = sortEntries(message.entries).filter((entry) => absolutePath(entry.path));
      this.search.truncated = message.truncated === true;
      this.search.reason = message.reason;
      this.search.skipped = Number(message.skipped) || 0;
      this.renderBrowser();
      return;
    }
    if (message.op === 'realpath') {
      this.pending = null;
      const path = absolutePath(message.path);
      if (!path) {
        this.view = 'error';
        this.errorMessage = 'The computer did not return a folder.';
        this.renderBrowser();
        return;
      }
      this.openPath(path);
      return;
    }
    if (message.op === 'read') {
      this.finishPending();
      if (!this.file) return;
      const text = typeof message.text === 'string' ? message.text : '';
      this.file = {
        ...this.file,
        status: 'text',
        lines: textLines(text),
        truncated: message.truncated === true,
        size: typeof message.size === 'number' ? message.size : this.file.size,
      };
      this.renderBrowser();
      return;
    }
    const reveal = this.reconcileSelection;
    const quiet = this.pending.quiet === true;
    const selectedName = this.reconcileSelection || this.entries[this.selected]?.name;
    this.reconcileSelection = null;
    this.pollFailures = 0;
    this.stopPolling();
    if (isPoll) {
      this.finishPending();
      this.reconcileEntries(message.entries, selectedName);
      this.schedulePolling();
      return;
    }
    this.finishPending();
    this.entries = sortEntries(message.entries);
    if (quiet && (this.view === 'ready' || this.view === 'empty' || this.view === 'loading')) {
      this.view = this.entries.length ? 'ready' : 'empty';
      const index = selectedName ? this.entries.findIndex((entry) => entry.name === selectedName) : -1;
      this.selected = index >= 0 ? index : (this.entries.length ? Math.max(0, this.selected) : -1);
      if (this.selected >= this.entries.length) this.selected = this.entries.length ? 0 : -1;
    } else {
      this.view = this.entries.length ? 'ready' : 'empty';
      this.selected = this.entries.length ? 0 : -1;
      this.notice = '';
    }
    const revealed = reveal ? this.entries.findIndex((entry) => entry.name === reveal) : -1;
    if (revealed >= 0) this.selected = revealed;
    if (this.reconcileNotice) {
      this.notice = this.reconcileNotice;
      this.reconcileNotice = null;
    }
    this.renderBrowser();
    this.restoreMutationFocus();
  }

  onOpError(message) {
    if (this.pending?.op === 'search') {
      clearTimeout(this.pending.timer);
      this.pending = null;
      if (!this.search) return;
      this.search.status = 'error';
      this.search.code = message.code;
      this.search.message = message.code === 'denied'
        ? 'Permission denied. This account cannot search this folder.'
        : message.message || 'The search failed. Try again or clear the query.';
      this.renderBrowser();
      return;
    }
    if (this.mutation?.busy && message.id === this.mutation.id) {
      const action = this.mutation;
      this.pending = null;
      this.refreshQueued = false;
      action.busy = false;
      action.error = `${this.mutationLabel(action.action)} failed: ${(message.message || 'The remote computer refused the action.').replace(/^(mkdir|rename|move|delete) failed:\s*/i, '')}`;
      this.mutationFocus = 'draft';
      this.notice = 'Refreshing folder after the failed action; the draft is retained.';
      this.refreshListing();
      this.renderBrowser();
      return;
    }
    const poll = this.pending?.poll === true;
    const reading = this.pending?.op === 'read' && this.file;
    const quiet = this.pending?.quiet === true;
    this.finishPending();
    if (poll) {
      this.pollFailures += 1;
      this.schedulePolling();
      return;
    }
    if (quiet && !reading) {
      this.reconcileSelection = null;
      this.reconcileNotice = null;
      this.notice = `Refresh failed: ${message.message || 'RemoteHub couldn’t read this folder.'} The previous listing is shown; try Refresh again.`;
      this.renderBrowser();
      this.restoreMutationFocus();
      return;
    }
    if (reading) {
      this.file = {
        ...this.file,
        status: readStatus(message.code),
        lines: null,
        message: message.message || '',
      };
      this.renderBrowser();
      return;
    }
    this.entries = [];
    this.selected = -1;
    this.errorMessage = message.message || 'RemoteHub couldn’t open this folder. Click Refresh to try again.';
    if (message.code === 'denied') this.view = 'denied';
    else if (message.code === 'not-found') this.view = 'missing';
    else this.view = 'error';
    this.renderBrowser();
  }

  onConnectionError(message) {
    this.finalMessage = true;
    if (message.code === 'hostkey-mismatch' && this.mismatch) this.renderMismatch(this.mismatch);
    else if (this.state === 'ready' || this.everReady) this.renderEnded(message.message);
    else {
      this.renderPasswordPrompt(message.message);
      this.callbacks.onConnectionLost();
    }
  }

  openPath(path) {
    if (this.state !== 'ready' || this.mutation?.busy) return;
    const next = absolutePath(path);
    if (!next) return;
    this.clearSearch(false);
    this.stopPolling(true);
    if (this.path !== next) this.pollRowNodes.clear();
    this.clearMutation();
    this.path = next;
    this.file = null;
    this.view = 'loading';
    this.entries = [];
    this.selected = -1;
    this.notice = '';
    this.renderBrowser();
    this.pending = { id: this.nextOp(), path: next, op: 'list' };
    this.send({ t: 'list', id: this.pending.id, path: next });
    this.syncWatch();
  }

  startSearch(event) {
    event?.preventDefault();
    if (this.state !== 'ready' || this.hasForegroundRequest || this.file || this.mutation?.busy || !absolutePath(this.path)) return;
    const query = this.searchInput.value.trim();
    if (!query) {
      this.clearSearch();
      this.searchHint.hidden = false;
      this.searchHint.replaceChildren('Enter part of a file or folder name.');
      this.searchInput.focus();
      return;
    }
    if (query.length > 255 || CONTROL.test(query) || query.includes('/')) {
      this.searchHint.hidden = false;
      this.searchHint.replaceChildren('Enter a name without slashes, up to 255 characters.');
      return;
    }
    this.searchHint.hidden = true;
    this.searchHint.replaceChildren();
    this.stopPolling(true);
    this.clearMutation();
    this.search = { query, path: this.path, status: 'loading', entries: [], scanned: 0 };
    this.pending = { id: this.nextOp(), op: 'search', path: this.path };
    const request = this.pending;
    request.timer = setTimeout(() => {
      if (this.pending !== request) return;
      this.send({ t: 'cancel', id: request.id });
      this.onOpError({
        code: 'timeout',
        message: 'Search stopped responding. Clear the search and try again. If it continues, reconnect the Files session.',
      });
    }, SEARCH_REPLY_TIMEOUT_MS);
    this.send({ t: 'search', id: this.pending.id, path: this.path, query });
    this.renderBrowser();
  }

  clearSearch(render = true) {
    if (this.pending?.op === 'search') {
      clearTimeout(this.pending.timer);
      this.send({ t: 'cancel', id: this.pending.id });
      this.pending = null;
    }
    this.search = null;
    this.searchInput.value = '';
    this.searchHint.hidden = true;
    this.searchHint.replaceChildren();
    if (render) {
      if (this.refreshQueued) {
        this.refreshQueued = false;
        this.refreshListing();
      }
      this.renderBrowser();
    }
  }

  activateHit(entry) {
    if (this.state !== 'ready' || (this.pending && this.pending.op !== 'search')) return;
    const path = absolutePath(entry.path);
    if (!path) return;
    this.openPath(entry.type === 'dir' ? path : parentPath(path));
    if (entry.type !== 'dir') this.reconcileSelection = entry.name;
    this.listEl.focus();
  }

  renderSearch() {
    const search = this.search;
    this.listEl.setAttribute('role', 'presentation');
    this.listEl.setAttribute('aria-label', 'Search results');
    this.listEl.setAttribute('aria-busy', search.status === 'loading' ? 'true' : 'false');
    let label = 'Searching';
    let title = 'Searching names…';
    let detail = `In ${search.path} and its subfolders.`;
    if (search.status === 'loading') detail += ` ${search.scanned || 0} folders searched · ${search.entries.length} matches so far.`;
    if (search.status === 'error') {
      label = search.code === 'denied' ? 'Unauthorized' : search.code === 'not-found' ? 'Not found' : 'Search failed';
      title = 'Search unavailable';
      detail = search.message;
    } else if (search.status === 'ended') {
      label = 'Disconnected';
      title = 'Disconnected';
      detail = 'The Files connection ended. Reconnect to search again.';
    } else if (search.status === 'complete') {
      label = search.entries.length ? 'Name search' : 'No match';
      title = search.entries.length ? `${search.entries.length} ${search.entries.length === 1 ? 'match' : 'matches'} for “${search.query}”` : search.truncated ? 'No matches found before the search limit.' : `No names match “${search.query}”`;
      detail = search.truncated ? `${search.reason === 'timeout' ? 'Time limit reached. Showing matches found so far.' : 'Search limit reached.'} Narrow the name or search from a deeper folder.` : `In ${search.path} and its subfolders.`;
      if (search.skipped) detail += ` ${search.skipped} ${search.skipped === 1 ? 'folder' : 'folders'} could not be read.`;
    }
    this.listEl.replaceChildren(
      el('div', { class: `files-search-summary is-${search.status}`, role: 'status' },
        el('span', { class: 'label' }, label), el('h2', {}, title), el('p', {}, detail)),
      ...search.entries.map((entry) => el('button', {
        type: 'button', class: 'files-row files-search-hit',
        disabled: this.state !== 'ready',
        onclick: () => this.activateHit(entry),
      }, el('span', { class: 'files-name' }, ...markMatch(entry.name, search.query)),
      el('span', { class: 'files-meta-line' }, `${typeLabel(entry.type)}  ·  ${formatSize(entry)}  ·  ${formatModified(entry.mtime)}`),
      el('span', { class: 'files-search-path' }, entry.path))),
    );
    this.countEl.textContent = ['loading', 'complete'].includes(search.status) ? String(search.entries.length).padStart(2, '0') : '—';
    this.footStatus.textContent = search.status === 'loading' ? 'Searching' : title;
  }

  activate(index) {
    if (this.state !== 'ready' || this.view !== 'ready' || this.hasForegroundRequest) return;
    const entry = this.entries[index];
    if (!entry) return;
    this.stopPolling(true);
    this.selected = index;
    this.clearMutation();
    if (entry.type === 'dir' || entry.type === 'symlink') {
      const next = joinPath(this.path, entry.name);
      if (next) this.openPath(next);
      return;
    }
    this.notice = '';
    this.renderBrowser();
    this.focusRow();
  }

  openFile(index) {
    if (this.hasForegroundRequest || this.mutation?.busy) return;
    this.clearMutation();
    const entry = this.entries[index];
    if (!entry || entry.type !== 'file' || this.state !== 'ready') return;
    const path = joinPath(this.path, entry.name);
    if (!path) return;
    this.stopPolling(true);
    this.selected = index;
    this.notice = '';
    this.file = {
      name: entry.name,
      path,
      status: 'loading',
      lines: null,
      truncated: false,
      size: entry.size,
      message: '',
    };
    this.renderBrowser();
    this.pending = { id: this.nextOp(), path, op: 'read' };
    this.send({ t: 'read', id: this.pending.id, path });
    this.focusReader();
  }

  closeFile() {
    if (!this.file) return;
    if (this.pending?.op === 'read') this.pending = null;
    this.file = null;
    this.notice = '';
    this.renderBrowser();
    if (this.state === 'ready' && this.view === 'ready') this.focusRow();
  }

  moveSelection(delta) {
    if (this.state !== 'ready' || this.view !== 'ready' || !this.entries.length || this.mutation?.busy) return;
    this.clearMutation();
    if (this.selected < 0) this.selected = delta < 0 ? this.entries.length - 1 : 0;
    else this.selected = Math.min(this.entries.length - 1, Math.max(0, this.selected + delta));
    this.notice = '';
    this.renderBrowser();
  }

  onListKey(event) {
    if (this.state !== 'ready') return;
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (event.target && typeof event.target.closest === 'function' && event.target.closest('.dock')) return;
    if (event.target?.closest?.('.files-mutation-form')) return;
    if (event.key === 'Escape' && this.mutation && !this.mutation.busy) {
      event.preventDefault();
      this.clearMutation();
      this.notice = '';
      this.renderBrowser();
      this.focusRow();
      return;
    }
    if (this.search) {
      if (event.key === 'Escape') { event.preventDefault(); this.clearSearch(); this.searchInput.focus(); }
      return;
    }
    if (this.file) {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeFile();
      }
      return;
    }
    if (event.key === 'Backspace') {
      event.preventDefault();
      const parent = parentPath(this.path);
      if (parent) this.openPath(parent);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.moveSelection(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveSelection(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      this.moveSelectionTo(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      this.moveSelectionTo(this.entries.length - 1);
    }
  }

  moveSelectionTo(index) {
    if (this.state !== 'ready' || this.view !== 'ready' || !this.entries.length || this.mutation?.busy) return;
    this.clearMutation();
    this.selected = Math.min(this.entries.length - 1, Math.max(0, index));
    this.notice = '';
    this.renderBrowser();
  }

  focusRow() {
    const row = this.rowElement(this.selected);
    if (row) row.focus();
    else this.listEl.focus();
  }

  focusReader() {
    if (this.closeEl) this.closeEl.focus();
  }

  rowElement(index) {
    const name = this.entries[index]?.name;
    if (!name) return null;
    const walk = (node) => {
      if (!node || typeof node !== 'object' || typeof node.getAttribute !== 'function') return null;
      if (node.getAttribute('data-files-key') === name) return node;
      for (const child of node.children || []) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this.listEl);
  }

  mutationLabel(action) {
    return { mkdir: 'Create folder', rename: 'Rename', move: 'Move', delete: 'Delete' }[action];
  }

  clearMutation() {
    this.mutation = null;
    this.mutationForm = null;
    this.mutationInput = null;
    this.mutationError = null;
    this.mutationSubmit = null;
    this.mutationCancel = null;
    this.movePickerEl = null;
    this.mutationFocus = null;
    this.reconcileNotice = null;
    this.reconcileSelection = null;
  }

  restoreMutationFocus() {
    const focus = this.mutationFocus;
    this.mutationFocus = null;
    if (!focus || !this.pane.classList.contains('active') || !this.pane.contains?.(document.activeElement)) return;
    if (focus === 'draft' && this.mutation?.picker) this.movePickerEl.focus();
    else if (focus === 'draft' && this.mutationInput && this.mutation) this.mutationInput.focus();
    else this.focusRow();
  }

  beginMutation(action) {
    if (this.state !== 'ready' || this.hasForegroundRequest || this.file || this.search || this.mutation?.busy) return;
    if (this.transfers.some((transfer) => transfer.state === 'queued' || transfer.state === 'transferring')) {
      this.notice = 'Wait for transfers to finish before changing files.';
      this.renderBrowser();
      return;
    }
    const entry = this.entries[this.selected];
    if (action !== 'mkdir' && !entry) return;
    const path = action === 'mkdir' ? this.path : joinPath(this.path, entry.name);
    if (!path) return;
    this.stopPolling(true);
    this.mutation = { action, path, name: entry?.name, type: entry?.type, draft: action === 'rename' ? entry.name : action === 'move' ? this.path : '', busy: false, error: '' };
    const change = this.mutation;
    if (action === 'move') change.picker = { path: this.path, entries: this.entries, pending: null, error: '' };
    this.mutationInput = action === 'move' ? null : el('input', {
      type: 'text', value: change.draft, autocomplete: 'off', spellcheck: 'false', required: true,
      'aria-describedby': `mutation-note-${this.id}`,
      oninput: () => { change.draft = this.mutationInput.value; this.updateMutationForm(); },
    });
    this.mutationError = el('p', { class: 'form-error', role: 'alert' });
    this.mutationSubmit = el('button', { type: 'submit', class: `btn btn-small${action === 'delete' ? '' : ' btn-primary'}` }, this.mutationLabel(action));
    this.mutationCancel = el('button', { type: 'button', class: 'btn btn-small', onclick: () => {
      if (this.mutation?.busy) return;
      this.clearMutation(); this.notice = ''; this.renderBrowser(); this.focusRow();
    } }, 'Cancel');
    const fieldLabel = action === 'delete' ? 'Type the exact name to confirm' : action === 'mkdir' ? 'Folder name' : 'New name';
    this.mutationForm = el('form', {
      class: 'files-mutation-form',
      onsubmit: (event) => { event.preventDefault(); this.submitMutation(); },
      onkeydown: (event) => {
        if (event.key === 'Escape' && !this.mutation?.busy) {
          event.preventDefault(); event.stopPropagation?.();
          this.clearMutation(); this.notice = ''; this.renderBrowser(); this.focusRow();
        }
      },
    },
    el('span', { class: 'label' }, action === 'delete' ? 'Permanent removal' : 'File action'),
    el('h2', {}, this.mutationLabel(action), action === 'mkdir' ? '' : ` ${entry.name}`),
    el('p', { class: 'hint' }, path),
    el('p', { class: 'hint', id: `mutation-note-${this.id}` }, action === 'delete'
      ? (entry.type === 'dir' ? 'This folder and its contents will be permanently removed. Deleted files can’t be recovered.' : 'This item will be permanently removed. Deleted files can’t be recovered.')
      : action === 'move' ? 'Keep the current name. Existing destinations will not be replaced.' : 'Existing items will not be replaced.'),
    action === 'move' ? this.createMovePicker() : el('label', { class: 'field' }, el('span', { class: 'label' }, fieldLabel), this.mutationInput),
    this.mutationError,
    el('div', { class: 'files-actions' }, this.mutationSubmit, this.mutationCancel));
    this.notice = '';
    this.renderBrowser();
    if (action === 'move') this.movePickerEl.focus();
    else { this.mutationInput.focus(); this.mutationInput.select?.(); }
  }

  createMovePicker() {
    this.movePickerEl = el('div', { class: 'files-move-picker', tabindex: '-1', 'aria-label': 'Destination folders' });
    this.renderMovePicker();
    return this.movePickerEl;
  }

  browseMove(path) {
    const change = this.mutation;
    if (!change?.picker || change.busy || this.pending || change.picker.pending) return;
    const next = absolutePath(path);
    if (!next || (change.type === 'dir' && (next === change.path || next.startsWith(`${change.path}/`)))) {
      change.picker.error = 'Start the path with / and choose a folder outside the one being moved.';
      this.renderMovePicker(); return;
    }
    change.picker.pending = { id: this.nextOp(), path: next };
    change.picker.error = '';
    this.movePickerEl.focus();
    this.renderMovePicker(); this.updateMutationForm();
    this.send({ t: 'list', id: change.picker.pending.id, path: next });
  }

  finishMoveBrowse(message, failed = false) {
    const change = this.mutation;
    const picker = change.picker;
    const next = picker.pending.path;
    picker.pending = null;
    if (failed) picker.error = `Cannot browse destination: ${message.message || 'Folder unavailable.'}`;
    else {
      picker.path = next; picker.entries = sortEntries(message.entries); picker.error = '';
      change.draft = next;
    }
    this.renderMovePicker(); this.updateMutationForm();
  }

  renderMovePicker() {
    const change = this.mutation;
    if (!change?.picker || !this.movePickerEl) return;
    const picker = change.picker;
    const disabled = change.busy || Boolean(picker.pending) || Boolean(this.pending);
    const folders = picker.entries.filter(entry => entry.type === 'dir'
      && !(change.type === 'dir' && (joinPath(picker.path, entry.name) === change.path || joinPath(picker.path, entry.name)?.startsWith(`${change.path}/`))));
    const parent = parentPath(picker.path);
    const choices = [{ label: `Current folder: ${picker.path}`, path: picker.path },
      ...(parent ? [{ label: `↑ Parent folder: ${parent}`, path: parent }] : []),
      ...folders.map(entry => ({ label: `${entry.name} /`, path: joinPath(picker.path, entry.name) }))];
    const optionNodes = [];
    let focused = 0;
    const close = () => { picker.expanded = false; menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); trigger.focus(); };
    const open = () => {
      picker.expanded = true; menu.hidden = false; trigger.setAttribute('aria-expanded', 'true');
      optionNodes[focused].focus();
      menu.scrollIntoView?.({ block: 'nearest' });
    };
    const trigger = el('button', { type: 'button', class: 'files-folder-select', disabled,
      'aria-label': `Destination folder: ${picker.path}`, 'aria-haspopup': 'listbox', 'aria-expanded': String(Boolean(picker.expanded)), 'aria-controls': `move-folders-${this.id}`,
      onclick: () => picker.expanded ? close() : open(),
      onkeydown: event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); open(); } } },
      el('span', {}, picker.path), el('span', { 'aria-hidden': 'true' }, '▾'));
    const menu = el('div', { class: 'files-folder-options', id: `move-folders-${this.id}`, role: 'listbox', 'aria-label': 'Destination folders',
      onkeydown: event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
        const next = event.key === 'ArrowDown' ? (focused + 1) % choices.length : event.key === 'ArrowUp' ? (focused + choices.length - 1) % choices.length : event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : null;
        if (next !== null) { event.preventDefault(); event.stopPropagation(); focused = next; optionNodes[next].focus(); }
      } }, choices.map((choice, index) => {
        const option = el('button', { type: 'button', class: 'files-folder-option', role: 'option', 'aria-selected': String(choice.path === picker.path),
          tabindex: '-1', onfocus: () => { focused = index; }, onclick: () => { close(); this.browseMove(choice.path); } }, choice.label);
        optionNodes.push(option); return option;
      }));
    menu.hidden = !picker.expanded;
    const selector = el('div', { class: 'files-folder-control', onfocusout: event => {
      if (!selector.contains?.(event.relatedTarget)) { picker.expanded = false; menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }
    } }, trigger, menu);
    this.movePickerEl.replaceChildren(
      el('div', { class: 'field' }, el('span', { class: 'label' }, 'Destination folder'), selector),
      el('p', { class: 'hint', role: 'status' }, picker.pending ? 'Loading folders…' : folders.length ? 'Select a folder to browse into it, then choose Move here.' : 'No subfolders. You can move into this folder or select its parent.'),
      ...(picker.error ? [el('p', { class: 'form-error', role: 'alert' }, picker.error)] : []));
  }

  updateMutationForm() {
    if (!this.mutation) return;
    const change = this.mutation;
    this.mutationError.hidden = !change.error;
    this.mutationError.replaceChildren(change.error);
    this.setButtonDisabled(this.mutationSubmit, Boolean(this.pending) || change.busy || Boolean(change.picker?.pending) || (change.action === 'move' && change.draft === this.path) || (change.action === 'delete' && change.draft !== change.name));
    this.setButtonDisabled(this.mutationCancel, change.busy);
    if (this.mutationInput) this.setButtonDisabled(this.mutationInput, change.busy);
    this.mutationSubmit.replaceChildren(change.busy ? 'Working…' : change.action === 'move' ? 'Move here' : this.mutationLabel(change.action));
  }

  submitMutation() {
    const change = this.mutation;
    if (!change || change.busy || this.pending || change.picker?.pending || this.state !== 'ready') return;
    change.draft = change.action === 'move' ? change.picker.path : this.mutationInput.value;
    const { action, draft } = change;
    const destinationDir = action === 'move' ? absolutePath(draft) : this.path;
    const destination = action === 'move' ? joinPath(destinationDir, change.name) : joinPath(this.path, draft);
    let error = '';
    if (action === 'delete') {
      if (draft !== change.name) error = 'Type the exact item name to confirm deletion.';
    } else if (!destination || !draft.trim()) error = action === 'move' ? 'Choose a destination folder.' : 'Enter one name without slashes or control characters.';
    else if (destination === change.path) error = 'Choose a different name or folder.';
    if (error) {
      change.error = `${this.mutationLabel(action)} failed: ${error}`;
      this.updateMutationForm();
      if (action === 'move') this.movePickerEl.focus();
      else this.mutationInput.focus();
      return;
    }
    change.busy = true;
    change.error = '';
    change.id = this.nextOp();
    // Keep focus on a stable element while its input and submit become disabled.
    this.mutationForm.setAttribute('tabindex', '-1');
    this.mutationForm.focus();
    this.pending = { id: change.id, op: action, path: change.path };
    this.send({ t: action, id: change.id, path: action === 'mkdir' ? destination : change.path,
      ...(action === 'rename' || action === 'move' ? { destination } : {}),
      ...(action === 'delete' ? { confirm: draft } : {}) });
    this.renderBrowser();
  }

  rowActions(entry, index) {
    const action = (label, callback) => el('button', { type: 'button', class: 'btn btn-small', disabled: this.hasForegroundRequest, 'data-files-action': label, onclick: callback }, label);
    return el('div', { class: 'files-inline-actions' },
      entry.type === 'file' ? action('Open', () => this.openFile(this.entries.findIndex((item) => item.name === entry.name))) : null,
      action('Rename', () => this.beginMutation('rename')),
      action('Move', () => this.beginMutation('move')),
      action('Delete', () => this.beginMutation('delete')));
  }

  renderBrowser() {
    const previous = typeof document !== 'undefined' ? document.activeElement : null;
    const keepFocus = this.pane.classList.contains('active')
      && previous
      && typeof this.pane.contains === 'function'
      && this.pane.contains(previous);

    const crumbs = crumbList(this.path);
    const browsing = this.state === 'ready';
    const detachedMutation = this.mutation && !this.entries.some((entry) => entry.name === this.mutation.name);
    const trail = this.file
      ? [...crumbs.map((crumb) => ({ ...crumb, current: false })), { label: this.file.name, path: this.file.path, current: true }]
      : crumbs.map((crumb, index) => ({ ...crumb, current: index === crumbs.length - 1 }));
    this.crumbsEl.replaceChildren(
      ...trail.map((crumb) => {
        if (crumb.current) return el('span', { class: 'files-crumb current', 'aria-current': 'page' }, crumb.label);
        return el('button', {
          type: 'button',
          class: 'files-crumb',
          disabled: !browsing,
          onclick: () => {
            if (this.file && crumb.path === this.path) this.closeFile();
            else this.openPath(crumb.path);
          },
        }, crumb.label);
      }),
    );

    this.listEl.setAttribute('aria-busy', this.view === 'loading' ? 'true' : 'false');
    if (this.view === 'ready') {
      this.listEl.setAttribute('role', 'listbox');
      const children = [this.dropCaption];
      if (this.mutation && (this.mutation.action === 'mkdir' || detachedMutation)) children.push(this.mutationForm);
      const liveNames = new Set();
      this.entries.forEach((entry, index) => {
        const signature = JSON.stringify([entry.type, entry.size, entry.mtime, index === this.selected, this.hasForegroundRequest, this.mutation?.name === entry.name && this.mutation.action !== 'mkdir']);
        const mutationForm = index === this.selected && this.mutation?.name === entry.name && this.mutation.action !== 'mkdir' ? this.mutationForm : null;
        let cached = this.pollRowNodes.get(entry.name);
        if (!cached || cached.signature !== signature || cached.mutationForm !== mutationForm) {
          cached = { signature, mutationForm, nodes: this.entryRow(entry, index) };
          this.pollRowNodes.set(entry.name, cached);
        }
        liveNames.add(entry.name);
        children.push(...cached.nodes);
      });
      for (const name of this.pollRowNodes.keys()) if (!liveNames.has(name)) this.pollRowNodes.delete(name);
      let cursor = this.listEl.firstChild;
      for (const node of children) {
        if (node === cursor) cursor = cursor.nextSibling;
        else this.listEl.insertBefore(node, cursor);
      }
      while (cursor) {
        const next = cursor.nextSibling;
        this.listEl.removeChild(cursor);
        cursor = next;
      }
    } else {
      this.listEl.setAttribute('role', 'presentation');
      const copy = this.stateCopy();
      this.listEl.replaceChildren(
        this.dropCaption,
        ...(this.mutation ? [this.mutationForm] : []),
        el(
          'div',
          { class: `files-state files-state-${this.view}`, role: 'status' },
          el('span', { class: 'label' }, copy.label),
          el('h2', {}, copy.title),
          copy.detail ? el('p', {}, copy.detail) : null,
        ),
      );
    }

    const listed = this.view === 'ready' ? this.entries.length : null;
    this.countEl.textContent = listed === null ? '—' : String(listed).padStart(2, '0');
    this.listEl.hidden = Boolean(this.file);
    this.readerEl.hidden = !this.file;
    if (this.file) this.renderReader();
    else {
      this.closeEl = null;
      this.readerEl.replaceChildren();
    }
    this.renderHelper();
    this.footPath.textContent = this.file?.path || this.path || '—';
    this.footStatus.textContent = this.file ? this.fileFoot() : this.footLabel();
    this.searchForm.hidden = Boolean(this.file);
    this.setButtonDisabled(this.searchInput, this.state !== 'ready' || (this.hasForegroundRequest && this.pending.op !== 'search') || Boolean(this.mutation?.busy));
    this.setButtonDisabled(this.searchSubmit, this.state !== 'ready' || this.hasForegroundRequest || Boolean(this.mutation?.busy) || !absolutePath(this.path));
    this.searchCancel.hidden = !this.search;
    this.searchCancel.replaceChildren(this.search?.status === 'loading' ? 'Cancel' : 'Clear');
    if (this.search) this.renderSearch();
    else this.listEl.setAttribute('aria-label', 'Folder contents');
    this.mutationToolbar.hidden = Boolean(this.file) || Boolean(this.search) || this.state !== 'ready';
    this.setButtonDisabled(this.mkdirButton, this.hasForegroundRequest || !['ready', 'empty'].includes(this.view));
    this.setButtonDisabled(this.refreshButton, this.hasForegroundRequest);
    this.updateMutationForm();
    this.renderDock();
    this.syncChrome();
    this.schedulePolling();

    if (keepFocus) {
      if (this.pane.contains?.(previous)) return;
      if (this.searchForm.contains?.(previous)) previous.focus();
      else if (this.search) return;
      else if (this.mutationForm?.contains?.(previous)) previous.focus();
      else if (this.file) this.focusReader();
      else if (this.pending) this.listEl.focus();
      else if (this.view === 'ready' && this.selected >= 0) this.focusRow();
      else this.listEl.focus();
    }
  }

  renderReader() {
    const copy = fileCopy(this.file);
    const nameId = `file-name-${this.id}`;
    const kicker = this.file.status === 'text' || this.file.status === 'loading' ? 'Read only' : copy.kicker;
    this.closeEl = el('button', {
      type: 'button',
      class: 'btn btn-small files-reader-close',
      'aria-label': `Close ${this.file.name} and return to the folder`,
      onclick: () => this.closeFile(),
    }, 'Close');
    const head = el(
      'div',
      { class: 'files-reader-head' },
      el(
        'div',
        {},
        el('p', { class: 'files-reader-kicker' }, kicker),
        el('h2', { class: 'files-reader-name', id: nameId }, this.file.name),
        el('p', { class: 'files-reader-path' }, this.file.path),
      ),
      this.closeEl,
    );
    const body = this.file.status === 'text'
      ? el(
        'div',
        { class: 'files-reader-body' },
        el('ol', { class: 'files-manuscript' }, ...(this.file.lines || []).map((line) => el('li', {}, line))),
        this.file.truncated
          ? el('p', { class: 'files-window-note' }, 'The rest of this file stays on the computer. It was not loaded into this page.')
          : null,
      )
      : el(
        'div',
        { class: 'files-reader-body' },
        el(
          'div',
          { class: 'files-state files-reader-state', role: 'status' },
          el('span', { class: 'label' }, copy.kicker),
          el('h2', {}, copy.title),
          copy.detail ? el('p', {}, copy.detail) : null,
        ),
      );
    this.readerEl.replaceChildren(head, body);
    this.readerEl.setAttribute('aria-labelledby', nameId);
  }

  fileFoot() {
    if (this.file.status === 'text') {
      const count = this.file.lines?.length || 0;
      if (this.file.truncated) return `Lines 1–${count} · the rest stays on the computer`;
      const noun = count === 1 ? 'line' : 'lines';
      return `${count} ${noun} · entire file`;
    }
    return fileCopy(this.file).kicker;
  }

  stateCopy() {
    if (this.view === 'loading') return { label: 'Loading', title: 'Listing this folder.', detail: this.path };
    if (this.view === 'empty') return { label: 'Empty', title: 'This folder is empty.', detail: 'There is nothing to open here.' };
    if (this.view === 'denied') return { label: 'Unauthorized', title: 'Permission denied.', detail: 'The account on this computer can’t open this folder.' };
    if (this.view === 'missing') return { label: 'Not found', title: 'This file or folder doesn’t exist.', detail: this.path };
    if (this.view === 'ended') {
      const reason = this.endedReason || 'The Files connection ended.';
      return {
        label: 'Disconnected',
        title: 'The Files connection ended.',
        detail: reason === 'The Files connection ended.' ? `The connection to ${this.host.name} closed.` : reason,
      };
    }
    return { label: 'Files', title: this.errorMessage || 'RemoteHub couldn’t open this folder. Click Refresh to try again.', detail: this.path };
  }

  footLabel() {
    if (this.notice) return this.notice;
    if (this.view === 'ready') {
      const noun = this.entries.length === 1 ? 'entry' : 'entries';
      return `${this.entries.length} ${noun}`;
    }
    if (this.view === 'loading') return 'Listing';
    if (this.view === 'empty') return 'Empty folder';
    if (this.view === 'denied') return 'Permission denied';
    if (this.view === 'missing') return 'Not found';
    if (this.view === 'ended') return 'Session ended';
    return 'Listing failed';
  }

  finishPending() {
    if (this.pending?.pollTimer) clearTimeout(this.pending.pollTimer);
    this.pending = null;
    if (!this.refreshQueued || this.state !== 'ready') return;
    this.refreshQueued = false;
    this.refreshListing();
  }

  refreshListing() {
    if (this.state !== 'ready' || typeof this.path !== 'string' || !this.path.startsWith('/')) return;
    if (this.pending || this.search) {
      this.refreshQueued = true;
      return;
    }
    this.pending = { id: this.nextOp(), path: this.path, op: 'list', quiet: true };
    this.send({ t: 'list', id: this.pending.id, path: this.path });
  }

  stopPolling(cancelInFlight = false) {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (cancelInFlight && this.pending?.poll === true) {
      const request = this.pending;
      if (request.pollTimer) clearTimeout(request.pollTimer);
      this.pending = null;
      this.send({ t: 'cancel', id: request.id });
    }
  }

  canPollDirectory() {
    return !this.isLive() && this.canRefreshQuietly();
  }

  canRefreshQuietly() {
    return this.state === 'ready'
      && this.ws?.readyState === 1
      && this.pane.classList.contains('active')
      && (typeof document === 'undefined' || !document.hidden)
      && ['ready', 'empty'].includes(this.view)
      && !this.pending
      && !this.search
      && !this.file
      && !this.mutation
      && !this.transfers.some((transfer) => transfer.state === 'queued' || transfer.state === 'transferring')
      && Boolean(absolutePath(this.path));
  }

  // ---- Live updates (SAA-298) -------------------------------------------------

  /** Ask the bridge to watch exactly the visible directory, or nothing. */
  syncWatch() {
    const visible = this.state === 'ready'
      && this.ws?.readyState === 1
      && this.pane.classList.contains('active')
      && (typeof document === 'undefined' || !document.hidden);
    const wanted = visible ? absolutePath(this.path) : null;
    if (wanted === this.watchRequested) return;
    if (this.livePath && this.livePath !== wanted) this.clearLive();
    this.watchRequested = wanted;
    if (this.ws?.readyState !== 1) return;
    if (wanted) this.send({ t: 'watch', path: wanted });
    else this.send({ t: 'unwatch' });
  }

  clearLive() {
    this.livePath = null;
    this.liveDirty = false;
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = null;
    if (this.pane.dataset) {
      this.pane.dataset.live = 'off';
      this.pane.dataset.liveSource = '';
    }
    this.liveSource = null;
    this.liveBadge.hidden = true;
  }

  // ---- Temporary helper (SAA-299) ---------------------------------------------

  toggleHelper() {
    if (this.state !== 'ready' || this.ws?.readyState !== 1) return;
    if (this.helper.state === 'running') this.send({ t: 'helper-stop' });
    else if (['idle', 'stopped', 'failed'].includes(this.helper.state)) {
      this.helper.state = 'starting';
      this.send({ t: 'helper-start' });
    }
    this.renderHelper();
  }

  onHelperStatus(message) {
    const helper = this.helper;
    if (message.s === 'available') {
      helper.available = true;
    } else if (['starting', 'running', 'stopping'].includes(message.s)) {
      helper.state = message.s;
      if (message.platform) helper.platform = String(message.platform);
      if (message.s === 'running') this.notice = 'Temporary connection running for this visit. Nothing is installed; it is removed when you stop it or close Files.';
    } else if (message.s === 'stopped') {
      helper.state = 'stopped';
      this.notice = message.cleaned === false
        ? 'Temporary connection stopped, but RemoteHub couldn’t confirm its files were removed from the computer.'
        : 'Temporary connection stopped and removed from the computer.';
    } else if (message.s === 'failed') {
      helper.state = 'failed';
      this.notice = `Temporary connection couldn’t start: ${message.reason || 'unknown error'}${message.cleaned === false ? ' Cleanup could not be confirmed.' : ''}`;
    }
    this.renderBrowser();
  }

  renderHelper() {
    if (!this.helperButton) return;
    const { available, state, platform } = this.helper;
    const agentLive = this.isLive() && this.liveSource === 'agent';
    // Offer the helper only when it adds something: not while an installed agent is live.
    this.helperButton.hidden = !available || this.state !== 'ready' || (agentLive && state !== 'running');
    this.helperButton.textContent = {
      starting: 'Starting the temporary connection\u2026',
      running: 'Stop the temporary connection',
      stopping: 'Removing the temporary connection\u2026',
    }[state] || 'Start a temporary connection for this visit';
    this.setButtonDisabled(this.helperButton, state === 'starting' || state === 'stopping');
    this.helperChip.hidden = !['starting', 'running', 'stopping'].includes(state);
    this.helperChip.textContent = `Temporary connection for this visit${platform ? ` \u00b7 ${platform}` : ''}${state === 'running' ? '' : ` \u00b7 ${state}`}`;
    if (this.pane.dataset) this.pane.dataset.helper = state;
  }

  isLive() {
    return Boolean(this.livePath) && this.livePath === this.path;
  }

  onWatchStatus(message) {
    if (message.path && message.path !== this.watchRequested) return; // stale
    if (message.s === 'live') {
      this.livePath = message.path;
      this.liveSource = message.source === 'helper' ? 'helper' : 'agent';
      if (this.pane.dataset) {
        this.pane.dataset.live = 'on';
        this.pane.dataset.liveSource = this.liveSource;
      }
      this.liveBadge.textContent = this.liveSource === 'helper' ? 'Live \u00b7 temporary connection for this visit' : 'Live \u00b7 agent';
      this.liveBadge.className = this.liveSource === 'helper' ? 'files-live files-live-helper' : 'files-live';
      this.liveBadge.title = this.liveSource === 'helper'
        ? 'Changes appear automatically through a temporary connection that is removed when you close Files'
        : 'Changes appear automatically through the RemoteHub agent installed on this computer';
      this.liveBadge.hidden = false;
      this.renderHelper();
      // Events now drive refreshes; the poll timer is not needed while live.
      this.stopPolling();
      // Catch anything that changed between the listing and the watch starting.
      this.queueLiveRefresh();
      return;
    }
    const wasLive = this.isLive();
    this.clearLive();
    if (message.s === 'unavailable') {
      // The directory itself went away; the next re-list reports it, and polling
      // takes over. Re-subscribing happens on the next navigation.
      this.notice = 'This folder changed on the computer and is no longer being watched.';
      this.liveDirty = true;
    } else if (wasLive && message.reason) {
      this.notice = 'Live updates paused; checking for changes periodically.';
    }
    this.renderBrowser();
    if (this.liveDirty) {
      this.liveDirty = false;
      this.runQuietList();
    }
    this.schedulePolling();
  }

  /** Coalesce change events into one quiet re-list of the current directory. */
  queueLiveRefresh() {
    if (this.liveTimer) return;
    this.liveTimer = setTimeout(() => {
      this.liveTimer = null;
      if (!this.isLive()) return;
      if (!this.canRefreshQuietly()) {
        // Busy (foreground list, mutation, transfer): refresh once it settles.
        this.liveDirty = true;
        return;
      }
      this.runQuietList();
    }, LIVE_REFRESH_DELAY_MS);
  }

  /** Quiet SFTP re-list; rows reconcile by name, so repeats are harmless. */
  runQuietList() {
    if (!this.canRefreshQuietly()) {
      this.liveDirty = true;
      return;
    }
    const id = this.nextOp();
    const request = { id, path: this.path, op: 'list', quiet: true, poll: true };
    this.pending = request;
    request.pollTimer = setTimeout(() => {
      if (this.pending !== request) return;
      this.send({ t: 'cancel', id: request.id });
      this.pollFailures += 1;
      this.finishPending();
      this.schedulePolling();
    }, DIRECTORY_POLL_REPLY_TIMEOUT_MS);
    if (this.ws?.readyState === 1) this.send({ t: 'list', id, path: this.path });
    else {
      clearTimeout(request.pollTimer);
      this.pending = null;
    }
  }

  schedulePolling() {
    if (this.isLive()) {
      this.stopPolling();
      if (this.liveDirty && this.canRefreshQuietly()) {
        this.liveDirty = false;
        this.runQuietList();
      }
      return;
    }
    if (!this.canPollDirectory()) {
      this.stopPolling();
      return;
    }
    if (this.pollTimer) return;
    const delay = Math.min(DIRECTORY_POLL_MAX_DELAY_MS, DIRECTORY_POLL_INTERVAL_MS * (2 ** this.pollFailures));
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (!this.canPollDirectory()) return;
      this.runQuietList();
    }, delay);
  }

  reconcileEntries(entries, selectedName) {
    this.entries = sortEntries(entries);
    this.view = this.entries.length ? 'ready' : 'empty';
    const index = selectedName ? this.entries.findIndex((entry) => entry.name === selectedName) : -1;
    this.selected = index >= 0 ? index : (this.entries.length ? Math.min(Math.max(this.selected, 0), this.entries.length - 1) : -1);
    this.renderBrowser();
  }

  entryRow(entry, index) {
    return [el('button', {
      type: 'button', class: 'files-row', role: 'option',
      'aria-selected': index === this.selected ? 'true' : 'false',
      'data-files-key': entry.name,
      disabled: this.hasForegroundRequest,
      onclick: () => this.activate(this.entries.findIndex((item) => item.name === entry.name)),
    },
    el('span', { class: 'files-name' }, entry.name),
    el('span', { class: 'files-meta-line' }, `${typeLabel(entry.type)}  ·  ${formatSize(entry)}  ·  ${formatModified(entry.mtime)}`)),
    index === this.selected ? this.rowActions(entry, index) : null,
    index === this.selected && this.mutation?.name === entry.name && this.mutation.action !== 'mkdir' ? this.mutationForm : null].filter(Boolean);
  }

  bindDrop(zone) {
    zone.addEventListener('dragover', (event) => {
      if (this.state !== 'ready') return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      zone.classList.add('is-drop');
    });
    zone.addEventListener('dragleave', (event) => {
      const next = event.relatedTarget;
      if (next && typeof zone.contains === 'function' && zone.contains(next)) return;
      zone.classList.remove('is-drop');
    });
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('is-drop');
      const files = [...(event.dataTransfer?.files || [])];
      this.queueUploads(files);
    });
  }

  transferById(id) {
    return this.transfers.find((transfer) => transfer.id === id) || null;
  }

  findTransferRow(id) {
    const walk = (node) => {
      if (!node || typeof node.getAttribute !== 'function') return null;
      if (node.getAttribute('data-transfer') === id) return node;
      for (const child of node.children || []) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this.dockList);
  }

  queueUploads(files) {
    if (this.search) return;
    if (this.mutation?.busy) {
      this.transferNotice = 'Wait for the file action to finish before uploading.';
      this.renderDock();
      return;
    }
    if (this.state !== 'ready' || typeof this.path !== 'string' || !this.path.startsWith('/')) {
      this.transferNotice = 'Open a folder before uploading. The folder listing was not changed.';
      this.renderDock();
      return;
    }
    const list = [...(files || [])].filter((file) => file && typeof file.name === 'string' && file.name.trim());
    if (!list.length) {
      this.transferNotice = 'No file in that drop. The folder listing was not changed.';
      this.renderDock();
      return;
    }
    let added = 0;
    for (const file of list) {
      const name = fileBaseName(file.name);
      const path = joinPath(this.path, name);
      const total = Number(file.size);
      if (!path || !Number.isSafeInteger(total) || total < 0) continue;
      this.transferSeq += 1;
      this.transfers.push({
        id: `xfer-${this.id}-${this.transferSeq}`,
        kind: 'upload',
        name,
        path,
        total,
        loaded: 0,
        state: 'queued',
        message: '',
        file,
        parts: [],
        sending: false,
      });
      added += 1;
    }
    if (!added) {
      this.transferNotice = 'Those files cannot be uploaded here. The folder listing was not changed.';
      this.renderDock();
      return;
    }
    this.transferNotice = '';
    this.renderDock();
    this.pump();
  }

  queueDownload() {
    if (this.search) return;
    if (this.state !== 'ready' || this.mutation?.busy) return;
    const entry = this.file
      ? { name: this.file.name, type: 'file', size: this.file.size }
      : this.entries[this.selected];
    if (!entry || entry.type !== 'file') {
      this.transferNotice = 'Choose a file to download. The folder listing was not changed.';
      this.renderDock();
      return;
    }
    const path = this.file?.path || joinPath(this.path, entry.name);
    const total = Number(entry.size);
    if (!path || !Number.isSafeInteger(total) || total < 0) {
      this.transferNotice = 'Choose a file to download. The folder listing was not changed.';
      this.renderDock();
      return;
    }
    const file = { name: entry.name, path, total };
    if (!canUseSavePicker()) {
      this.pushDownload({ ...file, saveKind: 'blob' });
      return;
    }
    this.chooseDownloadFile(file);
  }

  async chooseDownloadFile(file) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({ suggestedName: file.name });
    } catch (err) {
      if (err?.name === 'AbortError') {
        this.pushDownload({ ...file, state: 'cancelled' });
        return;
      }
      this.pushDownload({ ...file, saveKind: 'blob' });
      return;
    }
    try {
      const writable = await openDownloadWritable(handle);
      this.pushDownload({ ...file, saveKind: 'handle', writable });
    } catch {
      // The dialog was confirmed, so this is not a cancel, and the chosen file is
      // kept. The browser blocked the write right now, so the bytes buffer in
      // transfer.parts and are written to this same handle once the transfer
      // completes. No second save dialog is shown. Cancel discards the buffer.
      this.pushDownload({ ...file, saveKind: 'late-handle', handle });
    }
  }

  pushDownload(fields) {
    this.transferSeq += 1;
    const transfer = {
      id: `xfer-${this.id}-${this.transferSeq}`,
      kind: 'download',
      name: '',
      path: '',
      total: 0,
      loaded: 0,
      state: 'queued',
      message: '',
      parts: [],
      sending: false,
      saveKind: '',
      writable: null,
      handle: null,
      ...fields,
    };
    this.transfers.push(transfer);
    this.transferNotice = '';
    this.renderDock();
    if (transfer.state === 'queued') this.pump();
    return transfer;
  }

  cancelTransfer(id) {
    const transfer = this.transferById(id);
    if (!transfer || (transfer.state !== 'queued' && transfer.state !== 'transferring')) return;
    const wasActive = transfer.state === 'transferring';
    transfer.state = 'cancelled';
    transfer.message = '';
    transfer.parts = [];
    transfer.sending = false;
    this.abandonWritable(transfer);
    this.dropLateHandle(transfer);
    if (wasActive) {
      transfer.releasing = true;
      this.send({ t: 'cancel', id: transfer.id });
    }
    this.renderDock();
    if (!wasActive) this.pump();
  }

  clearFinished() {
    const kept = this.transfers.filter((transfer) => (
      transfer.state !== 'complete' && transfer.state !== 'error' && transfer.state !== 'cancelled'
    ));
    if (kept.length === this.transfers.length) return;
    this.transfers = kept;
    this.renderDock();
  }

  pump() {
    if (this.mutation?.busy) return;
    if (this.state !== 'ready' || !this.ws || this.ws.readyState !== 1) return;
    if (this.transfers.some((transfer) => transfer.state === 'transferring')) return;
    const next = this.transfers.find((transfer) => transfer.state === 'queued');
    if (!next) return;
    if (next.kind === 'download' && !next.saveKind) return;
    next.state = 'transferring';
    next.loaded = 0;
    next.parts = [];
    next.sending = false;
    this.renderDock();
    if (next.kind === 'upload') this.send({ t: 'put', id: next.id, path: next.path, size: next.total });
    else this.beginDownload(next);
  }

  beginDownload(transfer) {
    if (transfer.state !== 'transferring') return;
    if (transfer.saveKind !== 'handle' && transfer.saveKind !== 'late-handle') transfer.saveKind = 'blob';
    this.send({ t: 'get', id: transfer.id, path: transfer.path });
  }

  onTransfer(message) {
    const transfer = this.transferById(message.id);
    if (!transfer || transfer.state === 'cancelled' || transfer.state === 'error') {
      if (transfer?.releasing && (message.phase === 'cancelled' || message.phase === 'complete')) {
        transfer.releasing = false;
        this.pump();
      }
      return;
    }
    if (message.phase === 'start') {
      if (typeof message.size === 'number' && message.size >= 0) transfer.total = message.size;
      transfer.state = 'transferring';
      this.renderDock();
      if (transfer.kind === 'download') {
        if (transfer.total > 0) this.send({ t: 'ack', id: transfer.id });
      } else this.pushUpload(transfer);
      return;
    }
    if (message.phase === 'progress' || message.phase === 'ack') {
      if (typeof message.loaded === 'number') transfer.loaded = message.loaded;
      if (typeof message.size === 'number') transfer.total = message.size;
      this.patchRow(transfer);
      if (message.phase === 'ack' && transfer.kind === 'upload' && transfer.state === 'transferring') this.pushUpload(transfer);
      return;
    }
    if (message.phase === 'complete') {
      transfer.state = 'complete';
      transfer.loaded = typeof message.loaded === 'number' ? message.loaded : transfer.total;
      transfer.releasing = false;
      this.renderDock();
      if (transfer.kind === 'download') this.finishDownload(transfer);
      if (transfer.kind === 'upload') this.refreshListing();
      this.pump();
      return;
    }
    if (message.phase === 'cancelled') {
      transfer.state = 'cancelled';
      transfer.loaded = typeof message.loaded === 'number' ? message.loaded : transfer.loaded;
      transfer.parts = [];
      transfer.releasing = false;
      this.abandonWritable(transfer);
      this.dropLateHandle(transfer);
      this.renderDock();
      this.pump();
    }
  }

  onTransferError(message) {
    const transfer = this.transferById(message.id);
    if (!transfer) return false;
    if (transfer.state === 'cancelled') {
      transfer.releasing = false;
      this.pump();
      return true;
    }
    transfer.state = 'error';
    transfer.message = message.message || 'The transfer failed.';
    transfer.parts = [];
    transfer.releasing = false;
    this.abandonWritable(transfer);
    this.dropLateHandle(transfer);
    this.renderDock();
    this.pump();
    return true;
  }

  async acceptDownloadChunk(data) {
    const transfer = this.transfers.find((item) => item.state === 'transferring' && item.kind === 'download');
    if (!transfer) return;
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(await data.arrayBuffer());
    if (transfer.state !== 'transferring') return;
    if (transfer.writable) {
      try { await transfer.writable.write(bytes); } catch { /* the row records the failure if the stream ends */ }
    } else transfer.parts.push(bytes);
    transfer.loaded += bytes.byteLength;
    this.patchRow(transfer);
    this.send({ t: 'ack', id: transfer.id });
  }

  async pushUpload(transfer) {
    if (!transfer || transfer.kind !== 'upload' || transfer.state !== 'transferring' || transfer.sending) return;
    if (transfer.loaded >= transfer.total) {
      this.send({ t: 'put-end', id: transfer.id });
      return;
    }
    const file = transfer.file;
    if (!file || typeof file.slice !== 'function') {
      transfer.state = 'error';
      transfer.message = 'This browser could not read the file in chunks.';
      this.renderDock();
      this.send({ t: 'cancel', id: transfer.id });
      return;
    }
    transfer.sending = true;
    try {
      const end = Math.min(transfer.total, transfer.loaded + TRANSFER_CHUNK_BYTES);
      const slice = file.slice(transfer.loaded, end);
      const buf = new Uint8Array(await slice.arrayBuffer());
      if (transfer.state !== 'transferring') return;
      this.sendBytes(buf);
    } catch {
      if (transfer.state === 'transferring') {
        transfer.state = 'error';
        transfer.message = 'The file could not be read.';
        transfer.releasing = true;
        this.renderDock();
        this.send({ t: 'cancel', id: transfer.id });
      }
    } finally {
      transfer.sending = false;
    }
  }

  sendBytes(bytes) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(bytes);
  }

  async finishDownload(transfer) {
    if (transfer.state === 'cancelled') return;
    if (transfer.saveKind === 'handle' || transfer.writable) {
      const writable = transfer.writable;
      transfer.writable = null;
      transfer.saveKind = 'handle';
      if (writable) {
        try { await writable.close(); } catch { /* the bytes already streamed to the chosen file */ }
      }
      return;
    }
    if (transfer.saveKind === 'late-handle') {
      // Write the buffered bytes to the handle the user already chose. Never fall
      // back to an anchor click here, because that opens a second save dialog.
      const handle = transfer.handle;
      const parts = transfer.parts || [];
      transfer.parts = [];
      transfer.handle = null;
      try {
        const writable = await handle.createWritable();
        if (typeof Blob !== 'undefined') await writable.write(new Blob(parts));
        else for (const part of parts) await writable.write(part);
        await writable.close();
      } catch {
        transfer.state = 'error';
        transfer.message = 'The browser blocked writing to the chosen file.';
      }
      this.renderDock();
      return;
    }
    if (transfer.saveKind === 'saved') return;
    transfer.saveKind = 'saved';
    const parts = transfer.parts || [];
    transfer.parts = [];
    if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') return;
    try {
      const blob = new Blob(parts);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = transfer.name;
      link.click();
      URL.revokeObjectURL(url);
    } catch { /* the transfer row still shows Complete */ }
  }

  dropLateHandle(transfer) {
    if (!transfer || transfer.saveKind !== 'late-handle') return;
    transfer.handle = null;
    transfer.parts = [];
  }

  abandonWritable(transfer) {
    const writable = transfer?.writable;
    if (!writable) return;
    transfer.writable = null;
    writable.abort?.().catch(() => {});
  }

  patchRow(transfer) {
    const row = this.findTransferRow(transfer.id);
    if (!row || typeof row.querySelector !== 'function') {
      this.renderDock();
      return;
    }
    const bytes = row.querySelector('[data-live="bytes"]');
    if (!bytes) {
      this.renderDock();
      return;
    }
    const pct = transferPercent(transfer);
    bytes.textContent = transferBytes(transfer);
    const pctNode = row.querySelector('[data-live="pct"]');
    if (pctNode) pctNode.textContent = `${pct}%`;
    const meter = row.querySelector('[data-live="meter"]');
    if (meter?.style) meter.style.width = `${pct}%`;
    const bar = row.querySelector('[role="progressbar"]');
    if (bar) {
      bar.setAttribute('aria-valuenow', String(pct));
      bar.setAttribute('aria-valuetext', transferValueText(transfer));
    }
  }

  setButtonDisabled(button, disabled) {
    if (!button) return;
    button.disabled = disabled;
    if (disabled) button.setAttribute('disabled', '');
    else button.removeAttribute('disabled');
  }

  renderDock() {
    const browsing = this.state === 'ready' && !this.search && !this.mutation?.busy && typeof this.path === 'string' && this.path.startsWith('/');
    this.setButtonDisabled(this.uploadButton, !browsing);
    this.setButtonDisabled(this.downloadButton, this.state !== 'ready' || Boolean(this.search) || this.mutation?.busy);
    this.dockCount.textContent = String(this.transfers.length).padStart(2, '0');
    if (this.transferNotice) {
      this.dockNotice.hidden = false;
      this.dockNotice.replaceChildren(this.transferNotice);
    } else {
      this.dockNotice.hidden = true;
      this.dockNotice.replaceChildren();
    }
    if (!this.transfers.length) {
      this.dockList.replaceChildren(el('p', { class: 'dock-empty' }, 'No transfers. The folder list is unchanged.'));
      this.schedulePolling();
      return;
    }
    this.dockList.replaceChildren(...this.transfers.map((transfer) => this.transferArticle(transfer)));
    this.schedulePolling();
  }

  transferArticle(transfer) {
    const pct = transferPercent(transfer);
    const live = transfer.state === 'queued' || transfer.state === 'transferring';
    return el(
      'article',
      { class: `xfer is-${transfer.state}`, 'data-transfer': transfer.id },
      el(
        'div',
        { class: 'xfer-top' },
        el('span', { class: 'xfer-name' }, transfer.name),
        el('span', { class: 'label state-word', 'data-live': 'state' }, transferStateLabel(transfer.state)),
        el('span', { class: 'label' }, transfer.kind === 'upload' ? 'Upload' : 'Download'),
        el('span', { 'data-live': 'bytes' }, transferBytes(transfer)),
        el(
          'span',
          { class: 'xfer-end' },
          el('span', { class: 'pct', 'data-live': 'pct' }, `${pct}%`),
          live
            ? el('button', {
              type: 'button',
              class: 'btn btn-ghost btn-small',
              onclick: () => this.cancelTransfer(transfer.id),
            }, 'Cancel')
            : null,
        ),
      ),
      el(
        'div',
        {
          class: 'meter',
          role: 'progressbar',
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-valuenow': String(pct),
          'aria-valuetext': transferValueText(transfer),
          'aria-label': `${transfer.kind === 'upload' ? 'Upload' : 'Download'} ${transfer.name}`,
        },
        el('span', { 'data-live': 'meter', style: `width:${pct}%` }),
      ),
      el('p', { class: 'stream' }, transferNote(transfer)),
    );
  }

  disconnect() {
    this.stopPolling(true);
    this.clearLive();
    this.watchRequested = null;
    this.clearSearch(false);
    this.clearMutation();
    this.pending = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= 1) {
      try { ws.close(1000); } catch { /* already closing */ }
    }
  }

  showOverlay(card, { dock = false } = {}) {
    this.overlay.replaceChildren(card);
    this.overlay.classList.toggle('overlay-dock', dock);
    this.overlay.hidden = false;
    queueMicrotask(() => this.focus());
  }

  passwordForm(submitLabel, extraActions = []) {
    const input = el('input', {
      type: 'password',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': `SSH password for ${this.endpoint}`,
    });
    return el(
      'form',
      {
        onsubmit: (event) => {
          event.preventDefault();
          if (!input.value) return input.focus();
          const password = input.value;
          input.value = '';
          this.connect(password);
        },
      },
      el('label', { class: 'field' }, el('span', { class: 'label' }, 'SSH password'), input),
      el('div', { class: 'overlay-actions' }, el('button', { type: 'submit', class: 'btn btn-primary' }, submitLabel), extraActions),
    );
  }

  closeButton(label = 'Close tab') {
    return el('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: () => this.callbacks.onClose(this.id) }, label);
  }

  renderPasswordPrompt(error) {
    this.view = 'idle';
    this.setState('password');
    this.showOverlay(
      el(
        'div',
        { class: 'overlay-card bracketed' },
        el('span', { class: 'label' }, error ? "Couldn't connect" : 'Files'),
        el('h2', {}, this.host.name),
        el('p', {}, this.endpoint),
        error ? el('p', { class: 'form-error', role: 'alert' }, error) : null,
        this.passwordForm(error ? 'Try again' : 'Connect', this.everReady || error ? [this.closeButton()] : []),
      ),
    );
  }

  renderProgress(text) {
    this.showOverlay(
      el(
        'div',
        { class: 'overlay-card' },
        el('div', { class: 'overlay-progress', role: 'status' }, el('span', { class: 'dot', 'data-state': 'connecting' }), el('span', {}, text)),
        el('div', { class: 'overlay-actions' }, el('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: () => this.cancel() }, 'Cancel')),
      ),
    );
  }

  cancel() {
    this.finalMessage = true;
    this.disconnect();
    this.renderPasswordPrompt();
  }

  renderHostKeyPrompt({ keyType, fingerprint }) {
    this.setState('verify');
    const decide = (accept) => {
      this.send({ t: 'hostkey', accept });
      if (accept) this.renderProgress(`Logging in as ${this.host.username}…`);
    };
    this.showOverlay(
      el(
        'div',
        { class: 'overlay-card bracketed' },
        el('span', { class: 'label' }, 'First connection'),
        el('h2', {}, 'Check this computer’s ID'),
        el('p', {}, `RemoteHub hasn't connected to ${this.host.name} before. If this ID matches the one on that computer, trust it and RemoteHub will remember it.`),
        el('div', { class: 'kv' }, el('span', { class: 'label' }, 'Computer ID'), el('code', { class: 'fingerprint' }, fingerprint)),
        el('p', { class: 'hint' }, 'If you know the computer’s ID, check that it matches. If this is your own computer and you just set it up, it’s fine to continue.'),
        el(
          'div',
          { class: 'overlay-actions' },
          el('button', { type: 'button', class: 'btn btn-primary', onclick: () => decide(true) }, 'Trust and connect'),
          el('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: () => decide(false) }, 'Cancel'),
        ),
      ),
    );
  }

  renderMismatch({ keyType, fingerprint, expected }) {
    this.setState('ended');
    this.showOverlay(
      el(
        'div',
        { class: 'overlay-card bracketed' },
        el('span', { class: 'label' }, 'Connection blocked'),
        el('h2', {}, 'This computer’s ID changed'),
        el(
          'p',
          {},
          `${this.host.name} answered with a different computer ID than last time. That's expected after the computer was reinstalled, but it can also mean a different computer is pretending to be it. If you expected the change, open the computer’s settings, click “Forget this computer ID”, and connect again.`,
        ),
        el('div', { class: 'kv' }, el('span', { class: 'label' }, 'Saved ID'), el('code', { class: 'fingerprint expected' }, expected?.fingerprint || '')),
        el('div', { class: 'kv' }, el('span', { class: 'label' }, 'ID it sent now'), el('code', { class: 'fingerprint' }, fingerprint)),
        el(
          'div',
          { class: 'overlay-actions' },
          el('button', { type: 'button', class: 'btn btn-primary', onclick: () => this.callbacks.onEditHost(this.host) }, 'Open computer settings'),
          this.closeButton(),
        ),
      ),
    );
  }

  renderEnded(reason) {
    this.stopPolling(true);
    if (this.pending?.op === 'search') clearTimeout(this.pending.timer);
    if (this.search) { this.search.status = 'ended'; this.search.entries = []; }
    this.clearMutation();
    this.pending = null;
    this.refreshQueued = false;
    for (const transfer of this.transfers) {
      if (transfer.state === 'queued' || transfer.state === 'transferring') {
        transfer.state = 'error';
        transfer.message = 'The Files connection ended.';
        transfer.parts = [];
        this.abandonWritable(transfer);
      }
    }
    if (this.file) this.file = { ...this.file, status: 'ended', lines: null, truncated: false };
    this.view = 'ended';
    this.endedReason = reason || 'The Files connection ended.';
    this.setState('ended');
    this.renderBrowser();
    this.showOverlay(
      el(
        'div',
        { class: 'overlay-card bracketed' },
        el('span', { class: 'label' }, 'Disconnected'),
        el('h2', {}, this.host.name),
        el('p', {}, this.endedReason),
        this.passwordForm('Reconnect', [this.closeButton()]),
      ),
      { dock: true },
    );
  }
}
