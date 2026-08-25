import { supabase } from './client.js';
import { CONFIG } from './config.js';
import { escapeHtml, finishPageLoader, getAccount, icon, renderIcons, setButtonLoading, toast } from './ui.js';

let account, mode, editingId, dashboardData;
const modal = document.querySelector('#editor-modal');
const detailsModal = document.querySelector('#details-modal');
const imgModal = document.querySelector('#image-editor-modal');
const cropCanvas = document.querySelector('#crop-canvas');

const screenTitles = {
  overview: 'Store overview', products: 'Catalog', categories: 'Categories', transactions: 'Orders',
  customers: 'Customers', promotions: 'Promotions', content: 'Content', automation: 'Operations',
  moderation: 'Sellers & ads', tickets: 'Support',
};

function activateAdminScreen() {
  const key = location.hash.replace('#', '') || 'overview';
  const active = document.querySelector(`#${screenTitles[key] ? key : 'overview'}`);
  document.querySelectorAll('.admin-screen').forEach((screen) => screen.classList.toggle('is-active', screen === active));
  document.querySelectorAll('.admin-link').forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${key}`));
  const title = document.querySelector('#admin-page-title');
  if (title) title.textContent = screenTitles[key] || screenTitles.overview;
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', activateAdminScreen);

// ============================================================
// Mobile navigation drawer
// ============================================================
function setAdminDrawer(open) {
  const sidebar = document.querySelector('#admin-sidebar');
  const scrim = document.querySelector('#admin-scrim');
  const button = document.querySelector('#admin-menu-button');
  if (!sidebar || !scrim) return;

  sidebar.classList.toggle('is-open', open);
  scrim.classList.toggle('is-open', open);
  scrim.hidden = !open;
  button?.setAttribute('aria-expanded', String(open));
  document.body.style.overflow = open ? 'hidden' : '';
  if (open) sidebar.querySelector('.admin-link')?.focus();
}

document.querySelector('#admin-menu-button')?.addEventListener('click', () => setAdminDrawer(true));
document.querySelector('#admin-menu-close')?.addEventListener('click', () => setAdminDrawer(false));
document.querySelector('#admin-scrim')?.addEventListener('click', () => setAdminDrawer(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setAdminDrawer(false);
});
// Choosing a section closes the drawer, so the content is visible straight away.
document.querySelectorAll('.admin-link').forEach((link) => {
  link.addEventListener('click', () => setAdminDrawer(false));
});

// ============================================================
// Marketplace moderation
// ============================================================
const modMoney = (value, currency = 'USD') =>
  `${currency} ${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const modDate = (value) =>
  new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

const modEmpty = (message) => `<p class="py-6 text-center text-sm text-slate-500">${escapeHtml(message)}</p>`;

async function loadModeration() {
  const { data, error } = await supabase.rpc('moderation_queue');
  if (error) {
    document.querySelector('#mod-vendors').innerHTML = modEmpty(error.message);
    return;
  }

  const pendingTotal =
    (data.vendors?.length || 0) + (data.campaigns?.length || 0) +
    (data.topups?.length || 0) + (data.payouts?.length || 0);

  const badge = document.querySelector('#mod-badge');
  if (badge) {
    badge.textContent = pendingTotal;
    badge.classList.toggle('hidden', pendingTotal === 0);
  }

  // --- Seller applications --------------------------------------------------
  document.querySelector('#mod-vendors').innerHTML = data.vendors?.length
    ? data.vendors.map((v) => `
        <div class="border-t border-slate-100 py-4 first:border-t-0">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="min-w-0">
              <strong class="block text-[#142c55]">${escapeHtml(v.display_name)}</strong>
              <span class="text-xs text-slate-500">${escapeHtml(v.country)} · ${escapeHtml(v.payout_currency)} · applied ${escapeHtml(modDate(v.applied_at))} · ${v.commission_rate}% commission</span>
              ${v.bio ? `<p class="mt-2 max-w-2xl text-xs leading-relaxed text-slate-600">${escapeHtml(v.bio)}</p>` : ''}
            </div>
            <div class="flex shrink-0 gap-2">
              <button class="button button-primary !min-h-8 !px-3 text-xs" data-approve-vendor="${v.id}">Approve</button>
              <button class="button !min-h-8 !px-3 text-xs !text-red-600" data-reject-vendor="${v.id}">Reject</button>
            </div>
          </div>
        </div>`).join('')
    : modEmpty('No seller applications waiting.');

  // --- Ad campaigns ---------------------------------------------------------
  document.querySelector('#mod-campaigns').innerHTML = data.campaigns?.length
    ? data.campaigns.map((c) => `
        <div class="border-t border-slate-100 py-4 first:border-t-0">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="min-w-0">
              <strong class="block text-[#142c55]">${escapeHtml(c.name)}</strong>
              <span class="text-xs text-slate-500">
                ${escapeHtml(c.vendor_name)} · ${escapeHtml(c.product_title || 'product removed')} ·
                <span class="capitalize">${escapeHtml(c.placement)}</span> ·
                budget ${modMoney(c.budget, c.currency)}
              </span>
              <span class="mt-1 block text-[11px] text-slate-400">
                ${modMoney(c.cpm_rate, c.currency)}/1k views · ${modMoney(c.cpc_rate, c.currency)}/click · ${c.cpa_percent}%/sale
                · wallet ${modMoney(c.wallet_balance || 0, c.currency)}
              </span>
              ${Number(c.wallet_balance || 0) <= 0
                ? '<span class="mt-1 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">Wallet empty — will not serve until topped up</span>'
                : ''}
            </div>
            <div class="flex shrink-0 gap-2">
              <button class="button button-primary !min-h-8 !px-3 text-xs" data-approve-campaign="${c.id}">Approve</button>
              <button class="button !min-h-8 !px-3 text-xs !text-red-600" data-reject-campaign="${c.id}">Reject</button>
            </div>
          </div>
        </div>`).join('')
    : modEmpty('No campaigns waiting for review.');

  // --- Wallet top-ups -------------------------------------------------------
  document.querySelector('#mod-topups').innerHTML = data.topups?.length
    ? data.topups.map((t) => `
        <div class="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 py-3 first:border-t-0">
          <div class="min-w-0">
            <strong class="block text-sm text-[#142c55]">${modMoney(t.amount, t.currency)}</strong>
            <span class="text-xs text-slate-500">${escapeHtml(t.vendor_name)} · ${escapeHtml(modDate(t.created_at))}</span>
            ${t.note ? `<span class="block text-[11px] text-slate-400">Ref: ${escapeHtml(t.note)}</span>` : ''}
          </div>
          <div class="flex shrink-0 gap-2">
            <button class="button button-primary !min-h-8 !px-3 text-xs" data-approve-topup="${t.id}">Credit</button>
            <button class="button !min-h-8 !px-3 text-xs !text-red-600" data-reject-topup="${t.id}">Reject</button>
          </div>
        </div>`).join('')
    : modEmpty('No top-ups waiting.');

  // --- Payout requests ------------------------------------------------------
  document.querySelector('#mod-payouts').innerHTML = data.payouts?.length
    ? data.payouts.map((p) => {
        const dest = p.method === 'mobile_money'
          ? `${p.momo_provider || 'MoMo'} ····${p.account_last4 || ''}`
          : p.method === 'bank_transfer'
            ? `${p.bank_name || 'Bank'} ····${p.account_last4 || ''}`
            : (p.method || 'account');
        return `
        <div class="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 py-3 first:border-t-0">
          <div class="min-w-0">
            <strong class="block text-sm text-[#142c55]">${modMoney(p.amount, p.currency)}</strong>
            <span class="text-xs text-slate-500">${escapeHtml(p.vendor_name)} → ${escapeHtml(dest)}</span>
            <span class="block text-[11px] text-slate-400">${escapeHtml(p.account_name || '')} · requested ${escapeHtml(modDate(p.requested_at))}</span>
          </div>
          <div class="flex shrink-0 gap-2">
            <button class="button button-primary !min-h-8 !px-3 text-xs" data-pay-payout="${p.id}">Mark paid</button>
            <button class="button !min-h-8 !px-3 text-xs !text-red-600" data-fail-payout="${p.id}">Fail</button>
          </div>
        </div>`;
      }).join('')
    : modEmpty('No payout requests waiting.');

  renderIcons();
}

document.addEventListener('click', async (event) => {
  const el = event.target.closest(
    '[data-approve-vendor],[data-reject-vendor],[data-approve-campaign],[data-reject-campaign],' +
    '[data-approve-topup],[data-reject-topup],[data-pay-payout],[data-fail-payout]'
  );
  if (!el) return;

  const d = el.dataset;
  let result;

  if (d.approveVendor) {
    result = await supabase.rpc('moderate_vendor', { p_vendor_id: d.approveVendor, p_status: 'approved' });
  } else if (d.rejectVendor) {
    const reason = window.prompt('Why is this application being rejected? (shown to the applicant)');
    if (reason === null) return;
    result = await supabase.rpc('moderate_vendor', { p_vendor_id: d.rejectVendor, p_status: 'rejected', p_reason: reason });
  } else if (d.approveCampaign) {
    result = await supabase.rpc('moderate_campaign', { p_campaign_id: d.approveCampaign, p_approve: true });
  } else if (d.rejectCampaign) {
    const note = window.prompt('Why is this campaign being rejected? (shown to the seller)');
    if (note === null) return;
    result = await supabase.rpc('moderate_campaign', { p_campaign_id: d.rejectCampaign, p_approve: false, p_note: note });
  } else if (d.approveTopup) {
    const reference = window.prompt('Payment reference for this top-up (optional):') ?? null;
    result = await supabase.rpc('settle_ad_topup', { p_request_id: d.approveTopup, p_approve: true, p_reference: reference });
  } else if (d.rejectTopup) {
    result = await supabase.rpc('settle_ad_topup', { p_request_id: d.rejectTopup, p_approve: false });
  } else if (d.payPayout) {
    const reference = window.prompt('Transfer reference (optional):') ?? null;
    result = await supabase.from('payouts')
      .update({ status: 'paid', processed_at: new Date().toISOString(), reference })
      .eq('id', d.payPayout);
    if (!result.error) {
      // Earnings attached to this payout are settled at the same time.
      await supabase.from('vendor_earnings').update({ status: 'paid' }).eq('payout_id', d.payPayout);
    }
  } else if (d.failPayout) {
    const reason = window.prompt('Why did this payout fail?');
    if (reason === null) return;
    result = await supabase.from('payouts')
      .update({ status: 'failed', failure_reason: reason, processed_at: new Date().toISOString() })
      .eq('id', d.failPayout);
    if (!result.error) {
      // Release the earnings so the seller can request again.
      await supabase.from('vendor_earnings').update({ payout_id: null }).eq('payout_id', d.failPayout);
    }
  }

  if (result?.error) {
    toast(result.error.message, 'error');
    return;
  }
  toast('Done.');
  await loadModeration();
});

document.querySelector('#refresh-moderation')?.addEventListener('click', loadModeration);

// ============================================================
// Slugify Helper
// ============================================================
function slugify(text) {
  return (text || '')
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function categoryOptions(selected = 'General') {
  const defaults = ['Ebooks & Guides', 'Software & Tools', 'Templates & Themes', 'Online Courses', 'Audio & Media', 'Design & Graphics', 'General'];
  const managed = (dashboardData?.categories || []).map((category) => category.name);
  return [...new Set([...managed, ...defaults, selected])]
    .filter(Boolean)
    .map((name) => `<option value="${escapeHtml(name)}" ${name === selected ? 'selected' : ''}>${escapeHtml(name)}</option>`)
    .join('');
}

// ============================================================
// Image Editor — canvas-based crop + compress
// ============================================================
let editorImg = null;
let editorCallback = null;
let editorAspect = null;
let editorCropBox = { x: 0, y: 0, w: 0, h: 0 };
let editorCanvScale = { x: 1, y: 1 };

function openImageEditor(file, onDone) {
  editorCallback = onDone;
  editorAspect = null;
  document.querySelector('.crop-preset.active')?.classList.remove('active');
  document.querySelector('[data-aspect="free"]')?.classList.add('active');
  const ctx = cropCanvas.getContext('2d');
  ctx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);

  const img = new Image();
  img.onload = () => {
    editorImg = img;
    initCrop();
    imgModal.showModal();
  };
  img.src = URL.createObjectURL(file);
}

function initCrop() {
  const maxW = 560, maxH = 340;
  const srcAspect = editorImg.width / editorImg.height;
  let cw = maxW, ch = maxH;
  if (srcAspect > maxW / maxH) ch = Math.round(cw / srcAspect);
  else cw = Math.round(ch * srcAspect);
  cropCanvas.width = cw;
  cropCanvas.height = ch;
  editorCanvScale = { x: editorImg.width / cw, y: editorImg.height / ch };
  editorCropBox = { x: 0, y: 0, w: cw, h: ch };
  drawCrop();
}

function setCropAspect(aspect) {
  editorAspect = aspect;
  if (!editorImg) return;
  const cw = cropCanvas.width, ch = cropCanvas.height;
  if (aspect === null) {
    editorCropBox = { x: 0, y: 0, w: cw, h: ch };
  } else {
    if (cw / ch > aspect) {
      const nw = Math.round(ch * aspect);
      editorCropBox = { x: Math.round((cw - nw) / 2), y: 0, w: nw, h: ch };
    } else {
      const nh = Math.round(cw / aspect);
      editorCropBox = { x: 0, y: Math.round((ch - nh) / 2), w: cw, h: nh };
    }
  }
  drawCrop();
}

function drawCrop() {
  const ctx = cropCanvas.getContext('2d');
  const { x, y, w, h } = editorCropBox;
  const cw = cropCanvas.width, ch = cropCanvas.height;
  ctx.drawImage(editorImg, 0, 0, cw, ch);
  ctx.fillStyle = 'rgba(0,0,0,0.52)';
  ctx.fillRect(0, 0, cw, ch);
  ctx.clearRect(x, y, w, h);
  const { x: sx, y: sy } = editorCanvScale;
  ctx.drawImage(editorImg, x * sx, y * sy, w * sx, h * sy, x, y, w, h);
  ctx.strokeStyle = '#f97316';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  const s = 8;
  ctx.fillStyle = '#f97316';
  [[x, y], [x + w - s, y], [x, y + h - s], [x + w - s, y + h - s]].forEach(([hx, hy]) => {
    ctx.fillRect(hx, hy, s, s);
  });
}

async function applyCrop() {
  if (!editorImg) return null;
  const { x, y, w, h } = editorCropBox;
  const { x: sx, y: sy } = editorCanvScale;
  const out = document.createElement('canvas');
  out.width = Math.round(w * sx);
  out.height = Math.round(h * sy);
  out.getContext('2d').drawImage(
    editorImg,
    x * sx, y * sy, w * sx, h * sy,
    0, 0, out.width, out.height
  );
  const qualVal = document.querySelector('input[name="img-quality"]:checked')?.value ?? '0.92';
  return new Promise((resolve) => {
    if (qualVal === 'lossless') out.toBlob(resolve, 'image/png');
    else out.toBlob(resolve, 'image/jpeg', parseFloat(qualVal));
  });
}

document.querySelectorAll('.crop-preset').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.crop-preset').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const a = btn.dataset.aspect;
    setCropAspect(a === 'free' ? null : parseFloat(a));
  });
});

