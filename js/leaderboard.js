/**
 * Public leaderboards. One RPC — public.leaderboard(board, period, limit) —
 * per active tab, rendered on demand. A finished month is served frozen from
 * public.leaderboard_snapshots; the current month is computed live.
 */
import { supabase } from './client.js';
import {
  escapeHtml, finishPageLoader, icon, initMotion, mountFooter, mountHeader, renderIcons,
} from './ui.js';
import { emptyState } from './uikit.js';

const BOARDS = {
  top_sellers: { label: 'Top Sellers', unit: 'money', blurb: 'Ranked by net revenue.' },
  most_followed_creators: { label: 'Most Followed', unit: 'followers', blurb: 'Ranked by followers gained.' },
  top_buyers: { label: 'Top Buyers', unit: 'money', blurb: 'Ranked by spend. Names are masked unless a member opts in.' },
  top_affiliates: { label: 'Top Affiliates', unit: 'money', blurb: 'Ranked by commission earned. Names masked unless opted in.' },
  top_engagers: { label: 'Top Engagers', unit: 'points', blurb: 'Reviews, comments, likes and follows — weighted.' },
  top_community: { label: 'Community', unit: 'points', blurb: 'Engagement with follows weighted highest.' },
};

const params = new URLSearchParams(location.search);
let board = BOARDS[params.get('board')] ? params.get('board') : 'top_sellers';
let period = params.get('period') || 'current';

const money = (v) => `$${Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const whole = (v) => Number(v || 0).toLocaleString();

function formatValue(unit, value) {
  if (unit === 'money') return money(value);
  if (unit === 'followers') return `${whole(value)} follower${Number(value) === 1 ? '' : 's'}`;
  return `${whole(value)} pts`;
}

/** Populate the period picker with the last 12 completed months. */
function buildPeriodOptions() {
  const select = document.querySelector('#lb-period');
  const now = new Date();
  const opts = ['<option value="current">This month</option>'];
  for (let i = 1; i <= 12; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    opts.push(`<option value="${key}">${escapeHtml(label)}</option>`);
  }
  opts.push('<option value="all_time">All time</option>');
  select.innerHTML = opts.join('');
  select.value = period;
}

function rowHtml(r, unit) {
  const rank = Number(r.rank);
  const medal = rank <= 3 ? ` lb-row--rank${rank}` : '';
  const avatar = r.avatar_url
    ? `<img src="${escapeHtml(r.avatar_url)}" alt="" class="lb-row__avatar">`
    : `<span class="lb-row__avatar lb-row__avatar--initial">${escapeHtml((r.name || '?').charAt(0).toUpperCase())}</span>`;
  const name = r.slug
    ? `<a href="./store?vendor=${encodeURIComponent(r.slug)}">${escapeHtml(r.name || 'DigiStore member')}</a>`
    : escapeHtml(r.name || 'DigiStore member');
  const you = r.is_viewer ? '<span class="lb-row__you">You</span>' : '';
  return `
    <div class="lb-row${medal}">
      <span class="lb-row__rank">${rank <= 3 ? icon('crown', 16) : ''}<b>${rank}</b></span>
      ${avatar}
      <span class="lb-row__name">${name}${you}</span>
      <span class="lb-row__value">${escapeHtml(formatValue(unit, r.value))}</span>
    </div>`;
}

async function load() {
  const host = document.querySelector('#lb-rows');
  const caption = document.querySelector('#lb-caption');
  const meta = BOARDS[board];
  host.setAttribute('aria-busy', 'true');
  host.innerHTML = `<div class="lb-skel">${'<div></div>'.repeat(8)}</div>`;

  const { data, error } = await supabase.rpc('leaderboard', { p_board: board, p_period: period, p_limit: 50 });
  host.removeAttribute('aria-busy');

  if (error) {
    host.innerHTML = emptyState({ icon: 'triangle-alert', title: 'Could not load this board', body: error.message });
    caption.textContent = '';
    return;
  }

  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const periodLabel = data?.period === 'all_time'
    ? 'all time'
    : (data?.period || 'this month');
  caption.textContent = `${meta.blurb} ${data?.frozen ? `Final standings for ${periodLabel}.` : `Live standings, ${periodLabel}.`}`;

  host.innerHTML = rows.length
    ? rows.map((r) => rowHtml(r, meta.unit)).join('')
    : emptyState({ icon: 'trophy', title: 'Nothing here yet', body: 'No activity for this board in the selected period.' });
  renderIcons();
}

function paintActiveTab() {
  document.querySelectorAll('.lb-tab').forEach((t) => {
    const on = t.dataset.board === board;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
}

function syncUrl() {
  const u = new URL(location.href);
  u.searchParams.set('board', board);
  u.searchParams.set('period', period);
  history.replaceState(null, '', u);
}

async function init() {
  mountHeader();
  mountFooter();
  buildPeriodOptions();

  document.querySelector('#lb-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.lb-tab');
    if (!tab || tab.dataset.board === board) return;
    board = tab.dataset.board;
    paintActiveTab();
    syncUrl();
    load();
  });
  document.querySelector('#lb-period').addEventListener('change', (e) => {
    period = e.target.value;
    syncUrl();
    load();
  });

  paintActiveTab();
  document.querySelector('#lb-period').value = period;
  syncUrl();
  await load();
  initMotion();
  finishPageLoader();
}

init();
