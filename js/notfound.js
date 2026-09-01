import { mountHeader, mountFooter, finishPageLoader, renderIcons } from './ui.js';

/*
 * GitHub Pages serves /404.html for any unmatched path. Blog posts and
 * products normally exist as prerendered files (tools/prerender.mjs); one
 * published after the last deploy won't yet — bounce those to the client
 * shell, which fetches by slug and rewrites the bar back to the clean path.
 * Anything else is a genuine not-found.
 */
const pathname = window.location.pathname;
const blog = pathname.match(/^\/blog\/([^/]+)\/?$/);
const product = pathname.match(/^\/product\/([^/]+)\/?$/);

if (blog) {
  window.location.replace(`/blog?post=${blog[1]}`);
} else if (product) {
  window.location.replace(`/product?product=${product[1]}`);
} else {
  mountHeader();
  mountFooter();
  renderIcons();
  finishPageLoader();
}
