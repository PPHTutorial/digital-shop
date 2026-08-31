/**
 * Affiliate attribution — the client half of the affiliate programme.
 *
 * Imported once, site-wide, from js/ui.js. On any page load it looks for a
 * `?ref=CODE` (or `?ref=CODE` carried on a `/r/CODE` style share link that the
 * host rewrites) parameter:
 *
 *   1. mints / reuses a first-party visitor id in the `digistore_ref_vid`
 *      cookie (SameSite=Lax, 90-day TTL — the programme default),
 *   2. records the touch in localStorage AND a cookie so it survives a tab
 *      close, and posts it to the `track_affiliate_referral` RPC (which
 *      dedupes to one row per visitor+code per day and silently ignores
 *      unknown codes),
 *   3. strips `ref` from the visible URL.
 *
 * js/auth.js reads getStoredReferral() and forwards it into supabase.auth
 * .signUp() metadata so the DB signup trigger can set profiles.referred_by.
 *
 * Last touch within the window wins. A logged-in affiliate visiting their own
 * link is harmless — the server rejects self-referral at signup and at credit.
 */
import { supabase } from './client.js';

const VID_COOKIE = 'digistore_ref_vid';
const REF_COOKIE = 'digistore_ref';
const REF_STORE = 'digistore_ref';
const WINDOW_DAYS = 90;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

function readCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : '';
}

function writeCookie(name, value, maxAgeMs) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${Math.round(maxAgeMs / 1000)}; SameSite=Lax${secure}`;
}

function uuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function visitorId() {
  let vid = readCookie(VID_COOKIE);
  if (!vid) {
    vid = uuid();
    writeCookie(VID_COOKIE, vid, WINDOW_MS);
  }
  return vid;
}

/** The live referral, or null if there is none / it has expired. */
export function getStoredReferral() {
  let record = null;
  try {
    record = JSON.parse(localStorage.getItem(REF_STORE) || 'null');
  } catch { /* fall through to cookie */ }
  if (!record) {
    const raw = readCookie(REF_COOKIE);
    if (raw) { try { record = JSON.parse(raw); } catch { record = null; } }
  }
  if (!record || !record.code || !record.ts) return null;
  if (Date.now() - record.ts > WINDOW_MS) return null;
  return { code: record.code, vid: record.vid || readCookie(VID_COOKIE) || '' };
}

function storeReferral(code) {
  const vid = visitorId();
  const record = {
    code,
    vid,
    ts: Date.now(),
    landing: location.pathname + location.search,
  };
  try { localStorage.setItem(REF_STORE, JSON.stringify(record)); } catch { /* private mode */ }
  writeCookie(REF_COOKIE, JSON.stringify({ code, vid, ts: record.ts }), WINDOW_MS);
  return record;
}

function stripRefParam() {
  const url = new URL(location.href);
  if (!url.searchParams.has('ref')) return;
  url.searchParams.delete('ref');
  history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
}

async function captureFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = (params.get('ref') || '').trim();
  if (!code || !/^[a-z0-9_-]{2,64}$/i.test(code)) return;

  const record = storeReferral(code);
  stripRefParam();

  const utm = {};
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    const v = params.get(key);
    if (v) utm[key.replace('utm_', '')] = v;
  }

  try {
    await supabase.rpc('track_affiliate_referral', {
      p_code: code,
      p_visitor_id: record.vid,
      p_landing_path: record.landing,
      p_referrer: document.referrer || null,
      p_utm: utm,
    });
  } catch { /* tracking is best-effort; attribution still lives in the cookie */ }
}

/** Idempotent; safe to call more than once. */
export function initAffiliateTracking() {
  if (window.__affiliateTrackingReady) return;
  window.__affiliateTrackingReady = true;
  captureFromUrl();
}

initAffiliateTracking();
