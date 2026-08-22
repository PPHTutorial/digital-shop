import { supabase } from './client.js';
import { escapeHtml, getAccount, setButtonLoading, toast } from './ui.js';

let account, mode, editingId;
const modal     = document.querySelector('#editor-modal');
const imgModal  = document.querySelector('#image-editor-modal');
const cropCanvas = document.querySelector('#crop-canvas');

// ============================================================
// Image Editor — canvas-based crop + compress
// ============================================================
let editorImg        = null;   // HTMLImageElement
let editorCallback   = null;   // (blob) => void
let editorAspect     = null;   // null=free, number=w/h ratio
let editorCropBox    = { x: 0, y: 0, w: 0, h: 0 };
let editorCanvScale  = { x: 1, y: 1 }; // canvas-to-source mapping

function openImageEditor(file, onDone) {
  editorCallback = onDone;
  editorAspect   = null;
  document.querySelector('.crop-preset.active')?.classList.remove('active');
  document.querySelector('[data-aspect="free"]').classList.add('active');
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
  cropCanvas.width  = cw;
  cropCanvas.height = ch;
  editorCanvScale   = { x: editorImg.width / cw, y: editorImg.height / ch };
  editorCropBox     = { x: 0, y: 0, w: cw, h: ch };
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
  // Full image first
  ctx.drawImage(editorImg, 0, 0, cw, ch);
  // Dark mask outside crop
  ctx.fillStyle = 'rgba(0,0,0,0.52)';
  ctx.fillRect(0, 0, cw, ch);
  // Clear + redraw inside crop
  ctx.clearRect(x, y, w, h);
  const { x: sx, y: sy } = editorCanvScale;
  ctx.drawImage(editorImg, x * sx, y * sy, w * sx, h * sy, x, y, w, h);
  // Crop border
  ctx.strokeStyle = '#f97316';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  // Corner handles
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
  out.width  = Math.round(w * sx);
  out.height = Math.round(h * sy);
  out.getContext('2d').drawImage(
    editorImg,
    x * sx, y * sy, w * sx, h * sy,
    0, 0, out.width, out.height
  );
  const qualVal = document.querySelector('input[name="img-quality"]:checked')?.value ?? '0.92';
  return new Promise(resolve => {
    if (qualVal === 'lossless') out.toBlob(resolve, 'image/png');
    else out.toBlob(resolve, 'image/jpeg', parseFloat(qualVal));
  });
}

// Crop preset buttons
document.querySelectorAll('.crop-preset').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.crop-preset').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const a = btn.dataset.aspect;
    setCropAspect(a === 'free' ? null : parseFloat(a));
  });
});

// Cancel buttons for image editor
[document.querySelector('#cancel-crop-btn'), document.querySelector('#cancel-crop-btn-2')].forEach(b => {
  b?.addEventListener('click', () => imgModal.close());
});

// Apply & Upload
document.querySelector('#apply-crop-btn').addEventListener('click', async () => {
  const applyBtn = document.querySelector('#apply-crop-btn');
  setButtonLoading(applyBtn, true, 'Uploading…');
  const blob = await applyCrop();
  if (!blob) { setButtonLoading(applyBtn, false); return; }
  const ext  = blob.type === 'image/png' ? 'png' : 'jpg';
  const path = `covers/${Date.now()}.${ext}`;
  const { data: up, error: upErr } = await supabase.storage
    .from('product-images')
    .upload(path, blob, { contentType: blob.type, upsert: true });
  setButtonLoading(applyBtn, false);
  if (upErr) { toast(upErr.message, 'error'); return; }
  const { data: { publicUrl } } = supabase.storage.from('product-images').getPublicUrl(up.path);
  imgModal.close();
  editorCallback?.(publicUrl);
});

