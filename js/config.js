/**
 * Public runtime configuration.
 *
 * Only values that are safe to ship to a browser belong here. The anon key is
 * a public identifier — every table it can reach is guarded by row-level
 * security. Service-role keys, payment secrets, and IPN secrets live in
 * Supabase Function secrets and must never appear in this file.
 *
 * Regenerate for another environment with `npm run config`, which reads
 * SUPABASE_URL / SUPABASE_ANON_KEY / PUBLIC_SITE_URL from the environment.
 */

const PROJECT_REF = 'synnepvvxpluoydkmphb';

export const CONFIG = Object.freeze({
  PROJECT_REF,
  SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`,
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN5bm5lcHZ2eHBsdW95ZGttcGhiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczNDg3OTEsImV4cCI6MjEwMjkyNDc5MX0.WzHEKiXkxnlG0RYRvutEBAWfa9y2YWIQAY8itVZ6rc0',
  FUNCTIONS_URL: `https://${PROJECT_REF}.functions.supabase.co`,
  SITE_URL: typeof window === 'undefined' ? '' : window.location.origin,

  STORE_NAME: 'DigiStore',
  STORE_OPERATOR: 'Codeink Technologies',
  SUPPORT_EMAIL: 'hello@codeinktechnologies.com',
  BASE_CURRENCY: 'USD',

  /** Storage buckets. `files` is private; `media` is public-read. */
  BUCKET_FILES: 'books',
  BUCKET_MEDIA: 'product-images',

  /** Client-side guardrails. */
  PAGE_SIZE: 24,
  MAX_UPLOAD_MB: 25,
  SEARCH_DEBOUNCE_MS: 180,
  AUTOSAVE_DEBOUNCE_MS: 900,
});

/** Throws early and loudly rather than failing deep inside a fetch. */
export function assertConfig() {
  const missing = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'FUNCTIONS_URL'].filter((key) => !CONFIG[key]);
  if (missing.length) {
    throw new Error(`Runtime configuration is incomplete: ${missing.join(', ')}. Run "npm run config".`);
  }
  return CONFIG;
}
