/**
 * Custom select.
 *
 * A native <select> cannot have its option list styled — the popup is drawn by
 * the operating system — so anything beyond the trigger has to be rebuilt. This
 * enhances a real <select> rather than replacing it: the element stays in the
 * DOM as the source of truth, still carries the value, and still fires `change`.
 * If this script never runs, the page degrades to a working native control.
 *
 * On narrow screens the list presents as a bottom sheet, which is easier to
 * reach one-handed than a dropdown anchored to the top of the page.
 */

// Keyed by the native <select> so callers that mutate `select.innerHTML`
// directly (repopulating options after the element was already enhanced —
// e.g. a country picker whose payment-method options depend on the chosen
// country) can ask the wrapper to re-read them, via refreshSelect() below.
const instancesByNative = new WeakMap();

let openInstance = null;

function closeOpen() {
  if (openInstance) openInstance.close();
}

document.addEventListener('click', (event) => {
  if (openInstance && !event.target.closest('.xselect')) closeOpen();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeOpen();
});

/**
 * @param {HTMLSelectElement} select
 * @param {{ label?: string }} options
 */
export function enhanceSelect(select, { label = '' } = {}) {
  if (!select || select.dataset.enhanced === 'true') return null;
  select.dataset.enhanced = 'true';

  const wrap = document.createElement('div');
  wrap.className = 'xselect';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'xselect__trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const panel = document.createElement('div');
  panel.className = 'xselect__panel';
  panel.setAttribute('role', 'listbox');
  if (label) panel.setAttribute('aria-label', label);

  const sheet = document.createElement('div');
  sheet.className = 'xselect__sheet';
  panel.appendChild(sheet);

  const head = document.createElement('div');
  head.className = 'xselect__head';
  head.innerHTML = `<span>${label || 'Select'}</span>`;
  sheet.appendChild(head);

  const list = document.createElement('div');
  list.className = 'xselect__list';
  sheet.appendChild(list);

  // The native element stays, visually hidden, as the value holder.
  select.classList.add('xselect__native');
  select.parentNode.insertBefore(wrap, select);
  wrap.append(trigger, panel, select);

  // >=768px, the panel is a dropdown anchored under the trigger. Anchoring it
  // with `position:absolute` (relative to `.xselect`) means any scrollable or
  // `overflow:hidden` ancestor — a modal body, a horizontally-scrolling table
  // wrapper, a sidebar with its own scroll — clips or hides it. Positioning
  // it with `position:fixed` from real viewport coordinates escapes all of
  // that; below 768px the CSS media rules take over with a fixed bottom
  // sheet instead, so this is skipped there.
  function positionPanel() {
    if (!window.matchMedia('(min-width: 768px)').matches) {
      panel.style.cssText = '';
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUpward = spaceBelow < 280 && rect.top > spaceBelow;
    panel.style.position = 'fixed';
    panel.style.left = `${rect.left}px`;
    panel.style.width = `${rect.width}px`;
    panel.style.right = 'auto';
    if (openUpward) {
      panel.style.top = 'auto';
      panel.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    } else {
      panel.style.top = `${rect.bottom + 8}px`;
      panel.style.bottom = 'auto';
    }
  }
  const reposition = () => positionPanel();

  const instance = {
    close() {
      wrap.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('xselect-locked');
      panel.style.cssText = '';
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      if (openInstance === instance) openInstance = null;
    },
    open() {
      closeOpen();
      wrap.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      positionPanel();
      window.addEventListener('scroll', reposition, true);
      window.addEventListener('resize', reposition);
      // Only the sheet presentation locks scrolling; the dropdown does not.
      if (window.matchMedia('(max-width: 767px)').matches) {
        document.body.classList.add('xselect-locked');
      }
      openInstance = instance;
      list.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
    },
    refresh: renderOptions,
  };

  function renderTrigger() {
    const selected = select.options[select.selectedIndex];
    trigger.innerHTML = `
      <span class="xselect__value">${selected ? selected.textContent.trim() : ''}</span>
      <span class="xselect__chevron" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
             stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </span>`;
  }

  function renderOptions() {
    list.innerHTML = '';
    Array.from(select.options).forEach((option, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `xselect__option${index === select.selectedIndex ? ' is-selected' : ''}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === select.selectedIndex));
      item.innerHTML = `
        <span class="xselect__option-label">${option.textContent.trim()}</span>
        <span class="xselect__tick" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"
               stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </span>`;

      item.addEventListener('click', () => {
        select.selectedIndex = index;
        // Dispatched so existing listeners on the native element keep working.
        select.dispatchEvent(new Event('change', { bubbles: true }));
        renderTrigger();
        renderOptions();
        instance.close();
      });

      list.appendChild(item);
    });
    renderTrigger();
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    wrap.classList.contains('is-open') ? instance.close() : instance.open();
  });

  // Arrow keys move through the list while it is open.
  trigger.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (!wrap.classList.contains('is-open')) return instance.open();

    const items = Array.from(list.querySelectorAll('.xselect__option'));
    const current = items.findIndex((el) => el.classList.contains('is-selected'));
    const next = event.key === 'ArrowDown'
      ? Math.min(items.length - 1, current + 1)
      : event.key === 'ArrowUp' ? Math.max(0, current - 1) : current;
    if (event.key === 'Enter' || event.key === ' ') return items[current]?.click();
    items[next]?.click();
    instance.open();
  });

  head.addEventListener('click', () => instance.close());

  renderOptions();
  instancesByNative.set(select, instance);
  return instance;
}

/**
 * Re-reads a native <select>'s current <option>s into its custom trigger and
 * list — needed after code sets `select.innerHTML` directly (bypassing the
 * option-click path above) on a select that was already enhanced. A no-op if
 * the select was never enhanced.
 */
export function refreshSelect(select) {
  instancesByNative.get(select)?.refresh();
}

/** Enhances every matching select and returns the instances, keyed by id. */
export function enhanceSelects(selector, labels = {}) {
  const instances = {};
  document.querySelectorAll(selector).forEach((select) => {
    instances[select.id] = enhanceSelect(select, { label: labels[select.id] || '' });
  });
  return instances;
}
