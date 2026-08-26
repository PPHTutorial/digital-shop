/**
 * uikit — Phase 0 shared UI primitives.
 *
 * Framework-agnostic vanilla JS, mirroring the conventions in js/ui.js
 * (string-template mounting, `icon()`/`escapeHtml()` reuse, plain `export
 * function`s). Every page script includes this the same way it includes
 * ui.js: `<script type="module" src="./js/uikit.js"></script>` or an
 * `import { ... } from './uikit.js'` from another module.
 */
import { icon, escapeHtml, renderIcons } from './ui.js';
import { enhanceSelect } from './select.js';
import { enhanceCheckbox, enhanceRadio, enhanceDateInput } from './form-controls.js';

// Every openModal() call funnels arbitrary form markup (selects, checkboxes,
// radios, date inputs) into the DOM at once — this is the one place that can
// progressively-enhance all of it without every call site remembering to.
function enhanceModalControls(scopeEl) {
  scopeEl.querySelectorAll('select').forEach((el) => enhanceSelect(el, { label: el.closest('label')?.querySelector('.label')?.textContent?.trim() || '' }));
  scopeEl.querySelectorAll('input[type="checkbox"]').forEach((el) => enhanceCheckbox(el));
  scopeEl.querySelectorAll('input[type="radio"]').forEach((el) => enhanceRadio(el));
  scopeEl.querySelectorAll('input[type="date"]').forEach((el) => enhanceDateInput(el));
}

/* ==========================================================================
   Modal / dialog primitive
   ========================================================================== */

/**
 * Opens a generic `<dialog>` modal built from a title/body/footer, and
 * returns the dialog element plus a `close()` helper. Escape and backdrop
 * click both close it (native <dialog> behaviour); the caller is responsible
 * for removing the node from the DOM once done if it does not want it to
 * linger (usually not necessary — a repeat call reuses/replaces by id).
 */
export function openModal({ id, title, body = '', footer = '', danger = false, onClose } = {}) {
  document.querySelector(id ? `#${id}` : '.uk-modal[data-uk-transient]')?.remove();

  const dlg = document.createElement('dialog');
  if (id) dlg.id = id;
  else dlg.dataset.ukTransient = 'true';
  dlg.className = `uk-modal${danger ? ' uk-modal--danger' : ''}`;
  dlg.innerHTML = `
    <div class="uk-modal__head">
      <div>
        <h3>${escapeHtml(title || '')}</h3>
      </div>
      <button type="button" class="uk-modal__close" aria-label="Close">${icon('x', 16)}</button>
    </div>
    <div class="uk-modal__body">${body}</div>
    ${footer ? `<div class="uk-modal__foot">${footer}</div>` : ''}
  `;
  document.body.append(dlg);
  renderIcons();
  enhanceModalControls(dlg);

  const close = () => {
    dlg.close();
  };
  dlg.querySelector('.uk-modal__close').addEventListener('click', close);
  dlg.addEventListener('close', () => {
    onClose?.();
    dlg.remove();
  });
  // Clicking the ::backdrop lands directly on the <dialog> element itself.
  dlg.addEventListener('click', (event) => {
    if (event.target === dlg) close();
  });

  dlg.showModal();
  return { dialog: dlg, close };
}

/* ==========================================================================
   Confirmation dialog (destructive-action pattern)
   ========================================================================== */

/**
 * confirmDialog({title, body, confirmLabel, cancelLabel, danger}) -> Promise<boolean>
 * Resolves true if the user confirms, false on cancel/dismiss/Escape.
 */
