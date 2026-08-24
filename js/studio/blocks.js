/**
 * Block editor.
 *
 * A `contenteditable` canvas whose top-level children map one-to-one onto the
 * portable-text blocks in js/portable-text.js. Serialisation reads the DOM
 * rather than maintaining a parallel model, which keeps selection handling,
 * undo, and IME composition working the way the browser already does them.
 *
 * `document.execCommand` is deprecated but is still the only cross-browser way
 * to apply inline formatting to an arbitrary selection without reimplementing
 * range splitting. It is confined to `applyInline` so it can be replaced in one
 * place if a browser ever drops it.
 */

import { icon } from '../icons.js';
import { esc } from '../dom.js';
import { sanitizeInline, blockText, toPlainText } from '../portable-text.js';

const BLOCK_TAGS = {
  P: 'p',
  H2: 'h2',
  H3: 'h3',
  BLOCKQUOTE: 'quote',
  PRE: 'code',
  UL: 'ul',
  OL: 'ol',
  FIGURE: 'image',
  HR: 'divider',
};

const TOOLBAR = [
  { group: 'block', command: 'p', label: 'Body', icon: 'type', title: 'Body text' },
  { group: 'block', command: 'h2', label: 'H2', icon: 'h2', title: 'Heading 2' },
  { group: 'block', command: 'h3', label: 'H3', icon: 'h3', title: 'Heading 3' },
  { group: 'block', command: 'quote', icon: 'quote', title: 'Quote' },
  { group: 'block', command: 'ul', icon: 'list', title: 'Bulleted list' },
  { group: 'block', command: 'ol', icon: 'listOrdered', title: 'Numbered list' },
  { group: 'block', command: 'code', icon: 'code', title: 'Code block' },
  { separator: true },
  { group: 'inline', command: 'bold', icon: 'bold', title: 'Bold  (Ctrl+B)' },
  { group: 'inline', command: 'italic', icon: 'italic', title: 'Italic  (Ctrl+I)' },
  { group: 'inline', command: 'link', icon: 'link', title: 'Link  (Ctrl+K)' },
  { separator: true },
  { group: 'insert', command: 'image', icon: 'image', title: 'Insert image' },
  { group: 'insert', command: 'divider', icon: 'minus', title: 'Insert divider' },
];

/* ==========================================================================
   Serialisation
   ========================================================================== */

/** Reads the canvas DOM into a portable-text block array. */
export function serialize(canvas) {
  const blocks = [];

  for (const node of Array.from(canvas.children)) {
    const type = BLOCK_TAGS[node.tagName];
    if (!type) continue;

    if (type === 'ul' || type === 'ol') {
      const items = Array.from(node.querySelectorAll(':scope > li'))
        .map((li) => sanitizeInline(li.innerHTML).trim())
        .filter(Boolean);
      if (items.length) blocks.push({ type, items });
      continue;
    }

    if (type === 'image') {
      const img = node.querySelector('img');
      if (!img) continue;
      const caption = node.querySelector('figcaption')?.textContent?.trim() || '';
      blocks.push({
        type: 'image',
        url: img.getAttribute('src') || '',
        alt: img.getAttribute('alt') || '',
        ...(caption ? { caption } : {}),
      });
      continue;
    }

    if (type === 'divider') {
      blocks.push({ type: 'divider' });
      continue;
    }

    if (type === 'code') {
      const text = node.textContent ?? '';
      if (text.trim()) blocks.push({ type: 'code', text });
      continue;
    }

    const html = sanitizeInline(node.innerHTML).trim();
    const text = node.textContent?.trim() ?? '';
    if (!text) continue;
    blocks.push(html === esc(text) ? { type, text } : { type, text, html });
  }

  return blocks;
}

/** Renders a block array into editable canvas markup. */
export function deserialize(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) {
    return '<p data-placeholder="Start writing…"><br></p>';
  }

  return blocks
    .map((block) => {
      const inline = block.html ? sanitizeInline(block.html) : esc(block.text ?? '');
      switch (block.type) {
        case 'h2':
          return `<h2>${inline}</h2>`;
        case 'h3':
          return `<h3>${inline}</h3>`;
        case 'quote':
          return `<blockquote>${inline}</blockquote>`;
        case 'code':
          return `<pre>${esc(block.text ?? '')}</pre>`;
        case 'ul':
        case 'ol':
          return `<${block.type}>${(block.items || []).map((i) => `<li>${sanitizeInline(i)}</li>`).join('')}</${block.type}>`;
        case 'image':
          return block.url
            ? `<figure contenteditable="false"><img src="${esc(block.url)}" alt="${esc(block.alt || '')}">` +
                `${block.caption ? `<figcaption>${esc(block.caption)}</figcaption>` : ''}</figure>`
            : '';
        case 'divider':
          return '<hr contenteditable="false">';
        default:
          return `<p>${inline}</p>`;
      }
    })
    .join('');
}

