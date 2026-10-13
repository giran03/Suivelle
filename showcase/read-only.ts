import './read-only.css';

// Showcase-only affordances. Content access is enforced separately by the mock command boundary.
const writeAction = /^(New\b|Create\b|Add (?!condition\b|filter\b|sort\b)|Import\b|Export\b|Upload\b|Rename\b|Delete\b|Remove (?!condition\b|filter\b|sort\b)|Move (?:to\b|page\b|selected\b)|Duplicate\b|Cut\b|Paste\b|Save\b|Restore\b|Back up\b|Backups\b|Run\b|Edit\b|Manage\b|Change (?:page\b|icon\b|cover\b|date\b)|Quick capture\b|Automations\b)/i;
const nameOf = (el: Element) => el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent?.trim() || '';
function lockedControl(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const control = target.closest<HTMLElement>('button, [role="button"], input[type="checkbox"], input[type="file"]');
  return control && (control.matches('input[type="file"]') || writeAction.test(nameOf(control)) || control.matches('.main-scroll input[type="checkbox"]')) ? control : null;
}

document.documentElement.dataset.showcase = 'read-only';
const decorate = () => {
  for (const control of document.querySelectorAll<HTMLElement>('button, [role="button"], input[type="checkbox"], input[type="file"]')) {
    if (!lockedControl(control)) continue;
    if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) control.disabled = true;
    control.setAttribute('aria-disabled', 'true');
    control.dataset.showcaseLocked = '';
  }
};
let scheduled = false;
new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; decorate(); });
}).observe(document.getElementById('root')!, { subtree: true, childList: true, characterData: true });

for (const event of ['click', 'dblclick', 'change']) {
  document.addEventListener(event, e => {
    if (!lockedControl(e.target) && !(event === 'dblclick' && e.target instanceof Element && e.target.closest('.calendar'))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
}
window.addEventListener('keydown', e => {
  const typing = e.target instanceof Element && e.target.matches('input, textarea, [contenteditable="true"]');
  if (((e.ctrlKey || e.metaKey) && ['n', 'h', 'd'].includes(e.key.toLowerCase())) || (!typing && ['Delete', 'Backspace'].includes(e.key))) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}, true);
for (const type of ['beforeinput', 'paste', 'cut']) document.addEventListener(type, e => {
  if (!(e.target instanceof Element) || !e.target.closest('.editor, .page-title, .rp-value, .cell')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);
for (const type of ['drop', 'dragover'] as const) window.addEventListener(type, e => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);
