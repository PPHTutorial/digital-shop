import { supabase } from './client.js';
import { escapeHtml, getAccount, setButtonLoading, toast } from './ui.js';

let account, mode, editingId, dashboardData;
const modal = document.querySelector('#editor-modal');
const detailsModal = document.querySelector('#details-modal');
const imgModal = document.querySelector('#image-editor-modal');
const cropCanvas = document.querySelector('#crop-canvas');

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
  }

  renderPage();
}

function chart(points) {
  const max = Math.max(1, ...points.map((p) => p.revenue));
  return `<div class="flex h-full items-end gap-2">${points.map((p) => `
    <div class="flex flex-1 flex-col items-center gap-2">
      <span class="text-xs font-bold">$${p.revenue.toFixed(0)}</span>
      <div class="w-full rounded-t bg-orange-500" style="height:${Math.max(5, (p.revenue / max) * 150)}px"></div>
      <small class="text-[10px] text-slate-400">${p.date.slice(5)}</small>
    </div>`).join('')}</div>`;
}

// ============================================================
// Dashboard Load
// ============================================================
async function load() {
  account = await getAccount();
  if (!account.user || account.profile?.role !== 'admin') {
    location.replace('./account.html');
    return;
  }
  document.querySelector('#admin-user').textContent = account.user.email;

  const { data, error } = await supabase.functions.invoke('admin-dashboard');
  if (error || data?.error) {
    document.querySelector('#admin-status').textContent = data?.error || error?.message;
    document.querySelector('#admin-status').className = 'status-line error';
    finishPageLoader();
    return;
  }

  dashboardData = data;
  const { metrics, orders, users, tickets, products, promos, posts, revenueByDay } = data;

  document.querySelector('#m-revenue').textContent = `$${metrics.revenue.toFixed(2)}`;
  document.querySelector('#m-orders').textContent = metrics.paidOrders;
  document.querySelector('#m-customers').textContent = metrics.customers;
  document.querySelector('#m-tickets').textContent = metrics.openTickets;
  document.querySelector('#revenue-chart').innerHTML = chart(revenueByDay);
  document.querySelector('#operations-list').innerHTML = `
    <div class="metric !p-4"><span>Published products</span><strong>${metrics.activeProducts}</strong></div>
    <div class="metric !p-4"><span>Support queue</span><strong>${metrics.openTickets}</strong></div>`;

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
        <span class="tag !bg-green-100 !text-green-800 !text-xs">✓ ${paidCount} Paid</span>
        <span class="tag !bg-amber-100 !text-amber-800 !text-xs">⏳ ${pendingCount} Pending</span>
        <span class="tag !bg-red-100 !text-red-700 !text-xs">✕ ${cancelledCount} Cancelled</span>
        <span class="tag !bg-red-100 !text-red-700 !text-xs">! ${failedCount} Failed</span>
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
        ? `<span class="price-original">${p.currency} ${Number(p.original_price).toFixed(2)}</span>
           <strong class="ml-1 text-slate-900">${p.currency} ${Number(p.price).toFixed(2)}</strong>`
        : `<strong>${p.currency} ${Number(p.price).toFixed(2)}</strong>`;
      const canonicalSlug = p.slug || p.id;
      return `
        <td class="px-3 py-3">
          <div class="flex items-center gap-3">
            ${p.cover_url ? `<img src="${escapeHtml(p.cover_url)}" class="h-10 w-10 object-cover rounded bg-slate-100">` : ''}
            <div>
              <strong class="block text-[#142c55]">${escapeHtml(p.title)}</strong>
              <span class="text-xs text-slate-400 line-clamp-1">${escapeHtml(p.description || '')}</span>
            </div>
          </div>
        </td>
        <td class="px-3 py-3">
          <span class="tag text-xs font-semibold">${escapeHtml(p.category || 'General')}</span>
        </td>
        <td class="px-3 py-3">${priceCell}</td>
        <td class="px-3 py-3 text-xs font-mono text-slate-500">${escapeHtml(p.slug || '—')}</td>
        <td class="px-3 py-3">
          <span class="tag ${p.is_published ? '!bg-green-100 !text-green-800' : '!bg-slate-100 !text-slate-600'}">${p.is_published ? 'Published' : 'Draft'}</span>
        </td>
        <td class="px-3 py-3">
          <div class="flex items-center gap-1.5">
            <button class="button !min-h-8 !py-1 text-xs" data-copy-ad-link="${escapeHtml(canonicalSlug)}" title="Copy advertising link">🔗 Ad Link</button>
            <button class="button !min-h-8 !py-1 text-xs" data-edit-product="${escapeHtml(p.id)}">Edit</button>
            <button class="button !min-h-8 !py-1 text-xs text-red-600 hover:bg-red-50" data-delete-product="${escapeHtml(p.id)}">Delete</button>
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

  // 4. Promo Codes Table (Paginated)
  renderPaginatedTable(
    '#promos-table',
    promos,
    ['Promo Code', 'Discount', 'Redemptions', 'Status', 'Actions'],
    (p) => `
      <td class="px-3 py-3 font-bold text-[#142c55] font-mono">${escapeHtml(p.code)}</td>
      <td class="px-3 py-3">${p.discount_type === 'percent' ? `${p.discount_value}%` : `$${p.discount_value}`}</td>
      <td class="px-3 py-3">${p.redemption_count} ${p.max_redemptions ? `/ ${p.max_redemptions}` : ''}</td>
      <td class="px-3 py-3">
        <span class="tag ${p.is_active ? '!bg-green-100 !text-green-800' : '!bg-slate-100 !text-slate-600'}">${p.is_active ? 'Active' : 'Paused'}</span>
      </td>
      <td class="px-3 py-3">
        <button class="button !min-h-8 !py-1 text-xs" data-toggle-promo="${escapeHtml(p.id)}" data-active="${p.is_active}">
          ${p.is_active ? 'Pause' : 'Activate'}
        </button>
      </td>`,
    8,
    (container) => {
      container.querySelectorAll('[data-toggle-promo]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.togglePromo;
          const current = btn.dataset.active === 'true';
          await supabase.from('promo_codes').update({ is_active: !current }).eq('id', id);
          toast('Promotion updated.');
          load();
        });
      });
    }
  );

  // 5. Blog Posts Table (Paginated)
  renderPaginatedTable(
    '#posts-table',
    posts,
    ['Title', 'Slug', 'Status', 'Published'],
    (p) => `
      <td class="px-3 py-3 font-medium text-[#142c55]">${escapeHtml(p.title)}</td>
      <td class="px-3 py-3 text-xs font-mono text-slate-500">${escapeHtml(p.slug)}</td>
      <td class="px-3 py-3"><span class="tag">${escapeHtml(p.status)}</span></td>
      <td class="px-3 py-3 text-xs text-slate-500">${p.published_at ? new Date(p.published_at).toLocaleDateString() : '—'}</td>`,
    8
  );

  // 6. Tickets Table (Paginated)
  renderPaginatedTable(
    '#tickets-table',
    tickets,
    ['Customer', 'Category', 'Subject', 'Status', 'Actions'],
    (t) => `
      <td class="px-3 py-3">${escapeHtml(t.email)}</td>
      <td class="px-3 py-3"><span class="tag">${escapeHtml(t.category || 'General')}</span></td>
      <td class="px-3 py-3">${escapeHtml(t.subject)}</td>
      <td class="px-3 py-3">
        <span class="tag ${t.status === 'closed' ? '!bg-slate-100 !text-slate-600' : '!bg-orange-100 !text-orange-800'}">${escapeHtml(t.status)}</span>
      </td>
      <td class="px-3 py-3">
        <button class="button !min-h-8 !py-1 text-xs" data-toggle-ticket="${escapeHtml(t.id)}" data-status="${t.status}">
          ${t.status === 'closed' ? 'Reopen' : 'Close'}
        </button>
      </td>`,
    8,
    (container) => {
      container.querySelectorAll('[data-toggle-ticket]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.toggleTicket;
          const nextStatus = btn.dataset.status === 'closed' ? 'open' : 'closed';
          await supabase.from('tickets').update({ status: nextStatus }).eq('id', id);
          toast(`Ticket marked as ${nextStatus}.`);
          load();
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
      <label class="label">Full Name</label>
      <input class="field" name="full_name" value="${escapeHtml(user.full_name || '')}" placeholder="Customer full name">
    </div>

    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="label">System Role</label>
        <select class="field" name="role">
          <option value="customer" ${user.role === 'customer' ? 'selected' : ''}>Customer (Standard)</option>
          <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Administrator (Full Access)</option>
        </select>
      </div>
      <div>
        <label class="label">Phone Number</label>
        <input class="field" name="phone" value="${escapeHtml(user.phone || '')}" placeholder="+123456789">
      </div>
    </div>

    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="label">Country</label>
        <input class="field" name="country" value="${escapeHtml(user.country || '')}" placeholder="e.g. United States, Nigeria">
      </div>
      <div>
        <label class="label">Occupation</label>
        <input class="field" name="occupation" value="${escapeHtml(user.occupation || '')}" placeholder="Occupation">
      </div>
    </div>

    <div>
      <label class="label">Address</label>
      <textarea class="field" name="address" rows="2" placeholder="Customer address">${escapeHtml(user.address || '')}</textarea>
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

  document.querySelector('#editor-eyebrow').textContent = type === 'product' ? 'PRODUCT CATALOG' : 'PROMOTIONS';
  document.querySelector('#editor-title').textContent =
    type === 'product' ? (existing?.id ? 'Edit product details' : 'Add new product') : 'Add promotion code';

  let full = existing || {};

  // Fetch 100% full fresh row from database so no fields are missing or truncated!
  if (editingId) {
    const tableTarget = type === 'product' ? 'products' : 'promo_codes';
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
      // CREATE PRODUCT MODAL LAYOUT (Streamlined & Clean)
      // ============================================================
      document.querySelector('#editor-fields').innerHTML = `
        <div class="space-y-4">
          <div>
            <label class="label text-xs font-bold text-slate-700" for="product-title-input">Product Title *</label>
            <input class="field !mt-1" id="product-title-input" name="title" placeholder="e.g. Next.js SaaS Architecture Blueprint" value="" required>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="label text-xs font-bold text-slate-700" for="product-category-input">Category *</label>
              <select class="field !mt-1" id="product-category-input" name="category">
                <option value="Ebooks & Guides">Ebooks &amp; Guides</option>
                <option value="Software & Tools">Software &amp; Tools</option>
                <option value="Templates & Themes">Templates &amp; Themes</option>
                <option value="Online Courses">Online Courses</option>
                <option value="Audio & Media">Audio &amp; Media</option>
                <option value="Design & Graphics">Design &amp; Graphics</option>
                <option value="General">General</option>
              </select>
            </div>
            <div>
              <div class="flex items-center justify-between">
                <label class="label text-xs font-bold text-slate-700" for="product-slug-input">SEO URL Slug *</label>
                <button type="button" id="auto-slug-btn" class="text-xs text-orange-600 font-bold hover:underline flex items-center gap-1">
                  <i data-lucide="zap" width="12" height="12"></i>
                  <span>Auto</span>
                </button>
              </div>
              <input class="field font-mono text-xs !mt-1" id="product-slug-input" name="slug" placeholder="e.g. nextjs-saas-blueprint" value="" required>
            </div>
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

          <label class="flex items-center gap-2 text-sm font-semibold cursor-pointer pt-2">
            <input type="checkbox" name="is_published" checked class="rounded text-orange-600">
            <span>Publish immediately in store catalog</span>
          </label>
        </div>`;
    } else {
      // ============================================================
      // UPDATE PRODUCT MODAL LAYOUT (Advanced, Modular & Collapsible)
      // ============================================================
      const galleryVal = Array.isArray(full.gallery_urls) ? full.gallery_urls.join(', ') : (full.gallery_urls || '');

      document.querySelector('#editor-fields').innerHTML = `
        <div class="space-y-4">
          <!-- Top Shareable Ad Link Card -->
          <div class="form-section-card space-y-1.5">
            <div class="flex items-center justify-between text-xs font-bold text-slate-700">
              <span class="flex items-center gap-1.5">
                <i data-lucide="link" width="13" height="13" class="text-orange-500"></i>
                <span>Direct Advertising &amp; Checkout Link</span>
              </span>
              <button type="button" id="copy-modal-ad-link" class="text-orange-600 font-bold hover:underline flex items-center gap-1">
                <i data-lucide="copy" width="12" height="12"></i>
                <span>Copy Link</span>
              </button>
            </div>
            <div id="modal-ad-link-preview" class="font-mono text-[11px] text-slate-600 truncate bg-white p-2 rounded-lg border border-slate-200 shadow-inner">
              ${liveAdUrl}
            </div>
          </div>

          <!-- Section 1: Essentials & Category -->
          <div class="form-section-card space-y-3">
            <h3 class="text-xs font-black text-[#142c55] uppercase tracking-wider">Product Information</h3>
            <div>
              <label class="label text-xs" for="product-title-input">Product Title *</label>
              <input class="field !mt-1" id="product-title-input" name="title" value="${escapeHtml(full.title ?? '')}" required>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="label text-xs" for="product-category-input">Category *</label>
                <select class="field !mt-1" id="product-category-input" name="category">
                  <option value="Ebooks & Guides" ${currentCat === 'Ebooks & Guides' ? 'selected' : ''}>Ebooks &amp; Guides</option>
                  <option value="Software & Tools" ${currentCat === 'Software & Tools' ? 'selected' : ''}>Software &amp; Tools</option>
                  <option value="Templates & Themes" ${currentCat === 'Templates & Themes' ? 'selected' : ''}>Templates &amp; Themes</option>
                  <option value="Online Courses" ${currentCat === 'Online Courses' ? 'selected' : ''}>Online Courses</option>
                  <option value="Audio & Media" ${currentCat === 'Audio & Media' ? 'selected' : ''}>Audio &amp; Media</option>
                  <option value="Design & Graphics" ${currentCat === 'Design & Graphics' ? 'selected' : ''}>Design &amp; Graphics</option>
                  <option value="General" ${currentCat === 'General' ? 'selected' : ''}>General</option>
                </select>
              </div>
              <div>
                <div class="flex items-center justify-between">
                  <label class="label text-xs" for="product-slug-input">SEO Slug *</label>
                  <button type="button" id="auto-slug-btn" class="text-xs text-orange-600 font-bold hover:underline flex items-center gap-1">
                    <i data-lucide="zap" width="12" height="12"></i>
                    <span>Auto</span>
                  </button>
                </div>
                <input class="field font-mono text-xs !mt-1" id="product-slug-input" name="slug" value="${escapeHtml(initialSlug)}" required>
              </div>
            </div>
          </div>

          <!-- Section 2: Dual Pricing Dynamics -->
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

          <!-- Section 3: Media & Visual Assets -->
          <div class="form-section-card space-y-3">
            <div class="flex items-center justify-between">
              <h3 class="text-xs font-black text-[#142c55] uppercase tracking-wider">Cover Image &amp; Gallery</h3>
              ${full.cover_url ? `<span class="tag !text-[10px] !bg-green-100 !text-green-800">Cover Active</span>` : ''}
            </div>

            <div class="flex flex-wrap sm:flex-nowrap items-center gap-4">
              ${
                full.cover_url
                  ? `<div class="relative group shrink-0 w-24 h-24 rounded-xl overflow-hidden border border-slate-200 shadow-sm bg-slate-100">
                      <img id="cover-preview" src="${escapeHtml(full.cover_url)}" class="w-full h-full object-cover" alt="Cover">
                     </div>`
                  : `<img id="cover-preview" class="hidden w-24 h-24 rounded-xl object-cover border border-slate-200" alt="">`
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
              <label class="label text-xs">Additional Gallery Images (Comma-separated URLs)</label>
              <input class="field text-xs !mt-1" name="gallery_urls" value="${escapeHtml(galleryVal)}" placeholder="https://…/image2.jpg, https://…/image3.jpg">
            </div>
          </div>

          <!-- Section 4: Secure Downloadable File Asset -->
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
              <div class="upload-zone !p-1.5 !px-3 shrink-0 cursor-pointer text-xs font-bold text-orange-600 hover:bg-orange-50 border-orange-200" id="file-upload-zone">
                <input type="file" id="product-file-input" class="hidden">
                <span id="file-upload-prompt" class="flex items-center gap-1 text-xs">
                  <i data-lucide="upload" width="12" height="12"></i>
                  <span>${full.file_path ? 'Replace File' : 'Upload File'}</span>
                </span>
              </div>
            </div>
            <input type="hidden" name="file_path" id="file-path-input" value="${escapeHtml(full.file_path ?? '')}">
            <p id="file-upload-status" class="text-xs text-slate-500 font-medium"></p>
          </div>

          <!-- Section 5: Description with Compact View -->
          <div class="form-section-card space-y-2">
            <div class="flex items-center justify-between">
              <label class="text-xs font-black text-[#142c55] uppercase tracking-wider">Product Description</label>
              <button type="button" id="toggle-desc-size-btn" class="text-xs text-orange-600 font-bold hover:underline">Expand Editor</button>
            </div>
            <textarea class="field !mt-1" id="product-desc-textarea" name="description" placeholder="Comprehensive product description, chapters, instructions…" rows="3">${escapeHtml(full.description ?? '')}</textarea>
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
    document.querySelector('#auto-slug-btn')?.addEventListener('click', () => setTimeout(updateAdLink, 10));

    copyAdBtn?.addEventListener('click', () => {
      const s = slugInput?.value.trim() || 'product-slug';
      const u = `${window.location.origin}/checkout.html?product=${encodeURIComponent(s)}`;
      navigator.clipboard.writeText(u);
      toast('Advertising link copied to clipboard!');
    });

    renderIcons();
    setTimeout(wireUploadZones, 0);
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
        <input class="field" name="max_redemptions" type="number" min="1" placeholder="Unlimited if empty" value="${full.max_redemptions ?? ''}">
      </div>`;
  }

  modal.showModal();
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
  } else if (mode === 'promo') {
    v.code = v.code.toUpperCase().trim();
    v.discount_value = Number(v.discount_value);
    v.max_redemptions = v.max_redemptions ? parseInt(v.max_redemptions) : null;
  }

  setButtonLoading(submitBtn, true, 'Saving…');
  let error;
  if (mode === 'product' && editingId) {
    ({ error } = await supabase.from('products').update(v).eq('id', editingId));
  } else if (mode === 'product') {
    ({ error } = await supabase.from('products').insert(v));
  } else {
    ({ error } = await supabase.from('promo_codes').insert(v));
  }
  setButtonLoading(submitBtn, false);

  if (error) {
    toast(error.message, 'error');
    return;
  }

  modal.close();
  toast(editingId ? 'Product updated successfully.' : 'Product created successfully.');

  // Automatically refresh sitemap on product changes
  supabase.functions.invoke('sitemap').catch(() => {});

  load();
};

// Wiring dialog close & modal buttons
document.querySelector('#new-product').onclick = () => openEditor('product');
document.querySelector('#new-promo').onclick = () => openEditor('promo');
document.querySelector('#close-modal').onclick = () => modal.close();
document.querySelector('#cancel-modal-btn').onclick = () => modal.close();
document.querySelector('#close-details-modal').onclick = () => detailsModal.close();
document.querySelector('#close-details-btn').onclick = () => detailsModal.close();

// Sign out + CMS settings
document.querySelector('#admin-signout').onclick = async () => {
  await supabase.auth.signOut();
  location.href = './index.html';
};

document.querySelector('#cms-form').onsubmit = async (e) => {
  e.preventDefault();
  const v = Object.fromEntries(new FormData(e.currentTarget).entries());
  const { error } = await supabase.from('site_settings').upsert({ id: 1, ...v, updated_by: account.user.id });
  toast(error ? error.message : 'Content saved.', error ? 'error' : 'success');
};

load();