[document.querySelector('#cancel-crop-btn'), document.querySelector('#cancel-crop-btn-2')].forEach((b) => {
  b?.addEventListener('click', () => imgModal.close());
});

document.querySelector('#apply-crop-btn').addEventListener('click', async () => {
  const applyBtn = document.querySelector('#apply-crop-btn');
  setButtonLoading(applyBtn, true, 'Uploading…');
  const blob = await applyCrop();
  if (!blob) {
    setButtonLoading(applyBtn, false);
    return;
  }
  const ext = blob.type === 'image/png' ? 'png' : 'jpg';
  const path = `covers/${Date.now()}.${ext}`;
  const { data: up, error: upErr } = await supabase.storage
    .from('product-images')
    .upload(path, blob, { contentType: blob.type, upsert: true });
  setButtonLoading(applyBtn, false);
  if (upErr) {
    toast(upErr.message, 'error');
    return;
  }
  const { data: { publicUrl } } = supabase.storage.from('product-images').getPublicUrl(up.path);
  imgModal.close();
  editorCallback?.(publicUrl);
});

// ============================================================
// File upload helpers & dual pricing
// ============================================================
function wireUploadZones() {
  const coverZone = document.querySelector('#cover-upload-zone');
  const coverInput = document.querySelector('#cover-file-input');
  const coverUrlEl = document.querySelector('#cover-url-input');
  const coverPrev = document.querySelector('#cover-preview');

  if (coverZone && coverInput) {
    coverZone.addEventListener('click', () => coverInput.click());
    coverZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      coverZone.classList.add('drag-over');
    });
    coverZone.addEventListener('dragleave', () => coverZone.classList.remove('drag-over'));
    coverZone.addEventListener('drop', (e) => {
      e.preventDefault();
      coverZone.classList.remove('drag-over');
      const f = e.dataTransfer.files[0];
      if (f?.type.startsWith('image/')) handleCoverFile(f);
    });
    coverInput.addEventListener('change', () => {
      const f = coverInput.files[0];
      if (f) handleCoverFile(f);
    });
  }

  function handleCoverFile(file) {
    openImageEditor(file, (publicUrl) => {
      coverUrlEl.value = publicUrl;
      coverPrev.src = publicUrl;
      coverPrev.classList.remove('hidden');
      document.querySelector('#cover-upload-prompt')?.classList.add('hidden');
    });
  }

  const galleryZone = document.querySelector('#gallery-upload-zone');
  const galleryInput = document.querySelector('#gallery-file-input');
  const galleryUrlsEl = document.querySelector('#gallery-urls-input');
  const galleryPreview = document.querySelector('#gallery-preview-list');
  const readGallery = () => (galleryUrlsEl?.value || '').split(',').map((url) => url.trim()).filter(Boolean);
  const renderGallery = () => {
    if (!galleryPreview) return;
    const urls = readGallery();
    galleryPreview.innerHTML = urls.length ? urls.map((url, index) => `
      <div class="relative h-16 w-16 overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
        <img src="${escapeHtml(url)}" alt="Gallery image ${index + 1}" class="h-full w-full object-cover">
        <button type="button" class="absolute right-0 top-0 grid h-5 w-5 place-items-center rounded-bl bg-slate-900/70 text-xs font-bold text-white" data-remove-gallery="${index}" aria-label="Remove image">×</button>
      </div>`).join('') : '<span class="text-xs text-slate-400">No supporting images yet.</span>';
    galleryPreview.querySelectorAll('[data-remove-gallery]').forEach((button) => button.addEventListener('click', () => {
      const urls = readGallery();
      urls.splice(Number(button.dataset.removeGallery), 1);
      galleryUrlsEl.value = urls.join(', ');
      renderGallery();
    }));
  };
  if (galleryZone && galleryInput) {
    const handleGalleryFiles = (files) => Array.from(files || []).filter((file) => file.type.startsWith('image/')).slice(0, 1).forEach((file) => {
      openImageEditor(file, (publicUrl) => {
        galleryUrlsEl.value = [...readGallery(), publicUrl].join(', ');
        renderGallery();
      });
    });
    galleryZone.addEventListener('click', () => galleryInput.click());
    galleryZone.addEventListener('dragover', (event) => { event.preventDefault(); galleryZone.classList.add('drag-over'); });
    galleryZone.addEventListener('dragleave', () => galleryZone.classList.remove('drag-over'));
    galleryZone.addEventListener('drop', (event) => { event.preventDefault(); galleryZone.classList.remove('drag-over'); handleGalleryFiles(event.dataTransfer.files); });
    galleryInput.addEventListener('change', () => { handleGalleryFiles(galleryInput.files); galleryInput.value = ''; });
    renderGallery();
  }

  const fileZone = document.querySelector('#file-upload-zone');
  const fileInput = document.querySelector('#product-file-input');
  const filePathEl = document.querySelector('#file-path-input');
  const fileStat = document.querySelector('#file-upload-status');

  if (fileZone && fileInput) {
    fileZone.addEventListener('click', () => fileInput.click());
    fileZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      fileZone.classList.add('drag-over');
    });
    fileZone.addEventListener('dragleave', () => fileZone.classList.remove('drag-over'));
    fileZone.addEventListener('drop', (e) => {
      e.preventDefault();
      fileZone.classList.remove('drag-over');
      const f = e.dataTransfer.files[0];
      if (f) handleProductFile(f);
    });
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (f) handleProductFile(f);
    });
  }

  async function handleProductFile(file) {
    if (fileStat) {
      fileStat.textContent = 'Uploading file…';
      fileStat.className = 'text-xs mt-1 text-slate-400';
    }
    const path = `products/${Date.now()}-${file.name.replace(/[^a-z0-9._-]/gi, '_')}`;
    const { data: up, error: upErr } = await supabase.storage
      .from('books')
      .upload(path, file, { upsert: true });
    if (upErr) {
      if (fileStat) {
        fileStat.textContent = upErr.message;
        fileStat.className = 'text-xs mt-1 text-red-600';
      }
      return;
    }
    filePathEl.value = up.path;
    if (fileStat) {
      fileStat.textContent = `✓ Uploaded: ${file.name}`;
      fileStat.className = 'text-xs mt-1 text-green-700';
    }
    document.querySelector('#file-upload-prompt').textContent = `📁 ${file.name}`;
  }

  // Dual pricing auto-calc
  const origEl = document.querySelector('#orig-price-input');
  const saleEl = document.querySelector('#sale-price-input');
  const pctEl = document.querySelector('#discount-pct-input');

  function calcPct() {
    const o = parseFloat(origEl?.value), s = parseFloat(saleEl?.value);
    if (o > 0 && s >= 0 && pctEl) pctEl.value = ((1 - s / o) * 100).toFixed(1);
  }
  function calcSale() {
    const o = parseFloat(origEl?.value), p = parseFloat(pctEl?.value);
    if (o > 0 && p >= 0 && saleEl) saleEl.value = (o * (1 - p / 100)).toFixed(2);
  }
  origEl?.addEventListener('input', calcPct);
  saleEl?.addEventListener('input', calcPct);
  pctEl?.addEventListener('input', calcSale);

  // Auto-slug generator on Title typing
  const titleEl = document.querySelector('#product-title-input');
  const slugEl = document.querySelector('#product-slug-input');
  const autoSlugBtn = document.querySelector('#auto-slug-btn');

  let slugManual = Boolean(slugEl?.value);

  titleEl?.addEventListener('input', () => {
    if (!slugManual || !slugEl.value.trim()) {
      slugEl.value = slugify(titleEl.value);
    }
  });

  slugEl?.addEventListener('input', () => {
    slugManual = Boolean(slugEl.value.trim());
  });

  autoSlugBtn?.addEventListener('click', () => {
    slugEl.value = slugify(titleEl?.value || '');
    slugManual = false;
  });
}

