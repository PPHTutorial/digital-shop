/**
 * Custom checkbox / radio / date-picker.
 *
 * Same progressive-enhancement idea as select.js: native browser chrome for
 * checkboxes, radios and <input type="date"> can't be restyled consistently
 * across platforms, so each of these keeps the real input in the DOM
 * (visually hidden via a clip-rect, not display:none, so focus/tab order and
 * form semantics — change events, FormData, required — keep working) and
 * layers a token-styled control on top of it. If this script never runs, the
 * page degrades to working native controls.
 */

const TICK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const CHEVRON_LEFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
const CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
const CALENDAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';

/* ==========================================================================
   Checkbox
   ========================================================================== */

export function enhanceCheckbox(input) {
  if (!input || input.dataset.enhanced === 'true') return null;
  input.dataset.enhanced = 'true';
  input.classList.add('xcheck__native');

  const box = document.createElement('span');
  box.className = 'xcheck__box';
  box.setAttribute('aria-hidden', 'true');
  box.innerHTML = TICK_SVG;
  input.parentNode.insertBefore(box, input);

  const sync = () => {
    box.classList.toggle('is-checked', input.checked);
    box.classList.toggle('is-indeterminate', Boolean(input.indeterminate));
    box.classList.toggle('is-disabled', Boolean(input.disabled));
  };

  box.addEventListener('click', (event) => {
    event.preventDefault();
    if (input.disabled) return;
    input.checked = !input.checked;
    input.indeterminate = false;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    sync();
  });

  input.addEventListener('change', sync);
  sync();
  return { sync };
}

export function enhanceCheckboxes(selector) {
  document.querySelectorAll(selector).forEach((el) => enhanceCheckbox(el));
}

/* ==========================================================================
   Radio
   ========================================================================== */

