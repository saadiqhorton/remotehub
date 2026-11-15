// SAA-306: Desktop backend UI pieces (Advanced "Desktop connection" chooser, Auto label,
// missing-service explanation), mounted by DesktopSession. Everything is built with el(), so
// server-provided reasons can never inject markup.
import { el } from './dom.js';
import { BACKEND_LABELS, DESKTOP_PREFERENCES, selectDesktopBackend } from './desktop-auto.js';

/** Short status line, e.g. "Auto: RDP" or "VNC". Empty when nothing can be selected. */
export function describeSelection(selection) {
  if (!selection?.backend) return '';
  return selection.auto ? `Auto: ${BACKEND_LABELS[selection.backend]}` : BACKEND_LABELS[selection.backend];
}

/**
 * Advanced chooser. One radio per preference (Auto + every backend). Unavailable
 * backends stay visible but disabled, with their reason.
 * @param {{ backends: object[], preference?: string, onSelect?: Function, onCheckAgain?: Function, checking?: boolean }} opts
 */
export function createBackendChooser({ backends = [], preference = 'auto', onSelect = () => {}, onCheckAgain = null, checking = false }) {
  const byName = new Map(backends.map((b) => [b.backend, b]));
  const name = `desktop-backend-${Math.random().toString(36).slice(2, 8)}`;
  const auto = selectDesktopBackend(backends, 'auto');
  const options = DESKTOP_PREFERENCES.filter((pref) => pref !== 'nativeStream' || byName.get(pref)?.selectable === true).map((pref) => {
    const entry = byName.get(pref);
    const selectable = pref === 'auto' ? Boolean(auto.backend) : entry?.selectable === true;
    const note = pref === 'auto'
      ? (auto.backend ? `uses ${BACKEND_LABELS[auto.backend]}` : 'nothing available')
      : (entry?.selectable ? (entry.note || 'available') : (entry?.reason || 'Not checked yet.'));
    const input = el('input', { type: 'radio', name, value: pref, checked: pref === preference, disabled: !selectable,
      onchange: () => onSelect(pref) });
    return el('label', { class: `desktop-backend-option${selectable ? '' : ' unavailable'}`, 'data-backend': pref },
      input, el('span', { class: 'desktop-backend-label' }, BACKEND_LABELS[pref]), el('span', { class: 'desktop-backend-note' }, note));
  });
  const actions = onCheckAgain
    ? el('div', { class: 'overlay-actions' }, el('button', { type: 'button', class: 'btn desktop-backend-recheck', disabled: checking, onclick: () => onCheckAgain() }, checking ? 'Checking…' : 'Check again'))
    : null;
  return el('fieldset', { class: 'desktop-backends' }, el('legend', {}, 'Desktop connection'), ...options, actions);
}

/**
 * Explanation for a failed selection: the overall reason, each backend's reason, and,
 * when no agent is connected, the optional agent/helper path.
 * @param {object} selection result of selectDesktopBackend with backend === null
 * @param {{ onSetUpAgent?: Function }} [opts]
 */
export function missingServiceExplanation(selection, { onSetUpAgent = null } = {}) {
  if (!selection || selection.backend) return null;
  const items = Object.entries(selection.reasons ?? {}).filter(([backend]) => backend !== 'nativeStream').map(([backend, reason]) =>
    el('li', { 'data-backend': backend }, el('strong', {}, `${BACKEND_LABELS[backend]}: `), reason || 'available'));
  const helper = selection.helper
    ? el('p', { class: 'desktop-helper-path' },
      'You can also install the RemoteHub agent on this computer, or let RemoteHub start a temporary connection for this visit. ',
      onSetUpAgent ? el('button', { type: 'button', class: 'btn desktop-setup-agent', onclick: () => onSetUpAgent() }, 'Set up agent') : null)
    : null;
  return el('div', { class: 'desktop-missing', role: 'status' },
    el('p', { class: 'desktop-missing-reason' }, selection.reason),
    el('ul', { class: 'desktop-missing-list' }, ...items),
    helper);
}