// ============================================================
// Paginated Table Helper
// ============================================================
function renderPaginatedTable(containerSelector, dataList, heads, renderRow, pageSize = 8, onRendered = null) {
  let currentPage = 1;
  const container = document.querySelector(containerSelector);
  if (!container) return;

  function renderPage() {
    if (!dataList || !dataList.length) {
      container.innerHTML = '<p class="py-4 text-sm text-slate-500">No records found.</p>';
      return;
    }

    const totalPages = Math.ceil(dataList.length / pageSize) || 1;
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    const start = (currentPage - 1) * pageSize;
    const end = Math.min(start + pageSize, dataList.length);
    const pageRows = dataList.slice(start, end);

    container.innerHTML = `
      <div class="overflow-x-auto">
        <table class="min-w-full text-left text-sm">
          <thead><tr>${heads.map((h) => `<th class="px-3 py-3 text-xs uppercase tracking-wider text-slate-400 font-bold">${h}</th>`).join('')}</tr></thead>
          <tbody class="divide-y divide-slate-100">${pageRows.map((row) => `<tr>${renderRow(row)}</tr>`).join('')}</tbody>
        </table>
      </div>
      ${
        totalPages > 1 || dataList.length > 5
          ? `<div class="mt-4 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
              <div>Showing <strong class="text-slate-700">${start + 1}–${end}</strong> of <strong class="text-slate-700">${dataList.length}</strong> entries</div>
              <div class="flex items-center gap-1.5">
                <button type="button" class="pg-prev button !min-h-8 !px-3 text-xs ${currentPage === 1 ? '!opacity-40 !pointer-events-none' : ''}">Previous</button>
                <span class="px-2 font-bold text-slate-700">Page ${currentPage} of ${totalPages}</span>
                <button type="button" class="pg-next button !min-h-8 !px-3 text-xs ${currentPage === totalPages ? '!opacity-40 !pointer-events-none' : ''}">Next</button>
              </div>
            </div>`
          : ''
      }
    `;

    container.querySelector('.pg-prev')?.addEventListener('click', () => {
      if (currentPage > 1) {
        currentPage--;
        renderPage();
      }
    });

    container.querySelector('.pg-next')?.addEventListener('click', () => {
      if (currentPage < totalPages) {
        currentPage++;
        renderPage();
      }
    });

    if (typeof onRendered === 'function') {
      onRendered(container, pageRows);
    }
    renderIcons();
  }

  renderPage();
}

function chart(points) {
  const max = Math.max(1, ...points.map((p) => p.revenue));
  const stride = points.length > 12 ? 5 : 1;
  return `<div class="flex h-full items-end gap-1.5">${points.map((p, index) => `
    <div class="group flex flex-1 flex-col items-center justify-end gap-2 min-w-0" title="${p.date}: $${p.revenue.toFixed(2)}">
      <span class="invisible group-hover:visible text-[10px] font-bold text-slate-600">$${p.revenue.toFixed(0)}</span>
      <div class="w-full min-w-[4px] rounded-t bg-gradient-to-t from-orange-500 to-amber-400 transition-opacity group-hover:opacity-75" style="height:${Math.max(5, (p.revenue / max) * 150)}px"></div>
      <small class="text-[9px] text-slate-400">${index % stride === 0 ? p.date.slice(5) : ''}</small>
    </div>`).join('')}</div>`;
}

function renderRankList(items, valueKey, meta) {
  if (!items?.length) return '<p class="text-sm text-slate-500">Data will appear after paid orders are recorded.</p>';
  const max = Math.max(...items.map((item) => Number(item[valueKey]) || 0), 1);
  return `<div class="admin-rank-list">${items.map((item) => `
    <div class="admin-rank-row">
      <div><strong>${escapeHtml(item.title || item.category)}</strong><small>${escapeHtml(meta(item))}</small></div>
      <span class="admin-rank-value">$${Number(item[valueKey]).toFixed(2)}</span>
      <div class="admin-rank-track"><span style="width:${Math.max(4, Number(item[valueKey]) / max * 100)}%"></span></div>
    </div>`).join('')}</div>`;
}