export function confirmDialog({ title = 'Are you sure?', body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = true } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const { dialog, close } = openModal({
      title,
      body: `<p>${escapeHtml(body)}</p>`,
      danger,
      footer: `
        <button type="button" class="button" data-uk-cancel>${escapeHtml(cancelLabel)}</button>
        <button type="button" class="button ${danger ? 'button-danger' : 'button-primary'}" data-uk-confirm>${escapeHtml(confirmLabel)}</button>
      `,
      onClose: () => {
        if (!settled) { settled = true; resolve(false); }
      },
    });
    dialog.querySelector('[data-uk-cancel]').addEventListener('click', () => close());
    dialog.querySelector('[data-uk-confirm]').addEventListener('click', () => {
      settled = true;
      resolve(true);
      close();
    });
  });
}

/* ==========================================================================
   Tooltip primitive
   ========================================================================== */

/**
 * Attaches a CSS-driven tooltip to `el`. Nothing to tear down — it is pure
 * markup (`.uk-tip` + `data-uk-tip`), this helper just applies it.
 */
export function attachTooltip(el, text) {
  if (!el) return;
  el.classList.add('uk-tip');
  el.setAttribute('data-uk-tip', text);
  if (!el.hasAttribute('tabindex') && !['A', 'BUTTON', 'INPUT'].includes(el.tagName)) {
    el.setAttribute('tabindex', '0');
  }
}

/* ==========================================================================
   Popover primitive (generalizes the account-popover pattern)
   ========================================================================== */

let popoverWired = false;
const openPopovers = new Set();

function closeAllPopovers(except) {
  openPopovers.forEach((p) => {
    if (p !== except) { p.classList.remove('is-open'); openPopovers.delete(p); }
  });
}

/**
 * Wires `trigger` to toggle a `.uk-popover` panel of `contentHtml`, anchored
 * under the trigger. Returns {panel, open, close, toggle}. Panel is appended
 * once next to the trigger's parent and repositioned on open.
 */
export function attachPopover(trigger, contentHtml, { align = 'left' } = {}) {
  if (!trigger) return null;
  const panel = document.createElement('div');
  panel.className = 'uk-popover';
  panel.innerHTML = contentHtml;
  trigger.style.position ||= 'relative';
  const anchor = trigger.closest('[data-uk-popover-anchor]') || trigger.parentElement || trigger;
  if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';
  anchor.append(panel);
  panel.style.top = 'calc(100% + 8px)';
  if (align === 'right') panel.style.right = '0';
  else panel.style.left = '0';

  const open = () => { closeAllPopovers(panel); panel.classList.add('is-open'); openPopovers.add(panel); renderIcons(); };
  const close = () => { panel.classList.remove('is-open'); openPopovers.delete(panel); };
  const toggle = () => (panel.classList.contains('is-open') ? close() : open());

  trigger.addEventListener('click', (event) => { event.stopPropagation(); toggle(); });

  if (!popoverWired) {
    popoverWired = true;
    document.addEventListener('click', () => closeAllPopovers());
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeAllPopovers(); });
  }
  panel.addEventListener('click', (event) => event.stopPropagation());

  return { panel, open, close, toggle };
}

/* ==========================================================================
   Skeleton loaders
   ========================================================================== */

/** Inline/section skeleton: a grid of product-card-shaped placeholders. */
export function skeletonCardGrid(count = 4) {
  const card = `
    <div class="uk-skel-card">
      <div class="uk-skel uk-skel-card__media"></div>
      <div class="uk-skel-card__body">
        <div class="uk-skel uk-skel-line" style="width:40%"></div>
        <div class="uk-skel uk-skel-line" style="width:85%"></div>
        <div class="uk-skel uk-skel-line" style="width:55%"></div>
      </div>
    </div>`;
  return `<div class="uk-skel-grid">${card.repeat(count)}</div>`;
}

/** Renders a skeleton grid into `host` immediately. */
export function paintSkeletonGrid(host, count = 4) {
  if (host) host.innerHTML = skeletonCardGrid(count);
}

/** Small inline spinner for in-place async state, e.g. inside a stat tile. */
export function inlineSpinner(label = '') {
  return `<span class="uk-spin" role="status" aria-label="${escapeHtml(label || 'Loading')}"></span>${label ? ` <span>${escapeHtml(label)}</span>` : ''}`;
}

