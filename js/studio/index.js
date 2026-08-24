/**
 * Content studio shell.
 *
 * Three panes — structure, documents, editor — with the current position held
 * in the URL hash (`#/post/<id>`), so a document can be linked to, bookmarked,
 * and reached with the browser's back button.
 */

import { requireAdmin, supabase } from '../client.js';
import { CONFIG } from '../config.js';
import { icon } from '../icons.js';
import { $, esc, html, raw, el, debounce, trapFocus } from '../dom.js';
import { relativeTime } from '../format.js';
import { initTheme, toggleTheme, currentTheme, toast, bootDone, confirmDialog, closeOnBackdrop } from '../ui.js';
import { TYPES, groupedTypes, getType, hasType } from './schema.js';
import { storeFor, documentCounts } from './store.js';
import { mountEditor } from './editor.js';

initTheme();

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'published', label: 'Published' },
  { value: 'changed', label: 'Changed' },
  { value: 'draft', label: 'Drafts' },
];

const state = {
  account: null,
  typeName: null,
  documentId: null,
  search: '',
  statusFilter: '',
  ordering: null,
  counts: new Map(),
  items: [],
  total: 0,
  editor: null,
};

const dom = {};

/* ==========================================================================
   Routing
   ========================================================================== */

function readRoute() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [typeName, documentId] = hash.split('/').map((part) => decodeURIComponent(part || ''));
  return {
    typeName: typeName && hasType(typeName) ? typeName : TYPES[0].name,
    documentId: documentId || null,
  };
}

function writeRoute(typeName, documentId, { replace = false } = {}) {
  const hash = `#/${typeName}${documentId ? `/${documentId}` : ''}`;
  if (window.location.hash === hash) return;
  if (replace) window.history.replaceState({}, '', hash);
  else window.location.hash = hash;
}

async function applyRoute() {
  const route = readRoute();
  const typeChanged = route.typeName !== state.typeName;

  state.typeName = route.typeName;
  state.documentId = route.documentId;

  if (typeChanged) {
    state.search = '';
    state.statusFilter = '';
    state.ordering = getType(route.typeName).orderings[0] || null;
  }

  paintDesk();

  const type = getType(state.typeName);
  if (type.singleton) {
    dom.desk.classList.add('desk--single');
    dom.listPane.hidden = true;
  } else {
    dom.desk.classList.remove('desk--single');
    dom.listPane.hidden = false;
    await loadList();
  }

  openEditor();
  setFocusPane(state.documentId || type.singleton ? 'editor' : 'list');
}

/* ==========================================================================
   Structure pane
   ========================================================================== */

function paintDesk() {
  dom.deskBody.innerHTML = groupedTypes()
    .map(
      (group) => html`
        <div class="desk-section">${group.title}</div>
        ${raw(
          group.types
            .map(
              (type) => html`
                <button class="desk-item ${type.name === state.typeName ? 'is-active' : ''}"
                        type="button" data-type="${type.name}">
                  ${raw(icon(type.icon))}
                  <span class="desk-item__label">${type.plural || type.title}</span>
                  ${when(
                    !type.singleton,
                    () => html`<span class="desk-item__count">${String(state.counts.get(type.name) ?? '')}</span>`,
                  )}
                </button>
              `,
            )
            .join(''),
        )}
      `,
    )
    .join('');
}

/* ==========================================================================
   Document list pane
   ========================================================================== */

async function loadList() {
  const type = getType(state.typeName);
  const store = storeFor(type);

  dom.listTitle.textContent = type.plural || type.title;
  dom.listBody.innerHTML = html`<div class="p-4 stack-2">${raw(
    Array.from({ length: 6 }, () => '<div class="skeleton" style="height:44px"></div>').join(''),
  )}</div>`;

  paintListToolbar(type);

  try {
    const filter = state.statusFilter
      ? store.supportsDraft
        ? { status: state.statusFilter }
        : { column: type.publishField, value: state.statusFilter === 'published' }
      : null;

    const result = await store.list({
      search: state.search,
      filter,
      ordering: state.ordering,
      limit: 100,
    });

    state.items = result.items;
    state.total = result.total;
    paintList();
  } catch (error) {
    dom.listBody.innerHTML = html`<div class="p-4"><p class="alert alert--danger">${raw(icon('alertCircle'))}<span>${error.message}</span></p></div>`;
  }
}