// ============================================================
// Dashboard Load
// ============================================================
async function load() {
  account = await getAccount();
  if (!account.user) {
    const nextUrl = `admin.html${location.search}${location.hash}`;
    location.replace(`./auth.html?mode=signin&next=${encodeURIComponent(nextUrl)}`);
    return;
  }
  if (account.profile?.role !== 'admin') {
    location.replace('./account.html');
    return;
  }
  document.querySelector('#admin-user').textContent = account.user.email;

  // Marketplace queues come straight from the database, so they still render
  // even if the dashboard function is unavailable.
  loadModeration().catch(() => {});

  const { data, error } = await supabase.functions.invoke('admin-dashboard');
  if (error || data?.error) {
    document.querySelector('#admin-status').textContent = data?.error || error?.message;
    document.querySelector('#admin-status').className = 'status-line error';
    finishPageLoader();
    return;
  }

  dashboardData = data;
  const { metrics, orders, users, tickets, products, promos, posts, categories = [], revenueByDay, topProducts = [], categoryStats = [] } = data;

  document.querySelector('#m-revenue').textContent = `$${metrics.revenue.toFixed(2)}`;
  document.querySelector('#m-orders').textContent = metrics.paidOrders;
  document.querySelector('#m-customers').textContent = metrics.customers;
  document.querySelector('#m-tickets').textContent = metrics.openTickets;
  const averageOrder = metrics.paidOrders ? metrics.revenue / metrics.paidOrders : 0;
  document.querySelector('#m-aov').textContent = `Average order $${averageOrder.toFixed(2)}`;
  document.querySelector('#m-conversion').textContent = `${users.filter((u) => u.last_sign_in_at).length} signed in before`;
  document.querySelector('#m-catalog').textContent = `${metrics.activeProducts} of ${products.length} products live`;
  const renderRevenue = () => {
    const days = Number(document.querySelector('#revenue-period')?.value || 30);
    const selected = revenueByDay.slice(-days);
    const total = selected.reduce((sum, item) => sum + Number(item.revenue), 0);
    document.querySelector('#m-revenue-change').textContent = `$${total.toFixed(2)} in the selected period`;
    document.querySelector('#revenue-chart').innerHTML = chart(selected);
  };
  document.querySelector('#revenue-period').onchange = renderRevenue;
  renderRevenue();
  document.querySelector('#operations-list').innerHTML = `
    <div class="metric !p-4"><span>Published products</span><strong>${metrics.activeProducts}</strong><small>${products.length - metrics.activeProducts} drafts remaining</small></div>
    <div class="metric !p-4"><span>Support queue</span><strong>${metrics.openTickets}</strong><small>${tickets.filter((t) => t.status === 'pending').length} awaiting follow-up</small></div>`;
  document.querySelector('#top-products').innerHTML = renderRankList(topProducts, 'revenue', (item) => `${item.orders} paid order${item.orders === 1 ? '' : 's'}`);
  document.querySelector('#category-performance').innerHTML = renderRankList(categoryStats, 'revenue', (item) => `${item.products} product${item.products === 1 ? '' : 's'}`);
  document.querySelector('#customers-insight').textContent = `${users.length} customer profile${users.length === 1 ? '' : 's'} on record`;
  document.querySelector('#orders-insight').textContent = `${orders.filter((o) => o.status === 'paid').length} paid · ${orders.filter((o) => o.status === 'pending').length} pending`;
  document.querySelector('#promos-insight').textContent = `${promos.filter((p) => p.is_active).length} active campaign${promos.filter((p) => p.is_active).length === 1 ? '' : 's'}`;
  document.querySelector('#content-insight').textContent = `${posts.filter((p) => p.status === 'published').length} published article${posts.filter((p) => p.status === 'published').length === 1 ? '' : 's'}`;
  document.querySelector('#support-insight').textContent = `${tickets.filter((t) => t.status !== 'closed').length} conversation${tickets.filter((t) => t.status !== 'closed').length === 1 ? '' : 's'} to resolve`;

  // 1. Customers & Users Management Table (Paginated)
  renderPaginatedTable(
    '#users-table',
    users,
    ['Customer / Email', 'Role', 'Phone / Country', 'Joined', 'Actions'],
    (u) => {
      const roleBadge = u.role === 'admin'
        ? `<span class="tag !bg-purple-100 !text-purple-800">Admin</span>`
        : `<span class="tag !bg-slate-100 !text-slate-700">Customer</span>`;
      return `
        <td class="px-3 py-3">
          <strong class="block text-slate-800">${escapeHtml(u.full_name || 'Anonymous User')}</strong>
          <span class="text-xs text-slate-500">${escapeHtml(u.email || '')}</span>
        </td>
        <td class="px-3 py-3">${roleBadge}</td>
        <td class="px-3 py-3 text-xs text-slate-600">
          <div>${escapeHtml(u.phone || '—')}</div>
          <div class="text-slate-400">${escapeHtml(u.country || '—')}</div>
        </td>
        <td class="px-3 py-3 text-xs text-slate-500">${new Date(u.created_at).toLocaleDateString()}</td>
        <td class="px-3 py-3">
          <div class="flex items-center gap-2">
            <button class="button !min-h-8 !py-1 text-xs" data-edit-customer="${escapeHtml(u.id)}">Manage</button>
            <button class="button !min-h-8 !py-1 text-xs" data-view-customer-orders="${escapeHtml(u.id)}">Orders</button>
          </div>
        </td>`;
    },
    8,
    (container) => {
      container.querySelectorAll('[data-edit-customer]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const u = users.find((item) => item.id === btn.dataset.editCustomer);
          if (u) openCustomerEditor(u);
        });
      });
      container.querySelectorAll('[data-view-customer-orders]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const u = users.find((item) => item.id === btn.dataset.viewCustomerOrders);
          if (u) viewCustomerOrders(u, orders);
        });
      });
    }
  );

  // 2. Transactions / Orders Table (Paginated + Status Filter)
  let activeOrderFilter = 'all';
  const orderStatusColors = {
    paid: '!bg-green-100 !text-green-800',
    pending: '!bg-amber-100 !text-amber-800',
    cancelled: '!bg-red-100 !text-red-700',
    failed: '!bg-red-100 !text-red-700',
    refunded: '!bg-blue-100 !text-blue-700',
  };

  function renderOrdersSection() {
    const paidCount = orders.filter((o) => o.status === 'paid').length;
    const pendingCount = orders.filter((o) => o.status === 'pending').length;
    const cancelledCount = orders.filter((o) => o.status === 'cancelled').length;
    const failedCount = orders.filter((o) => o.status === 'failed').length;

    // Status summary badges
    const summaryEl = document.querySelector('#orders-status-summary');
    if (summaryEl) {
      summaryEl.innerHTML = `
        <span class="tag !bg-green-100 !text-green-800 !text-xs inline-flex items-center gap-1">${icon('check', 12)} ${paidCount} Paid</span>
        <span class="tag !bg-amber-100 !text-amber-800 !text-xs inline-flex items-center gap-1">${icon('clock', 12)} ${pendingCount} Pending</span>
        <span class="tag !bg-red-100 !text-red-700 !text-xs inline-flex items-center gap-1">${icon('x-circle', 12)} ${cancelledCount} Cancelled</span>
        <span class="tag !bg-red-100 !text-red-700 !text-xs inline-flex items-center gap-1">${icon('alert-triangle', 12)} ${failedCount} Failed</span>
        <span class="text-slate-400 text-xs ml-1">(Only paid orders count towards revenue & purchases)</span>`;
    }

    // Filter tabs
    const filterEl = document.querySelector('#orders-filter-tabs');
    if (filterEl) {
      const tabs = [
        { key: 'all', label: `All (${orders.length})` },
        { key: 'paid', label: `Paid (${paidCount})` },
        { key: 'pending', label: `Pending (${pendingCount})` },
        { key: 'cancelled', label: `Cancelled (${cancelledCount})` },
        { key: 'failed', label: `Failed (${failedCount})` },
      ];
      filterEl.innerHTML = tabs
        .map(
          (t) =>
            `<button type="button" class="order-filter-tab rounded-lg px-3 py-1.5 text-xs font-bold transition ${
              activeOrderFilter === t.key ? 'bg-[#142c55] text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }" data-filter="${t.key}">${t.label}</button>`
        )
        .join('');

      filterEl.querySelectorAll('.order-filter-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
          activeOrderFilter = btn.dataset.filter;
          renderOrdersSection();
        });
      });
    }

    // Filtered orders list
    const filtered = activeOrderFilter === 'all' ? orders : orders.filter((o) => o.status === activeOrderFilter);

    renderPaginatedTable(
      '#orders-table',
      filtered,
      ['Customer', 'Product', 'Amount', 'Status', 'Date'],
      (o) => `
        <td class="px-3 py-3">
          <div class="font-medium">${escapeHtml(o.customer_email)}</div>
          <div class="text-[11px] text-slate-400">${escapeHtml(o.provider || 'Gateway')} · ${escapeHtml(o.provider_reference || o.id.slice(0, 8))}</div>
        </td>
        <td class="px-3 py-3">${escapeHtml(o.products?.title || 'Digital Product')}</td>
        <td class="px-3 py-3 font-bold">${escapeHtml(o.currency || 'USD')} ${Number(o.amount).toFixed(2)}</td>
        <td class="px-3 py-3">
          <span class="tag ${orderStatusColors[o.status] || '!bg-slate-100 !text-slate-600'}">${escapeHtml(o.status)}</span>
        </td>
        <td class="px-3 py-3 text-xs text-slate-500">${new Date(o.created_at).toLocaleDateString()}</td>`,
      8
    );
  }

  renderOrdersSection();

  // 3. Products Catalog Table (Paginated)
  renderPaginatedTable(
    '#products-table',
    products,
    ['Product Details', 'Category', 'Pricing', 'Slug / URL', 'Status', 'Actions'],
    (p) => {
      const priceCell = p.original_price
        ? `<span class="price-original text-xs">${p.currency} ${Number(p.original_price).toFixed(2)}</span>
           <strong class="ml-1 text-slate-900 text-xs font-bold">${p.currency} ${Number(p.price).toFixed(2)}</strong>`
        : `<strong class="text-xs font-bold text-slate-900">${p.currency} ${Number(p.price).toFixed(2)}</strong>`;
      const canonicalSlug = p.slug || p.id;
      return `
        <td class="px-3 py-3">
          <div class="flex items-center gap-2.5">
            ${p.cover_url ? `<img src="${escapeHtml(p.cover_url)}" class="h-9 w-9 object-cover rounded-lg bg-slate-100 shrink-0">` : ''}
            <div class="min-w-0 max-w-[180px] sm:max-w-[220px]">
              <strong class="block text-xs font-bold text-[#142c55] truncate" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</strong>
              <span class="text-[10px] text-slate-400 truncate block">${escapeHtml(p.description || 'No description')}</span>
            </div>
          </div>
        </td>
        <td class="px-3 py-3">
          <span class="tag text-[10px] font-semibold">${escapeHtml(p.category || 'General')}</span>
        </td>
        <td class="px-3 py-3">${priceCell}</td>
        <td class="px-3 py-3 text-[11px] font-mono text-slate-500 truncate max-w-[120px]">${escapeHtml(p.slug || '—')}</td>
        <td class="px-3 py-3">
          <span class="tag text-[10px] ${p.is_published ? '!bg-green-100 !text-green-800' : '!bg-slate-100 !text-slate-600'}">${p.is_published ? 'Published' : 'Draft'}</span>
        </td>
        <td class="px-3 py-3">
          <div class="flex items-center gap-1.5 whitespace-nowrap">
            <button class="button !min-h-8 !py-1 text-xs inline-flex items-center gap-1" data-copy-ad-link="${escapeHtml(canonicalSlug)}" title="Copy advertising link">
              ${icon('link', 11)}
              <span>Ad Link</span>
            </button>
            ${p.file_path ? `
              <a href="${escapeHtml(p.file_path.includes('?') ? p.file_path + '&download=' : p.file_path + '?download=')}" target="_blank" download class="button !min-h-8 !py-1 text-xs text-blue-600 hover:bg-blue-50 inline-flex items-center gap-1" title="Direct test download for this product asset">
                ${icon('download', 11)}
                <span>Test File</span>
              </a>` : ''}
            <button class="button !min-h-8 !py-1 text-xs inline-flex items-center gap-1" data-edit-product="${escapeHtml(p.id)}">
              ${icon('edit-2', 11)}
              <span>Edit</span>
            </button>
            <button class="button !min-h-8 !py-1 text-xs text-red-600 hover:bg-red-50 inline-flex items-center gap-1" data-delete-product="${escapeHtml(p.id)}">
              ${icon('trash-2', 11)}
              <span>Delete</span>
            </button>
          </div>
        </td>`;
    },
    8,
    (container) => {
      container.querySelectorAll('[data-copy-ad-link]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const slug = btn.dataset.copyAdLink;
          const adUrl = `${window.location.origin}/checkout.html?product=${encodeURIComponent(slug)}`;
          navigator.clipboard.writeText(adUrl);
          toast('Advertising link copied to clipboard!');
        });
      });
      container.querySelectorAll('[data-edit-product]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.editProduct;
          const p = products.find((item) => item.id === id);
          openEditor('product', p || { id });
        });
      });
      container.querySelectorAll('[data-delete-product]').forEach((btn) => {
        btn.addEventListener('click', () => deleteProduct(btn.dataset.deleteProduct));
      });
    }
  );

  // 4. Category management is intentionally independent from products: editors
  // can curate navigation before (or after) assigning products to it.
  renderPaginatedTable(
    '#categories-table',
    categories,
    ['Category', 'Storefront URL', 'Products', 'Visibility', 'Actions'],
    (category) => {
      const assigned = products.filter((product) => (product.category || 'General').toLowerCase() === category.name.toLowerCase()).length;
      return `
        <td class="px-3 py-3"><strong class="block text-slate-800">${escapeHtml(category.name)}</strong><span class="text-xs text-slate-500">${escapeHtml(category.description || 'No description')}</span></td>
        <td class="px-3 py-3 text-xs font-mono text-slate-500">/${escapeHtml(category.slug)}</td>
        <td class="px-3 py-3 text-xs font-bold">${assigned}</td>
        <td class="px-3 py-3"><span class="tag text-[10px] ${category.is_active ? '!bg-green-100 !text-green-800' : '!bg-slate-100 !text-slate-600'}">${category.is_active ? 'Visible' : 'Hidden'}</span></td>
        <td class="px-3 py-3"><div class="flex gap-2"><button class="button !min-h-8 !py-1 text-xs" data-edit-category="${escapeHtml(category.id)}">Edit</button><button class="button !min-h-8 !py-1 text-xs" data-toggle-category="${escapeHtml(category.id)}" data-active="${category.is_active}">${category.is_active ? 'Hide' : 'Show'}</button></div></td>`;
    },
    8,
    (container) => {
      container.querySelectorAll('[data-edit-category]').forEach((btn) => btn.addEventListener('click', () => openEditor('category', categories.find((item) => item.id === btn.dataset.editCategory))));
      container.querySelectorAll('[data-toggle-category]').forEach((btn) => btn.addEventListener('click', async () => {
        const { error } = await supabase.from('categories').update({ is_active: btn.dataset.active !== 'true' }).eq('id', btn.dataset.toggleCategory);
        if (error) toast(error.message, 'error'); else { toast('Category visibility updated.'); load(); }
      }));
    }
  );

  // 5. Promo Codes Table (Paginated)
  renderPaginatedTable(
    '#promos-table',
    promos,
    ['Promo Code', 'Discount', 'Redemptions', 'Status', 'Actions'],
    (p) => `
      <td class="px-3 py-3 font-bold text-[#142c55] font-mono text-xs">${escapeHtml(p.code)}</td>
      <td class="px-3 py-3 text-xs">${p.discount_type === 'percent' ? `${p.discount_value}%` : `$${p.discount_value}`}</td>
      <td class="px-3 py-3 text-xs">${p.redemption_count} ${p.max_redemptions ? `/ ${p.max_redemptions}` : ''}</td>
      <td class="px-3 py-3">
        <span class="tag text-[10px] ${p.is_active ? '!bg-green-100 !text-green-800' : '!bg-slate-100 !text-slate-600'}">${p.is_active ? 'Active' : 'Paused'}</span>
      </td>
      <td class="px-3 py-3">
        <div class="flex items-center gap-1.5">
          <button class="button !min-h-8 !py-1 text-xs" data-toggle-promo="${escapeHtml(p.id)}" data-active="${p.is_active}">
            ${p.is_active ? 'Pause' : 'Activate'}
          </button>
          <button class="button !min-h-8 !py-1 text-xs text-red-600 hover:bg-red-50" data-delete-promo="${escapeHtml(p.id)}">Delete</button>
        </div>
      </td>`,
    8,
    (container) => {
      container.querySelectorAll('[data-toggle-promo]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.togglePromo;
          const current = btn.dataset.active === 'true';
          setButtonLoading(btn, true, 'Updating…');
          const { error } = await supabase.from('promo_codes').update({ is_active: !current }).eq('id', id);
          setButtonLoading(btn, false);
          if (error) toast(error.message, 'error');
          else {
            toast(`Promo code ${current ? 'paused' : 'activated'}.`);
            load();
          }
        });
      });
      container.querySelectorAll('[data-delete-promo]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this promotion code?')) return;
          const id = btn.dataset.deletePromo;
          const { error } = await supabase.from('promo_codes').delete().eq('id', id);
          if (error) toast(error.message, 'error');
          else {
            toast('Promo code deleted.');
            load();
          }
        });
      });
    }
  );

  // 5. Blog Posts Table (Paginated)
  renderPaginatedTable(
    '#posts-table',
    posts,
    ['Article Title', 'Status', 'Date', 'Actions'],
    (p) => `
      <td class="px-3 py-3">
        <strong class="block text-xs font-bold text-[#142c55] truncate max-w-xs">${escapeHtml(p.title)}</strong>
        <span class="text-[10px] font-mono text-slate-400">/${escapeHtml(p.slug || '')}</span>
      </td>
      <td class="px-3 py-3">
        <span class="tag text-[10px] ${p.status === 'published' ? '!bg-green-100 !text-green-800' : '!bg-amber-100 !text-amber-800'}">${escapeHtml(p.status)}</span>
      </td>
      <td class="px-3 py-3 text-xs text-slate-500">${new Date(p.created_at).toLocaleDateString()}</td>
      <td class="px-3 py-3">
        <div class="flex items-center gap-1.5">
          <button class="button !min-h-8 !py-1 text-xs" data-toggle-post="${escapeHtml(p.id)}" data-status="${p.status}">
            ${p.status === 'published' ? 'Unpublish' : 'Publish'}
          </button>
          <button class="button !min-h-8 !py-1 text-xs text-red-600 hover:bg-red-50" data-delete-post="${escapeHtml(p.id)}">Delete</button>
        </div>
      </td>`,
    8,
    (container) => {
      container.querySelectorAll('[data-toggle-post]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.togglePost;
          const isPub = btn.dataset.status === 'published';
          setButtonLoading(btn, true, 'Updating…');
          const { error } = await supabase.from('blog_posts').update({ status: isPub ? 'draft' : 'published' }).eq('id', id);
          setButtonLoading(btn, false);
          if (error) toast(error.message, 'error');
          else {
            toast(`Post ${isPub ? 'unpublished' : 'published'}.`);
            load();
          }
        });
      });
      container.querySelectorAll('[data-delete-post]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this article?')) return;
          const id = btn.dataset.deletePost;
          const { error } = await supabase.from('blog_posts').delete().eq('id', id);
          if (error) toast(error.message, 'error');
          else {
            toast('Article deleted.');
            load();
          }
        });
      });
    }
  );

  // 6. Tickets Table (Paginated)
  renderPaginatedTable(
    '#tickets-table',
    tickets,
    ['Sender / Email', 'Subject', 'Status', 'Date', 'Actions'],
    (t) => `
      <td class="px-3 py-3">
        <strong class="block text-xs font-bold text-[#142c55]">${escapeHtml(t.name || 'User')}</strong>
        <span class="text-[10px] text-slate-400">${escapeHtml(t.email)}</span>
      </td>
      <td class="px-3 py-3">
        <span class="text-xs font-medium text-slate-700 block truncate max-w-xs">${escapeHtml(t.subject)}</span>
        <span class="text-[10px] text-slate-400 line-clamp-1">${escapeHtml(t.message || '')}</span>
      </td>
      <td class="px-3 py-3">
        <span class="tag text-[10px] ${t.status === 'closed' ? '!bg-slate-100 !text-slate-600' : '!bg-orange-100 !text-orange-800'}">${escapeHtml(t.status)}</span>
      </td>
      <td class="px-3 py-3 text-xs text-slate-500">${new Date(t.created_at).toLocaleDateString()}</td>
      <td class="px-3 py-3">
        <div class="flex items-center gap-1.5">
          <button class="button !min-h-8 !py-1 text-xs" data-toggle-ticket="${escapeHtml(t.id)}" data-status="${t.status}">
            ${t.status === 'closed' ? 'Reopen' : 'Resolve'}
          </button>
        </div>
      </td>`,
    8,
    (container) => {
      container.querySelectorAll('[data-toggle-ticket]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.toggleTicket;
          const isClosed = btn.dataset.status === 'closed';
          setButtonLoading(btn, true, 'Updating…');
          const { error } = await supabase.from('tickets').update({ status: isClosed ? 'open' : 'closed' }).eq('id', id);
          setButtonLoading(btn, false);
          if (error) toast(error.message, 'error');
          else {
            toast(`Ticket marked as ${isClosed ? 'open' : 'resolved'}.`);
            load();
          }
        });
      });
    }
  );

  document.querySelector('#admin-status').textContent = 'Live dashboard data refreshed.';
  document.querySelector('#admin-status').className = 'status-line success';
  finishPageLoader();
}