/** Button "Saving…"-style loading state; mirrors ui.js's setButtonLoading but keeps the uikit spinner visuals. */
export function setButtonBusy(button, busy, busyLabel = 'Saving…') {
  if (!button) return;
  if (busy) {
    button.dataset.ukLabel = button.dataset.ukLabel || button.innerHTML;
    button.disabled = true;
    button.classList.add('uk-btn-loading');
    button.innerHTML = `${inlineSpinner()} ${escapeHtml(busyLabel)}`;
  } else {
    button.disabled = false;
    button.classList.remove('uk-btn-loading');
    if (button.dataset.ukLabel) button.innerHTML = button.dataset.ukLabel;
  }
}

/* ==========================================================================
   Empty state
   ========================================================================== */

export function emptyState({ icon: iconName = 'inbox', title, body = '', ctaLabel, ctaHref } = {}) {
  return `
    <div class="uk-empty">
      <span class="uk-empty__icon">${icon(iconName, 26)}</span>
      <strong class="uk-empty__title">${escapeHtml(title || '')}</strong>
      ${body ? `<p class="uk-empty__body">${escapeHtml(body)}</p>` : ''}
      ${ctaLabel && ctaHref ? `<a class="button button-primary uk-empty__cta" href="${escapeHtml(ctaHref)}">${escapeHtml(ctaLabel)}</a>` : ''}
    </div>`;
}

/* ==========================================================================
   Status / badge pill — one color-mapping helper reused across every
   status field in the data model (orders, vendors, campaigns, reviews,
   tickets, CMS documents, payouts...).
   ========================================================================== */

const STATUS_MAP = {
  // success / positive
  paid: 'success', approved: 'success', active: 'success', published: 'success',
  completed: 'success', verified: 'success', available: 'success', closed: 'success',
  // warning / in-progress
  pending: 'warning', processing: 'warning', draft: 'warning', requested: 'warning',
  changed: 'warning', open: 'warning',
  // danger / negative
  failed: 'danger', rejected: 'danger', suspended: 'danger', cancelled: 'danger',
  refunded: 'danger', reversed: 'danger', blocked: 'danger', terminated: 'danger',
  removed: 'danger',
  // info / neutral-but-notable
  unpublished: 'info', paused: 'info',
  // admin tiers
  super_admin: 'danger', admin: 'success', moderator: 'info', support: 'neutral',
  // store team roles
  owner: 'success', manager: 'info', staff: 'neutral',
};

/** status string -> uk-badge variant (success/warning/danger/info/neutral). */
export function statusVariant(status) {
  return STATUS_MAP[String(status || '').toLowerCase()] || 'neutral';
}

/** Renders a `<span class="uk-badge uk-badge--…">` for any status string. */
export function statusBadge(status, label) {
  const variant = statusVariant(status);
  return `<span class="uk-badge uk-badge--${variant}">${escapeHtml(label || status || '—')}</span>`;
}

/* ==========================================================================
   Tabs primitive
   ========================================================================== */

/**
 * Wires a tab list to its panels. `root` must contain `[data-uk-tab]`
 * buttons (each with a matching `data-uk-tab-panel` target elsewhere in the
 * document) — used for dashboard sub-navigation (vendor/admin consoles).
 */
export function initTabs(root, { onChange } = {}) {
  if (!root) return;
  const buttons = [...root.querySelectorAll('[data-uk-tab]')];
  const activate = (key) => {
    buttons.forEach((b) => b.classList.toggle('is-active', b.dataset.ukTab === key));
    document.querySelectorAll('[data-uk-tab-panel]').forEach((p) => {
      p.classList.toggle('is-active', p.dataset.ukTabPanel === key);
    });
    onChange?.(key);
  };
  buttons.forEach((b) => b.addEventListener('click', () => activate(b.dataset.ukTab)));
  const initial = root.querySelector('[data-uk-tab].is-active')?.dataset.ukTab || buttons[0]?.dataset.ukTab;
  if (initial) activate(initial);
  return { activate };
}

