/**
 * Supabase client and the thin data-access layer built on top of it.
 *
 * Note on the import specifier: the major version is pinned (`@2`) rather than
 * an exact patch. Pin the exact version here once it has been verified against
 * a deployed environment — see README, "Frontend dependencies".
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CONFIG, assertConfig } from './config.js';

assertConfig();

export const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'digistore.auth',
    flowType: 'pkce',
  },
  global: {
    headers: { 'x-client-name': 'digistore-web' },
  },
  db: { schema: 'public' },
});

/**
 * Turns a Supabase/Postgres error into something a person can act on.
 * Postgres error codes are stable, so they are worth mapping explicitly.
 */
export function describeError(error) {
  if (!error) return '';
  const code = error.code || '';

  const byCode = {
    '23505': 'That value is already taken. Choose a different one.',
    '23503': 'This record is still referenced by other data and cannot be removed.',
    '23514': 'One of the values falls outside the allowed range.',
    '42501': 'Your account does not have permission to do that.',
    '42P01': 'The requested table does not exist. The database may need migrating.',
    PGRST116: 'No matching record was found.',
    PGRST301: 'Your session has expired. Sign in again.',
    '22P02': 'One of the values is not in the expected format.',
  };

  if (byCode[code]) return byCode[code];
  if (error.message?.includes('Failed to fetch')) return 'Cannot reach the server. Check your connection and try again.';
  if (error.message?.includes('JWT')) return 'Your session has expired. Sign in again.';
  return error.message || 'Something went wrong. Please try again.';
}

/** Rejects with a readable Error instead of returning `{ data, error }`. */
export async function unwrap(builder) {
  const { data, error } = await builder;
  if (error) {
    const wrapped = new Error(describeError(error));
    wrapped.cause = error;
    throw wrapped;
  }
  return data;
}

/** Current access token, or null when signed out. */
export async function accessToken() {
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token ?? null;
}

/**
 * Calls an Edge Function with the caller's bearer token attached.
 * Throws with the function's own error message when it returns one.
 */
export async function callFunction(name, { method = 'POST', body, signal, query: search } = {}) {
  const token = await accessToken();
  const url = new URL(`${CONFIG.FUNCTIONS_URL}/${name}`);
  if (search) for (const [key, value] of Object.entries(search)) if (value != null) url.searchParams.set(key, value);

  const response = await fetch(url, {
    method,
    signal,
    headers: {
      'content-type': 'application/json',
      apikey: CONFIG.SUPABASE_ANON_KEY,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { error: text };
  }

  if (!response.ok) {
    const error = new Error(payload?.error || `${name} failed with status ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

let cachedAccount;

/**
 * Signed-in user plus their profile row. Cached for the page's lifetime and
 * invalidated on any auth state change, so the header and the page body can
 * both ask for it without duplicating the round trip.
 */
export async function getAccount({ force = false } = {}) {
  if (cachedAccount && !force) return cachedAccount;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    cachedAccount = { user: null, profile: null, isAdmin: false };
    return cachedAccount;
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('id,full_name,role,phone,address,country,occupation,age,avatar_url,created_at')
    .eq('id', user.id)
    .maybeSingle();

  cachedAccount = {
    user,
    profile: profile ?? null,
    isAdmin: profile?.role === 'admin',
  };
  return cachedAccount;
}

supabase.auth.onAuthStateChange(() => {
  cachedAccount = undefined;
});

/** Redirects to sign-in when signed out. Returns the account when signed in. */
export async function requireAuth(returnTo = window.location.pathname.split('/').pop()) {
  const account = await getAccount();
  if (!account.user) {
    window.location.replace(`./auth.html?next=${encodeURIComponent(returnTo || 'account.html')}`);
    return null;
  }
  return account;
}

/** As `requireAuth`, but also enforces the admin role. */
export async function requireAdmin(returnTo = 'admin.html') {
  const account = await requireAuth(returnTo);
  if (!account) return null;
  if (!account.isAdmin) {
    window.location.replace('./account.html?denied=admin');
    return null;
  }
  return account;
}