// ============================================================
// Customer Management Dialogs
// ============================================================
function openCustomerEditor(user) {
  mode = 'customer';
  editingId = user.id;

  document.querySelector('#editor-eyebrow').textContent = 'CUSTOMER MANAGEMENT';
  document.querySelector('#editor-title').textContent = `Manage: ${user.email}`;

  document.querySelector('#editor-fields').innerHTML = `
    <div>
      <label class="label text-xs font-bold">Full Name</label>
      <input class="field !mt-1" name="full_name" value="${escapeHtml(user.full_name || '')}" placeholder="Customer full name">
    </div>

    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="label text-xs font-bold">System Role</label>
        <select class="field !mt-1" name="role">
          <option value="customer" ${user.role === 'customer' ? 'selected' : ''}>Customer (Standard)</option>
          <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Administrator (Full Access)</option>
        </select>
      </div>
      <div>
        <label class="label text-xs font-bold">Phone Number</label>
        <input class="field !mt-1" name="phone" value="${escapeHtml(user.phone || '')}" placeholder="+123456789">
      </div>
    </div>

    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="label text-xs font-bold">Country</label>
        <input class="field !mt-1" name="country" value="${escapeHtml(user.country || '')}" placeholder="e.g. United States, Ghana">
      </div>
      <div>
        <label class="label text-xs font-bold">Occupation</label>
        <input class="field !mt-1" name="occupation" value="${escapeHtml(user.occupation || '')}" placeholder="Occupation">
      </div>
    </div>

    <div>
      <label class="label text-xs font-bold">Address</label>
      <textarea class="field !mt-1" name="address" rows="2" placeholder="Customer address">${escapeHtml(user.address || '')}</textarea>
    </div>`;

  modal.showModal();
}

