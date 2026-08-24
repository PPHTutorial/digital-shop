/**
 * DOM helpers.
 *
 * Small, dependency-free, and deliberately unopinionated: enough to build
 * markup safely and wire events without reaching for a framework.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes a value for interpolation into HTML text or a quoted attribute. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/**
 * Tagged template that escapes every interpolation.
 *
 *   html`<p>${untrusted}</p>`
 *
 * Arrays are joined without separators so `${rows.map(row => html`…`)}` works.
 * To interpolate markup you have already built, wrap it in `raw()`.
 */
export function html(strings, ...values) {
  return strings.reduce((out, chunk, i) => {
    if (i === 0) return chunk;
    const value = values[i - 1];
    let rendered;
    if (value == null || value === false) rendered = '';
    else if (value instanceof RawHtml) rendered = value.value;
    else if (Array.isArray(value)) rendered = value.map((v) => (v instanceof RawHtml ? v.value : esc(v))).join('');
    else rendered = esc(value);
    return out + rendered + chunk;
  }, '');
}

class RawHtml {
  constructor(value) {
    this.value = String(value ?? '');
  }
}

/** Marks a string as already-safe markup for use inside `html`. */
export function raw(value) {
  return new RawHtml(value);
}

/** Conditionally emits markup — keeps ternaries out of templates. */
export function when(condition, render) {
  return condition ? raw(typeof render === 'function' ? render() : render) : '';
}

export const $ = (selector, scope = document) => scope.querySelector(selector);
export const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

/** Creates an element with attributes, dataset, listeners, and children. */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * Event delegation. Returns an unsubscribe function.
 *
 *   on(table, 'click', '[data-id]', (event, target) => …)
 */
export function on(root, type, selector, handler, options) {
  const listener = (event) => {
    const target = event.target instanceof Element ? event.target.closest(selector) : null;
    if (target && root.contains(target)) handler(event, target);
  };
  root.addEventListener(type, listener, options);
  return () => root.removeEventListener(type, listener, options);
}

/** Trailing-edge debounce with a `.cancel()` escape hatch. */
export function debounce(fn, wait = 200) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/** Leading-edge throttle, for scroll and resize handlers. */
export function throttle(fn, wait = 120) {
  let last = 0;
  let queued;
  return (...args) => {
    const now = Date.now();
    const remaining = wait - (now - last);
    clearTimeout(queued);
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else {
      queued = setTimeout(() => {
        last = Date.now();
        fn(...args);
      }, remaining);
    }
  };
}

/** Copies text, preferring the async clipboard and falling back for http origins. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const scratch = el('textarea', { value: text, style: 'position:fixed;opacity:0;top:0' });
    document.body.append(scratch);
    scratch.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    scratch.remove();
    return copied;
  }
}

/** Traps Tab inside `container` while it is open. Returns a release function. */
export function trapFocus(container) {
  const SELECTOR =
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  const handle = (event) => {
    if (event.key !== 'Tab') return;
    const focusable = $$(SELECTOR, container).filter((node) => node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  container.addEventListener('keydown', handle);
  return () => container.removeEventListener('keydown', handle);
}

/** Reads and writes the query string without adding history entries. */
export const query = {
  get(key, fallback = null) {
    return new URLSearchParams(window.location.search).get(key) ?? fallback;
  },
  set(patch, { replace = true } = {}) {
    const params = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === '' || value === 'all') params.delete(key);
      else params.set(key, value);
    }
    const search = params.toString();
    const url = `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`;
    window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
  },
};
