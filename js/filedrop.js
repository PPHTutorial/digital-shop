/**
 * Drag-and-drop file field. A styled surface that also takes a click, wraps a
 * hidden <input type="file">, shows a status line and (for images) a preview.
 * Everything is width-clamped so a native file input can't bleed out of the
 * modal grid.
 *
 * Usage:
 *   host.innerHTML = buildDropzone({ id: 'p-file', accept: '...', label: '…' });
 *   const dz = wireDropzone(host.querySelector('.filedrop'), {
 *     onFiles: async (files) => { ...upload...; dz.setPreview(url); },
 *   });
 */

import { escapeHtml, icon, renderIcons } from './ui.js';
import { fileGlyph } from './preview.js';

export function buildDropzone({
  id,
  accept = '',
  label = 'Drop a file or click to browse',
  hint = '',
  multiple = false,
  compact = false,
} = {}) {
  return `
    <div class="filedrop${compact ? ' filedrop--compact' : ''}" data-filedrop>
      <input type="file" id="${id}"${accept ? ` accept="${escapeHtml(accept)}"` : ''}${multiple ? ' multiple' : ''}>
      <span class="filedrop__icon">${icon('upload-cloud', 20)}</span>
      <span class="filedrop__label">${escapeHtml(label)}</span>
      ${hint ? `<span class="filedrop__hint">${escapeHtml(hint)}</span>` : ''}
      <div class="filedrop__preview" hidden></div>
      <p class="filedrop__status help" aria-live="polite"></p>
    </div>`;
}

export function wireDropzone(root, { onFiles, disabled = false } = {}) {
  if (!root) return null;
  const input = root.querySelector('input[type="file"]');
  const statusEl = root.querySelector('.filedrop__status');
  const previewEl = root.querySelector('.filedrop__preview');

  const setStatus = (text, kind = '') => {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.className = `filedrop__status help${kind ? ` ${kind}` : ''}`;
  };

  const setPreview = (value) => {
    if (!previewEl) return;
    if (!value) { previewEl.hidden = true; previewEl.innerHTML = ''; return; }
    previewEl.hidden = false;
    const str = String(value);
    const isImageUrl = /^(https?:|blob:|data:image)/.test(str) && !/\.(zip|pdf|docx?|epub|apk|exe|dmg|mp4|mov)(\?|$)/i.test(str);
    if (isImageUrl) {
      previewEl.innerHTML = `<img src="${escapeHtml(str)}" alt="preview" loading="lazy" style="cursor:zoom-in">`;
    } else {
      previewEl.innerHTML = `<span class="filedrop__file">${fileGlyph(str, 22)}<span>${escapeHtml(str)}</span></span>`;
    }
    renderIcons();
  };

  const emit = (fileList) => {
    const files = Array.from(fileList || []).filter(Boolean);
    if (files.length) onFiles?.(files);
  };

  if (!disabled) {
    root.addEventListener('click', (event) => {
      if (event.target.closest('a, button')) return;
      input.click();
    });
    input.addEventListener('change', () => { emit(input.files); input.value = ''; });

    ['dragenter', 'dragover'].forEach((type) => root.addEventListener(type, (event) => {
      event.preventDefault();
      root.classList.add('is-dragover');
    }));
    ['dragleave', 'dragend', 'drop'].forEach((type) => root.addEventListener(type, (event) => {
      event.preventDefault();
      if (type === 'dragleave' && root.contains(event.relatedTarget)) return;
      root.classList.remove('is-dragover');
    }));
    root.addEventListener('drop', (event) => emit(event.dataTransfer?.files));
  } else {
    root.classList.add('is-disabled');
  }

  return { setStatus, setPreview, input, el: root };
}

/** file name / URL -> uppercase extension, e.g. "guide.PDF" -> "PDF" */
export function extOf(nameOrUrl = '') {
  const clean = String(nameOrUrl).split(/[?#]/)[0];
  const match = clean.match(/\.([a-z0-9]{1,8})$/i);
  return match ? match[1].toUpperCase() : '';
}