function viewCustomerOrders(user, allOrders) {
  const userOrders = allOrders.filter((o) => o.user_id === user.id || o.customer_email?.toLowerCase() === user.email?.toLowerCase());

  document.querySelector('#details-eyebrow').textContent = 'CUSTOMER RECORD';
  document.querySelector('#details-title').textContent = `${user.full_name || user.email}`;

  let ordersHtml = userOrders.length
    ? userOrders.map((o) => `
        <div class="p-3.5 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between">
          <div>
            <strong class="block text-sm text-[#142c55]">${escapeHtml(o.products?.title || 'Digital Product')}</strong>
            <span class="text-xs text-slate-400">${new Date(o.created_at).toLocaleString()} · Ref: ${escapeHtml(o.provider_reference || o.id.slice(0, 8))}</span>
          </div>
          <div class="text-right">
            <strong class="block text-sm text-slate-900">${escapeHtml(o.currency || 'USD')} ${Number(o.amount).toFixed(2)}</strong>
            <span class="tag !text-[10px] ${o.status === 'paid' ? '!bg-green-100 !text-green-800' : '!bg-amber-100 !text-amber-800'}">${escapeHtml(o.status)}</span>
          </div>
        </div>
      `).join('')
    : '<p class="text-sm text-slate-500 py-2">No orders placed by this customer yet.</p>';

  document.querySelector('#details-content').innerHTML = `
    <div class="p-4 bg-orange-50 border border-orange-100 rounded-xl space-y-1 text-xs">
      <div class="flex justify-between"><strong>Email:</strong> <span>${escapeHtml(user.email)}</span></div>
      <div class="flex justify-between"><strong>Role:</strong> <span>${escapeHtml(user.role)}</span></div>
      <div class="flex justify-between"><strong>Phone:</strong> <span>${escapeHtml(user.phone || '—')}</span></div>
      <div class="flex justify-between"><strong>Country:</strong> <span>${escapeHtml(user.country || '—')}</span></div>
      <div class="flex justify-between"><strong>Joined:</strong> <span>${new Date(user.created_at).toLocaleDateString()}</span></div>
    </div>
    
    <div>
      <h3 class="font-black text-sm text-[#142c55] mb-2">Order History (${userOrders.length})</h3>
      <div class="space-y-2 max-h-56 overflow-y-auto">${ordersHtml}</div>
    </div>`;

  detailsModal.showModal();
}

