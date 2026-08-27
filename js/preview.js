/**
 * Universal file preview overlay + format glyphs.
 *
 *   openFileViewer({ src, name, mime })  — full-screen viewer
 *   fileGlyph(extOrName, size)            — inline SVG for a file type
 *   fileCategory(extOrName)               — 'archive' | 'pdf' | 'image' | …
 *
 * Images get wheel-zoom + drag-pan + pinch; video/audio get native players;
 * text is fetched and shown; PDF renders in an <iframe>; anything else shows a
 * branded format glyph with an Open link. No dependencies.
 */

import { escapeHtml, icon, renderIcons } from './ui.js';

/* -------------------------------------------------------------------------- */
/* Format classification + glyphs                                            */
/* -------------------------------------------------------------------------- */

const CATEGORY_BY_EXT = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif'],
  video: ['mp4', 'webm', 'mov', 'm4v', 'ogv'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac'],
  pdf: ['pdf'],
  text: ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yml', 'yaml', 'xml', 'html', 'htm', 'css', 'js', 'ts'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz'],
  android: ['apk', 'aab'],
  executable: ['exe', 'msi', 'dmg', 'appimage', 'deb', 'rpm', 'bin'],
  doc: ['doc', 'docx', 'odt', 'rtf', 'pages'],
  sheet: ['xls', 'xlsx', 'ods', 'numbers'],
  slides: ['ppt', 'pptx', 'odp', 'key'],
  ebook: ['epub', 'mobi', 'azw3', 'azw'],
  design: ['psd', 'ai', 'sketch', 'fig', 'xd', 'afdesign', 'afphoto'],
  font: ['ttf', 'otf', 'woff', 'woff2', 'eot'],
};

const CATEGORY_COLOR = {
  archive: '#f59e0b',
  android: '#3ddc84',
  executable: '#64748b',
  pdf: '#e5484d',
  doc: '#2563eb',
  sheet: '#16a34a',
  slides: '#ea580c',
  ebook: '#8b5cf6',
  design: '#ec4899',
  font: '#0d9488',
  text: '#64748b',
  image: '#0ea5e9',
  video: '#0ea5e9',
  audio: '#0ea5e9',
  file: '#94a3b8',
};

export function extOf(nameOrUrl = '') {
  const clean = String(nameOrUrl).split(/[?#]/)[0];
  const m = clean.match(/\.([a-z0-9]{1,8})$/i);
  return m ? m[1].toLowerCase() : '';
}

export function fileCategory(nameOrUrl = '') {
  const ext = extOf(nameOrUrl);
  for (const [cat, list] of Object.entries(CATEGORY_BY_EXT)) {
    if (list.includes(ext)) return cat;
  }
  return 'file';
}

/** Branded SVG for a file type: a sheet with a folded corner + the extension. */
export function fileGlyph(nameOrUrl = '', size = 64) {
  const ext = (extOf(nameOrUrl) || 'file').toUpperCase();
  const cat = fileCategory(nameOrUrl);
  const color = CATEGORY_COLOR[cat] || CATEGORY_COLOR.file;
  const label = ext.length > 4 ? ext.slice(0, 4) : ext;
  return `
    <svg class="file-glyph" width="${size}" height="${size}" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeHtml(ext)} file">
      <path d="M10 4h20l10 10v28a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="${color}" fill-opacity="0.14"/>
      <path d="M30 4l10 10H32a2 2 0 0 1-2-2V4z" fill="${color}" fill-opacity="0.32"/>
      <path d="M10 4h20l10 10v28a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
      <rect x="7" y="24" width="27" height="14" rx="3" fill="${color}"/>
      <text x="20.5" y="34" text-anchor="middle" fill="#fff" font-family="ui-sans-serif,system-ui,sans-serif" font-weight="800" font-size="9" letter-spacing="0.5">${escapeHtml(label)}</text>
    </svg>`;
}

/* -------------------------------------------------------------------------- */
/* Viewer overlay                                                            */
/* -------------------------------------------------------------------------- */

let activeViewer = null;

export function closeFileViewer() {
  if (!activeViewer) return;
  try { activeViewer.close(); } catch { /* noop */ }
  activeViewer.remove();
  activeViewer = null;
}

/**
 * @param {{src:string, name?:string, mime?:string, category?:string}} opts
 */
export function openFileViewer({ src, name = '', mime = '', category } = {}) {
  if (!src) return;
  closeFileViewer();
  // Prefer an explicit category, then the MIME type, then the filename's
  // extension, then the URL's extension. `name` is often a label with no
  // extension (e.g. "Cover image"), so it must not win over `src`.
  const byName = fileCategory(name);
  const cat = category
    || (mime.startsWith('image/') ? 'image'
      : mime.startsWith('video/') ? 'video'
        : mime.startsWith('audio/') ? 'audio'
          : mime === 'application/pdf' ? 'pdf' : '')
    || (byName !== 'file' ? byName : fileCategory(src));

  const overlay = document.createElement('dialog');
  overlay.className = 'fviewer';
  overlay.innerHTML = `
    <div class="fviewer__bar">
      <span class="fviewer__name" title="${escapeHtml(name || src)}">${escapeHtml(name || decodeURIComponent(src.split('/').pop() || 'file'))}</span>
      <span class="fviewer__tools">
        ${cat === 'image' ? `
          <button type="button" data-z="out" aria-label="Zoom out">${icon('minus', 16)}</button>
          <button type="button" data-z="reset" aria-label="Reset zoom">${icon('maximize', 15)}</button>
          <button type="button" data-z="in" aria-label="Zoom in">${icon('plus', 16)}</button>` : ''}
        <a href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer" aria-label="Open in new tab">${icon('external-link', 15)}</a>
        <button type="button" data-close aria-label="Close">${icon('x', 18)}</button>
      </span>
    </div>
    <div class="fviewer__stage" data-stage></div>`;
  document.body.append(overlay);
  activeViewer = overlay;
  overlay.showModal();

  const stage = overlay.querySelector('[data-stage]');
  overlay.querySelector('[data-close]').addEventListener('click', closeFileViewer);
  overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target === stage) closeFileViewer(); });
  overlay.addEventListener('cancel', (e) => { e.preventDefault(); closeFileViewer(); });

  if (cat === 'image') {
    mountZoomableImage(stage, src, overlay);
  } else if (cat === 'video') {
    stage.innerHTML = `<video src="${escapeHtml(src)}" controls autoplay playsinline class="fviewer__media"></video>`;
  } else if (cat === 'audio') {
    stage.innerHTML = `<div class="fviewer__audio">${fileGlyph(name || src, 72)}<audio src="${escapeHtml(src)}" controls autoplay></audio></div>`;
  } else if (cat === 'pdf') {
    stage.innerHTML = `<iframe src="${escapeHtml(src)}" class="fviewer__frame" title="PDF preview"></iframe>`;
  } else if (cat === 'text') {
    stage.innerHTML = `<pre class="fviewer__text">Loading…</pre>`;
    fetch(src).then((r) => r.text()).then((t) => {
      const pre = stage.querySelector('.fviewer__text');
      if (pre) pre.textContent = t.slice(0, 200000);
    }).catch(() => {
      const pre = stage.querySelector('.fviewer__text');
      if (pre) pre.textContent = 'Could not load this file for preview.';
    });
  } else {
    stage.innerHTML = `
      <div class="fviewer__nofile">
        ${fileGlyph(name || src, 96)}
        <p>No inline preview for this format.</p>
        <a class="button button-primary" href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer">Open / download</a>
      </div>`;
  }
  renderIcons();
}

