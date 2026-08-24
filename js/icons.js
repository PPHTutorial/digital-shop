/**
 * Inline icon set.
 *
 * Replaces the runtime icon CDN. Icons are emitted as SVG markup at render
 * time, so there is no extra request, no flash of unstyled glyphs, and no
 * second DOM pass to hydrate placeholders.
 *
 * All shapes are drawn on a 24×24 grid with a 1.75 stroke and round joins,
 * which keeps them optically consistent at the 13–18px sizes the UI uses.
 */

const PATHS = {
  // --- Navigation -----------------------------------------------------------
  home: '<path d="M3 10.2 12 3l9 7.2V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  store: '<path d="M3 8h18l-1 12H4z"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/>',
  cart: '<path d="M3 4h2l2.4 10.6a2 2 0 0 0 2 1.4h7.4a2 2 0 0 0 2-1.5L20.5 8H6"/><circle cx="10" cy="20" r="1.2"/><circle cx="17" cy="20" r="1.2"/>',
  journal: '<path d="M4 5h11a1 1 0 0 1 1 1v13H5a1 1 0 0 1-1-1z"/><path d="M16 9h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-3"/><path d="M7 9h5M7 12h5M7 15h3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="m3.5 6.5 8.5 6 8.5-6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .9-1 1.6v.4"/><path d="M12 17h.01"/>',
  support: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.4"/><path d="m5.6 5.6 3.9 3.9M14.5 14.5l3.9 3.9M18.4 5.6l-3.9 3.9M9.5 14.5l-3.9 3.9"/>',
  dashboard: '<rect x="3" y="3" width="7.5" height="8.5" rx="1"/><rect x="13.5" y="3" width="7.5" height="5" rx="1"/><rect x="13.5" y="10" width="7.5" height="11" rx="1"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1"/>',
  package: '<path d="M12 3 4 7v10l8 4 8-4V7z"/><path d="m4 7 8 4 8-4M12 11v10"/>',
  users: '<path d="M15.5 20v-1.6a3.4 3.4 0 0 0-3.4-3.4H6.9a3.4 3.4 0 0 0-3.4 3.4V20"/><circle cx="9.5" cy="8" r="3.4"/><path d="M20.5 20v-1.6a3.4 3.4 0 0 0-2.6-3.3M15.5 4.7a3.4 3.4 0 0 1 0 6.6"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="1.5"/><path d="M2.5 10h19M6 15h3"/>',
  tags: '<path d="M11.6 3H4v7.6a2 2 0 0 0 .6 1.4l7.4 7.4a2 2 0 0 0 2.8 0l5.6-5.6a2 2 0 0 0 0-2.8L13 3.6a2 2 0 0 0-1.4-.6z"/><path d="M7.5 7.5h.01"/>',
  tag: '<path d="M11.6 3H4v7.6a2 2 0 0 0 .6 1.4l7.4 7.4a2 2 0 0 0 2.8 0l5.6-5.6a2 2 0 0 0 0-2.8L13 3.6a2 2 0 0 0-1.4-.6z"/><path d="M7.5 7.5h.01"/>',
  percent: '<path d="M19 5 5 19"/><circle cx="7.5" cy="7.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/>',
  doc: '<path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  docs: '<path d="M9 3h6l4 4v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M15 3v4h4"/><path d="M6 7v13a1 1 0 0 0 1 1h9"/>',
  workflow: '<rect x="3" y="3" width="7" height="6" rx="1"/><rect x="14" y="15" width="7" height="6" rx="1"/><path d="M6.5 9v5a2 2 0 0 0 2 2H14"/>',
  shield: '<path d="M12 3 5 6v6c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6z"/><path d="m9.2 12 2 2 3.6-3.8"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10.5" rx="1.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8 2 2-2 2 2 2-2 2-2-2-2 2"/>',
  database: '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6"/><path d="M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 14a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V20a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4 14a2 2 0 1 1 0-4 1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10.6 4V4a2 2 0 1 1 4 0 1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.6 1.6 0 0 0 20 10a2 2 0 1 1 0 4z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>',

  // --- Actions --------------------------------------------------------------
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m4.5 12.5 5 5L20 7"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.4 15.4 4.1 4.1"/>',
  filter: '<path d="M3.5 5h17l-6.7 8v6l-3.6 2v-8z"/>',
  edit: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/><path d="m14.5 6.5 3 3"/>',
  trash: '<path d="M4.5 6.5h15M9 6.5V4.8A1.3 1.3 0 0 1 10.3 3.5h3.4A1.3 1.3 0 0 1 15 4.8v1.7"/><path d="M6.5 6.5 7.4 20a1.3 1.3 0 0 0 1.3 1.2h6.6a1.3 1.3 0 0 0 1.3-1.2l.9-13.5"/><path d="M10.5 10.5v6.5M13.5 10.5v6.5"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="1.5"/><path d="M15.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 4v9A1.5 1.5 0 0 0 5 14.5h1.5"/>',
  save: '<path d="M5 3.5h11.5L20.5 7.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5z"/><path d="M7.5 3.5v6h9v-6M7.5 20.5v-6h9v6"/>',
  upload: '<path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/><path d="M12 4v11M7.5 8.5 12 4l4.5 4.5"/>',
  download: '<path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/><path d="M12 15V4M7.5 10.5 12 15l4.5-4.5"/>',
  send: '<path d="M21 3 10.5 13.5"/><path d="M21 3 14.4 21l-3.9-7.5L3 9.6z"/>',
  share: '<circle cx="17.5" cy="5.5" r="2.5"/><circle cx="6.5" cy="12" r="2.5"/><circle cx="17.5" cy="18.5" r="2.5"/><path d="m8.7 10.8 6.6-3.9M8.7 13.2l6.6 3.9"/>',
  link: '<path d="M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.5 1.5"/><path d="M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.5-1.5"/>',
  external: '<path d="M13 4h7v7"/><path d="m20 4-9 9"/><path d="M18 14v5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V7.5A1.5 1.5 0 0 1 5 6h5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-13.6-4.9L3.5 9"/><path d="M4 13a8 8 0 0 0 13.6 4.9L20.5 15"/><path d="M3.5 4.5V9H8M20.5 19.5V15H16"/>',
  undo: '<path d="M4 9h9.5a5.5 5.5 0 0 1 0 11H8"/><path d="M7.5 5 4 9l3.5 4"/>',
  redo: '<path d="M20 9h-9.5a5.5 5.5 0 0 0 0 11H16"/><path d="M16.5 5 20 9l-3.5 4"/>',
  history: '<path d="M3.7 9A8.5 8.5 0 1 1 3.5 13"/><path d="M3.5 4v5h5"/><path d="M12 8v4.5l3 1.8"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.9 5.7A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.3 4.1M6.3 7.6A17 17 0 0 0 2.5 12S6 18.5 12 18.5a9.4 9.4 0 0 0 3.6-.7"/><path d="M10 10a2.8 2.8 0 0 0 4 4M3 3l18 18"/>',
  more: '<circle cx="5.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.5" cy="12" r="1.4"/>',
  menu: '<path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17"/>',
  grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
  command: '<path d="M8.5 3.5a2.5 2.5 0 1 1 0 5h-2a2.5 2.5 0 0 1 0-5zM15.5 3.5a2.5 2.5 0 1 0 0 5h2a2.5 2.5 0 0 0 0-5zM8.5 20.5a2.5 2.5 0 1 1 0-5h-2a2.5 2.5 0 0 0 0 5zM15.5 20.5a2.5 2.5 0 1 0 0-5h2a2.5 2.5 0 0 1 0 5z"/><rect x="8.5" y="8.5" width="7" height="7" rx="1"/>',
  enter: '<path d="M20 5v6a3 3 0 0 1-3 3H4"/><path d="m8 10-4 4 4 4"/>',
  logout: '<path d="M9 20H5.5A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4H9"/><path d="M15.5 8 20 12l-4.5 4M20 12H9"/>',
  login: '<path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15"/><path d="M9.5 8 14 12l-4.5 4M14 12H4"/>',

  // --- Direction ------------------------------------------------------------
  chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
  chevronUp: '<path d="m6 14.5 6-6 6 6"/>',
  chevronLeft: '<path d="m14.5 5-7 7 7 7"/>',
  chevronRight: '<path d="m9.5 5 7 7-7 7"/>',
  chevronsUpDown: '<path d="m7.5 9 4.5-4.5L16.5 9M7.5 15l4.5 4.5L16.5 15"/>',
  arrowRight: '<path d="M4 12h15"/><path d="m13 6 6 6-6 6"/>',
  arrowLeft: '<path d="M20 12H5"/><path d="m11 6-6 6 6 6"/>',
  arrowUp: '<path d="M12 20V5"/><path d="m6 11 6-6 6 6"/>',
  arrowDown: '<path d="M12 4v15"/><path d="m6 13 6 6 6-6"/>',
  panelLeft: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M9.5 4v16"/>',

  // --- Status ---------------------------------------------------------------
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.2 12.2 2.6 2.6 5-5.2"/>',
  xCircle: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  alert: '<path d="M10.7 3.9 2.6 18a1.5 1.5 0 0 0 1.3 2.3h16.2a1.5 1.5 0 0 0 1.3-2.3L13.3 3.9a1.5 1.5 0 0 0-2.6 0z"/><path d="M12 9.5v4M12 17h.01"/>',
  alertCircle: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6.8V12l3.4 2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="1.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  bolt: '<path d="M13.5 2.5 4 13.5h6.5l-.5 8L20 10.5h-6.7z"/>',
  star: '<path d="m12 3.5 2.7 5.6 6.1.8-4.4 4.3 1 6.2-5.4-2.9-5.4 2.9 1-6.2L3.2 9.9l6.1-.8z"/>',
  inbox: '<path d="M3.5 12.5h4l1.5 3h6l1.5-3h4"/><path d="M5.7 4.5h12.6l2.2 8v6a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-6z"/>',
  trendUp: '<path d="M3.5 16.5 9.5 10l4 4 7-7.5"/><path d="M15 6.5h5.5V12"/>',
  trendDown: '<path d="M3.5 7.5 9.5 14l4-4 7 7.5"/><path d="M15 17.5h5.5V12"/>',
  chart: '<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7.5" y="12" width="3" height="5"/><rect x="13" y="8" width="3" height="9"/><rect x="18" y="14" width="3" height="3" transform="translate(-1.5)"/>',
  dollar: '<path d="M12 2.5v19"/><path d="M16.5 6.5H9.8a3.3 3.3 0 0 0 0 6.5h4.4a3.3 3.3 0 0 1 0 6.5H7"/>',

  // --- Media / files --------------------------------------------------------
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 4.6-4.6a1.5 1.5 0 0 1 2.1 0L16 17.7M14.5 14.5l1.4-1.4a1.5 1.5 0 0 1 2.1 0l2 2"/>',
  file: '<path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z"/><path d="M14 3v4h4"/>',
  folder: '<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  play: '<path d="M7 4.5 19 12 7 19.5z"/>',
  cloud: '<path d="M17.5 19H7a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 10.6a4.2 4.2 0 0 1-.5 8.4z"/>',
  crop: '<path d="M6.5 2.5v15h15"/><path d="M2.5 6.5h15v15"/>',

  // --- Editor ---------------------------------------------------------------
  bold: '<path d="M7 4.5h6a3.75 3.75 0 0 1 0 7.5H7z"/><path d="M7 12h6.8a3.75 3.75 0 0 1 0 7.5H7z"/>',
  italic: '<path d="M15.5 4.5h-6M14.5 19.5h-6M14 4.5l-4 15"/>',
  h2: '<path d="M4 5v14M11 5v14M4 12h7"/><path d="M15.5 9.6a2.6 2.6 0 0 1 4.5 1.8c0 2.2-4.5 3.9-4.5 7.6h5"/>',
  h3: '<path d="M4 5v14M11 5v14M4 12h7"/><path d="M15.5 9.5h4.5l-2.8 3.4a2.8 2.8 0 1 1-1.9 4.9"/>',
  quote: '<path d="M9 6.5C6.5 7.6 5 9.9 5 12.8V18h5.5v-5.5H8c0-1.9.6-3.3 2-4.2z"/><path d="M19 6.5c-2.5 1.1-4 3.4-4 6.3V18h5.5v-5.5H18c0-1.9.6-3.3 2-4.2z"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
  listOrdered: '<path d="M10 6.5h10M10 12h10M10 17.5h10"/><path d="M4 5.5h1.5v4M4 9.5h3M4 14h3v1.8L4.5 18H7"/>',
  code: '<path d="m8.5 8-4.5 4 4.5 4M15.5 8l4.5 4-4.5 4"/>',
  type: '<path d="M4.5 7V5h15v2M12 5v14M9 19h6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
  moon: '<path d="M20 14.4A8.5 8.5 0 0 1 9.6 4 8.5 8.5 0 1 0 20 14.4z"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="17" r="2"/>',
};

/** Every icon name the set knows about. Used by the schema and by tests. */
export const ICON_NAMES = Object.keys(PATHS);

/**
 * Returns SVG markup for `name`. Unknown names render nothing rather than
 * throwing, so a typo degrades to a missing glyph instead of a blank page.
 *
 * @param {string} name  key from ICON_NAMES
 * @param {number} [size] pixel size; omit to inherit the CSS `svg` sizing
 */
export function icon(name, size) {
  const path = PATHS[name];
  if (!path) {
    if (typeof console !== 'undefined') console.warn(`icon(): unknown icon "${name}"`);
    return '';
  }
  const dims = size ? ` width="${size}" height="${size}"` : '';
  return (
    `<svg${dims} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>`
  );
}

/** Renders an icon as a real element, for imperative DOM building. */
export function iconEl(name, size) {
  const holder = document.createElement('span');
  holder.style.display = 'contents';
  holder.innerHTML = icon(name, size);
  return holder.firstElementChild;
}
