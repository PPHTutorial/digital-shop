import { supabase } from './client.js';
import { finishPageLoader, mountFooter, mountHeader, renderIcons } from './ui.js';
import { inlineHtmlFromMarkdown } from './rte.js';

const DOC_TITLES = {
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',
  cookies: 'Cookie Policy',
  refunds: 'Refund Policy',
  licence: 'Digital Licence Agreement',
  'acceptable-use': 'Acceptable Use Policy',
  'dispute-resolution': 'Dispute Resolution & Chargebacks',
  'ip-dmca': 'Intellectual Property & Takedown Policy',
  'vendor-agreement': 'Vendor Agreement',
  'store-policy': 'Store & Listing Policy',
  payouts: 'Payout & Settlement Policy',
};

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function bodyBlockHtml(block) {
  // Block text carries lightweight inline markdown (**bold**, *italic*,
  // `code`, [link](url)) written in the admin rich-text editor — render it
  // rather than showing the literal markers.
  const text = inlineHtmlFromMarkdown(block.text || '');
  switch (block.type) {
    case 'h2': return `<h2>${text}</h2>`;
    case 'h3': return `<h3>${text}</h3>`;
    case 'li': return `<li>${text}</li>`;
    default: return `<p>${text}</p>`;
  }
}

function renderBody(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return '<p>This document has no content yet.</p>';
  const html = [];
  let inList = false;
  for (const block of blocks) {
    if (block.type === 'li' && !inList) { html.push('<ul>'); inList = true; }
    if (block.type !== 'li' && inList) { html.push('</ul>'); inList = false; }
    html.push(bodyBlockHtml(block));
  }
  if (inList) html.push('</ul>');
  return html.join('');
}

async function load() {
  mountHeader();
  mountFooter();

  const params = new URLSearchParams(window.location.search);
  const slug = params.get('doc') || 'terms';

  document.querySelectorAll('[data-legal-link]').forEach((link) => {
    link.classList.toggle('is-active', link.dataset.legalLink === slug);
  });

  const { data, error } = await supabase
    .from('cms_documents')
    .select('title,published')
    .eq('type', 'legal')
    .eq('slug', slug)
    .not('published', 'is', null)
    .maybeSingle();

  document.querySelector('#legal-loading')?.classList.add('hidden');

  if (error || !data) {
    document.querySelector('#legal-not-found')?.classList.remove('hidden');
    finishPageLoader();
    return;
  }

  const doc = data.published || {};
  const title = data.title || DOC_TITLES[slug] || 'Legal document';

  document.title = `${title} | DigiStore`;
  document.querySelector('#legal-hero-title').textContent = title;
  document.querySelector('#legal-hero-sub').textContent = doc.summary || 'The agreements that govern buying, selling, and browsing on DigiStore.';
  document.querySelector('#legal-title').textContent = title;
  document.querySelector('#legal-summary').textContent = doc.summary || '';
  document.querySelector('#legal-summary').classList.toggle('hidden', !doc.summary);
  document.querySelector('#legal-effective').textContent = doc.effective_date ? `Effective ${formatDate(doc.effective_date)}` : '';
  document.querySelector('#legal-effective').classList.toggle('hidden', !doc.effective_date);

  // The refund policy is the one legal document with a live number in it —
  // the platform's standard partial-refund rate, set in the admin Settings
  // screen (site_settings.refund_rate_percent) rather than hardcoded here.
  let body = renderBody(doc.body);
  if (slug === 'refunds') {
    const { data: settings } = await supabase.from('site_settings').select('refund_rate_percent').eq('id', 1).maybeSingle();
    const rate = settings?.refund_rate_percent;
    if (rate != null) {
      body += `<h2>Partial refunds</h2><p>Where a full refund is not appropriate but a good-faith gesture is warranted, DigiStore may issue a partial refund of ${Number(rate)}% of the order value, at the support team's discretion.</p>`;
    }
  }
  document.querySelector('#legal-doc-body').innerHTML = body;

  document.querySelector('#legal-content')?.classList.remove('hidden');
  renderIcons();
  finishPageLoader();
}

load().catch(() => finishPageLoader());
