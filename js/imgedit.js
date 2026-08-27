/**
 * Pre-upload image editor: pan/zoom a photo behind a fixed crop frame, pick an
 * aspect ratio (Free / 1:1 / 16:9 / 9:16), cap the long edge, then export WebP
 * and auto-compress until it is at or below the size limit.
 *
 *   openImageEditor(file, { maxBytes, onApply })
 *     onApply(newFile, { beforeBytes, afterBytes, width, height })
 *
 * Rendered in a top-layer <dialog> (so it sits above the product modal) that
 * fills the viewport. No dependencies beyond the shared custom <select>.
 */

import { escapeHtml, icon, renderIcons, toast } from './ui.js';
import { enhanceSelect } from './select.js';

const RATIOS = [
  { key: 'free', label: 'Free', value: null },
  { key: '1x1', label: '1:1', value: 1 },
  { key: '16x9', label: '16:9', value: 16 / 9 },
  { key: '9x16', label: '9:16', value: 9 / 16 },
];

const EDGE_CAPS = [
  { label: 'Keep original size', value: 0 },
  { label: 'Max 2048px', value: 2048 },
  { label: 'Max 1600px', value: 1600 },
  { label: 'Max 1024px', value: 1024 },
  { label: 'Max 512px', value: 512 },
];

