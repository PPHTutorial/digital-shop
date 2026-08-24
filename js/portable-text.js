/**
 * Portable text.
 *
 * The studio's block editor writes this shape, and the storefront renders it.
 * Keeping the format small and explicit means content survives a change of
 * editor, and rendering never has to trust arbitrary HTML from the database.
 *
 * Block shapes:
 *
 *   { type: 'p' | 'h2' | 'h3' | 'quote', text, html? }
 *   { type: 'code', text, language? }
 *   { type: 'ul' | 'ol', items: string[] }   // items may carry inline html
 *   { type: 'image', url, alt?, caption? }
 *   { type: 'divider' }
 *
 * `text` is always the plain-text projection — used for search, excerpts, and
 * character counts. `html` carries inline marks and is sanitised on render.
 */

import { esc } from './dom.js';

/** Inline tags the renderer will emit. Everything else is stripped. */
const INLINE_ALLOWED = new Set(['STRONG', 'B', 'EM', 'I', 'CODE', 'A', 'BR', 'S', 'U']);

export const BLOCK_TYPES = ['p', 'h2', 'h3', 'quote', 'code', 'ul', 'ol', 'image', 'divider'];

/**
 * Strips every element and attribute outside the inline allow-list.
 * Runs in the browser (uses DOMParser); `renderBlocks` falls back to escaped
 * plain text when no DOM is available, so this is safe to import anywhere.
 */
export function sanitizeInline(markup) {
  if (typeof markup !== 'string' || markup === '') return '';
  if (typeof DOMParser === 'undefined') return esc(stripTags(markup));

  const doc = new DOMParser().parseFromString(`<div>${markup}</div>`, 'text/html');
  const root = doc.body.firstElementChild;

  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) continue;

      if (child.nodeType !== Node.ELEMENT_NODE) {
        child.remove();
        continue;
      }

      if (!INLINE_ALLOWED.has(child.tagName)) {
        // Unwrap rather than delete: keep the words, drop the wrapper.
        child.replaceWith(...Array.from(child.childNodes));
        continue;
      }

      for (const attribute of Array.from(child.attributes)) {
        const keep =
          child.tagName === 'A' && (attribute.name === 'href' || attribute.name === 'title');
        if (!keep) child.removeAttribute(attribute.name);
      }

      if (child.tagName === 'A') {
        const href = child.getAttribute('href') || '';
        // Block javascript:, data:, and other script-bearing schemes.
        if (!/^(https?:|mailto:|tel:|\/|\.\/|#)/i.test(href)) {
          child.removeAttribute('href');
        } else {
          child.setAttribute('rel', 'noopener noreferrer');
          if (/^https?:/i.test(href)) child.setAttribute('target', '_blank');
        }
      }

      walk(child);
    }
  };

  walk(root);
  return root.innerHTML;
}

function stripTags(markup) {
  return String(markup).replace(/<[^>]*>/g, '');
}

/** Plain-text projection of a block, for excerpts and counters. */
export function blockText(block) {
  if (!block) return '';
  if (block.type === 'ul' || block.type === 'ol') {
    return (block.items || []).map((item) => stripTags(item)).join(' ');
  }
  if (block.type === 'image') return block.caption || block.alt || '';
  if (block.type === 'divider') return '';
  return block.text ?? stripTags(block.html || '');
}

/** Plain-text projection of a whole document. */
export function toPlainText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.map(blockText).filter(Boolean).join('\n\n');
}

/** First `length` characters of the prose, cut on a word boundary. */
export function excerptFrom(blocks, length = 180) {
  const text = toPlainText(blocks).replace(/\s+/g, ' ').trim();
  if (text.length <= length) return text;
  const cut = text.slice(0, length);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > length * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/** Renders one block to safe HTML. */
function renderBlock(block) {
  if (!block || typeof block !== 'object') return '';

  const inline = () => (block.html ? sanitizeInline(block.html) : esc(block.text ?? ''));

  switch (block.type) {
    case 'h2':
      return `<h2>${inline()}</h2>`;
    case 'h3':
      return `<h3>${inline()}</h3>`;
    case 'quote':
      return `<blockquote>${inline()}</blockquote>`;
    case 'code':
      return `<pre><code${block.language ? ` data-language="${esc(block.language)}"` : ''}>${esc(block.text ?? '')}</code></pre>`;
    case 'ul':
    case 'ol': {
      const items = (block.items || []).map((item) => `<li>${sanitizeInline(item)}</li>`).join('');
      return `<${block.type}>${items}</${block.type}>`;
    }
    case 'image': {
      if (!block.url) return '';
      const img = `<img src="${esc(block.url)}" alt="${esc(block.alt || '')}" loading="lazy" decoding="async">`;
      return block.caption
        ? `<figure>${img}<figcaption>${esc(block.caption)}</figcaption></figure>`
        : `<figure>${img}</figure>`;
    }
    case 'divider':
      return '<hr>';
    case 'p':
    default: {
      const body = inline();
      return body.trim() ? `<p>${body}</p>` : '';
    }
  }
}

/**
 * Renders a block array to HTML for insertion into a `.prose` container.
 * Accepts a plain string too, so legacy plain-text descriptions still render.
 */
export function renderBlocks(blocks) {
  if (typeof blocks === 'string') {
    return blocks
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .map((paragraph) => `<p>${esc(paragraph).replace(/\n/g, '<br>')}</p>`)
      .join('');
  }
  if (!Array.isArray(blocks)) return '';
  return blocks.map(renderBlock).join('');
}

/** Converts a plain string into blocks, for migrating legacy fields. */
export function fromPlainText(text) {
  return String(text ?? '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => ({ type: 'p', text: paragraph }));
}

/** Rough reading time in minutes at 220 words per minute. */
export function readingMinutes(blocks) {
  const words = toPlainText(blocks).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}
