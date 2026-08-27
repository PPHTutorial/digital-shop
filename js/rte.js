/**
 * Lightweight rich-text editor + format converters. No build step, no
 * dependencies: a contenteditable surface driven by `document.execCommand`
 * (deprecated but universally implemented and adequate for an internal
 * back-office tool) plus a toolbar.
 *
 * The storefront stores three different shapes for "body" content:
 *   - legal documents  → a block array  [{ type: 'h2'|'h3'|'li'|'p', text }]
 *   - blog posts        → raw HTML
 *   - everything else    → a markdown string (rendered by ui.js renderMarkdown)
 *
 * The editor always works in HTML internally. `valueToHtml()` loads any of the
 * three shapes into it; `htmlToValue()` serialises back to the shape a given
 * document type expects. Block/markdown text keeps inline emphasis by carrying
 * lightweight markdown (`**bold**`, `*italic*`, `` `code` ``, `[t](url)`),
 * which both renderMarkdown and legal.js understand.
 */

import { escapeHtml, renderMarkdown, renderIcons, icon } from './ui.js';

/* -------------------------------------------------------------------------- */
/* Inline emphasis <-> markdown                                              */
/* -------------------------------------------------------------------------- */

export function inlineHtmlFromMarkdown(text) {
  return escapeHtml(String(text ?? ''))
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function inlineMarkdownFromNode(node) {
  let out = '';
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) { out += child.textContent; return; }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const tag = child.tagName.toLowerCase();
    const inner = inlineMarkdownFromNode(child);
    if (tag === 'strong' || tag === 'b') out += inner.trim() ? `**${inner}**` : '';
    else if (tag === 'em' || tag === 'i') out += inner.trim() ? `*${inner}*` : '';
    else if (tag === 'code') out += inner.trim() ? '`' + inner + '`' : '';
    else if (tag === 'a') {
      const href = child.getAttribute('href') || '';
      out += href ? `[${inner}](${href})` : inner;
    } else if (tag === 'br') out += '\n';
    else out += inner;
  });
  return out.replace(/ /g, ' ');
}

/* -------------------------------------------------------------------------- */
/* Block array <-> HTML                                                      */
/* -------------------------------------------------------------------------- */