// ============================================================
// File upload helpers (called from openEditor)
// ============================================================
function wireUploadZones() {
  // ---- Cover image ----
  const coverZone  = document.querySelector('#cover-upload-zone');
  const coverInput = document.querySelector('#cover-file-input');
  const coverUrlEl = document.querySelector('#cover-url-input');
  const coverPrev  = document.querySelector('#cover-preview');

  if (coverZone && coverInput) {
    coverZone.addEventListener('click', () => coverInput.click());
    coverZone.addEventListener('dragover', e => { e.preventDefault(); coverZone.classList.add('drag-over'); });
    coverZone.addEventListener('dragleave', () => coverZone.classList.remove('drag-over'));
    coverZone.addEventListener('drop', e => {
      e.preventDefault(); coverZone.classList.remove('drag-over');
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
      document.querySelector('#cover-upload-prompt').classList.add('hidden');
    });
  }

  // ---- Product file ----
  const fileZone   = document.querySelector('#file-upload-zone');
  const fileInput  = document.querySelector('#product-file-input');
  const filePathEl = document.querySelector('#file-path-input');
  const fileStat   = document.querySelector('#file-upload-status');

  if (fileZone && fileInput) {
    fileZone.addEventListener('click', () => fileInput.click());
    fileZone.addEventListener('dragover', e => { e.preventDefault(); fileZone.classList.add('drag-over'); });
    fileZone.addEventListener('dragleave', () => fileZone.classList.remove('drag-over'));
    fileZone.addEventListener('drop', e => {
      e.preventDefault(); fileZone.classList.remove('drag-over');
      const f = e.dataTransfer.files[0];
      if (f) handleProductFile(f);
    });
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (f) handleProductFile(f);
    });
  }

  async function handleProductFile(file) {
    if (fileStat) { fileStat.textContent = 'Uploading…'; fileStat.className = 'text-xs mt-1 text-slate-400'; }
    const path = `products/${Date.now()}-${file.name.replace(/[^a-z0-9._-]/gi, '_')}`;
    const { data: up, error: upErr } = await supabase.storage
      .from('books')
      .upload(path, file, { upsert: true });
    if (upErr) {
      if (fileStat) { fileStat.textContent = upErr.message; fileStat.className = 'text-xs mt-1 text-red-600'; }
      return;
    }
    filePathEl.value = up.path;
    if (fileStat) { fileStat.textContent = `✓ Uploaded: ${file.name}`; fileStat.className = 'text-xs mt-1 text-green-700'; }
    document.querySelector('#file-upload-prompt').textContent = `📁 ${file.name}`;
  }

  // ---- Dual pricing auto-calc ----
  const origEl  = document.querySelector('#orig-price-input');
  const saleEl  = document.querySelector('#sale-price-input');
  const pctEl   = document.querySelector('#discount-pct-input');

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
}

