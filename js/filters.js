/**
 * Shared period + date-range filter primitive.
 *
 * Dashboards across the app (admin overview, admin data tables, vendor
 * dashboard) all want the same "Today / Yesterday / This week / This month /
 * This year / All time / Custom range" control. This renders that control and
 * hands back a `{ from, to }` Date window; `inPeriod()` tests a row's date
 * against it. Everything is client-side — callers already hold the full row
 * set and just re-slice it.
 */

import { enhanceSelect } from './select.js';

export const PERIOD_PRESETS = [
  { key: 'all', label: 'All time' },
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'year', label: 'This year' },
  { key: 'custom', label: 'Custom range' },
];

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };

/**
 * @param {string} key one of PERIOD_PRESETS keys
 * @param {string} [customFrom] YYYY-MM-DD (only read when key === 'custom')
 * @param {string} [customTo]   YYYY-MM-DD
 * @returns {{ from: Date|null, to: Date|null }} null bounds mean "unbounded".
 */
export function periodRange(key, customFrom, customTo) {
  const now = new Date();
  switch (key) {
    case 'today':
      return { from: startOfDay(now), to: endOfDay(now) };
    case 'yesterday': {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return { from: startOfDay(y), to: endOfDay(y) };
    }
    case 'week': {
      // Monday-anchored week.
      const s = startOfDay(now);
      s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
      return { from: s, to: endOfDay(now) };
    }
    case 'month':
      return { from: startOfDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: endOfDay(now) };
    case 'year':
      return { from: startOfDay(new Date(now.getFullYear(), 0, 1)), to: endOfDay(now) };
    case 'custom':
      return {
        from: customFrom ? startOfDay(new Date(customFrom)) : null,
        to: customTo ? endOfDay(new Date(customTo)) : null,
      };
    case 'all':
    default:
      return { from: null, to: null };
  }
}

/** True when `dateish` falls inside `range` (an unbounded / empty range passes everything). */
export function inPeriod(dateish, range) {
  if (!range || (!range.from && !range.to)) return true;
  const t = dateish instanceof Date ? dateish : new Date(dateish);
  if (Number.isNaN(t.getTime())) return false;
  if (range.from && t < range.from) return false;
  if (range.to && t > range.to) return false;
  return true;
}

/**
 * renderPeriodFilter(host, { value, from, to, onChange })
 * - value: initial preset key (default 'all')
 * - from/to: initial custom-range values (YYYY-MM-DD)
 * - onChange({ key, from, to, range }): fired on every change; `range` is
 *   ready to pass straight to inPeriod().
 * Returns { getRange, key } for callers that also need the current window
 * outside the change handler (e.g. first paint).
 */
export function renderPeriodFilter(host, { value = 'all', from = '', to = '', onChange } = {}) {
  if (!host) return { getRange: () => periodRange('all'), key: 'all' };
  host.classList.add('period-filter');
  host.innerHTML = `
    <label class="period-filter__group">
      <span class="label">Period</span>
      <select class="field" data-role="preset">
        ${PERIOD_PRESETS.map((p) => `<option value="${p.key}"${p.key === value ? ' selected' : ''}>${p.label}</option>`).join('')}
      </select>
    </label>
    <label class="period-filter__group period-filter__custom" data-role="from-wrap"${value === 'custom' ? '' : ' hidden'}>
      <span class="label">From</span>
      <input type="date" class="field" data-role="from" value="${from}">
    </label>
    <label class="period-filter__group period-filter__custom" data-role="to-wrap"${value === 'custom' ? '' : ' hidden'}>
      <span class="label">To</span>
      <input type="date" class="field" data-role="to" value="${to}">
    </label>`;

  const presetEl = host.querySelector('[data-role="preset"]');
  const fromEl = host.querySelector('[data-role="from"]');
  const toEl = host.querySelector('[data-role="to"]');
  const customWraps = host.querySelectorAll('.period-filter__custom');

  const currentRange = () => periodRange(presetEl.value, fromEl.value, toEl.value);
  const emit = () => {
    const isCustom = presetEl.value === 'custom';
    customWraps.forEach((el) => el.toggleAttribute('hidden', !isCustom));
    onChange?.({ key: presetEl.value, from: fromEl.value, to: toEl.value, range: currentRange() });
  };

  presetEl.addEventListener('change', emit);
  fromEl.addEventListener('change', emit);
  toEl.addEventListener('change', emit);
  enhanceSelect(presetEl, { label: 'Period' });

  return { getRange: currentRange, key: presetEl.value };
}