/* ==========================================================================
   Data table primitive — sortable header click, row-actions slot,
   pagination footer. Consumer supplies columns + a page of rows; this stays
   presentation-only (no fetching), so it works the same in front of a
   Supabase query or a plain in-memory array.
   ========================================================================== */

/**
 * renderDataTable(host, {columns, rows, page, pageSize, total, sortKey, sortDir,
 *   onSort, onPage, rowActions, emptyMessage})
 * - columns: [{key, label, sortable, render?(row)}]
 * - rowActions?(row) -> html string, rendered right-aligned in its own column
 */
export function renderDataTable(host, opts) {
  if (!host) return;
  const {
    columns, rows = [], page = 1, pageSize = 20, total = rows.length,
    sortKey, sortDir = 'asc', onSort, onPage, rowActions, emptyMessage = 'Nothing to show yet.',
  } = opts;

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const headHtml = columns.map((col) => {
    const sorted = col.key === sortKey;
    return `<th ${col.sortable ? `data-sortable data-key="${col.key}"` : ''} class="${sorted ? 'is-sorted' : ''}">
      ${escapeHtml(col.label)}
      ${col.sortable ? `<span class="uk-sort-icon">${sorted ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}</span>` : ''}
    </th>`;
  }).join('') + (rowActions ? '<th></th>' : '');

  const bodyHtml = rows.length
    ? rows.map((row) => `
        <tr>
          ${columns.map((col) => `<td>${col.render ? col.render(row) : escapeHtml(row[col.key] ?? '—')}</td>`).join('')}
          ${rowActions ? `<td><div class="uk-table__actions">${rowActions(row)}</div></td>` : ''}
        </tr>`).join('')
    : `<tr><td colspan="${columns.length + (rowActions ? 1 : 0)}">${emptyState({ icon: 'inbox', title: 'No results', body: emptyMessage })}</td></tr>`;

  host.innerHTML = `
    <div class="uk-table-wrap">
      <table class="uk-table">
        <thead><tr>${headHtml}</tr></thead>
        <tbody>${bodyHtml}</tbody>
      </table>
      <div class="uk-table-foot">
        <span>${total ? `Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}` : 'No rows'}</span>
        <div style="display:flex;gap:6px;align-items:center">
          <button type="button" class="uk-page-btn" data-uk-prev ${page <= 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevron-left', 15)}</button>
          <span>${page} / ${pageCount}</span>
          <button type="button" class="uk-page-btn" data-uk-next ${page >= pageCount ? 'disabled' : ''} aria-label="Next page">${icon('chevron-right', 15)}</button>
        </div>
      </div>
    </div>`;

  host.querySelectorAll('th[data-sortable]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      const nextDir = key === sortKey && sortDir === 'asc' ? 'desc' : 'asc';
      onSort?.(key, nextDir);
    });
  });
  host.querySelector('[data-uk-prev]')?.addEventListener('click', () => page > 1 && onPage?.(page - 1));
  host.querySelector('[data-uk-next]')?.addEventListener('click', () => page < pageCount && onPage?.(page + 1));

  renderIcons();
}

/* ==========================================================================
   Theme toggle (light / dark / system) — supports the tokens defined in
   css/app.css. Persists the explicit choice; "system" clears it.
   ========================================================================== */

const THEME_KEY = 'digistore-theme';

export function getStoredTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
}

export function setTheme(theme) {
  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch { /* storage may be unavailable; theme still applies for this load */ }
  applyTheme(theme);
}

/** Call once on page load to restore whatever the visitor last chose. */
export function initTheme() {
  applyTheme(getStoredTheme());
}