export function blocksToHtml(blocks) {
  if (!Array.isArray(blocks)) return '';
  let html = '';
  let inList = false;
  for (const block of blocks) {
    const type = block?.type || 'p';
    const inner = inlineHtmlFromMarkdown(block?.text || '');
    if (type === 'li') {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inner}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (type === 'h2' || type === 'h3') html += `<${type}>${inner}</${type}>`;
    else html += `<p>${inner}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

export function htmlToBlocks(html) {
  const root = document.createElement('div');
  root.innerHTML = html || '';
  const blocks = [];
  const push = (type, node) => {
    const text = inlineMarkdownFromNode(node).replace(/\s+\n/g, '\n').trim();
    if (text) blocks.push({ type, text });
  };
  for (const el of root.children) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'h1' || tag === 'h2') push('h2', el);
    else if (['h3', 'h4', 'h5', 'h6'].includes(tag)) push('h3', el);
    else if (tag === 'ul' || tag === 'ol') el.querySelectorAll(':scope > li').forEach((li) => push('li', li));
    else push('p', el);
  }
  if (!blocks.length && root.textContent.trim()) {
    root.textContent.trim().split(/\n{2,}/).forEach((para) => {
      const text = para.trim();
      if (text) blocks.push({ type: 'p', text });
    });
  }
  return blocks;
}

/* -------------------------------------------------------------------------- */
/* HTML -> markdown                                                          */
/* -------------------------------------------------------------------------- */

export function htmlToMarkdown(html) {
  const root = document.createElement('div');
  root.innerHTML = html || '';
  const lines = [];
  for (const el of root.children) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'ul') {
      el.querySelectorAll(':scope > li').forEach((li) => lines.push(`- ${inlineMarkdownFromNode(li).trim()}`));
      lines.push('');
      continue;
    }
    if (tag === 'ol') {
      let n = 1;
      el.querySelectorAll(':scope > li').forEach((li) => lines.push(`${n++}. ${inlineMarkdownFromNode(li).trim()}`));
      lines.push('');
      continue;
    }
    const inline = inlineMarkdownFromNode(el).trim();
    if (!inline) continue;
    if (tag === 'h1' || tag === 'h2') lines.push(`## ${inline}`, '');
    else if (tag === 'h3' || tag === 'h4') lines.push(`### ${inline}`, '');
    else if (tag === 'blockquote') lines.push(`> ${inline}`, '');
    else lines.push(inline, '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* -------------------------------------------------------------------------- */
/* Sanitise + shape adapters                                                */
/* -------------------------------------------------------------------------- */

const ALLOWED_TAGS = new Set(['P', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'CODE', 'PRE', 'A', 'DIV', 'SPAN']);

export function sanitizeRteHtml(html) {
  const root = document.createElement('div');
  root.innerHTML = html || '';
  root.querySelectorAll('script,style,iframe,object,embed,link,meta,form,input,button').forEach((n) => n.remove());
  root.querySelectorAll('*').forEach((el) => {
    if (!ALLOWED_TAGS.has(el.tagName)) {
      el.replaceWith(...el.childNodes);
      return;
    }
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const keep = el.tagName === 'A' ? ['href', 'target', 'rel'] : [];
      if (!keep.includes(name)) { el.removeAttribute(attr.name); return; }
      if (name === 'href' && /^\s*(javascript|data):/i.test(attr.value)) el.removeAttribute(attr.name);
    });
    if (el.tagName === 'A' && el.getAttribute('href')) {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return root.innerHTML.trim();
}

/**
 * Any stored shape -> HTML for the editor.
 */
export function valueToHtml(value) {
  if (value == null || value === '') return '';
  if (Array.isArray(value)) return blocksToHtml(value);
  const str = String(value);
  if (/<(p|h[1-6]|ul|ol|li|blockquote|div)\b/i.test(str)) return sanitizeRteHtml(str);
  return renderMarkdown(str);
}

/**
 * Editor HTML -> stored shape.
 * @param {string} html
 * @param {'blocks'|'markdown'|'html'} format
 */
export function htmlToValue(html, format) {
  const clean = sanitizeRteHtml(html || '');
  if (format === 'blocks') return htmlToBlocks(clean);
  if (format === 'html') return clean;
  return htmlToMarkdown(clean);
}

/** The storage shape a CMS document type expects for its rich body. */
export function formatForType(type) {
  if (type === 'legal') return 'blocks';
  if (type === 'post') return 'html';
  return 'markdown';
}

/* -------------------------------------------------------------------------- */
/* The editor component                                                     */
/* -------------------------------------------------------------------------- */

const TOOLBAR = [
  { cmd: 'formatBlock', value: 'H2', icon: 'heading-2', label: 'Heading' },
  { cmd: 'formatBlock', value: 'H3', icon: 'heading-3', label: 'Subheading' },
  { cmd: 'formatBlock', value: 'P', icon: 'pilcrow', label: 'Paragraph' },
  { sep: true },
  { cmd: 'bold', icon: 'bold', label: 'Bold' },
  { cmd: 'italic', icon: 'italic', label: 'Italic' },
  { cmd: 'underline', icon: 'underline', label: 'Underline' },
  { cmd: 'strikeThrough', icon: 'strikethrough', label: 'Strikethrough' },
  { cmd: 'code', icon: 'code', label: 'Inline code' },
  { sep: true },
  { cmd: 'insertUnorderedList', icon: 'list', label: 'Bulleted list' },
  { cmd: 'insertOrderedList', icon: 'list-ordered', label: 'Numbered list' },
  { cmd: 'formatBlock', value: 'BLOCKQUOTE', icon: 'quote', label: 'Quote' },
  { sep: true },
  { cmd: 'createLink', icon: 'link', label: 'Insert link' },
  { cmd: 'unlink', icon: 'unlink', label: 'Remove link' },
  { cmd: 'removeFormat', icon: 'eraser', label: 'Clear formatting' },
];

/**
 * Returns the markup string for an editor. Call `wireRte()` on the mounted
 * `.cms-rte` element afterwards to attach behaviour and seed content.
 */
export function buildRte({ id, minHeight = 320, disabled = false } = {}) {
  const buttons = TOOLBAR.map((item) => {
    if (item.sep) return '<span class="cms-rte__sep" aria-hidden="true"></span>';
    return `<button type="button" class="cms-rte__btn" data-cmd="${item.cmd}"${item.value ? ` data-value="${item.value}"` : ''} title="${escapeHtml(item.label)}" aria-label="${escapeHtml(item.label)}" tabindex="-1">${icon(item.icon, 15)}</button>`;
  }).join('');
  return `
    <div class="cms-rte${disabled ? ' is-disabled' : ''}" data-rte="${id}">
      <div class="cms-rte__toolbar" role="toolbar" aria-label="Formatting">${buttons}</div>
      <div class="cms-rte__area pd-markdown" id="${id}" contenteditable="${disabled ? 'false' : 'true'}" role="textbox" aria-multiline="true" style="min-height:${minHeight}px" spellcheck="true"></div>
    </div>`;
}

export function wireRte(root, initialHtml = '', { disabled = false } = {}) {
  if (!root) return;
  const area = root.querySelector('.cms-rte__area');
  if (!area) return;
  area.innerHTML = initialHtml || '<p><br></p>';

  if (disabled) { renderIcons(); return; }

  const exec = (cmd, value = null) => {
    area.focus();
    if (cmd === 'code') return wrapInlineCode(area);
    if (cmd === 'createLink') {
      const url = window.prompt('Link URL (https://…)');
      if (!url) return;
      document.execCommand('createLink', false, url.trim());
      // execCommand can't set attributes; tag the freshly created links
      area.querySelectorAll('a[href]:not([data-tagged])').forEach((a) => {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        a.dataset.tagged = '1';
      });
      return;
    }
    if (cmd === 'formatBlock') return document.execCommand('formatBlock', false, `<${value}>`);
    document.execCommand(cmd, false, value);
  };

  root.querySelectorAll('.cms-rte__btn').forEach((btn) => {
    // mousedown, not click: keeps the editor selection intact
    btn.addEventListener('mousedown', (event) => {
      event.preventDefault();
      exec(btn.dataset.cmd, btn.dataset.value || null);
      syncToolbarState(root, area);
    });
  });

  area.addEventListener('keyup', () => syncToolbarState(root, area));
  area.addEventListener('mouseup', () => syncToolbarState(root, area));
  area.addEventListener('paste', (event) => {
    event.preventDefault();
    const text = (event.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  renderIcons();
  syncToolbarState(root, area);
}

function syncToolbarState(root, area) {
  if (!area.contains(document.getSelection()?.anchorNode || null)) return;
  const q = (cmd) => { try { return document.queryCommandState(cmd); } catch { return false; } };
  root.querySelectorAll('.cms-rte__btn').forEach((btn) => {
    const cmd = btn.dataset.cmd;
    let active = false;
    if (['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'].includes(cmd)) active = q(cmd);
    else if (cmd === 'formatBlock' && btn.dataset.value) {
      let node = document.getSelection()?.anchorNode;
      node = node?.nodeType === 3 ? node.parentElement : node;
      const block = node?.closest?.('h1,h2,h3,h4,blockquote,p');
      active = !!block && block.tagName === btn.dataset.value;
    }
    btn.classList.toggle('is-active', active);
  });
}

function wrapInlineCode(area) {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const existing = (range.startContainer.parentElement || range.startContainer).closest?.('code');
  if (existing) {
    existing.replaceWith(...existing.childNodes);
    return;
  }
  const code = document.createElement('code');
  code.appendChild(range.extractContents());
  range.insertNode(code);
  sel.removeAllRanges();
  const after = document.createRange();
  after.selectNodeContents(code);
  sel.addRange(after);
}

export function getRteValue(root, format) {
  const area = root?.querySelector('.cms-rte__area');
  return htmlToValue(area ? area.innerHTML : '', format);
}
