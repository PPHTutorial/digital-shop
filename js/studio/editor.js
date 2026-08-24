/**
 * Document editor pane.
 *
 * Compiles a schema type into a form, autosaves the draft, tracks validation,
 * and exposes the publish workflow. The pane owns one document at a time and
 * is fully torn down when the selection changes.
 */

import { icon } from '../icons.js';
import { esc, html, raw, el, debounce } from '../dom.js';
import { CONFIG } from '../config.js';
import { formatDate, relativeTime } from '../format.js';
import { toast, setBusy, confirmDialog } from '../ui.js';
import { fieldGroups, emptyDocument, documentTitle, getType } from './schema.js';
import { validateDocument } from './validate.js';
import { renderField } from './fields.js';
import { storeFor, invalidateReferences } from './store.js';

const STATUS_LABEL = {
  published: 'Published',
  draft: 'Draft',
  changed: 'Unpublished changes',
  unpublished: 'Unpublished',
};

/**
 * @param {HTMLElement} pane   the `.pane--editor` element to render into
 * @param {object} options     { typeName, id, onSaved, onDeleted, onBack }
 */
export function mountEditor(pane, { typeName, id, onSaved, onDeleted, onBack }) {
  const type = getType(typeName);
  const store = storeFor(type);

  let doc = emptyDocument(type);
  let version = null;
  let status = 'draft';
  let publishedAt = null;
  let updatedAt = null;
  let documentId = id === 'new' ? null : id;
  let dirty = false;
  let saving = false;
  let destroyed = false;
  let controls = [];
  let lockTimer = null;
  let revisions = [];

  pane.innerHTML = html`
    <div class="editor">
      <div class="editor__head">
        <button class="btn btn--sm btn--ghost btn--icon pane__back" type="button" data-back aria-label="Back to list">
          ${raw(icon('chevronLeft'))}
        </button>
        <div class="fill truncate">
          <span class="pane__title" data-title>Loading…</span>
        </div>
        <span class="pubstate" data-status></span>
        <div class="row row-1">
          <button class="btn btn--sm" type="button" data-menu-duplicate title="Duplicate">${raw(icon('copy'))}</button>
          <button class="btn btn--sm" type="button" data-menu-delete title="Delete">${raw(icon('trash'))}</button>
        </div>
      </div>
      <div class="editor__split">
        <div class="editor__body">
          <form class="editor__form" data-form novalidate>
            <p class="t-13 subtle">Loading…</p>
          </form>
        </div>
        <aside class="inspector" data-inspector></aside>
      </div>
      <div class="editor__foot">
        <span class="editor__savestate" data-savestate></span>
        <button class="btn btn--sm" type="button" data-save>Save draft</button>
        <button class="btn btn--sm btn--primary" type="button" data-publish>Publish</button>
      </div>
    </div>
  `;

  const titleEl = pane.querySelector('[data-title]');
  const statusEl = pane.querySelector('[data-status]');
  const form = pane.querySelector('[data-form]');
  const inspector = pane.querySelector('[data-inspector]');
  const saveState = pane.querySelector('[data-savestate]');
  const saveButton = pane.querySelector('[data-save]');
  const publishButton = pane.querySelector('[data-publish]');

  /* ---------------------------------------------------------------- Chrome */

  function paintHeader() {
    titleEl.textContent = documentTitle(type, doc);
    const key = status in STATUS_LABEL ? status : 'draft';
    statusEl.innerHTML = html`<span class="pubdot pubdot--${key}"></span>${STATUS_LABEL[key]}`;

    publishButton.textContent = status === 'published' ? 'Republish' : 'Publish';
    publishButton.disabled = status === 'published' && !dirty && store.supportsDraft;
  }

  function paintSaveState(text, tone = '') {
    saveState.className = `editor__savestate${tone ? ` editor__savestate--${tone}` : ''}`;
    saveState.innerHTML = text;
  }

  /* ------------------------------------------------------------ Validation */

  function runValidation({ focusFirst = false } = {}) {
    const problems = validateDocument(type, doc);
    const byField = new Map(problems.map((problem) => [problem.field, problem.message]));

    for (const control of controls) {
      control.setError?.(byField.get(control.def.name) || null);
    }

    paintValidationSummary(problems);

    if (focusFirst && problems.length) {
      const first = controls.find((control) => control.def.name === problems[0].field);
      first?.focus?.();
      first?.root?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    return problems;
  }

  function paintValidationSummary(problems) {
    const box = inspector.querySelector('[data-validation]');
    if (!box) return;
    if (!problems.length) {
      box.innerHTML = html`<p class="t-12 ok">${raw(icon('checkCircle', 13))} Ready to publish.</p>`;
      return;
    }
    box.innerHTML = html`
      <div class="validation">
        ${raw(
          problems
            .map(
              (problem) => html`
                <p class="validation__item">
                  ${raw(icon('alertCircle', 13))}
                  <button type="button" data-goto="${problem.field}">${problem.message}</button>
                </p>
              `,
            )
            .join(''),
        )}
      </div>
    `;
  }

  /* ------------------------------------------------------------------ Form */

  function buildForm() {
    controls.forEach((control) => control.destroy?.());
    controls = [];
    form.innerHTML = '';

    for (const group of fieldGroups(type)) {
      const section = el('section', { class: 'stack-5' });
      if (fieldGroups(type).length > 1) {
        section.append(el('span', { class: 'eyebrow', text: group.title }));
      }

      for (const fieldDef of group.fields) {
        const control = renderField(fieldDef, doc[fieldDef.name], {
          getDoc: () => doc,
          onChange: (next) => {
            doc = { ...doc, [fieldDef.name]: next };
            markDirty();
          },
          onMeta: (patch) => {
            doc = { ...doc, ...patch };
            for (const [key, value] of Object.entries(patch)) {
              controls.find((c) => c.def.name === key)?.setValue?.(value);
            }
            markDirty();
          },
        });
        controls.push(control);
        section.append(control.root);
      }

      form.append(section);
    }
  }

  /* ---------------------------------------------------------------- Saving */

  function markDirty() {
    dirty = true;
    paintHeader();
    paintSaveState(`${icon('clock', 13)}<span>Unsaved changes</span>`, 'dirty');
    autosave();
  }

  const autosave = debounce(() => {
    if (!dirty || saving || destroyed) return;
    save({ silent: true });
  }, CONFIG.AUTOSAVE_DEBOUNCE_MS);

  async function save({ silent = false } = {}) {
    if (saving) return false;

    // A brand-new document needs a title before it can be stored at all.
    if (!documentId && !documentTitle(type, doc).replace('Untitled', '').trim()) {
      const problems = runValidation({ focusFirst: true });
      if (problems.some((problem) => problem.field === type.titleField)) {
        if (!silent) toast('Give the document a title before saving.', 'info');
        return false;
      }
    }

    saving = true;
    autosave.cancel();
    paintSaveState(`<span class="spinner"></span><span>Saving…</span>`);

    try {
      const result = await store.save(documentId, doc, version);
      documentId = result.id;
      version = result.version;
      status = result.status ?? status;
      updatedAt = result.updatedAt ?? new Date().toISOString();
      dirty = false;

      invalidateReferences(type.name);
      paintHeader();
      paintSaveState(`${icon('checkCircle', 13)}<span>Saved ${relativeTime(updatedAt)}</span>`, 'saved');
      if (!silent) toast('Draft saved.');
      onSaved?.({ id: documentId, type: type.name });
      if (store.supportsHistory) loadRevisions();
      return true;
    } catch (error) {
      paintSaveState(`${icon('alertCircle', 13)}<span>${esc(error.message)}</span>`, 'dirty');
      toast(error.message, 'error');
      return false;
    } finally {
      saving = false;
    }
  }

  async function publish() {
    const problems = runValidation({ focusFirst: true });
    if (problems.length) {
      toast(`${problems.length} field${problems.length === 1 ? '' : 's'} still need attention.`, 'error');
      return;
    }

    setBusy(publishButton, true, 'Publishing…');
    try {
      if (dirty || !documentId) {
        const saved = await save({ silent: true });
        if (!saved) return;
      }
      const result = await store.publish(documentId, version);
      version = result.version ?? version;
      status = 'published';
      publishedAt = result.publishedAt ?? new Date().toISOString();
      paintHeader();
      paintInspector();
      toast('Published.');
      onSaved?.({ id: documentId, type: type.name });
      if (store.supportsHistory) loadRevisions();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(publishButton, false);
      paintHeader();
    }
  }

  async function unpublish() {
    const confirmed = await confirmDialog({
      title: 'Unpublish this document?',
      body: 'It will disappear from the storefront immediately. The draft is kept.',
      confirmLabel: 'Unpublish',
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      const result = await store.unpublish(documentId);
      version = result.version ?? version;
      status = result.status ?? 'draft';
      publishedAt = null;
      paintHeader();
      paintInspector();
      toast('Unpublished.');
      onSaved?.({ id: documentId, type: type.name });
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function remove() {
    const confirmed = await confirmDialog({
      title: `Delete "${documentTitle(type, doc)}"?`,
      body: 'This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      await store.remove(documentId);
      invalidateReferences(type.name);
      toast('Deleted.');
      onDeleted?.({ id: documentId, type: type.name });
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function duplicate() {
    try {
      if (dirty) await save({ silent: true });
      const newId = await store.duplicate(documentId);
      invalidateReferences(type.name);
      toast('Duplicated.');
      onSaved?.({ id: newId, type: type.name, select: true });
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  /* ------------------------------------------------------------- Inspector */

  function paintInspector() {
    inspector.innerHTML = html`
      <div class="inspector__section">
        <h4>Status</h4>
        <dl class="kv kv--inline">
          <div><dt>State</dt><dd>${STATUS_LABEL[status] || status}</dd></div>
          <div><dt>Last saved</dt><dd>${updatedAt ? relativeTime(updatedAt) : '—'}</dd></div>
          <div><dt>Published</dt><dd>${publishedAt ? formatDate(publishedAt, 'datetime') : 'Never'}</dd></div>
          ${when(version != null, () => html`<div><dt>Version</dt><dd>${String(version)}</dd></div>`)}
        </dl>
        ${when(
          status === 'published' || status === 'changed',
          () => html`<button class="btn btn--sm btn--block mt-3" type="button" data-unpublish>Unpublish</button>`,
        )}
      </div>

      <div class="inspector__section">
        <h4>Validation</h4>
        <div data-validation></div>
      </div>

      ${when(
        store.supportsHistory,
        () => html`
          <div class="inspector__section">
            <h4>History</h4>
            <div data-revisions><p class="t-12 subtle">Loading…</p></div>
          </div>
        `,
      )}
    `;

    inspector.querySelector('[data-unpublish]')?.addEventListener('click', unpublish);
    paintRevisions();
  }

  function paintRevisions() {
    const box = inspector.querySelector('[data-revisions]');
    if (!box) return;
    if (!revisions.length) {
      box.innerHTML = html`<p class="t-12 subtle">No history yet.</p>`;
      return;
    }
    box.innerHTML = revisions
      .slice(0, 12)
      .map(
        (revision) => html`
          <button class="revision" type="button" data-revision="${revision.id}">
            <span class="pubdot pubdot--${revision.action === 'publish' ? 'published' : 'draft'}"></span>
            <span>
              <span class="revision__label">${revision.action}</span>
              <span class="revision__meta block">${revision.actor_email || 'system'}</span>
            </span>
            <span class="revision__time">${relativeTime(revision.created_at)}</span>
          </button>
        `,
      )
      .join('');
  }

  async function loadRevisions() {
    if (!store.supportsHistory || !documentId) return;
    try {
      revisions = await store.revisions(documentId);
      paintRevisions();
    } catch {
      revisions = [];
    }
  }

  async function restoreRevision(revisionId) {
    const confirmed = await confirmDialog({
      title: 'Restore this revision?',
      body: 'The current draft is replaced. The change is itself recorded in history, so it can be undone.',
      confirmLabel: 'Restore',
    });
    if (!confirmed) return;

    try {
      await store.restore(documentId, revisionId);
      await load();
      toast('Revision restored.');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  /* --------------------------------------------------------------- Loading */

  async function load() {
    try {
      if (documentId) {
        const loaded = await store.get(documentId);
        doc = { ...emptyDocument(type), ...loaded.doc };
        version = loaded.version;
        status = loaded.status;
        publishedAt = loaded.publishedAt;
        updatedAt = loaded.updatedAt;
      } else if (type.singleton) {
        const loaded = await store.getSingleton();
        documentId = loaded.id;
        doc = { ...emptyDocument(type), ...loaded.doc };
        version = loaded.version;
        status = loaded.status;
        publishedAt = loaded.publishedAt;
        updatedAt = loaded.updatedAt;
      } else {
        doc = emptyDocument(type);
      }
    } catch (error) {
      form.innerHTML = html`<div class="alert alert--danger">${raw(icon('alertCircle'))}<span>${error.message}</span></div>`;
      return;
    }

    if (destroyed) return;

    dirty = false;
    buildForm();
    paintHeader();
    paintInspector();
    runValidation();
    paintSaveState(
      documentId ? `${icon('check', 13)}<span>Saved ${relativeTime(updatedAt)}</span>` : '<span>New document</span>',
      documentId ? 'saved' : '',
    );

    if (store.supportsHistory && documentId) {
      loadRevisions();
      claimLock();
    }
    controls[0]?.focus?.();
  }

  async function claimLock() {
    if (!documentId) return;
    const lock = await store.claimLock(documentId);
    if (!lock.held_by_me) {
      pane.querySelector('.editor__head')?.after(
        el('div', {
          class: 'alert alert--warn',
          style: 'margin:12px 20px 0',
          html: `${icon('alert')}<span><strong>${esc(lock.holder_name || 'Someone else')}</strong> is editing this document. Saving will overwrite their changes.</span>`,
        }),
      );
    }
    clearInterval(lockTimer);
    lockTimer = setInterval(() => {
      if (!destroyed) store.claimLock(documentId);
    }, 90_000);
  }

  /* ---------------------------------------------------------------- Events */

  pane.querySelector('[data-save]').addEventListener('click', () => save());
  pane.querySelector('[data-publish]').addEventListener('click', publish);
  pane.querySelector('[data-menu-delete]').addEventListener('click', remove);
  pane.querySelector('[data-menu-duplicate]').addEventListener('click', duplicate);
  pane.querySelector('[data-back]').addEventListener('click', () => onBack?.());

  inspector.addEventListener('click', (event) => {
    const goto = event.target.closest('[data-goto]');
    if (goto) {
      const control = controls.find((c) => c.def.name === goto.dataset.goto);
      control?.focus?.();
      control?.root?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    const revision = event.target.closest('[data-revision]');
    if (revision) restoreRevision(revision.dataset.revision);
  });

  form.addEventListener('input', debounce(() => runValidation(), 400));

  const onKeyDown = (event) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    } else if (event.shiftKey && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      publish();
    }
  };

  const onBeforeUnload = (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  };

  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('beforeunload', onBeforeUnload);

  load();

  return {
    get dirty() {
      return dirty;
    },
    save,
    destroy() {
      destroyed = true;
      clearInterval(lockTimer);
      autosave.cancel();
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('beforeunload', onBeforeUnload);
      controls.forEach((control) => control.destroy?.());
      if (documentId && store.supportsHistory) store.releaseLock(documentId);
      pane.innerHTML = '';
    },
  };
}

/** Local helper mirroring dom.when so this module needs no extra import. */
function when(condition, render) {
  return condition ? raw(typeof render === 'function' ? render() : render) : '';
}
