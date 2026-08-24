/**
 * Presentation-layer formatting.
 *
 * Every number, date, and money value that reaches the DOM goes through here,
 * so rounding and locale behaviour is decided in exactly one place.
 */

/** Currencies with no minor unit — formatting them with cents is wrong. */
const ZERO_DECIMAL = new Set(['UGX', 'JPY', 'RWF', 'TZS', 'KRW', 'VND', 'CLP', 'ISK', 'XAF', 'XOF']);

const moneyFormatters = new Map();

function moneyFormatter(currency) {
  const code = (currency || 'USD').toUpperCase();
  if (!moneyFormatters.has(code)) {
    const digits = ZERO_DECIMAL.has(code) ? 0 : 2;
    let formatter;
    try {
      formatter = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: code,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    } catch {
      // Unknown ISO code: fall back to a plain number with the code in front.
      const plain = new Intl.NumberFormat('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
      formatter = { format: (value) => `${code} ${plain.format(value)}` };
    }
    moneyFormatters.set(code, formatter);
  }
  return moneyFormatters.get(code);
}

/** `formatMoney(19.5, 'USD')` → `$19.50`. Invalid input renders as zero. */
export function formatMoney(amount, currency = 'USD') {
  const value = Number(amount);
  return moneyFormatter(currency).format(Number.isFinite(value) ? value : 0);
}

/** Money without the symbol — for table columns that carry the code in the header. */
export function formatAmount(amount, currency = 'USD') {
  const digits = ZERO_DECIMAL.has((currency || 'USD').toUpperCase()) ? 0 : 2;
  const value = Number(amount);
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number.isFinite(value) ? value : 0);
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat('en-US');

/** 1_240 → `1,240`. */
export function formatNumber(value) {
  const n = Number(value);
  return plain.format(Number.isFinite(n) ? n : 0);
}

/** 12_400 → `12.4K`. Used only where column width is genuinely tight. */
export function formatCompact(value) {
  const n = Number(value);
  return compact.format(Number.isFinite(n) ? n : 0);
}

/** 0.184 → `18.4%`. Pass `fraction: false` when the input is already 0–100. */
export function formatPercent(value, { fraction = true, digits = 1 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${(fraction ? n * 100 : n).toFixed(digits)}%`;
}

const dateShort = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const dateLong = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const monthYear = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' });
const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value, style = 'short') {
  const date = toDate(value);
  if (!date) return '—';
  if (style === 'long') return dateLong.format(date);
  if (style === 'datetime') return dateTime.format(date);
  if (style === 'monthYear') return monthYear.format(date);
  if (style === 'dayMonth') return dayMonth.format(date);
  return dateShort.format(date);
}

/** ISO date for `<input type="date">` and query params. */
export function toISODate(value) {
  const date = toDate(value);
  return date ? date.toISOString().slice(0, 10) : '';
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const UNITS = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

/** `relativeTime(t)` → `3 days ago`, `in 2 hours`, `just now`. */
export function relativeTime(value, now = Date.now()) {
  const date = toDate(value);
  if (!date) return '—';
  const seconds = (date.getTime() - now) / 1000;
  const magnitude = Math.abs(seconds);
  if (magnitude < 45) return 'just now';
  for (const [unit, size] of UNITS) {
    if (magnitude >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return relative.format(Math.round(seconds), 'second');
}

/** `formatBytes(1536)` → `1.5 KB`. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const scaled = n / 1024 ** power;
  return `${scaled.toFixed(power === 0 ? 0 : scaled < 10 ? 1 : 0)} ${units[power]}`;
}

/** URL- and filename-safe slug. Matches the SQL `slugify()` in the schema. */
export function slugify(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

/** Trims to a word boundary and appends an ellipsis only if it actually cut. */
export function truncate(value, max = 140) {
  const text = String(value ?? '').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/** Initials for an avatar: at most two letters, always uppercase. */
export function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Percentage discount between two prices, or 0 when there is no markdown. */
export function discountPercent(price, originalPrice) {
  const now = Number(price);
  const was = Number(originalPrice);
  if (!Number.isFinite(now) || !Number.isFinite(was) || was <= 0 || now >= was) return 0;
  return Math.round((1 - now / was) * 100);
}
