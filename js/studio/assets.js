/**
 * Media library.
 *
 * Uploads are downscaled and re-encoded in the browser before they leave the
 * page, which keeps the bucket small and page loads fast without asking the
 * editor to think about image dimensions. Every upload is registered in
 * `cms_assets` so the library is browsable and reusable.
 */

import { supabase, unwrap } from '../client.js';
import { CONFIG } from '../config.js';
import { icon } from '../icons.js';
import { esc, html, raw, trapFocus, debounce } from '../dom.js';
import { formatBytes, formatDate, slugify } from '../format.js';
import { toast, setBusy, closeOnBackdrop } from '../ui.js';

const MAX_EDGE = 2000;
const JPEG_QUALITY = 0.86;

/* ==========================================================================
   Client-side processing
   ========================================================================== */

/** Reads a File into an ImageBitmap, falling back to <img> where needed. */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('That file could not be read as an image.'));
      image.src = url;
    });
    return image;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Downscales to `MAX_EDGE` on the long side and optionally crops to a ratio.
 * Returns a Blob plus the final pixel dimensions.
 */
export async function processImage(file, { aspect = null, maxEdge = MAX_EDGE } = {}) {
  const source = await decode(file);
  const sourceWidth = source.width;
  const sourceHeight = source.height;

  let cropX = 0;
  let cropY = 0;
  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;

  if (aspect) {
    const currentAspect = sourceWidth / sourceHeight;
    if (currentAspect > aspect) {
      cropWidth = Math.round(sourceHeight * aspect);
      cropX = Math.round((sourceWidth - cropWidth) / 2);
    } else {
      cropHeight = Math.round(sourceWidth / aspect);
      cropY = Math.round((sourceHeight - cropHeight) / 2);
    }
  }

  const scale = Math.min(1, maxEdge / Math.max(cropWidth, cropHeight));
  const width = Math.max(1, Math.round(cropWidth * scale));
  const height = Math.max(1, Math.round(cropHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, cropX, cropY, cropWidth, cropHeight, 0, 0, width, height);
  source.close?.();

  // PNG is preserved only when the source is a PNG that may carry alpha.
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, JPEG_QUALITY));
  if (!blob) throw new Error('The image could not be encoded.');

  return { blob, width, height, type };
}

/* ==========================================================================
   Upload
   ========================================================================== */