export function enhanceRadio(input) {
  if (!input || input.dataset.enhanced === 'true') return null;
  input.dataset.enhanced = 'true';
  input.classList.add('xradio__native');

  const dot = document.createElement('span');
  dot.className = 'xradio__dot';
  dot.setAttribute('aria-hidden', 'true');
  input.parentNode.insertBefore(dot, input);

  const sync = () => {
    dot.classList.toggle('is-checked', input.checked);
    dot.classList.toggle('is-disabled', Boolean(input.disabled));
  };

  dot.addEventListener('click', (event) => {
    event.preventDefault();
    if (input.disabled || input.checked) return;
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // Native radio semantics already clear the `checked` state of every other
  // input sharing this `name` — this just mirrors that onto their custom dots.
  input.addEventListener('change', () => {
    if (!input.name) return sync();
    const scope = input.form || document;
    scope.querySelectorAll(`input[type="radio"][name="${CSS.escape(input.name)}"]`)
      .forEach((el) => el._xradioSync?.());
  });

  input._xradioSync = sync;
  sync();
  return { sync };
}

export function enhanceRadios(selector) {
  document.querySelectorAll(selector).forEach((el) => enhanceRadio(el));
}

/* ==========================================================================
   Date picker
   ========================================================================== */

let openDateInstance = null;
function closeOpenDate() {
  if (openDateInstance) openDateInstance.close();
}
document.addEventListener('click', (event) => {
  if (openDateInstance && !event.target.closest('.xdate')) closeOpenDate();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeOpenDate();
});

function pad2(n) { return String(n).padStart(2, '0'); }
function toISO(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function parseISO(s) {
  if (!s) return null;
  const [y, m, d] = String(s).split('-').map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? null : date;
}
function sameDay(a, b) { return !!a && !!b && toISO(a) === toISO(b); }

/**
 * @param {HTMLInputElement} input type="date"
 * @param {{ placeholder?: string }} options
 */
export function enhanceDateInput(input, { placeholder = 'Select date' } = {}) {
  if (!input || input.dataset.enhanced === 'true') return null;
  input.dataset.enhanced = 'true';
  input.classList.add('xdate__native');

  const wrap = document.createElement('div');
  wrap.className = 'xdate';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'xdate__trigger';
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');

  const panel = document.createElement('div');
  panel.className = 'xdate__panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Choose a date');

  input.parentNode.insertBefore(wrap, input);
  wrap.append(trigger, panel, input);

  const min = parseISO(input.min);
  const max = parseISO(input.max);
  let viewDate = parseISO(input.value) || new Date();
  viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);

  const instance = {
    close() {
      wrap.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      panel.style.top = '';
      panel.style.bottom = '';
      panel.style.left = '';
      panel.style.right = '';
      if (openDateInstance === instance) openDateInstance = null;
    },
    open() {
      closeOpenDate();
      const selected = parseISO(input.value);
      viewDate = selected
        ? new Date(selected.getFullYear(), selected.getMonth(), 1)
        : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      renderCalendar();
      wrap.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      openDateInstance = instance;
      reposition();
    },
  };

  // Flip the panel above the trigger, or pin it to the right edge, when the
  // default placement would overflow the viewport — the same overflow class
  // of issue enhanceSelect's bottom-sheet mode sidesteps by pinning to the
  // viewport on narrow screens; on wide screens we just nudge the panel back
  // on-screen instead.
  function reposition() {
    if (window.matchMedia('(max-width: 640px)').matches) return; // sheet mode, CSS handles placement
    requestAnimationFrame(() => {
      const rect = panel.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) {
        panel.style.left = 'auto';
        panel.style.right = '0';
      }
      if (rect.bottom > window.innerHeight - 8) {
        panel.style.top = 'auto';
        panel.style.bottom = 'calc(100% + 8px)';
      }
    });
  }

  function fmt(d) {
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function renderTrigger() {
    const d = parseISO(input.value);
    trigger.innerHTML = `
      <span class="xdate__value${d ? '' : ' is-placeholder'}">${d ? fmt(d) : placeholder}</span>
      <span class="xdate__icon" aria-hidden="true">${CALENDAR_SVG}</span>`;
  }

  function renderCalendar() {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const first = new Date(year, month, 1);
    const startOffset = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const selected = parseISO(input.value);
    const today = new Date();

    let cells = '';
    for (let i = 0; i < startOffset; i++) cells += '<span class="xdate__cell xdate__cell--empty"></span>';
    for (let day = 1; day <= daysInMonth; day++) {
      const cellDate = new Date(year, month, day);
      const iso = toISO(cellDate);
      const disabled = (min && cellDate < min) || (max && cellDate > max);
      cells += `<button type="button" class="xdate__cell${sameDay(cellDate, selected) ? ' is-selected' : ''}${sameDay(cellDate, today) ? ' is-today' : ''}" ${disabled ? 'disabled' : ''} data-iso="${iso}">${day}</button>`;
    }

    const prevDisabled = min && new Date(year, month, 0) < min && min.getMonth() === month && min.getFullYear() === year;
    panel.innerHTML = `
      <div class="xdate__head">
        <button type="button" class="xdate__nav" data-nav="-1" aria-label="Previous month">${CHEVRON_LEFT}</button>
        <strong>${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong>
        <button type="button" class="xdate__nav" data-nav="1" aria-label="Next month">${CHEVRON_RIGHT}</button>
      </div>
      <div class="xdate__weekdays">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<span>${d}</span>`).join('')}</div>
      <div class="xdate__grid">${cells}</div>
      <div class="xdate__foot">
        <button type="button" class="xdate__today" data-action="today">Today</button>
        <button type="button" class="xdate__clear" data-action="clear">Clear</button>
      </div>`;
    void prevDisabled;

    // Every handler below stops propagation: several of them (the month nav
    // buttons especially) replace `panel.innerHTML` synchronously inside the
    // click handler, which detaches the clicked element from the document
    // before the click finishes bubbling. A detached node's `closest('.xdate')`
    // resolves to null, so the document-level outside-click listener above
    // would otherwise see a click that looks like it landed outside the
    // picker and close it out from under the re-render.
    panel.querySelector('[data-nav="-1"]').addEventListener('click', (event) => { event.stopPropagation(); viewDate = new Date(year, month - 1, 1); renderCalendar(); });
    panel.querySelector('[data-nav="1"]').addEventListener('click', (event) => { event.stopPropagation(); viewDate = new Date(year, month + 1, 1); renderCalendar(); });
    panel.querySelectorAll('.xdate__cell:not(.xdate__cell--empty)').forEach((cell) => {
      cell.addEventListener('click', (event) => {
        event.stopPropagation();
        if (cell.disabled) return;
        input.value = cell.dataset.iso;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        renderTrigger();
        instance.close();
      });
    });
    panel.querySelector('[data-action="today"]').addEventListener('click', (event) => {
      event.stopPropagation();
      const t = new Date();
      if ((min && t < min) || (max && t > max)) return;
      input.value = toISO(t);
      input.dispatchEvent(new Event('change', { bubbles: true }));
      renderTrigger();
      instance.close();
    });
    panel.querySelector('[data-action="clear"]').addEventListener('click', (event) => {
      event.stopPropagation();
      input.value = '';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      renderTrigger();
      instance.close();
    });
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    wrap.classList.contains('is-open') ? instance.close() : instance.open();
  });
  trigger.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    wrap.classList.contains('is-open') ? instance.close() : instance.open();
  });

  input.addEventListener('change', renderTrigger);

  renderTrigger();
  return instance;
}

export function enhanceDateInputs(selector, options = {}) {
  document.querySelectorAll(selector).forEach((el) => enhanceDateInput(el, options));
}

/* ==========================================================================
   Date + time picker  (<input type="datetime-local">, value YYYY-MM-DDTHH:mm)
   ========================================================================== */

function parseDT(s) {
  if (!s) return null;
  const [d, t] = String(s).split('T');
  const date = parseISO(d);
  if (!date) return null;
  const [h, m] = (t || '00:00').split(':').map(Number);
  return { date, h: Number.isFinite(h) ? h : 0, m: Number.isFinite(m) ? m : 0 };
}

export function enhanceDateTimeInput(input, { placeholder = 'Select date & time', minuteStep = 5 } = {}) {
  if (!input || input.dataset.enhanced === 'true') return null;
  input.dataset.enhanced = 'true';
  input.classList.add('xdate__native');

  const wrap = document.createElement('div');
  wrap.className = 'xdate xdate--time';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'xdate__trigger';
  trigger.setAttribute('aria-haspopup', 'dialog');
  const panel = document.createElement('div');
  panel.className = 'xdate__panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Choose date and time');

  input.parentNode.insertBefore(wrap, input);
  wrap.append(trigger, panel, input);

  let cur = parseDT(input.value);
  let hh = cur ? cur.h : 9;
  let mm = cur ? cur.m : 0;
  let viewDate = new Date((cur ? cur.date : new Date()).getFullYear(), (cur ? cur.date : new Date()).getMonth(), 1);

  const instance = {
    close() {
      wrap.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      if (openDateInstance === instance) openDateInstance = null;
    },
    open() {
      closeOpenDate();
      cur = parseDT(input.value);
      if (cur) { hh = cur.h; mm = cur.m; viewDate = new Date(cur.date.getFullYear(), cur.date.getMonth(), 1); }
      render();
      wrap.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      openDateInstance = instance;
    },
  };

  const commit = (date) => {
    input.value = `${toISO(date)}T${pad2(hh)}:${pad2(mm)}`;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    renderTrigger();
  };

  function renderTrigger() {
    const v = parseDT(input.value);
    trigger.innerHTML = `
      <span class="xdate__value${v ? '' : ' is-placeholder'}">${v
        ? `${v.date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })} · ${pad2(v.h)}:${pad2(v.m)}`
        : placeholder}</span>
      <span class="xdate__icon" aria-hidden="true">${CALENDAR_SVG}</span>`;
  }

  function render() {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const first = new Date(year, month, 1);
    const startOffset = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const selected = parseDT(input.value)?.date || null;
    const today = new Date();

    let cells = '';
    for (let i = 0; i < startOffset; i++) cells += '<span class="xdate__cell xdate__cell--empty"></span>';
    for (let day = 1; day <= daysInMonth; day++) {
      const cd = new Date(year, month, day);
      cells += `<button type="button" class="xdate__cell${sameDay(cd, selected) ? ' is-selected' : ''}${sameDay(cd, today) ? ' is-today' : ''}" data-iso="${toISO(cd)}">${day}</button>`;
    }

    panel.innerHTML = `
      <div class="xdate__head">
        <button type="button" class="xdate__nav" data-nav="-1" aria-label="Previous month">${CHEVRON_LEFT}</button>
        <strong>${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong>
        <button type="button" class="xdate__nav" data-nav="1" aria-label="Next month">${CHEVRON_RIGHT}</button>
      </div>
      <div class="xdate__weekdays">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<span>${d}</span>`).join('')}</div>
      <div class="xdate__grid">${cells}</div>
      <div class="xdate__time">
        <span>Time</span>
        <div class="xdate__stepper">
          <button type="button" data-t="h-">−</button>
          <span data-hh>${pad2(hh)}</span>
          <button type="button" data-t="h+">+</button>
        </div>
        <span class="xdate__colon">:</span>
        <div class="xdate__stepper">
          <button type="button" data-t="m-">−</button>
          <span data-mm>${pad2(mm)}</span>
          <button type="button" data-t="m+">+</button>
        </div>
      </div>
      <div class="xdate__foot">
        <button type="button" class="xdate__today" data-action="now">Now</button>
        <button type="button" class="xdate__clear" data-action="clear">Clear</button>
        <button type="button" class="xdate__today" data-action="done">Done</button>
      </div>`;

    panel.querySelector('[data-nav="-1"]').addEventListener('click', (e) => { e.stopPropagation(); viewDate = new Date(year, month - 1, 1); render(); });
    panel.querySelector('[data-nav="1"]').addEventListener('click', (e) => { e.stopPropagation(); viewDate = new Date(year, month + 1, 1); render(); });
    panel.querySelectorAll('.xdate__cell:not(.xdate__cell--empty)').forEach((cell) => {
      cell.addEventListener('click', (e) => {
        e.stopPropagation();
        const [y, mo, d] = cell.dataset.iso.split('-').map(Number);
        commit(new Date(y, mo - 1, d));
        render();
      });
    });
    panel.querySelectorAll('[data-t]').forEach((btn) => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const k = btn.dataset.t;
      if (k === 'h+') hh = (hh + 1) % 24;
      if (k === 'h-') hh = (hh + 23) % 24;
      if (k === 'm+') mm = (mm + minuteStep) % 60;
      if (k === 'm-') mm = (mm + 60 - minuteStep) % 60;
      panel.querySelector('[data-hh]').textContent = pad2(hh);
      panel.querySelector('[data-mm]').textContent = pad2(mm);
      const base = parseDT(input.value)?.date || new Date();
      commit(new Date(base.getFullYear(), base.getMonth(), base.getDate()));
    }));
    panel.querySelector('[data-action="now"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const n = new Date();
      hh = n.getHours();
      mm = Math.round(n.getMinutes() / minuteStep) * minuteStep % 60;
      commit(new Date(n.getFullYear(), n.getMonth(), n.getDate()));
      instance.close();
    });
    panel.querySelector('[data-action="clear"]').addEventListener('click', (e) => {
      e.stopPropagation();
      input.value = '';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      renderTrigger();
      instance.close();
    });
    panel.querySelector('[data-action="done"]').addEventListener('click', (e) => { e.stopPropagation(); instance.close(); });
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    wrap.classList.contains('is-open') ? instance.close() : instance.open();
  });
  input.addEventListener('change', renderTrigger);
  renderTrigger();
  return instance;
}

export function enhanceDateTimeInputs(selector, options = {}) {
  document.querySelectorAll(selector).forEach((el) => enhanceDateTimeInput(el, options));
}
