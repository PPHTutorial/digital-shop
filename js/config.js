export const CONFIG = {
  SUPABASE_URL: 'https://synnepvvxpluoydkmphb.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_tx3y5qXU1CGFCzifoZ8ozw_NKAz_Aba',
  CURRENCY: 'USD',
  PAYMENT_FUNCTIONS_BASE: 'https://synnepvvxpluoydkmphb.functions.supabase.co'
};

const supabase = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY
);


//supabase secrets set SUPABASE_URL='https://synnepvvxpluoydkmphb.supabase.co'
//supabase secrets set SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY"
//supabase secrets set PUBLIC_SITE_URL="https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPOSITORY"
//supabase secrets set STORE_NAME="Dital Shop"
//supabase secrets set FLW_SECRET_KEY="FLWSECK-b893799d803d6f35b8c72a42c6d5c353-1959601ffd2vt-X"
//supabase secrets set NOWPAYMENTS_API_KEY="WCGQVEW-1CP4JDX-PWV250G-X6A1RHD"
//supabase secrets set NOWPAYMENTS_IPN_SECRET="eLpLNumBSE/Y7OL9Ozt6lnzOLKjMLnp5"
//supabase secrets set SUPABASE_FUNCTIONS_URL="https://synnepvvxpluoydkmphb.supabase.co/functions/v1"

git init`
git commit -m "first commit"`
git branch -M main`
git remote add origin https://github.com/PPHTutorial/digital-shop.git`
git push -u origin main`