function paintListToolbar(type) {
  const orderings = type.orderings.length
    ? type.orderings
    : [{ name: 'updated', title: 'Recently updated', column: 'updated_at', ascending: false }];

  dom.listToolbar.innerHTML = html`
    <label class="input-affix">
      ${raw(icon('search'))}
      <input class="input" type="search" placeholder="Search ${(type.plural || type.title).toLowerCase()}"
             value="${state.search}" data-search />
    </label>
    <div class="row row--between row-2 mt-3">
      <div class="segmented">
        ${raw(
          STATUS_FILTERS.map(
            (filter) => html`
              <button type="button" data-status="${filter.value}"
                      aria-pressed="${String(state.statusFilter === filter.value)}">${filter.label}</button>
            `,
          ).join(''),
        )}
      </div>
      <select class="select" style="width:auto" data-ordering>
        ${raw(
          orderings
            .map(
              (ordering) => html`
                <option value="${ordering.name}" ${state.ordering?.name === ordering.name ? 'selected' : ''}>
                  ${ordering.title}
                </option>
              `,
            )
            .join(''),
        )}
      </select>
    </div>
  `;

  dom.listToolbar.querySelector('[data-search]').addEventListener(
    'input',
    debounce((event) => {
      state.search = event.target.value;
      loadList();
    }, CONFIG.SEARCH_DEBOUNCE_MS),
  );

  dom.listToolbar.querySelector('[data-ordering]').addEventListener('change', (event) => {
    state.ordering = orderings.find((ordering) => ordering.name === event.target.value) || null;
    loadList();
  });

  dom.listToolbar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-status]');
    if (!button) return;
    state.statusFilter = button.dataset.status;
    loadList();
  });
}

function paintList() {
  const type = getType(state.typeName);

  if (!state.items.length) {
    dom.listBody.innerHTML = html`
      <div class="empty">
        ${raw(icon(type.icon))}
        <p class="empty__title">No ${(type.plural || type.title).toLowerCase()} yet</p>
        <p class="empty__body">
          ${state.search ? 'Nothing matched that search.' : `Create the first ${type.title.toLowerCase()} to get started.`}
        </p>
      </div>
    `;
  } else {
    dom.listBody.innerHTML = state.items
      .map(
        (item) => html`
          <button class="doc-row ${item.id === state.documentId ? 'is-active' : ''}" type="button" data-id="${item.id}">
            <span class="doc-row__thumb">
              ${item.media ? raw(`<img src="${esc(item.media)}" alt="" loading="lazy">`) : raw(icon(type.icon))}
            </span>
            <span class="truncate">
              <span class="doc-row__title">${item.title}</span>
              <span class="doc-row__meta">${item.subtitle || relativeTime(item.updatedAt)}</span>
            </span>
            <span class="pubstate"><span class="pubdot pubdot--${item.status}"></span></span>
          </button>
        `,
      )
      .join('');
  }

  dom.listCount.textContent = `${state.total} item${state.total === 1 ? '' : 's'}`;
  dom.listNew.hidden = !type.creatable;
}

/* ==========================================================================
   Editor pane
   ========================================================================== */

function openEditor() {
  const type = getType(state.typeName);

  state.editor?.destroy();
  state.editor = null;

  if (!state.documentId && !type.singleton) {
    dom.editorPane.innerHTML = html`
      <div class="empty">
        ${raw(icon('edit'))}
        <p class="empty__title">Nothing selected</p>
        <p class="empty__body">Choose a document from the list, or create a new one.</p>
        ${when(
          type.creatable,
          () => html`<button class="btn btn--sm btn--primary mt-2" type="button" data-new>New ${type.title.toLowerCase()}</button>`,
        )}
      </div>
    `;
    dom.editorPane.querySelector('[data-new]')?.addEventListener('click', createNew);
    return;
  }

  state.editor = mountEditor(dom.editorPane, {
    typeName: state.typeName,
    id: state.documentId || 'new',
    onSaved: async ({ id, select }) => {
      if (id && id !== state.documentId) {
        state.documentId = id;
        writeRoute(state.typeName, id, { replace: !select });
      }
      await refreshCounts();
      if (!getType(state.typeName).singleton) await loadList();
    },
    onDeleted: async () => {
      state.documentId = null;
      writeRoute(state.typeName, null, { replace: true });
      await refreshCounts();
      await loadList();
      openEditor();
    },
    onBack: () => setFocusPane('list'),
  });
}

async function createNew() {
  const type = getType(state.typeName);
  if (!type.creatable) return;
  state.documentId = null;
  writeRoute(type.name, null, { replace: true });
  openEditor();
  setFocusPane('editor');
}

async function selectDocument(id) {
  if (state.editor?.dirty) {
    const proceed = await confirmDialog({
      title: 'Leave unsaved changes?',
      body: 'The current document has edits that have not been saved.',
      confirmLabel: 'Discard and continue',
      tone: 'danger',
    });
    if (!proceed) return;
  }
  state.documentId = id;
  writeRoute(state.typeName, id);
}

/* ==========================================================================
   Command palette
   ========================================================================== */

