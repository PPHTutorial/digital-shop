# Northstar Books — Secure Digital Shop Prototype

A static HTML + JavaScript + Tailwind storefront with a Supabase/Postgres backend layer for authentication, CMS, support tickets, payment verification, and protected digital downloads.

## Design direction

The visual direction combines current premium Tailwind ecommerce patterns: roomy product cards, rounded containers, strong typography, dense admin tables, and checkout/support coverage. The implementation is original and does not copy proprietary template source. The reference direction was informed by Preline's premium ecommerce storefront/admin page structure. citeturn940323search7turn940323search9

## Security model

- Never put Flutterwave secret keys or NOWPayments API/IPN secrets in frontend files.
- Customer passwords are handled by Supabase Auth, not stored in your own tables.
- Payment redirects are not treated as proof of payment.
- Flutterwave is re-verified server-side before marking an order paid. Their current docs explicitly require server-side verification and recommend checking status, amount, currency, and tx_ref before releasing value. citeturn940323search1turn940323search3
- NOWPayments is created server-side using its API key and uses a signed IPN callback. NOWPayments documents IPN secrets for authenticity verification. citeturn951093search0turn951093search4
- Books live in a private storage bucket and are released through short-lived signed URLs.
- RLS policies protect profiles/orders/tickets/CMS from ordinary users.

## GitHub Pages temporary hosting

GitHub Pages can host the static frontend, but it cannot safely hold payment-provider secrets or run the payment verification endpoints. Deploy `/supabase` to Supabase and keep the frontend on GitHub Pages during the interim.

### Configure

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the SQL editor.
3. Create a private Storage bucket named `books` and upload your PDFs/EPUBs.
4. Put the exact file path into each product's `file_path`.
5. Set `js/config.js` with the Supabase URL, anon key, and Functions base URL. The browser must only receive the publishable/anon key.
6. Deploy the Edge Functions and set secrets:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `PUBLIC_SITE_URL`
   - `STORE_NAME`
   - `FLW_SECRET_KEY`
   - `NOWPAYMENTS_API_KEY`
   - `NOWPAYMENTS_IPN_SECRET`
   - `SUPABASE_FUNCTIONS_URL`
7. `create-flutterwave-payment` already points the provider redirect at `flutterwave-callback`, which verifies the transaction and creates the one-time download token before returning the customer to the static success page.
8. In NOWPayments, set the IPN callback URL to the deployed `nowpayments-ipn` function.
9. Create one admin user, then update its `profiles.role` to `admin` in SQL.
10. Add products through the admin CMS/catalog workflow.

## Authentication and deployment checklist

1. In Supabase Auth URL Configuration, set the Site URL to the deployed storefront URL and add `https://YOUR-DOMAIN/auth.html` to Redirect URLs. This enables email-confirmation links to return to the store.
2. Run the updated `supabase/schema.sql`. It is safe to rerun and creates a profile automatically for every new Auth user.
3. Deploy all five Edge Functions again. Checkout now invokes the payment functions with the customer's access token, and those functions verify that the requested order belongs to that customer.
4. Rotate the Supabase service-role key, Flutterwave secret key, NOWPayments API key, and NOWPayments IPN secret. They were previously committed in the frontend configuration and must be considered exposed. Set the replacements only with `supabase secrets set`; never put them in `js/config.js`.

## Data minimization

The requested form includes age, gender, occupation, and address. Those fields are included in the prototype, but they should be retained only when they serve a real business/compliance purpose. Do not send them to payment gateways unless actually needed.

## Payment notes

Flutterwave currently supports hosted checkout/HTML checkout and returns the customer with `status`, `tx_ref`, and a transaction ID. The provider documentation says the final transaction state should be verified on the server. citeturn940323search1

NOWPayments currently exposes `POST /v1/payment`, takes an API key header, and supports `ipn_callback_url` plus order metadata for fulfillment. citeturn951093search0

## Preview

Open `index.html` locally or serve this directory with any static server. Replace the Supabase placeholders before expecting catalog, auth, payments, and admin features to work.


supabase functions deploy create-flutterwave-payment --project-ref synnepvvxpluoydkmphb --use-api --debug
supabase functions deploy flutterwave-callback --project-ref synnepvvxpluoydkmphb --use-api --debug
supabase functions deploy create-nowpayments-payment --project-ref synnepvvxpluoydkmphb --use-api --debug
supabase functions deploy nowpayments-ipn --project-ref synnepvvxpluoydkmphb --use-api --debug
supabase functions deploy download-book --project-ref synnepvvxpluoydkmphb --use-api --debug