const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function openImageEditor(file, { maxBytes = 5 * 1024 * 1024, onApply } = {}) {
  if (!file || !file.type?.startsWith('image/')) { onApply?.(file); return; }

  const dlg = document.createElement('dialog');
  dlg.className = 'imgedit';
  dlg.innerHTML = `
    <div class="imgedit__head">
      <strong>Edit image</strong>
      <button type="button" data-close aria-label="Close">${icon('x', 18)}</button>
    </div>

    <div class="imgedit__stage" data-stage>
      <img class="imgedit__img" alt="" draggable="false">
      <div class="imgedit__frame" data-frame><span></span><span></span><span></span><span></span></div>
    </div>

    <div class="imgedit__controls">
      <div class="imgedit__row">
        <span class="label">Aspect</span>
        <div class="seg" data-ratios>
          ${RATIOS.map((r, i) => `<button type="button" class="seg__btn ${i === 0 ? 'is-active' : ''}" data-ratio="${r.key}">${r.label}</button>`).join('')}
        </div>
      </div>
      <div class="imgedit__row">
        <span class="label">Zoom</span>
        <input type="range" data-zoom min="1" max="6" step="0.001" value="1" class="imgedit__range">
      </div>
      <div class="imgedit__row">
        <span class="label">Output</span>
        <select class="field" data-edge>
          ${EDGE_CAPS.map((e) => `<option value="${e.value}" ${e.value === 1600 ? 'selected' : ''}>${e.label}</option>`).join('')}
        </select>
      </div>
      <p class="imgedit__note" data-note>Original: ${fmtBytes(file.size)} · exports as WebP, auto-compressed to ≤ ${fmtBytes(maxBytes)}</p>
    </div>

    <div class="imgedit__foot">
      <button type="button" class="button" data-skip>Use original</button>
      <button type="button" class="button button-primary" data-apply>Apply</button>
    </div>`;
  document.body.append(dlg);
  renderIcons();
  enhanceSelect(dlg.querySelector('[data-edge]'), { label: 'Output size' });
  dlg.showModal();

  const stage = dlg.querySelector('[data-stage]');
  const img = dlg.querySelector('.imgedit__img');
  const frame = dlg.querySelector('[data-frame]');
  const zoomInput = dlg.querySelector('[data-zoom]');
  const noteEl = dlg.querySelector('[data-note]');
  const edgeSelect = dlg.querySelector('[data-edge]');

  let done = false;
  const finish = (result) => {
    if (done) return;
    done = true;
    ro.disconnect();
    try { if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src); } catch { /* noop */ }
    dlg.close();
    dlg.remove();
    onApply?.(result || file);
  };
  dlg.querySelector('[data-close]').addEventListener('click', () => finish(null));
  dlg.querySelector('[data-skip]').addEventListener('click', () => finish(file));
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });

  // --- geometry -----------------------------------------------------------
  // s   = natural-pixel -> screen-pixel factor (the on-screen image is
  //       natW*s by natH*s). tx/ty pan the image relative to the stage centre.
  const g = { ratio: null, natW: 0, natH: 0, fw: 0, fh: 0, minS: 1, s: 1, tx: 0, ty: 0 };

  const paint = () => {
    img.style.width = `${g.natW * g.s}px`;
    img.style.height = 'auto';
    img.style.transform = `translate(-50%, -50%) translate(${g.tx}px, ${g.ty}px)`;
    frame.style.width = `${g.fw}px`;
    frame.style.height = `${g.fh}px`;
    zoomInput.value = String(g.s / g.minS);
  };

  const clampPan = () => {
    const maxX = Math.max(0, (g.natW * g.s - g.fw) / 2);
    const maxY = Math.max(0, (g.natH * g.s - g.fh) / 2);
    g.tx = Math.max(-maxX, Math.min(maxX, g.tx));
    g.ty = Math.max(-maxY, Math.min(maxY, g.ty));
  };

  const layout = ({ keepZoom = false } = {}) => {
    const rect = stage.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4 || !g.natW) { requestAnimationFrame(() => layout({ keepZoom })); return; }
    const pad = 0.88;
    const ratio = g.ratio || (g.natW / g.natH);
    let fw = rect.width * pad;
    let fh = fw / ratio;
    if (fh > rect.height * pad) { fh = rect.height * pad; fw = fh * ratio; }
    g.fw = Math.round(fw);
    g.fh = Math.round(fh);
    g.minS = Math.max(g.fw / g.natW, g.fh / g.natH);
    const zoomRatio = keepZoom && g.s ? g.s / g.minS : 1;
    g.s = g.minS * Math.max(1, zoomRatio);
    zoomInput.min = '1';
    zoomInput.max = '6';
    clampPan();
    paint();
  };

  const zoomTo = (nextRel, pivotX, pivotY) => {
    const rel = Math.max(1, Math.min(6, nextRel));
    const nextS = g.minS * rel;
    // keep the pivot point (stage-centre-relative px) stationary
    const px = pivotX ?? 0;
    const py = pivotY ?? 0;
    g.tx = (g.tx - px) * (nextS / g.s) + px;
    g.ty = (g.ty - py) * (nextS / g.s) + py;
    g.s = nextS;
    clampPan();
    paint();
  };

  img.addEventListener('load', () => {
    g.natW = img.naturalWidth;
    g.natH = img.naturalHeight;
    layout();
  });
  img.src = URL.createObjectURL(file);

  const ro = new ResizeObserver(() => layout({ keepZoom: true }));
  ro.observe(stage);

  // --- interaction ------------------------------------------------------
  dlg.querySelector('[data-ratios]').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ratio]');
    if (!btn) return;
    dlg.querySelectorAll('[data-ratio]').forEach((b) => b.classList.toggle('is-active', b === btn));
    g.ratio = RATIOS.find((r) => r.key === btn.dataset.ratio)?.value || null;
    g.tx = 0; g.ty = 0;
    layout();
  });

  zoomInput.addEventListener('input', () => zoomTo(Number(zoomInput.value)));

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const px = e.clientX - rect.left - rect.width / 2;
    const py = e.clientY - rect.top - rect.height / 2;
    zoomTo((g.s / g.minS) * (e.deltaY < 0 ? 1.12 : 1 / 1.12), px, py);
  }, { passive: false });

  let dragging = false;
  let lx = 0;
  let ly = 0;
  const pts = new Map();
  let pinch = 0;
  img.addEventListener('pointerdown', (e) => {
    img.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, e);
    if (pts.size === 1) { dragging = true; lx = e.clientX; ly = e.clientY; }
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }
  });
  img.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, e);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (pinch) zoomTo((g.s / g.minS) * (d / pinch));
      pinch = d;
      return;
    }
    if (dragging) {
      g.tx += e.clientX - lx;
      g.ty += e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;
      clampPan();
      paint();
    }
  });
  const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = 0; if (!pts.size) dragging = false; };
  img.addEventListener('pointerup', up);
  img.addEventListener('pointercancel', up);

  const hint = () => {
    const cap = Number(edgeSelect.value) || 0;
    noteEl.textContent = `Original ${fmtBytes(file.size)} → WebP${cap ? `, long edge ≤ ${cap}px` : ''}, auto-compressed to ≤ ${fmtBytes(maxBytes)}`;
  };
  edgeSelect.addEventListener('change', hint);

  // --- export ---------------------------------------------------------
  dlg.querySelector('[data-apply]').addEventListener('click', async () => {
    const btn = dlg.querySelector('[data-apply]');
    btn.disabled = true;
    btn.textContent = 'Processing…';
    try {
      // crop rect in natural pixels
      let sw = g.fw / g.s;
      let sh = g.fh / g.s;
      let sx = g.natW / 2 - g.tx / g.s - sw / 2;
      let sy = g.natH / 2 - g.ty / g.s - sh / 2;
      sx = Math.max(0, Math.min(sx, g.natW - 1));
      sy = Math.max(0, Math.min(sy, g.natH - 1));
      sw = Math.min(sw, g.natW - sx);
      sh = Math.min(sh, g.natH - sy);

      const cap = Number(edgeSelect.value) || 0;
      let outW = Math.round(sw);
      let outH = Math.round(sh);
      if (cap && Math.max(outW, outH) > cap) {
        const k = cap / Math.max(outW, outH);
        outW = Math.max(1, Math.round(outW * k));
        outH = Math.max(1, Math.round(outH * k));
      }

      const bmp = await createImageBitmap(img, sx, sy, sw, sh);
      let quality = 0.92;
      let blob = await encode(bmp, outW, outH, quality);
      let guard = 0;
      while (blob.size > maxBytes && guard < 14) {
        guard += 1;
        if (quality > 0.5) quality -= 0.08;
        else { outW = Math.max(1, Math.round(outW * 0.85)); outH = Math.max(1, Math.round(outH * 0.85)); }
        blob = await encode(bmp, outW, outH, quality);
      }
      bmp.close?.();

      if (blob.size > maxBytes) {
        toast('Could not get this image under the size limit — try a tighter crop or a smaller output.', 'error');
        btn.disabled = false;
        btn.textContent = 'Apply';
        return;
      }
      const base = (file.name || 'image').replace(/\.[a-z0-9]+$/i, '');
      finish(new File([blob], `${base}.webp`, { type: 'image/webp' }));
    } catch (err) {
      console.error('Image edit failed:', err);
      toast('Image processing failed — using the original.', 'error');
      finish(file);
    }
  });

  function encode(bitmap, w, h, q) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, w);
    canvas.height = Math.max(1, h);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b || new Blob()), 'image/webp', q));
  }
}