function openPalette() {
  const dialog = el('dialog', { class: 'dialog palette' });
  dialog.innerHTML = html`
    <input class="palette__input" type="text" placeholder="Jump to a type or document…" data-input aria-label="Search" />
    <div class="palette__results menu" data-results></div>
    <div class="palette__hint">
      <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
      <span><kbd>↵</kbd> open</span>
      <span><kbd>esc</kbd> close</span>
    </div>
  `;

  const input = dialog.querySelector('[data-input]');
  const results = dialog.querySelector('[data-results]');
  let entries = [];
  let cursor = 0;

  const close = () => {
    release();
    dialog.close();
    dialog.remove();
  };

  const paint = () => {
    results.innerHTML = entries.length
      ? entries
          .map(
            (entry, index) => html`
              <button class="menu__item" type="button" data-index="${String(index)}"
                      style="${index === cursor ? 'background:var(--surface-sunken)' : ''}">
                ${raw(icon(entry.icon))}
                <span class="fill truncate">${entry.label}</span>
                <span class="t-11 subtle">${entry.hint}</span>
              </button>
            `,
          )
          .join('')
      : html`<p class="p-3 t-12 subtle">No matches.</p>`;
  };

  const search = debounce(async (term) => {
    const typeMatches = TYPES.filter((type) =>
      (type.plural || type.title).toLowerCase().includes(term.toLowerCase()),
    ).map((type) => ({
      icon: type.icon,
      label: type.plural || type.title,
      hint: 'Type',
      run: () => writeRoute(type.name, null),
    }));

    let documentMatches = [];
    if (term.trim().length >= 2) {
      const { data } = await supabase
        .from('cms_documents')
        .select('id,type,title')
        .ilike('search_text', `%${term.trim().toLowerCase()}%`)
        .limit(8);
      documentMatches = (data || [])
        .filter((row) => hasType(row.type))
        .map((row) => ({
          icon: getType(row.type).icon,
          label: row.title,
          hint: getType(row.type).title,
          run: () => writeRoute(row.type, row.id),
        }));
    }

    entries = [...typeMatches, ...documentMatches].slice(0, 12);
    cursor = 0;
    paint();
  }, 140);

  input.addEventListener('input', () => search(input.value));

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cursor = Math.min(cursor + 1, entries.length - 1);
      paint();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      cursor = Math.max(cursor - 1, 0);
      paint();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      entries[cursor]?.run();
      close();
    }
  });

  results.addEventListener('click', (event) => {
    const button = event.target.closest('[data-index]');
    if (!button) return;
    entries[Number(button.dataset.index)]?.run();
    close();
  });

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });

  document.body.append(dialog);
  closeOnBackdrop(dialog);
  const release = trapFocus(dialog);
  dialog.showModal();
  input.focus();
  search('');
}

/* ==========================================================================
   Responsive pane focus
   ========================================================================== */

function setFocusPane(pane) {
  dom.desk.dataset.focus = pane;
}

/* ==========================================================================
   Boot
   ========================================================================== */

async function refreshCounts() {
  try {
    state.counts = await documentCounts();
    paintDesk();
  } catch {
    /* counts are decorative */
  }
}

async function boot() {
  const account = await requireAdmin('studio.html');
  if (!account) return;
  state.account = account;

  dom.desk = $('#desk');
  dom.deskBody = $('#desk-body');
  dom.listPane = $('#list-pane');
  dom.listTitle = $('#list-title');
  dom.listToolbar = $('#list-toolbar');
  dom.listBody = $('#list-body');
  dom.listCount = $('#list-count');
  dom.listNew = $('#list-new');
  dom.editorPane = $('#editor-pane');

  $('#studio-user').textContent = account.profile?.full_name || account.user.email;

  dom.deskBody.addEventListener('click', (event) => {
    const button = event.target.closest('[data-type]');
    if (button) writeRoute(button.dataset.type, null);
  });

  dom.listBody.addEventListener('click', (event) => {
    const row = event.target.closest('[data-id]');
    if (row) selectDocument(row.dataset.id);
  });

  dom.listNew.addEventListener('click', createNew);
  $('#studio-palette').addEventListener('click', openPalette);
  $('#studio-theme').addEventListener('click', (event) => {
    const next = toggleTheme();
    event.currentTarget.innerHTML = icon(next === 'dark' ? 'sun' : 'moon');
  });
  $('#studio-theme').innerHTML = icon(currentTheme() === 'dark' ? 'sun' : 'moon');

  $('#desk-back')?.addEventListener('click', () => setFocusPane('structure'));
  $('#list-back')?.addEventListener('click', () => setFocusPane('structure'));

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openPalette();
    }
  });

  window.addEventListener('hashchange', () => {
    applyRoute().catch((error) => toast(error.message, 'error'));
  });

  await refreshCounts();
  await applyRoute();
  bootDone();
}

/** Local helper mirroring dom.when. */
function when(condition, render) {
  return condition ? raw(typeof render === 'function' ? render() : render) : '';
}

boot().catch((error) => {
  console.error(error);
  toast(error.message || 'The studio failed to start.', 'error');
  bootDone();
});
