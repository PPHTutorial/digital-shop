/**
 * Pre-upload image editor: pan/zoom a photo behind a fixed crop frame, pick an
 * aspect ratio (Free / 1:1 / 16:9 / 9:16), cap the long edge, then export WebP
 * and auto-compress until it is at or below the size limit.
 *
 *   openImageEditor(file, { maxBytes, onApply })
 *     onApply(newFile, { beforeBytes, afterBytes, width, height })
 *
 * No dependencies — canvas + pointer events.
 */

import { escapeHtml, icon, renderIcons, toast } from './ui.js';

const RATIOS = [
  { key: 'free', label: 'Free', value: null },
  { key: '1x1', label: '1:1', value: 1 },
  { key: '16x9', label: '16:9', value: 16 / 9 },
  { key: '9x16', label: '9:16', value: 9 / 16 },
];

const EDGE_CAPS = [
  { label: 'Original', value: 0 },
  { label: '2048px', value: 2048 },
  { label: '1600px', value: 1600 },
  { label: '1024px', value: 1024 },
  { label: '512px', value: 512 },
];

const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function openImageEditor(file, { maxBytes = 5 * 1024 * 1024, onApply } = {}) {
  if (!file || !file.type?.startsWith('image/')) { onApply?.(file); return; }

  const overlay = document.createElement('div');
  overlay.className = 'imgedit';
  overlay.innerHTML = `
    <div class="imgedit__panel">
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
          <input type="range" data-zoom min="1" max="6" step="0.01" value="1" class="imgedit__range">
        </div>
        <div class="imgedit__row">
          <span class="label">Max size</span>
          <select class="field" data-edge>
            ${EDGE_CAPS.map((e) => `<option value="${e.value}" ${e.value === 1600 ? 'selected' : ''}>${e.label}</option>`).join('')}
          </select>
        </div>
        <p class="imgedit__note" data-note>Original: ${fmtBytes(file.size)} · exports as WebP, auto-compressed to ≤ ${fmtBytes(maxBytes)}</p>
      </div>

      <div class="imgedit__foot">
        <button type="button" class="button" data-skip>Use as-is</button>
        <button type="button" class="button button-primary" data-apply>Apply</button>
      </div>
    </div>`;
  document.body.append(overlay);
  renderIcons();

  const stage = overlay.querySelector('[data-stage]');
  const img = overlay.querySelector('.imgedit__img');
  const frame = overlay.querySelector('[data-frame]');
  const zoomInput = overlay.querySelector('[data-zoom]');
  const noteEl = overlay.querySelector('[data-note]');

  const close = () => {
    try { if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src); } catch { /* noop */ }
    window.removeEventListener('resize', layoutFrame);
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.querySelector('[data-close]').addEventListener('click', close);
  overlay.querySelector('[data-skip]').addEventListener('click', () => { close(); onApply?.(file); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // scale:0 → first layoutFrame() snaps it to the cover (minimum) scale.
  const state = { ratio: null, minScale: 1, scale: 0, tx: 0, ty: 0, fw: 0, fh: 0, natW: 0, natH: 0 };

  const layoutFrame = () => {
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const pad = 0.86;
    let ratio = state.ratio || (state.natW / state.natH);
    let fw = sw * pad;
    let fh = fw / ratio;
    if (fh > sh * pad) { fh = sh * pad; fw = fh * ratio; }
    state.fw = Math.round(fw);
    state.fh = Math.round(fh);
    frame.style.width = `${state.fw}px`;
    frame.style.height = `${state.fh}px`;
    // cover scale
    state.minScale = Math.max(state.fw / state.natW, state.fh / state.natH);
    state.scale = Math.max(state.scale, state.minScale);
    zoomInput.min = state.minScale.toFixed(3);
    zoomInput.max = (state.minScale * 6).toFixed(3);
    clampAndApply(true);
  };

  const frameBox = () => {
    const sRect = stage.getBoundingClientRect();
    return {
      left: (sRect.width - state.fw) / 2,
      top: (sRect.height - state.fh) / 2,
    };
  };

  const clampAndApply = (center = false) => {
    const { left, top } = frameBox();
    const dispW = state.natW * state.scale;
    const dispH = state.natH * state.scale;
    if (center) {
      state.tx = left + (state.fw - dispW) / 2;
      state.ty = top + (state.fh - dispH) / 2;
    }
    state.tx = Math.min(left, Math.max(left + state.fw - dispW, state.tx));
    state.ty = Math.min(top, Math.max(top + state.fh - dispH, state.ty));
    img.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
    zoomInput.value = state.scale;
  };

  img.addEventListener('load', () => {
    state.natW = img.naturalWidth;
    state.natH = img.naturalHeight;
    layoutFrame();
  });
  img.src = URL.createObjectURL(file);

  // Aspect
  overlay.querySelector('[data-ratios]').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ratio]');
    if (!btn) return;
    overlay.querySelectorAll('[data-ratio]').forEach((b) => b.classList.toggle('is-active', b === btn));
    state.ratio = RATIOS.find((r) => r.key === btn.dataset.ratio)?.value || null;
    state.scale = 0; // force recover
    layoutFrame();
  });

  // Zoom slider
  zoomInput.addEventListener('input', () => {
    const { left, top } = frameBox();
    const cx = left + state.fw / 2;
    const cy = top + state.fh / 2;
    const next = Number(zoomInput.value);
    const ox = cx - state.tx;
    const oy = cy - state.ty;
    state.tx -= ox * (next / state.scale - 1);
    state.ty -= oy * (next / state.scale - 1);
    state.scale = next;
    clampAndApply();
  });

  // Drag pan
  let dragging = false;
  let lx = 0;
  let ly = 0;
  img.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; img.setPointerCapture(e.pointerId); });
  img.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    state.tx += e.clientX - lx;
    state.ty += e.clientY - ly;
    lx = e.clientX;
    ly = e.clientY;
    clampAndApply();
  });
  const endDrag = () => { dragging = false; };
  img.addEventListener('pointerup', endDrag);
  img.addEventListener('pointercancel', endDrag);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomInput.value = Math.max(Number(zoomInput.min), Math.min(Number(zoomInput.max), state.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    zoomInput.dispatchEvent(new Event('input'));
  }, { passive: false });

  window.addEventListener('resize', layoutFrame);

  // Apply
  overlay.querySelector('[data-apply]').addEventListener('click', async () => {
    const applyBtn = overlay.querySelector('[data-apply]');
    applyBtn.disabled = true;
    applyBtn.textContent = 'Processing…';
    try {
      const { left, top } = frameBox();
      // crop rect in natural pixels
      let sx = (left - state.tx) / state.scale;
      let sy = (top - state.ty) / state.scale;
      let sw = state.fw / state.scale;
      let sh = state.fh / state.scale;
      sx = Math.max(0, sx); sy = Math.max(0, sy);
      sw = Math.min(sw, state.natW - sx);
      sh = Math.min(sh, state.natH - sy);

      const edgeCap = Number(overlay.querySelector('[data-edge]').value) || 0;
      let outW = Math.round(sw);
      let outH = Math.round(sh);
      if (edgeCap && Math.max(outW, outH) > edgeCap) {
        const k = edgeCap / Math.max(outW, outH);
        outW = Math.round(outW * k);
        outH = Math.round(outH * k);
      }

      const bmp = await createImageBitmap(img, sx, sy, sw, sh);
      let quality = 0.92;
      let blob = await encode(bmp, outW, outH, quality);
      let guard = 0;
      while (blob.size > maxBytes && guard < 12) {
        guard += 1;
        if (quality > 0.5) quality -= 0.08;
        else { outW = Math.round(outW * 0.85); outH = Math.round(outH * 0.85); }
        blob = await encode(bmp, outW, outH, quality);
      }
      bmp.close?.();

      if (blob.size > maxBytes) {
        toast('Could not get this image under the size limit — try a smaller crop or max size.', 'error');
        applyBtn.disabled = false;
        applyBtn.textContent = 'Apply';
        return;
      }

      const base = (file.name || 'image').replace(/\.[a-z0-9]+$/i, '');
      const out = new File([blob], `${base}.webp`, { type: 'image/webp' });
      close();
      onApply?.(out, { beforeBytes: file.size, afterBytes: blob.size, width: outW, height: outH });
    } catch (err) {
      console.error('Image edit failed:', err);
      toast('Image processing failed — using the original.', 'error');
      close();
      onApply?.(file);
    }
  });

  function encode(bitmap, w, h, q) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    return new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b || new Blob()), 'image/webp', q);
    });
  }

  // live size hint as controls change
  const hint = () => {
    const edgeCap = Number(overlay.querySelector('[data-edge]').value) || 0;
    noteEl.textContent = `Original ${fmtBytes(file.size)} → WebP${edgeCap ? `, long edge ≤ ${edgeCap}px` : ''}, auto-compressed to ≤ ${fmtBytes(maxBytes)}`;
  };
  overlay.querySelector('[data-edge]').addEventListener('change', hint);
}
