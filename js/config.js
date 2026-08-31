export const CONFIG = {
  SUPABASE_URL: 'https://synnepvvxpluoydkmphb.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_tx3y5qXU1CGFCzifoZ8ozw_NKAz_Aba',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN5bm5lcHZ2eHBsdW95ZGttcGhiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczNDg3OTEsImV4cCI6MjEwMjkyNDc5MX0.WzHEKiXkxnlG0RYRvutEBAWfa9y2YWIQAY8itVZ6rc0',
  CURRENCY: 'USD',
  PAYMENT_FUNCTIONS_BASE: 'https://synnepvvxpluoydkmphb.functions.supabase.co',
  SITE_URL: window.location.origin,

  // External-link ("ad") listings. Migration 20260827160000
  // (products.is_ad / external_url / ad_status) is applied on remote as of
  // 2026-08-31, so this is live: the catalog hides is_ad rows, their detail
  // page shows a "leaving DigiStore" click-through instead of a checkout, and
  // checkout refuses them. Keep this TRUE so any existing is_ad rows stay
  // handled — it does not, by itself, let sellers create new ones.
  ADS_LIVE: true,

  // Whether sellers (and admins) may CREATE new external-link listings.
  // Paused for launch. Flip this AND site_settings.external_listings_open back
  // on together (migration 20260831170000) when the feature is ready.
  EXTERNAL_LISTINGS_OPEN: false
};


// supabase functions deploy admin-dashboard --project-ref synnepvvxpluoydkmphb --use-api --debug
// supabase functions deploy create-flutterwave-payment --project-ref synnepvvxpluoydkmphb --use-api --debug
// supabase functions deploy create-nowpayments-payment --project-ref synnepvvxpluoydkmphb --use-api --debug
// supabase functions deploy daily-content --project-ref synnepvvxpluoydkmphb --use-api --debug
// supabase functions deploy download-book --project-ref synnepvvxpluoydkmphb --use-api --debug
// supabase functions deploy flutterwave-callback --project-ref synnepvvxpluoydkmphb --use-api --debug
// supabase functions deploy nowpayments-ipn --project-ref synnepvvxpluoydkmphb --use-api --debug
// supabase functions deploy search-index --project-ref synnepvvxpluoydkmphb --use-api --debug
// supabase functions deploy sitemap --project-ref synnepvvxpluoydkmphb --use-api --debug
// supabase functions deploy sitemap --project-ref synnepvvxpluoydkmphb --use-api --debug
// supabase functions deploy ad-funding-callback --project-ref synnepvvxpluoydkmphb --use-api --debug
// supabase functions deploy ad-funding-ipn --project-ref synnepvvxpluoydkmphb --use-api --debug
// supabase functions deploy inspect-product-archive --project-ref synnepvvxpluoydkmphb --use-api --debug