// ============================================================
// Entity Editor Modal (Fetching ALL Details)
// ============================================================
async function openEditor(type, existing = null) {
  mode = type;
  editingId = existing?.id ?? null;

  document.querySelector('#editor-eyebrow').textContent = type === 'product' ? 'PRODUCT CATALOG' : type === 'post' ? 'JOURNAL CMS' : type === 'category' ? 'CATALOG TAXONOMY' : 'PROMOTIONS';
  document.querySelector('#editor-title').textContent =
    type === 'product' ? (existing?.id ? 'Edit product details' : 'Add new product') : type === 'post' ? (existing?.id ? 'Edit article' : 'Write article') : type === 'category' ? (existing?.id ? 'Edit category' : 'Add category') : 'Add promotion code';

  let full = existing || {};

  // Fetch 100% full fresh row from database so no fields are missing or truncated!
  if (editingId) {
    const tableTarget = type === 'product' ? 'products' : type === 'post' ? 'blog_posts' : type === 'category' ? 'categories' : 'promo_codes';
    const { data: fresh } = await supabase.from(tableTarget).select('*').eq('id', editingId).maybeSingle();
    if (fresh) full = fresh;
  }

  if (type === 'product') {
    const isEdit = Boolean(editingId);
    const op = full.original_price ?? '';
    const currentCat = full.category || 'General';
    const initialSlug = full.slug || (full.title ? slugify(full.title) : '');
    const liveAdUrl = `${window.location.origin}/checkout.html?product=${encodeURIComponent(initialSlug || 'product-slug')}`;

    if (!isEdit) {
      // ============================================================
      // CREATE PRODUCT MODAL (Slug below description)
      // ============================================================
      document.querySelector('#editor-fields').innerHTML = `
        <div class="space-y-4">
          <div>
            <label class="label text-xs font-bold text-slate-700" for="product-title-input">Product Title *</label>
            <input class="field !mt-1" id="product-title-input" name="title" placeholder="e.g. Next.js SaaS Architecture Blueprint" value="" required>
          </div>

          <div>
            <label class="label text-xs font-bold text-slate-700" for="product-category-input">Category *</label>
            <select class="field !mt-1" id="product-category-input" name="category">
              ${categoryOptions()}
            </select>
          </div>

          <div class="grid grid-cols-3 gap-3">
            <div>
              <label class="label text-xs font-bold text-slate-700">Original price (Was)</label>
              <input class="field !mt-1" id="orig-price-input" name="original_price" type="number" step=".01" min="0" placeholder="0.00">
            </div>
            <div>
              <label class="label text-xs font-bold text-slate-700">Sale price (Now) *</label>
              <input class="field font-bold !mt-1" id="sale-price-input" name="price" type="number" step=".01" min="0" placeholder="0.00" required>
            </div>
            <div>
              <label class="label text-xs font-bold text-slate-700">Discount %</label>
              <input class="field !mt-1" id="discount-pct-input" type="number" step="0.1" min="0" max="100" placeholder="Auto">
            </div>
          </div>

          <div>
            <label class="label text-xs font-bold text-slate-700">Cover Image</label>
            <div class="upload-zone mt-1" id="cover-upload-zone">
              <input type="file" id="cover-file-input" accept="image/*" class="hidden">
              <img id="cover-preview" class="hidden h-28 mx-auto rounded-lg object-cover mb-2" alt="">
              <div id="cover-upload-prompt" class="flex flex-col items-center justify-center gap-1 text-slate-500 py-2">
                <i data-lucide="upload-cloud" width="24" height="24" class="text-slate-400"></i>
                <span class="text-xs font-bold text-slate-700">Click or drag image to upload</span>
                <span class="text-[11px] text-slate-400">Image crop &amp; compress tool opens automatically</span>
              </div>
            </div>
            <input type="hidden" name="cover_url" id="cover-url-input" value="">
          </div>

          <div>
            <label class="label text-xs font-bold text-slate-700">Product gallery</label>
            <p class="help">Add supporting images one at a time. Each image uses the same crop and quality controls as the cover.</p>
            <div class="mt-2 flex flex-wrap gap-2" id="gallery-preview-list"></div>
            <div class="upload-zone mt-2 !p-3" id="gallery-upload-zone"><input type="file" id="gallery-file-input" accept="image/*" class="hidden"><span class="text-xs font-bold text-slate-700">Add gallery image</span></div>
            <input type="hidden" name="gallery_urls" id="gallery-urls-input" value="">
          </div>

          <div>
            <label class="label text-xs font-bold text-slate-700">Product Downloadable File Asset *</label>
            <div class="upload-zone mt-1" id="file-upload-zone">
              <input type="file" id="product-file-input" class="hidden">
              <div id="file-upload-prompt" class="flex flex-col items-center justify-center gap-1 text-slate-500 py-2">
                <i data-lucide="package" width="24" height="24" class="text-slate-400"></i>
                <span class="text-xs font-bold text-slate-700">Click or drag file (ZIP, PDF, EPUB, DMG…)</span>
                <span class="text-[11px] text-slate-400">Encrypted in private storage</span>
              </div>
            </div>
            <input type="hidden" name="file_path" id="file-path-input" value="">
            <p id="file-upload-status" class="text-xs mt-1 text-slate-500 font-medium"></p>
          </div>

          <div>
            <label class="label text-xs font-bold text-slate-700">Product Description</label>
            <textarea class="field !mt-1" name="description" placeholder="Comprehensive product overview, highlights, features, and bundle contents…" rows="3"></textarea>
          </div>

          <div class="form-section-card space-y-3">
            <div class="flex items-center justify-between">
              <label class="label text-xs font-bold text-slate-700" for="product-slug-input">SEO URL Slug *</label>
              <button type="button" id="auto-slug-btn" class="text-xs text-orange-600 font-bold hover:underline flex items-center gap-1">
                <i data-lucide="zap" width="12" height="12"></i>
                <span>Auto Generate</span>
              </button>
            </div>
            <input class="field font-mono text-xs !mt-1" id="product-slug-input" name="slug" placeholder="e.g. nextjs-saas-blueprint" value="" required>

            <div class="p-2.5 bg-white rounded-lg border border-slate-200 text-xs space-y-1">
              <div class="flex items-center justify-between font-bold text-slate-600">
                <span>Checkout Link Preview</span>
                <button type="button" id="copy-modal-ad-link" class="text-orange-600 font-bold hover:underline flex items-center gap-1">
                  <i data-lucide="copy" width="12" height="12"></i>
                  <span>Copy</span>
                </button>
              </div>
              <div id="modal-ad-link-preview" class="font-mono text-[11px] text-slate-500 truncate">
                ${liveAdUrl}
              </div>
            </div>
          </div>

          <label class="flex items-center gap-2 text-sm font-semibold cursor-pointer pt-1">
            <input type="checkbox" name="is_published" checked class="rounded text-orange-600">
            <span>Publish immediately in store catalog</span>
          </label>
        </div>`;
    } else {
      // ============================================================
      // UPDATE PRODUCT MODAL (Slug placed below description)
      // ============================================================
      const galleryVal = Array.isArray(full.gallery_urls) ? full.gallery_urls.join(', ') : (full.gallery_urls || '');

      document.querySelector('#editor-fields').innerHTML = `
        <div class="space-y-4">
          <div class="form-section-card space-y-3">
            <h3 class="text-xs font-black text-[#142c55] uppercase tracking-wider">Product Information</h3>
            <div>
              <label class="label text-xs" for="product-title-input">Product Title *</label>
              <input class="field !mt-1" id="product-title-input" name="title" value="${escapeHtml(full.title ?? '')}" required>
            </div>

            <div>
            <label class="label text-xs" for="product-category-input">Category *</label>
            <select class="field !mt-1" id="product-category-input" name="category">
                ${categoryOptions(currentCat)}
              </select>
            </div>
          </div>

          <div class="form-section-card space-y-3">
            <h3 class="text-xs font-black text-[#142c55] uppercase tracking-wider">Pricing &amp; Discounts</h3>
            <div class="grid grid-cols-3 gap-3">
              <div>
                <label class="label text-xs">Original price (Was)</label>
                <input class="field !mt-1" id="orig-price-input" name="original_price" type="number" step=".01" min="0" placeholder="0.00" value="${op}">
              </div>
              <div>
                <label class="label text-xs font-bold">Sale price (Now) *</label>
                <input class="field font-bold !mt-1" id="sale-price-input" name="price" type="number" step=".01" min="0" placeholder="0.00" value="${full.price ?? ''}" required>
              </div>
              <div>
                <label class="label text-xs">Discount %</label>
                <input class="field !mt-1" id="discount-pct-input" type="number" step="0.1" min="0" max="100" placeholder="Auto">
              </div>
            </div>
          </div>

          <div class="form-section-card space-y-3">
            <div class="flex items-center justify-between">
              <h3 class="text-xs font-black text-[#142c55] uppercase tracking-wider">Cover Image &amp; Gallery</h3>
              ${full.cover_url ? `<span class="tag !text-[10px] !bg-green-100 !text-green-800">Cover Active</span>` : ''}
            </div>

            <div class="flex flex-wrap sm:flex-nowrap items-center gap-4">
              ${
                full.cover_url
                  ? `<div class="relative group shrink-0 w-20 h-20 rounded-xl overflow-hidden border border-slate-200 shadow-sm bg-slate-100">
                      <img id="cover-preview" src="${escapeHtml(full.cover_url)}" class="w-full h-full object-cover" alt="Cover">
                     </div>`
                  : `<img id="cover-preview" class="hidden w-20 h-20 rounded-xl object-cover border border-slate-200" alt="">`
              }
              <div class="upload-zone flex-1 !p-3" id="cover-upload-zone">
                <input type="file" id="cover-file-input" accept="image/*" class="hidden">
                <p id="cover-upload-prompt" class="text-xs font-bold text-slate-700 flex items-center justify-center gap-1.5">
                  <i data-lucide="image" width="14" height="14"></i>
                  <span>${full.cover_url ? 'Replace cover image' : 'Upload cover image'}</span>
                </p>
                <p class="text-[10px] text-slate-400 mt-0.5">Click or drag to crop &amp; compress</p>
              </div>
            </div>
            <input type="hidden" name="cover_url" id="cover-url-input" value="${escapeHtml(full.cover_url ?? '')}">

            <div>
              <label class="label text-xs">Product gallery</label>
              <p class="help">Supporting images display as a product gallery at checkout. Add, crop and remove them here.</p>
              <div class="mt-2 flex flex-wrap gap-2" id="gallery-preview-list"></div>
              <div class="upload-zone mt-2 !p-3" id="gallery-upload-zone"><input type="file" id="gallery-file-input" accept="image/*" class="hidden"><span class="text-xs font-bold text-slate-700">Add gallery image</span></div>
              <input type="hidden" name="gallery_urls" id="gallery-urls-input" value="${escapeHtml(galleryVal)}">
            </div>
          </div>

          <div class="form-section-card space-y-3">
            <div class="flex items-center justify-between">
              <h3 class="text-xs font-black text-[#142c55] uppercase tracking-wider">Downloadable Asset</h3>
              ${full.file_path ? `<span class="tag !text-[10px] !bg-green-100 !text-green-800">File Linked</span>` : '<span class="tag !text-[10px] !bg-amber-100 !text-amber-800">Pending Upload</span>'}
            </div>

            <div class="p-3 bg-white rounded-xl border border-slate-200 flex items-center justify-between gap-3">
              <div class="flex items-center gap-2.5 min-w-0">
                <div class="w-8 h-8 rounded-lg bg-orange-50 border border-orange-100 text-orange-600 flex items-center justify-center shrink-0">
                  <i data-lucide="file-check" width="16" height="16"></i>
                </div>
                <div class="min-w-0">
                  <span class="block text-xs font-bold text-slate-800 truncate">${full.file_path ? escapeHtml(full.file_path) : 'No file uploaded yet'}</span>
                  <span class="block text-[10px] text-slate-400">Stored in encrypted bucket</span>
                </div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                ${
                  full.file_path
                    ? `<a href="${escapeHtml(full.file_path.includes('?') ? full.file_path + '&download=' : full.file_path + '?download=')}" target="_blank" download class="button !min-h-7 !py-1 !px-2.5 text-[11px] font-bold text-blue-600 hover:bg-blue-50 inline-flex items-center gap-1">
                        <i data-lucide="download" width="11" height="11"></i>
                        <span>Test File</span>
                       </a>`
                    : ''
                }
                <div class="upload-zone !p-1.5 !px-3 cursor-pointer text-xs font-bold text-orange-600 hover:bg-orange-50 border-orange-200" id="file-upload-zone">
                  <input type="file" id="product-file-input" class="hidden">
                  <span id="file-upload-prompt" class="flex items-center gap-1 text-xs">
                    <i data-lucide="upload" width="12" height="12"></i>
                    <span>${full.file_path ? 'Replace File' : 'Upload File'}</span>
                  </span>
                </div>
              </div>
            </div>
            <input type="hidden" name="file_path" id="file-path-input" value="${escapeHtml(full.file_path ?? '')}">
            <p id="file-upload-status" class="text-xs text-slate-500 font-medium"></p>
          </div>

          <div class="form-section-card space-y-2">
            <div class="flex items-center justify-between">
              <label class="text-xs font-black text-[#142c55] uppercase tracking-wider">Product Description</label>
              <button type="button" id="toggle-desc-size-btn" class="text-xs text-orange-600 font-bold hover:underline">Expand Editor</button>
            </div>
            <textarea class="field !mt-1" id="product-desc-textarea" name="description" placeholder="Comprehensive product description, chapters, instructions…" rows="3">${escapeHtml(full.description ?? '')}</textarea>
          </div>

          <div class="form-section-card space-y-3">
            <div class="flex items-center justify-between">
              <label class="text-xs font-black text-[#142c55] uppercase tracking-wider" for="product-slug-input">SEO URL Slug *</label>
              <button type="button" id="auto-slug-btn" class="text-xs text-orange-600 font-bold hover:underline flex items-center gap-1">
                <i data-lucide="zap" width="12" height="12"></i>
                <span>Auto Generate</span>
              </button>
            </div>
            <input class="field font-mono text-xs !mt-1" id="product-slug-input" name="slug" value="${escapeHtml(initialSlug)}" required>

            <div class="p-2.5 bg-white rounded-lg border border-slate-200 space-y-1.5 shadow-inner">
              <div class="flex items-center justify-between text-xs font-bold text-slate-700">
                <span class="flex items-center gap-1.5">
                  <i data-lucide="link" width="13" height="13" class="text-orange-500"></i>
                  <span>Live Advertising &amp; Checkout Link</span>
                </span>
                <button type="button" id="copy-modal-ad-link" class="text-orange-600 font-bold hover:underline flex items-center gap-1">
                  <i data-lucide="copy" width="12" height="12"></i>
                  <span>Copy Link</span>
                </button>
              </div>
              <div id="modal-ad-link-preview" class="font-mono text-[11px] text-slate-600 truncate">
                ${liveAdUrl}
              </div>
            </div>
          </div>

          <label class="flex items-center gap-2 text-sm font-semibold cursor-pointer pt-1">
            <input type="checkbox" name="is_published" ${full.is_published ? 'checked' : ''} class="rounded text-orange-600">
            <span>Publish in store catalog</span>
          </label>
        </div>`;

      // Wire description toggle
      const descArea = document.querySelector('#product-desc-textarea');
      const toggleDescBtn = document.querySelector('#toggle-desc-size-btn');
      toggleDescBtn?.addEventListener('click', () => {
        if (descArea.rows === 3) {
          descArea.rows = 8;
          toggleDescBtn.textContent = 'Collapse';
        } else {
          descArea.rows = 3;
          toggleDescBtn.textContent = 'Expand Editor';
        }
      });
    }

    // Live shareable ad link updates
    const slugInput = document.querySelector('#product-slug-input');
    const adPreview = document.querySelector('#modal-ad-link-preview');
    const copyAdBtn = document.querySelector('#copy-modal-ad-link');

    function updateAdLink() {
      const s = slugInput?.value.trim() || 'product-slug';
      const u = `${window.location.origin}/checkout.html?product=${encodeURIComponent(s)}`;
      if (adPreview) adPreview.textContent = u;
    }

    slugInput?.addEventListener('input', updateAdLink);
    document.querySelector('#product-title-input')?.addEventListener('input', () => setTimeout(updateAdLink, 10));
    document.querySelector('#auto-slug-btn')?.addEventListener('click', () => {
      const titleVal = document.querySelector('#product-title-input')?.value || '';
      if (slugInput && titleVal) {
        slugInput.value = slugify(titleVal);
        updateAdLink();
      }
    });

    copyAdBtn?.addEventListener('click', () => {
      const s = slugInput?.value.trim() || 'product-slug';
      const u = `${window.location.origin}/checkout.html?product=${encodeURIComponent(s)}`;
      navigator.clipboard.writeText(u);
      toast('Advertising link copied to clipboard!');
    });

    renderIcons();
    setTimeout(wireUploadZones, 0);
  } else if (type === 'post') {
    document.querySelector('#editor-fields').innerHTML = `
      <div><label class="label">Article title *</label><input id="post-title-input" class="field" name="title" value="${escapeHtml(full.title ?? '')}" required></div>
      <div><label class="label">SEO slug *</label><input id="post-slug-input" class="field font-mono text-xs" name="slug" value="${escapeHtml(full.slug ?? '')}" required></div>
      <div><label class="label">Excerpt</label><textarea class="field" name="excerpt" rows="2">${escapeHtml(full.excerpt ?? '')}</textarea></div>
      <div><label class="label">Article content *</label><textarea class="field" name="content" rows="12" required>${escapeHtml(full.content ?? '')}</textarea></div>
      <div class="grid grid-cols-2 gap-3"><label><span class="label">Cover image URL</span><input class="field" name="cover_url" value="${escapeHtml(full.cover_url ?? '')}"></label><label><span class="label">Source URL</span><input class="field" name="source_url" value="${escapeHtml(full.source_url ?? '')}"></label></div>
      <label class="flex gap-2 text-sm font-bold"><input type="checkbox" name="published" ${full.status === 'published' ? 'checked' : ''}> Publish immediately</label>`;
    const title = document.querySelector('#post-title-input'); const slug = document.querySelector('#post-slug-input');
    title?.addEventListener('input', () => { if (!slug.dataset.edited) slug.value = slugify(title.value); }); slug?.addEventListener('input', () => { slug.dataset.edited = 'true'; });
  } else if (type === 'category') {
    document.querySelector('#editor-fields').innerHTML = `
      <div class="form-section-card space-y-4">
        <div><label class="label">Category name *</label><input id="category-name-input" class="field" name="name" value="${escapeHtml(full.name ?? '')}" placeholder="e.g. Business templates" required></div>
        <div><label class="label">Storefront slug *</label><input id="category-slug-input" class="field font-mono text-xs" name="slug" value="${escapeHtml(full.slug ?? '')}" placeholder="business-templates" required></div>
        <div><label class="label">Description</label><textarea class="field" name="description" rows="3" placeholder="A short customer-facing explanation">${escapeHtml(full.description ?? '')}</textarea></div>
        <div class="grid gap-3 sm:grid-cols-2"><label><span class="label">Display order</span><input class="field" name="sort_order" type="number" min="0" value="${full.sort_order ?? 0}"></label><label class="flex items-end gap-2 pb-3 text-sm font-bold"><input type="checkbox" name="is_active" ${full.is_active !== false ? 'checked' : ''}> Show in the storefront</label></div>
      </div>`;
    const name = document.querySelector('#category-name-input'); const slug = document.querySelector('#category-slug-input');
    name?.addEventListener('input', () => { if (!slug.dataset.edited) slug.value = slugify(name.value); });
    slug?.addEventListener('input', () => { slug.dataset.edited = 'true'; });
  } else if (type === 'promo') {
    document.querySelector('#editor-fields').innerHTML = `
      <div>
        <label class="label">Promo Code *</label>
        <input class="field font-mono uppercase font-bold" name="code" placeholder="e.g. SAVE20" value="${escapeHtml(full.code ?? '')}" required>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label">Discount Type</label>
          <select class="field" name="discount_type">
            <option value="percent" ${full.discount_type === 'percent' ? 'selected' : ''}>Percentage (%)</option>
            <option value="fixed" ${full.discount_type === 'fixed' ? 'selected' : ''}>Fixed Amount ($)</option>
          </select>
        </div>
        <div>
          <label class="label">Discount Value *</label>
          <input class="field" name="discount_value" type="number" step=".01" min="0.01" placeholder="e.g. 20" value="${full.discount_value ?? ''}" required>
        </div>
      </div>
      <div>
        <label class="label">Max Redemptions (Optional)</label>
        <input class="field" name="max_redemptions" type="number" min="1" placeholder="Unlimited if empty" value="${full.max_redemptions ?? ''}">`
  }

  if (modal && !modal.open) {
    modal.showModal();
  }
}