function storagePath(filename) {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const stamp = Date.now().toString(36);
  const now = new Date();
  const folder = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${folder}/${slugify(stem) || 'asset'}-${stamp}`;
}

/**
 * Uploads an image to the public media bucket and registers it in cms_assets.
 * @returns {Promise<{id: string, url: string, path: string, width: number, height: number}>}
 */
export async function uploadImage(file, { aspect = null, alt = '' } = {}) {
  if (!file.type.startsWith('image/')) throw new Error('Only image files can be uploaded here.');
  if (file.size > CONFIG.MAX_UPLOAD_MB * 1024 * 1024) {
    throw new Error(`Images must be under ${CONFIG.MAX_UPLOAD_MB} MB.`);
  }

  const { blob, width, height, type } = await processImage(file, { aspect });
  const extension = type === 'image/png' ? 'png' : 'jpg';
  const path = `${storagePath(file.name)}.${extension}`;

  const { error } = await supabase.storage
    .from(CONFIG.BUCKET_MEDIA)
    .upload(path, blob, { contentType: type, cacheControl: '31536000', upsert: false });

  if (error) throw new Error(error.message);

  const { data: publicUrl } = supabase.storage.from(CONFIG.BUCKET_MEDIA).getPublicUrl(path);
  const url = publicUrl.publicUrl;

  const record = await unwrap(
    supabase
      .from('cms_assets')
      .insert({
        bucket: CONFIG.BUCKET_MEDIA,
        path,
        url,
        filename: file.name,
        mime_type: type,
        size_bytes: blob.size,
        width,
        height,
        alt,
      })
      .select('id')
      .single(),
  );

  return { id: record.id, url, path, width, height };
}

/** Uploads a deliverable to the private bucket. No processing, no public URL. */
export async function uploadProtectedFile(file, { onProgress } = {}) {
  const path = `${storagePath(file.name)}${file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : ''}`;
  onProgress?.(0);
  const { error } = await supabase.storage
    .from(CONFIG.BUCKET_FILES)
    .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
  if (error) throw new Error(error.message);
  onProgress?.(1);
  return { path, size: file.size, type: file.type };
}

export async function listAssets({ search = '', limit = 60 } = {}) {
  let query = supabase
    .from('cms_assets')
    .select('id,url,filename,mime_type,size_bytes,width,height,alt,created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (search.trim()) query = query.ilike('filename', `%${search.trim()}%`);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

export async function deleteAsset(asset) {
  await supabase.storage.from(CONFIG.BUCKET_MEDIA).remove([asset.path]);
  await unwrap(supabase.from('cms_assets').delete().eq('id', asset.id));
}

/* ==========================================================================
   Picker dialog
   ========================================================================== */

/**
 * Opens the media picker.
 *
 * @param {object} [options]
 * @param {number} [options.aspect] crop ratio applied to new uploads
 * @returns {Promise<{url: string, alt: string}|null>}
 */
export function openAssetPicker({ aspect = null, title = 'Choose an image' } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog dialog--wide';
    dialog.innerHTML = html`
      <div class="dialog__head">
        <div>
          <h2 class="dialog__title">${title}</h2>
          <p class="dialog__sub">
            Uploads are resized to ${String(MAX_EDGE)}px on the long edge${aspect ? ' and cropped to fit the frame' : ''}.
          </p>
        </div>
        <button class="btn btn--sm btn--ghost btn--icon" type="button" data-close aria-label="Close">
          ${raw(icon('x'))}
        </button>
      </div>
      <div class="dialog__body stack-5">
        <label class="dropzone" data-dropzone>
          ${raw(icon('upload'))}
          <span><strong>Drop an image here</strong> or click to browse</span>
          <span class="t-11 subtle">JPEG, PNG, or WebP · up to ${String(CONFIG.MAX_UPLOAD_MB)} MB</span>
          <input type="file" accept="image/*" hidden data-file />
        </label>
        <div class="row row--between">
          <label class="input-affix fill">
            ${raw(icon('search'))}
            <input class="input" type="search" placeholder="Search the library" data-search />
          </label>
          <span class="t-12 subtle" data-count></span>
        </div>
        <div class="assets" data-grid>
          <p class="t-13 subtle">Loading…</p>
        </div>
      </div>
      <div class="dialog__foot dialog__foot--split">
        <label class="field fill">
          <input class="input" type="text" placeholder="Alternative text — describe the image" data-alt />
        </label>
        <div class="row row-2">
          <button class="btn" type="button" data-close>Cancel</button>
          <button class="btn btn--primary" type="button" data-choose disabled>Use image</button>
        </div>
      </div>
    `;

    const grid = dialog.querySelector('[data-grid]');
    const countEl = dialog.querySelector('[data-count]');
    const altInput = dialog.querySelector('[data-alt]');
    const chooseButton = dialog.querySelector('[data-choose]');
    const dropzone = dialog.querySelector('[data-dropzone]');
    const fileInput = dialog.querySelector('[data-file]');

    let selected = null;
    let assets = [];

    const renderGrid = () => {
      countEl.textContent = `${assets.length} item${assets.length === 1 ? '' : 's'}`;
      if (!assets.length) {
        grid.innerHTML = html`<p class="t-13 subtle">Nothing in the library yet. Upload the first image above.</p>`;
        return;
      }
      grid.innerHTML = assets
        .map(
          (asset) => html`
            <button class="asset" type="button" data-id="${asset.id}"
                    aria-selected="${String(selected?.id === asset.id)}">
              <span class="asset__media"><img src="${asset.url}" alt="" loading="lazy" /></span>
              <span class="asset__meta">
                <span class="asset__name">${asset.filename}</span>
                <span class="asset__size">${asset.width}×${asset.height} · ${formatBytes(asset.size_bytes)}</span>
              </span>
            </button>
          `,
        )
        .join('');
    };

    const load = async (search = '') => {
      try {
        assets = await listAssets({ search });
        renderGrid();
      } catch (error) {
        grid.innerHTML = html`<p class="t-13 danger">${error.message}</p>`;
      }
    };

    const select = (asset) => {
      selected = asset;
      chooseButton.disabled = !asset;
      if (asset?.alt && !altInput.value) altInput.value = asset.alt;
      renderGrid();
    };

    const finish = (result) => {
      release();
      dialog.close();
      dialog.remove();
      resolve(result);
    };

    const upload = async (file) => {
      if (!file) return;
      const restore = dropzone.innerHTML;
      dropzone.innerHTML = '<span class="spinner"></span><span>Uploading…</span>';
      try {
        const asset = await uploadImage(file, { aspect, alt: altInput.value });
        toast('Image uploaded.');
        await load();
        select(assets.find((a) => a.id === asset.id) || { ...asset, filename: file.name });
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        dropzone.innerHTML = restore;
      }
    };

    grid.addEventListener('click', (event) => {
      const button = event.target.closest('[data-id]');
      if (button) select(assets.find((a) => a.id === button.dataset.id) || null);
    });

    dialog.querySelectorAll('[data-close]').forEach((node) => node.addEventListener('click', () => finish(null)));

    chooseButton.addEventListener('click', () => {
      if (!selected) return;
      finish({ url: selected.url, alt: altInput.value.trim() || selected.alt || '' });
    });

    fileInput.addEventListener('change', (event) => upload(event.target.files?.[0]));

    dropzone.addEventListener('dragover', (event) => {
      event.preventDefault();
      dropzone.classList.add('is-over');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-over'));
    dropzone.addEventListener('drop', (event) => {
      event.preventDefault();
      dropzone.classList.remove('is-over');
      upload(event.dataTransfer?.files?.[0]);
    });

    dialog
      .querySelector('[data-search]')
      .addEventListener('input', debounce((event) => load(event.target.value), CONFIG.SEARCH_DEBOUNCE_MS));

    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(null);
    });

    document.body.append(dialog);
    closeOnBackdrop(dialog);
    const release = trapFocus(dialog);
    dialog.showModal();
    load();
  });
}

export { setBusy, esc };