// ============================================================
// Table helper
// ============================================================
const table = (rows, heads, render) =>
  rows?.length
    ? `<div class="overflow-x-auto"><table class="min-w-full text-left text-sm">
        <thead><tr>${heads.map(h => `<th class="px-3 py-3 text-slate-400">${h}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(row => `<tr class="border-t border-slate-100">${render(row)}</tr>`).join('')}</tbody>
      </table></div>`
    : '<p class="py-4 text-sm text-slate-500">No data yet.</p>';

function chart(points) {
  const max = Math.max(1, ...points.map(p => p.revenue));
  return `<div class="flex h-full items-end gap-2">${points.map(p => `
    <div class="flex flex-1 flex-col items-center gap-2">
      <span class="text-xs font-bold">$${p.revenue.toFixed(0)}</span>
      <div class="w-full rounded-t bg-orange-500" style="height:${Math.max(5, p.revenue / max * 150)}px"></div>
      <small class="text-[10px] text-slate-400">${p.date.slice(5)}</small>
    </div>`).join('')}</div>`;
}

// ============================================================
// Dashboard load
// ============================================================
async function load() {
  account = await getAccount();
  if (!account.user || account.profile?.role !== 'admin') {
    location.replace('./account.html'); return;
  }
  document.querySelector('#admin-user').textContent = account.user.email;

  const { data, error } = await supabase.functions.invoke('admin-dashboard');
  if (error || data?.error) {
    document.querySelector('#admin-status').textContent = data?.error || error?.message;
    document.querySelector('#admin-status').className = 'status-line error'; return;
  }

  const { metrics, orders, users, tickets, products, promos, posts, revenueByDay } = data;
  document.querySelector('#m-revenue').textContent   = `$${metrics.revenue.toFixed(2)}`;
  document.querySelector('#m-orders').textContent    = metrics.paidOrders;
  document.querySelector('#m-customers').textContent = metrics.customers;
  document.querySelector('#m-tickets').textContent   = metrics.openTickets;
  document.querySelector('#revenue-chart').innerHTML = chart(revenueByDay);
  document.querySelector('#operations-list').innerHTML = `
    <div class="metric !p-4"><span>Published products</span><strong>${metrics.activeProducts}</strong></div>
    <div class="metric !p-4"><span>Support queue</span><strong>${metrics.openTickets}</strong></div>`;

  document.querySelector('#users-table').innerHTML = table(users, ['Email', 'Joined', 'Last sign-in'],
    u => `<td class="px-3 py-3">${escapeHtml(u.email || '')}</td>
           <td class="px-3 py-3">${new Date(u.created_at).toLocaleDateString()}</td>
           <td class="px-3 py-3">${u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleDateString() : '—'}</td>`);

  document.querySelector('#orders-table').innerHTML = table(orders, ['Customer', 'Product', 'Amount', 'Status', 'Provider'],
    o => `<td class="px-3 py-3">${escapeHtml(o.customer_email)}</td>
           <td class="px-3 py-3">${escapeHtml(o.products?.title || '')}</td>
           <td class="px-3 py-3">$${Number(o.amount).toFixed(2)}</td>
           <td class="px-3 py-3">${escapeHtml(o.status)}</td>
           <td class="px-3 py-3">${escapeHtml(o.provider || '—')}</td>`);

  // Products — show was/now price + edit/delete
  document.querySelector('#products-table').innerHTML = table(
    products, ['Title', 'Price', 'Status', 'Actions'],
    p => {
      const priceCell = p.original_price
        ? `<span class="price-original">${p.currency} ${Number(p.original_price).toFixed(2)}</span>
           <strong class="ml-1">${p.currency} ${Number(p.price).toFixed(2)}</strong>`
        : `<strong>${p.currency} ${Number(p.price).toFixed(2)}</strong>`;
      return `<td class="px-3 py-3">${escapeHtml(p.title)}</td>
               <td class="px-3 py-3">${priceCell}</td>
               <td class="px-3 py-3">${p.is_published ? '✅ Published' : '⬜ Draft'}</td>
               <td class="px-3 py-3 flex gap-2">
                 <button class="button text-xs" data-edit-id="${escapeHtml(p.id)}"
                   data-product='${JSON.stringify(p).replace(/'/g, "&#39;")}'>Edit</button>
                 <button class="button text-xs text-red-600" data-delete-id="${escapeHtml(p.id)}">Delete</button>
               </td>`;
    });

  document.querySelectorAll('[data-edit-id]').forEach(btn => {
    btn.addEventListener('click', () => openEditor('product', JSON.parse(btn.dataset.product)));
  });
  document.querySelectorAll('[data-delete-id]').forEach(btn => {
    btn.addEventListener('click', () => deleteProduct(btn.dataset.deleteId));
  });

  document.querySelector('#promos-table').innerHTML = table(promos, ['Code', 'Redemptions', 'Status'],
    p => `<td class="px-3 py-3">${escapeHtml(p.code)}</td>
           <td class="px-3 py-3">${p.redemption_count}</td>
           <td class="px-3 py-3">${p.is_active ? 'Active' : 'Paused'}</td>`);

  document.querySelector('#posts-table').innerHTML = table(posts, ['Post', 'Status', 'Published'],
    p => `<td class="px-3 py-3">${escapeHtml(p.title)}</td>
           <td class="px-3 py-3">${p.status}</td>
           <td class="px-3 py-3">${p.published_at ? new Date(p.published_at).toLocaleDateString() : '—'}</td>`);

  document.querySelector('#tickets-table').innerHTML = table(tickets, ['Customer', 'Subject', 'Status'],
    t => `<td class="px-3 py-3">${escapeHtml(t.email)}</td>
           <td class="px-3 py-3">${escapeHtml(t.subject)}</td>
           <td class="px-3 py-3">${t.status}</td>`);

  document.querySelector('#admin-status').textContent = 'Live dashboard data loaded.';
  document.querySelector('#admin-status').className = 'status-line success';
}

// ============================================================
// Editor modal
// ============================================================
function openEditor(type, existing = null) {
  mode = type;
  editingId = existing?.id ?? null;
  document.querySelector('#editor-title').textContent =
    type === 'product' ? (existing ? 'Edit product' : 'Add product') : 'Add promotion';

  if (type === 'product') {
    const op = existing?.original_price ?? '';
    document.querySelector('#editor-fields').innerHTML = `
      <input class="field" name="title" placeholder="Title *" value="${escapeHtml(existing?.title ?? '')}" required>
      <input class="field" name="slug"  placeholder="slug (unique URL key) *" value="${escapeHtml(existing?.slug ?? '')}" required>
      <textarea class="field" name="description" placeholder="Description (optional)" rows="3">${escapeHtml(existing?.description ?? '')}</textarea>

      <div>
        <span class="label">Cover image</span>
        <div class="upload-zone mt-2" id="cover-upload-zone">
          <input type="file" id="cover-file-input" accept="image/*" class="hidden">
          ${existing?.cover_url
            ? `<img id="cover-preview" src="${escapeHtml(existing.cover_url)}" class="h-28 mx-auto rounded-lg object-cover mb-2" alt="">`
            : `<img id="cover-preview" class="hidden h-28 mx-auto rounded-lg object-cover mb-2" alt="">`}
          <p id="cover-upload-prompt" class="text-sm text-slate-400 ${existing?.cover_url ? 'hidden' : ''}">📸 Click or drag to upload cover image</p>
          <p class="text-xs text-slate-300 mt-1">Image will open crop &amp; compress editor</p>
        </div>
        <input type="hidden" name="cover_url" id="cover-url-input" value="${escapeHtml(existing?.cover_url ?? '')}">
      </div>

      <div class="grid grid-cols-3 gap-3">
        <label><span class="label">Original price (was)</span>
          <input class="field" id="orig-price-input" name="original_price" type="number" step=".01" min="0"
            placeholder="0.00" value="${op}"></label>
        <label><span class="label">Sale price (now) *</span>
          <input class="field" id="sale-price-input" name="price" type="number" step=".01" min="0"
            placeholder="0.00" value="${existing?.price ?? ''}" required></label>
        <label><span class="label">Discount %</span>
          <input class="field" id="discount-pct-input" type="number" step="0.1" min="0" max="100"
            placeholder="Auto"></label>
      </div>

      <div>
        <span class="label">Product file</span>
        <div class="upload-zone mt-2" id="file-upload-zone">
          <input type="file" id="product-file-input" class="hidden">
          <p id="file-upload-prompt" class="text-sm text-slate-400">
            ${existing?.file_path ? `📁 ${existing.file_path}` : '📁 Click or drag product file (PDF, ZIP, EPUB…)'}
          </p>
          <p class="text-xs text-slate-300 mt-1">Uploads to private storage</p>
        </div>
        <input type="hidden" name="file_path" id="file-path-input" value="${escapeHtml(existing?.file_path ?? '')}">
        <p id="file-upload-status" class="text-xs mt-1 text-slate-400"></p>
      </div>

      <label class="flex items-center gap-2 text-sm">
        <input type="checkbox" name="is_published" ${existing?.is_published ? 'checked' : ''}> Publish immediately
      </label>`;

    // Wire up after HTML is set
    setTimeout(wireUploadZones, 0);

  } else {
    document.querySelector('#editor-fields').innerHTML = `
      <input class="field" name="code" placeholder="PROMO10" required>
      <select class="field" name="discount_type">
        <option value="percent">Percent (%)</option>
        <option value="fixed">Fixed ($)</option>
      </select>
      <input class="field" name="discount_value" type="number" step=".01" min="0.01" placeholder="Discount value" required>`;
  }

  modal.showModal();
}

async function deleteProduct(id) {
  if (!confirm('Delete this product? This cannot be undone.')) return;
  const { error } = await supabase.from('products').delete().eq('id', id);
  if (error) { toast(error.message, 'error'); return; }
  toast('Product deleted.'); load();
}

// ============================================================
// Static wiring
// ============================================================
document.querySelector('#new-product').onclick  = () => openEditor('product');
document.querySelector('#new-promo').onclick    = () => openEditor('promo');
document.querySelector('#close-modal').onclick  = () => modal.close();

// ============================================================
// Form submit
// ============================================================
document.querySelector('#editor-form').onsubmit = async e => {
  e.preventDefault();
  const btn = e.currentTarget.querySelector('[type=submit]');
  const v   = Object.fromEntries(new FormData(e.currentTarget).entries());

  if (mode === 'product') {
    v.price          = Number(v.price);
    v.currency       = 'USD';
    v.is_published   = e.currentTarget.elements.is_published.checked;
    v.original_price = v.original_price ? Number(v.original_price) : null;
    if (!v.description) delete v.description;
    if (!v.cover_url)   delete v.cover_url;
    // file_path is required for new products
    if (!v.file_path && !editingId) {
      toast('Please upload a product file first.', 'error'); return;
    }
    if (!v.file_path) delete v.file_path; // don't overwrite on edit if unchanged
    delete v[''];  // remove any empty-key artifact
  } else {
    v.code           = v.code.toUpperCase();
    v.discount_value = Number(v.discount_value);
  }

  setButtonLoading(btn, true, 'Saving…');
  let error;
  if (mode === 'product' && editingId) {
    ({ error } = await supabase.from('products').update(v).eq('id', editingId));
  } else {
    ({ error } = await supabase.from(mode === 'product' ? 'products' : 'promo_codes').insert(v));
  }
  setButtonLoading(btn, false);
  if (error) { toast(error.message, 'error'); return; }
  modal.close();
  toast(editingId ? 'Product updated.' : 'Saved.');
  load();
};

// ============================================================
// Sign out + CMS
// ============================================================
document.querySelector('#admin-signout').onclick = async () => {
  await supabase.auth.signOut(); location.href = './index.html';
};
document.querySelector('#cms-form').onsubmit = async e => {
  e.preventDefault();
  const v = Object.fromEntries(new FormData(e.currentTarget).entries());
  const { error } = await supabase.from('site_settings').upsert({ id: 1, ...v, updated_by: account.user.id });
  toast(error ? error.message : 'Content saved.', error ? 'error' : 'success');
};

load();