/* ==========================================================================
   Editor
   ========================================================================== */

/**
 * Mounts a block editor.
 *
 * @param {object} options
 * @param {Array}  options.value      initial blocks
 * @param {(blocks: Array) => void} options.onChange
 * @param {() => Promise<{url: string, alt?: string}|null>} [options.pickImage]
 * @returns {{ element: HTMLElement, getValue: () => Array, setValue: (blocks: Array) => void, destroy: () => void }}
 */
export function createBlockEditor({ value = [], onChange, pickImage, placeholder = 'Start writing…' } = {}) {
  const root = document.createElement('div');
  root.className = 'blocks';

  root.innerHTML = `
    <div class="blocks__bar" role="toolbar" aria-label="Formatting">
      ${TOOLBAR.map((entry) =>
        entry.separator
          ? '<span class="blocks__sep" aria-hidden="true"></span>'
          : `<button class="btn" type="button" data-group="${entry.group}" data-command="${entry.command}"
                     title="${esc(entry.title)}" aria-label="${esc(entry.title)}" aria-pressed="false">
               ${icon(entry.icon)}${entry.label ? `<span>${esc(entry.label)}</span>` : ''}
             </button>`,
      ).join('')}
    </div>
    <div class="blocks__canvas" contenteditable="true" role="textbox" aria-multiline="true"
         spellcheck="true" data-placeholder="${esc(placeholder)}"></div>
    <div class="blocks__foot">
      <span data-counter>0 words</span>
      <span>Markdown shortcuts: <kbd>##</kbd> heading &nbsp; <kbd>-</kbd> list &nbsp; <kbd>&gt;</kbd> quote</span>
    </div>
  `;

  const canvas = root.querySelector('.blocks__canvas');
  const counter = root.querySelector('[data-counter]');
  const bar = root.querySelector('.blocks__bar');

  canvas.innerHTML = deserialize(value);

  let current = Array.isArray(value) ? structuredClone(value) : [];
  let raf = 0;

  const emit = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      current = serialize(canvas);
      const words = toPlainText(current).split(/\s+/).filter(Boolean).length;
      counter.textContent = `${words} word${words === 1 ? '' : 's'}`;
      onChange?.(current);
    });
  };

  /* --- Selection-aware toolbar state ------------------------------------- */

  const currentBlock = () => {
    const selection = window.getSelection();
    if (!selection?.anchorNode || !canvas.contains(selection.anchorNode)) return null;
    let node = selection.anchorNode;
    while (node && node.parentNode !== canvas) node = node.parentNode;
    return node instanceof Element ? node : null;
  };

  const syncToolbar = () => {
    const block = currentBlock();
    const blockType = block ? BLOCK_TAGS[block.tagName] || 'p' : null;

    for (const button of bar.querySelectorAll('button')) {
      const { group, command } = button.dataset;
      if (group === 'block') {
        button.setAttribute('aria-pressed', String(blockType === command));
      } else if (group === 'inline' && command !== 'link') {
        let active = false;
        try {
          active = document.queryCommandState(command);
        } catch {
          active = false;
        }
        button.setAttribute('aria-pressed', String(active));
      }
    }
  };

  /* --- Commands ----------------------------------------------------------- */

  const applyInline = (command, argument) => {
    canvas.focus();
    // Deprecated, but the only portable way to split ranges correctly.
    document.execCommand(command, false, argument);
    emit();
    syncToolbar();
  };

  const setBlockType = (target) => {
    canvas.focus();
    const block = currentBlock();
    if (!block) return;

    if (target === 'ul' || target === 'ol') {
      document.execCommand(target === 'ul' ? 'insertUnorderedList' : 'insertOrderedList');
      emit();
      syncToolbar();
      return;
    }

    // Lists need unwrapping before they can become a paragraph or heading.
    if (block.tagName === 'UL' || block.tagName === 'OL') {
      document.execCommand(block.tagName === 'UL' ? 'insertUnorderedList' : 'insertOrderedList');
    }

    const tag = { p: 'P', h2: 'H2', h3: 'H3', quote: 'BLOCKQUOTE', code: 'PRE' }[target] || 'P';
    const replacement = document.createElement(tag);
    replacement.innerHTML = tag === 'PRE' ? esc(block.textContent ?? '') : block.innerHTML || '<br>';

    const refreshed = currentBlock();
    (refreshed || block).replaceWith(replacement);

    placeCaretAtEnd(replacement);
    emit();
    syncToolbar();
  };

  const insertBlock = (node) => {
    canvas.focus();
    const block = currentBlock();
    if (block) block.after(node);
    else canvas.append(node);

    const trailing = document.createElement('p');
    trailing.innerHTML = '<br>';
    node.after(trailing);
    placeCaretAtEnd(trailing);
    emit();
  };

  const insertImage = async () => {
    const picked = await pickImage?.();
    if (!picked?.url) return;
    const figure = document.createElement('figure');
    figure.contentEditable = 'false';
    figure.innerHTML =
      `<img src="${esc(picked.url)}" alt="${esc(picked.alt || '')}">` +
      (picked.caption ? `<figcaption>${esc(picked.caption)}</figcaption>` : '');
    insertBlock(figure);
  };

  const insertLink = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      window.alert('Select the text you want to link first.');
      return;
    }
    const existing = selection.anchorNode?.parentElement?.closest?.('a')?.getAttribute('href') || 'https://';
    const href = window.prompt('Link address', existing);
    if (href === null) return;
    if (href.trim() === '') applyInline('unlink');
    else applyInline('createLink', href.trim());
  };

  /* --- Events ------------------------------------------------------------- */

  const onToolbarClick = (event) => {
    const button = event.target.closest('button[data-command]');
    if (!button) return;
    event.preventDefault();

    const { group, command } = button.dataset;
    if (group === 'block') setBlockType(command);
    else if (command === 'link') insertLink();
    else if (group === 'inline') applyInline(command);
    else if (command === 'image') insertImage();
    else if (command === 'divider') {
      const rule = document.createElement('hr');
      rule.contentEditable = 'false';
      insertBlock(rule);
    }
  };

  // Keep the caret inside the canvas when the toolbar is clicked.
  const onToolbarMouseDown = (event) => event.preventDefault();

  const onKeyDown = (event) => {
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      applyInline('bold');
    } else if (meta && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      applyInline('italic');
    } else if (meta && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      insertLink();
    } else if (event.key === 'Enter' && !event.shiftKey) {
      // Leaving a quote or code block should return to body text.
      const block = currentBlock();
      if (block && (block.tagName === 'BLOCKQUOTE' || block.tagName === 'PRE') && isCaretAtEnd(block)) {
        const text = block.textContent ?? '';
        if (text.endsWith('\n') || block.tagName === 'BLOCKQUOTE') {
          event.preventDefault();
          const paragraph = document.createElement('p');
          paragraph.innerHTML = '<br>';
          block.after(paragraph);
          placeCaretAtEnd(paragraph);
          emit();
        }
      }
    }
  };

  /** Markdown-style shortcuts applied as the author types them. */
  const onInput = () => {
    const block = currentBlock();
    if (block && block.tagName === 'P') {
      const text = block.textContent ?? '';
      const shortcut = { '# ': 'h2', '## ': 'h2', '### ': 'h3', '> ': 'quote', '- ': 'ul', '* ': 'ul', '1. ': 'ol', '``` ': 'code' };
      for (const [prefix, target] of Object.entries(shortcut)) {
        if (text === prefix) {
          block.textContent = '';
          setBlockType(target);
          return;
        }
      }
    }
    emit();
  };

  /** Paste arrives as plain text: no Word styling, no tracking spans. */
  const onPaste = (event) => {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;

    const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim());
    if (paragraphs.length <= 1) {
      document.execCommand('insertText', false, text.replace(/\n/g, ' '));
    } else {
      const block = currentBlock();
      const fragment = document.createDocumentFragment();
      for (const paragraph of paragraphs) {
        const node = document.createElement('p');
        node.textContent = paragraph.trim();
        fragment.append(node);
      }
      const last = fragment.lastChild;
      if (block) block.after(fragment);
      else canvas.append(fragment);
      if (last) placeCaretAtEnd(last);
    }
    emit();
  };

  bar.addEventListener('mousedown', onToolbarMouseDown);
  bar.addEventListener('click', onToolbarClick);
  canvas.addEventListener('input', onInput);
  canvas.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('paste', onPaste);
  document.addEventListener('selectionchange', syncToolbar);

  emit();

  return {
    element: root,
    getValue: () => current,
    setValue(next) {
      current = Array.isArray(next) ? structuredClone(next) : [];
      canvas.innerHTML = deserialize(current);
      emit();
    },
    focus: () => canvas.focus(),
    destroy() {
      document.removeEventListener('selectionchange', syncToolbar);
      cancelAnimationFrame(raf);
      root.remove();
    },
  };
}

/* ==========================================================================
   Caret helpers
   ========================================================================== */

function placeCaretAtEnd(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  if (node instanceof HTMLElement) node.focus?.();
}

function isCaretAtEnd(block) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return false;
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(block);
  range.setStart(selection.anchorNode, selection.anchorOffset);
  return range.toString().length === 0;
}

export { blockText };