async function deleteProduct(id) {
  if (!confirm('Are you sure you want to delete this product? This action cannot be undone.')) return;
  const { error } = await supabase.from('products').delete().eq('id', id);
  if (error) {
    toast(error.message, 'error');
    return;
  }
  toast('Product deleted.');
  // Refresh sitemap in background
  supabase.functions.invoke('sitemap').catch(() => {});
  load();
}

// ============================================================
// Form Submit Handling
// ============================================================
document.querySelector('#editor-form').onsubmit = async (e) => {
  e.preventDefault();
  const submitBtn = document.querySelector('#editor-submit-btn');
  const v = Object.fromEntries(new FormData(e.currentTarget).entries());

  if (mode === 'customer') {
    setButtonLoading(submitBtn, true, 'Updating customer…');
    const { data: res, error } = await supabase.functions.invoke('admin-dashboard', {
      body: {
        action: 'update_user_role',
        target_user_id: editingId,
        role: v.role,
        full_name: v.full_name,
        phone: v.phone,
        country: v.country,
        address: v.address,
        occupation: v.occupation,
      },
    });
    setButtonLoading(submitBtn, false);

    if (error || res?.error) {
      toast(res?.error || error?.message, 'error');
      return;
    }

    toast('Customer updated successfully!');
    modal.close();
    load();
    return;
  }

  if (mode === 'product') {
    v.price = Number(v.price);
    v.currency = 'USD';
    v.is_published = e.currentTarget.elements.is_published.checked;
    v.original_price = v.original_price ? Number(v.original_price) : null;
    v.category = v.category || 'General';
    v.slug = slugify(v.slug || v.title);

    if (v.gallery_urls) {
      v.gallery_urls = v.gallery_urls.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      v.gallery_urls = null;
    }

    if (!v.slug) {
      toast('Please enter a title or slug for the product.', 'error');
      return;
    }
    if (!v.file_path && !editingId) {
      toast('Please upload a downloadable product file first.', 'error');
      return;
    }
    if (!v.file_path) delete v.file_path;
    delete v[''];
  } else if (mode === 'post') {
    v.slug = slugify(v.slug || v.title);
    v.status = e.currentTarget.elements.published.checked ? 'published' : 'draft';
    v.published_at = v.status === 'published' ? new Date().toISOString() : null;
    delete v.published;
  } else if (mode === 'promo') {
    v.code = v.code.toUpperCase().trim();
    v.discount_value = Number(v.discount_value);
    v.max_redemptions = v.max_redemptions ? parseInt(v.max_redemptions) : null;
  } else if (mode === 'category') {
    v.slug = slugify(v.slug || v.name);
    v.sort_order = Number(v.sort_order || 0);
    v.is_active = e.currentTarget.elements.is_active.checked;
    if (!v.slug) {
      toast('Please enter a category name or slug.', 'error');
      return;
    }
  }

  setButtonLoading(submitBtn, true, 'Saving…');
  let error;
  if (mode === 'product' && editingId) {
    ({ error } = await supabase.from('products').update(v).eq('id', editingId));
  } else if (mode === 'product') {
    ({ error } = await supabase.from('products').insert(v));
  } else if (mode === 'post' && editingId) {
    ({ error } = await supabase.from('blog_posts').update(v).eq('id', editingId));
  } else if (mode === 'post') {
    ({ error } = await supabase.from('blog_posts').insert(v));
  } else if (mode === 'category' && editingId) {
    ({ error } = await supabase.from('categories').update(v).eq('id', editingId));
  } else if (mode === 'category') {
    ({ error } = await supabase.from('categories').insert(v));
  } else {
    ({ error } = await supabase.from('promo_codes').insert(v));
  }
  setButtonLoading(submitBtn, false);

  if (error) {
    toast(error.message, 'error');
    return;
  }

  modal.close();
  toast(mode === 'category' ? `Category ${editingId ? 'updated' : 'created'} successfully.` : editingId ? 'Changes saved successfully.' : 'Record created successfully.');

  // Automatically refresh sitemap on product changes
  supabase.functions.invoke('sitemap').catch(() => {});

  load();
};

// Wiring dialog close & modal buttons
document.querySelector('#new-product')?.addEventListener('click', (e) => {
  e.preventDefault();
  openEditor('product');
});

document.querySelector('#new-promo')?.addEventListener('click', (e) => {
  e.preventDefault();
  openEditor('promo');
});

document.querySelector('#new-category')?.addEventListener('click', () => openEditor('category'));
document.querySelector('#new-post')?.addEventListener('click', () => openEditor('post'));

async function runAutomation(functionName, button) {
  const feedback = document.querySelector('#automation-feedback');
  setButtonLoading(button, true, 'Running…');
  if (functionName === 'sitemap') {
    window.open(`${CONFIG.PAYMENT_FUNCTIONS_BASE}/sitemap`, '_blank', 'noopener');
    setButtonLoading(button, false);
    feedback.textContent = 'The live dynamic sitemap opened in a new tab.';
    feedback.className = 'status-line success mt-4';
    return;
  }
  const { data, error } = await supabase.functions.invoke(functionName);
  setButtonLoading(button, false);
  if (error || data?.error) { feedback.textContent = data?.error || error?.message || 'Automation failed.'; feedback.className = 'status-line error mt-4'; return; }
  feedback.textContent = `${functionName.replace('-', ' ')} completed.`; feedback.className = 'status-line success mt-4'; toast('Automation completed.'); load();
}
document.querySelectorAll('#run-daily-content, #run-daily-content-secondary').forEach((button) => button?.addEventListener('click', () => runAutomation('daily-content', button)));
document.querySelector('#run-search-index')?.addEventListener('click', (event) => runAutomation('search-index', event.currentTarget));
document.querySelector('#refresh-sitemap')?.addEventListener('click', (event) => runAutomation('sitemap', event.currentTarget));

document.querySelector('#close-modal')?.addEventListener('click', () => modal?.close());
document.querySelector('#cancel-modal-btn')?.addEventListener('click', () => modal?.close());
document.querySelector('#close-details-modal')?.addEventListener('click', () => detailsModal?.close());
document.querySelector('#close-details-btn')?.addEventListener('click', () => detailsModal?.close());

// Close dialogs ONLY when strictly clicking on the outer backdrop outside modal rect
function setupBackdropClose(dialog) {
  if (!dialog) return;
  dialog.addEventListener('click', (e) => {
    const rect = dialog.getBoundingClientRect();
    const isOutside =
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom;
    if (isOutside && dialog.open) {
      dialog.close();
    }
  });
}

[modal, detailsModal, imgModal].forEach(setupBackdropClose);

// Sign out + CMS settings
document.querySelectorAll('#admin-signout, #admin-header-signout').forEach((btn) => {
  btn.onclick = async () => {
    await supabase.auth.signOut();
    location.href = './index.html';
  };
});

document.querySelector('#cms-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = Object.fromEntries(new FormData(e.currentTarget).entries());
  const { error } = await supabase.from('site_settings').upsert({ id: 1, ...v, updated_by: account.user.id });
  toast(error ? error.message : 'Content saved.', error ? 'error' : 'success');
});

activateAdminScreen();
load().catch((err) => {
  console.error('Admin initialization error:', err);
  finishPageLoader();
});
