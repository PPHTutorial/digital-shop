/**
 * inspect-product-archive
 *
 * Server-side check that a .zip / .apk product file is a real deliverable and
 * not a thin wrapper around "go to this website and pay/redeem there" — which
 * is an ad, and must go through External-link mode + the ad deposit instead.
 *
 * The browser (js/vendor.js / js/admin.js) calls this right after uploading the
 * file, before the product row exists, so it keys off the storage path. The
 * verdict lands in public.archive_scans via record_archive_scan(); the
 * products BEFORE-trigger (20260831140000) then refuses to publish a hosted
 * archive whose path has no 'ok' row.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { unzipSync, strFromU8 } from 'https://esm.sh/fflate@0.8.2';
import { corsHeaders, json } from '../_shared/cors.ts';

const DEEP_SCAN_LIMIT = 8 * 1024 * 1024;      // above this, too big to be a link wrapper
const TEXT_BUDGET = 256 * 1024;               // stop decoding text past this
const PAYLOAD_MIN = 20 * 1024;                // an entry this big counts as real content

const TEXTISH = /\.(txt|nfo|url|webloc|desktop|html?|md|rtf|json|xml|csv|ini|cfg|lnk)$/i;
const URL_RE = /\bhttps?:\/\/[^\s"'<>)\]}]+/gi;
const VERB_RE = /\b(visit|go to|open (the|this)|redeem|claim|activate|unlock|get it (from|at)|download (it )?from|access (your|the)|click (here|the link)|purchase (at|from)|buy (it )?(at|from)|enter (your )?(code|key) at)\b/i;

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const db = createClient(url, serviceKey);

  let filePath = '';
  try {
    const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'Authentication required.' }, { status: 401 });

    const auth = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: { user }, error: authError } = await auth.auth.getUser();
    if (authError || !user) return json({ error: 'Invalid session.' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    filePath = String(body.file_path || '').replace(/^books\//, '').trim();
    if (!filePath) return json({ error: 'file_path is required.' }, { status: 400 });

    // Light ownership guard: seller uploads land under vendors/<vendor_id>/.
    const owner = filePath.match(/^vendors\/([0-9a-f-]{36})\//i)?.[1];
    if (owner) {
      const { data: mine } = await auth.from('vendors').select('id').eq('id', owner).maybeSingle();
      const { data: admin } = await auth.rpc('is_admin');
      if (!mine && admin !== true) return json({ error: 'Not your file.' }, { status: 403 });
    }

    const { data: blob, error: dlError } = await db.storage.from('books').download(filePath);
    if (dlError || !blob) return json({ error: 'The uploaded file could not be read.' }, { status: 404 });

    const bytes = new Uint8Array(await blob.arrayBuffer());

    // Not a ZIP container (APKs are ZIPs) → nothing to wrap, pass it.
    const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    if (!isZip) return await settle(db, filePath, 'ok', 'not_a_zip');
    if (bytes.length > DEEP_SCAN_LIMIT) return await settle(db, filePath, 'ok', 'too_large_to_wrap');

    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes);
    } catch (_e) {
      return await settle(db, filePath, 'ok', 'unreadable_zip');
    }

    let payloadCount = 0;
    let fileCount = 0;
    let text = '';
    const names: string[] = [];

    for (const [name, content] of Object.entries(entries)) {
      if (name.endsWith('/')) continue;
      fileCount++;
      names.push(name);
      const base = name.split('/').pop() || name;
      const textish = TEXTISH.test(base) || !base.includes('.') || /read.?me|instruction|how.?to|start.?here|link/i.test(base);

      if (textish && text.length < TEXT_BUDGET) {
        text += '\n' + strFromU8(content.subarray(0, TEXT_BUDGET)).slice(0, TEXT_BUDGET - text.length);
      } else if (!textish && content.length >= PAYLOAD_MIN) {
        payloadCount++;
      }
    }

    const haystack = (text + '\n' + names.join('\n')).slice(0, TEXT_BUDGET + 4096);
    const urls = haystack.match(URL_RE) || [];
    const verb = VERB_RE.test(haystack);

    const looksLikeWrapper = payloadCount === 0 && urls.length >= 1 && verb;
    const verdict = looksLikeWrapper ? 'external_wrapper' : 'ok';
    const detail = `files=${fileCount} payload=${payloadCount} urls=${urls.length} verb=${verb}`;

    return await settle(db, filePath, verdict, detail);
  } catch (error) {
    const message = String((error as Error)?.message || error);
    if (filePath) { try { await settle(db, filePath, 'error', message.slice(0, 200)); } catch (_e) { /* noop */ } }
    return json({ error: message }, { status: 500 });
  }
});

async function settle(
  db: ReturnType<typeof createClient>,
  filePath: string,
  verdict: 'ok' | 'external_wrapper' | 'error',
  detail: string,
) {
  await db.rpc('record_archive_scan', { p_file_path: filePath, p_verdict: verdict, p_detail: detail });
  return json({ verdict, detail, file_path: filePath });
}