/* Wheel-zoom + drag-pan + two-finger pinch for a single image. */
function mountZoomableImage(stage, src, overlay) {
  stage.innerHTML = `<img class="fviewer__img" alt="" draggable="false">`;
  const img = stage.querySelector('img');
  let scale = 1;
  let min = 1;
  let tx = 0;
  let ty = 0;

  const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };
  const clamp = () => {
    scale = Math.max(min, Math.min(scale, min * 8));
    // keep image roughly within the stage
    const maxX = (img.width * scale) / 2;
    const maxY = (img.height * scale) / 2;
    tx = Math.max(-maxX, Math.min(tx, maxX));
    ty = Math.max(-maxY, Math.min(ty, maxY));
  };

  img.addEventListener('load', () => { scale = min = 1; tx = ty = 0; apply(); });
  img.src = src;

  const zoomAt = (factor, cx, cy) => {
    const rect = stage.getBoundingClientRect();
    const ox = (cx ?? rect.left + rect.width / 2) - rect.left - rect.width / 2 - tx;
    const oy = (cy ?? rect.top + rect.height / 2) - rect.top - rect.height / 2 - ty;
    const next = scale * factor;
    tx -= ox * (next / scale - 1);
    ty -= oy * (next / scale - 1);
    scale = next;
    clamp();
    apply();
  };

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
  }, { passive: false });

  img.addEventListener('dblclick', (e) => zoomAt(scale > min * 1.5 ? min / scale : 2, e.clientX, e.clientY));

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const pointers = new Map();
  let pinchDist = 0;

  img.addEventListener('pointerdown', (e) => {
    img.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, e);
    if (pointers.size === 1) { dragging = true; lastX = e.clientX; lastY = e.clientY; }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }
  });
  img.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, e);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (pinchDist) zoomAt(d / pinchDist, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      pinchDist = d;
      return;
    }
    if (dragging) {
      tx += e.clientX - lastX;
      ty += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      clamp();
      apply();
    }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) dragging = false;
  };
  img.addEventListener('pointerup', endPointer);
  img.addEventListener('pointercancel', endPointer);

  overlay.querySelector('[data-z="in"]')?.addEventListener('click', () => zoomAt(1.3));
  overlay.querySelector('[data-z="out"]')?.addEventListener('click', () => zoomAt(1 / 1.3));
  overlay.querySelector('[data-z="reset"]')?.addEventListener('click', () => { scale = min; tx = ty = 0; apply(); });
}
