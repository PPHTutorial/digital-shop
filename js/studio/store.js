/**
 * Studio data layer.
 *
 * The editor talks to a store, never to Supabase directly. Two adapters
 * implement the same interface:
 *
 *   DocumentStore — `cms_documents` plus the cms_* RPCs. Draft/published
 *                   split, optimistic locking, revision history.
 *   TableStore    — an ordinary table. There is no draft copy, so "publish"
 *                   flips a boolean column and history is not available.
 *
 * Every method resolves to plain data or throws an Error whose message is
 * safe to show the editor.
 */

import { supabase, unwrap, describeError } from '../client.js';
import { documentTitle, documentSubtitle, documentMedia, emptyDocument } from './schema.js';

/* ==========================================================================
   Shared shaping
   ========================================================================== */

function summarise(type, doc, meta) {
  return {
    id: meta.id,
    title: documentTitle(type, doc),
    subtitle: documentSubtitle(type, doc),
    media: documentMedia(type, doc),
    status: meta.status,
    updatedAt: meta.updatedAt,
    ordering: meta.ordering ?? 0,
  };
}

/* ==========================================================================
   Document store — cms_documents
   ========================================================================== */

class DocumentStore {
  constructor(type) {
    this.type = type;
    this.supportsHistory = true;
    this.supportsDraft = true;
  }

  async list({ search = '', filter = null, ordering = null, limit = 100, offset = 0 } = {}) {
    let query = supabase
      .from('cms_documents')
      .select('id,title,slug,draft,status,ordering,updated_at,published_at', { count: 'exact' })
      .eq('type', this.type.name);

    if (search.trim()) query = query.ilike('search_text', `%${search.trim().toLowerCase()}%`);
    if (filter?.status) query = query.eq('status', filter.status);

    const column = ordering?.column && ordering.column !== 'ordering' ? ordering.column : 'updated_at';
    const ascending = ordering?.ascending ?? false;
    query = query.order(column === 'updated_at' ? 'updated_at' : column, { ascending }).range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) throw new Error(describeError(error));

    return {
      total: count ?? data.length,
      items: (data || []).map((row) =>
        summarise(this.type, { ...row.draft, title: row.title, slug: row.slug }, {
          id: row.id,
          status: row.status,
          updatedAt: row.updated_at,
          ordering: row.ordering,
        }),
      ),
    };
  }

  async get(id) {
    const row = await unwrap(supabase.from('cms_documents').select('*').eq('id', id).single());
    return {
      id: row.id,
      doc: { ...row.draft, title: row.title, slug: row.slug },
      version: row.version,
      status: row.status,
      publishedAt: row.published_at,
      updatedAt: row.updated_at,
      published: row.published,
    };
  }

  /** Loads the singleton for this type, creating it on first open. */
  async getSingleton() {
    const { data } = await supabase
      .from('cms_documents')
      .select('id')
      .eq('type', this.type.name)
      .order('created_at')
      .limit(1)
      .maybeSingle();

    if (data?.id) return this.get(data.id);

    const created = await this.save(null, { ...emptyDocument(this.type), title: this.type.title });
    return this.get(created.id);
  }

  async save(id, doc, version = null) {
    const { title, slug, ...rest } = doc;
    const payload = await unwrap(
      supabase.rpc('cms_save', {
        p_id: id,
        p_type: this.type.name,
        p_draft: rest,
        p_title: title ?? doc[this.type.titleField] ?? null,
        p_slug: slug ?? null,
        p_expected_version: version,
      }),
    );
    return { id: payload.id, version: payload.version, status: payload.status, updatedAt: payload.updated_at };
  }

  async publish(id, version = null) {
    const payload = await unwrap(supabase.rpc('cms_publish', { p_id: id, p_expected_version: version }));
    return { id: payload.id, version: payload.version, status: payload.status, publishedAt: payload.published_at };
  }

  async unpublish(id) {
    const payload = await unwrap(supabase.rpc('cms_unpublish', { p_id: id }));
    return { id: payload.id, version: payload.version, status: payload.status };
  }

  async remove(id) {
    await unwrap(supabase.rpc('cms_delete', { p_id: id }));
  }

  async duplicate(id) {
    const payload = await unwrap(supabase.rpc('cms_duplicate', { p_id: id }));
    return payload.id;
  }

  async reorder(ids) {
    await unwrap(supabase.rpc('cms_reorder', { p_ids: ids }));
  }

  async revisions(id) {
    const rows = await unwrap(
      supabase
        .from('cms_revisions')
        .select('id,version,action,title,actor_email,created_at')
        .eq('document_id', id)
        .order('created_at', { ascending: false })
        .limit(50),
    );
    return rows || [];
  }

  async revision(id, revisionId) {
    return unwrap(
      supabase.from('cms_revisions').select('*').eq('id', revisionId).eq('document_id', id).single(),
    );
  }

  async restore(id, revisionId) {
    const payload = await unwrap(supabase.rpc('cms_restore', { p_id: id, p_revision_id: revisionId }));
    return { id: payload.id, version: payload.version };
  }

  async claimLock(id) {
    try {
      return await unwrap(supabase.rpc('cms_claim_lock', { p_id: id }));
    } catch {
      return { held_by_me: true }; // a lock failure must never block editing
    }
  }

  async releaseLock(id) {
    try {
      await supabase.rpc('cms_release_lock', { p_id: id });
    } catch {
      /* best effort */
    }
  }
}

/* ==========================================================================
   Table store — products, categories, promo_codes
   ========================================================================== */

class TableStore {
  constructor(type) {
    this.type = type;
    this.table = type.store.slice('table:'.length);
    this.supportsHistory = false;
    this.supportsDraft = false;
    this.publishField = type.publishField;
  }

  /** Only columns the schema declares are written back to the table. */
  #columns() {
    return this.type.fields.map((f) => f.name);
  }

  #statusOf(row) {
    if (!this.publishField) return 'published';
    return row[this.publishField] ? 'published' : 'draft';
  }

  async list({ search = '', filter = null, ordering = null, limit = 100, offset = 0 } = {}) {
    let query = supabase.from(this.table).select('*', { count: 'exact' });

    if (search.trim()) {
      const term = `%${search.trim()}%`;
      const titleColumn = this.type.titleField;
      const extra = this.type.slugField ? `,${this.type.slugField}.ilike.${term}` : '';
      query = query.or(`${titleColumn}.ilike.${term}${extra}`);
    }

    if (filter?.column) query = query.eq(filter.column, filter.value);

    const column = ordering?.column || 'created_at';
    query = query.order(column, { ascending: ordering?.ascending ?? false }).range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) throw new Error(describeError(error));

    return {
      total: count ?? data.length,
      items: (data || []).map((row) =>
        summarise(this.type, row, {
          id: row.id,
          status: this.#statusOf(row),
          updatedAt: row.updated_at || row.created_at,
          ordering: row[this.type.orderField] ?? 0,
        }),
      ),
    };
  }

  async get(id) {
    const row = await unwrap(supabase.from(this.table).select('*').eq('id', id).single());
    return {
      id: row.id,
      doc: row,
      version: null,
      status: this.#statusOf(row),
      publishedAt: row.published_at ?? null,
      updatedAt: row.updated_at || row.created_at,
      published: this.#statusOf(row) === 'published' ? row : null,
    };
  }

  #payload(doc) {
    const allowed = new Set(this.#columns());
    const payload = {};
    for (const [key, value] of Object.entries(doc)) {
      if (!allowed.has(key)) continue;
      const fieldDef = this.type.fieldsByName.get(key);
      if (fieldDef?.readOnly) continue;
      payload[key] = value === '' ? null : value;
    }
    // The publish flag is owned by the publish action, not the form.
    if (this.publishField) delete payload[this.publishField];
    return payload;
  }

  async save(id, doc) {
    const payload = this.#payload(doc);

    if (!id) {
      if (this.publishField) payload[this.publishField] = false;
      const row = await unwrap(supabase.from(this.table).insert(payload).select('id').single());
      await this.#audit('create', row.id, doc);
      return { id: row.id, version: null, status: 'draft', updatedAt: new Date().toISOString() };
    }

    const row = await unwrap(supabase.from(this.table).update(payload).eq('id', id).select('*').single());
    await this.#audit('update', id, doc);
    return { id: row.id, version: null, status: this.#statusOf(row), updatedAt: row.updated_at };
  }

  async publish(id) {
    if (!this.publishField) return { id, status: 'published' };
    const patch = { [this.publishField]: true };
    if (this.type.name === 'product') patch.published_at = new Date().toISOString();
    const row = await unwrap(supabase.from(this.table).update(patch).eq('id', id).select('*').single());
    await this.#audit('publish', id, row);
    return { id: row.id, version: null, status: 'published', publishedAt: row.published_at ?? null };
  }

  async unpublish(id) {
    if (!this.publishField) return { id, status: 'published' };
    const row = await unwrap(
      supabase.from(this.table).update({ [this.publishField]: false }).eq('id', id).select('*').single(),
    );
    await this.#audit('unpublish', id, row);
    return { id: row.id, version: null, status: 'draft' };
  }

  async remove(id) {
    await unwrap(supabase.from(this.table).delete().eq('id', id));
    await this.#audit('delete', id, {});
  }

  async duplicate(id) {
    const { doc } = await this.get(id);
    const copy = this.#payload(doc);
    copy[this.type.titleField] = `${doc[this.type.titleField]} (copy)`;
    if (this.type.slugField) copy[this.type.slugField] = `${doc[this.type.slugField]}-copy`.slice(0, 96);
    if (this.publishField) copy[this.publishField] = false;
    const row = await unwrap(supabase.from(this.table).insert(copy).select('id').single());
    return row.id;
  }

  async reorder(ids) {
    if (!this.type.orderField) return;
    await Promise.all(
      ids.map((id, index) =>
        supabase.from(this.table).update({ [this.type.orderField]: index }).eq('id', id),
      ),
    );
  }

  async revisions() {
    return [];
  }

  async restore() {
    throw new Error('Revision history is not available for this document type.');
  }

  async claimLock() {
    return { held_by_me: true };
  }

  async releaseLock() {}

  /** Table edits are not in cms_revisions, so they go to the audit log. */
  async #audit(action, id, doc) {
    try {
      await supabase.rpc('record_audit', {
        p_action: `${this.type.name}.${action}`,
        p_entity_type: this.type.name,
        p_entity_id: String(id),
        p_summary: `${action} ${this.type.title.toLowerCase()} "${doc?.[this.type.titleField] ?? id}"`,
      });
    } catch {
      /* auditing must never block the edit */
    }
  }
}

/* ==========================================================================
   Factory
   ========================================================================== */

const cache = new Map();

export function storeFor(type) {
  if (!cache.has(type.name)) {
    cache.set(type.name, type.store.startsWith('table:') ? new TableStore(type) : new DocumentStore(type));
  }
  return cache.get(type.name);
}

/**
 * Options for a reference field: id/label pairs from the referenced type.
 * Cached per type for the session — reference lists change rarely.
 */
const referenceCache = new Map();

export async function referenceOptions(targetType, { force = false } = {}) {
  if (!force && referenceCache.has(targetType.name)) return referenceCache.get(targetType.name);

  const store = storeFor(targetType);
  const { items } = await store.list({ limit: 200, ordering: { column: targetType.titleField, ascending: true } });
  const options = items.map((item) => ({ id: item.id, label: item.title, media: item.media }));
  referenceCache.set(targetType.name, options);
  return options;
}

export function invalidateReferences(typeName) {
  if (typeName) referenceCache.delete(typeName);
  else referenceCache.clear();
}

/** Counts per type, for the badge in the structure pane. */
export async function documentCounts() {
  const counts = new Map();

  const { data } = await supabase.from('cms_documents').select('type');
  for (const row of data || []) counts.set(row.type, (counts.get(row.type) || 0) + 1);

  const tables = [
    ['product', 'products'],
    ['category', 'categories'],
    ['promotion', 'promo_codes'],
  ];

  await Promise.all(
    tables.map(async ([name, table]) => {
      const { count } = await supabase.from(table).select('id', { count: 'exact', head: true });
      counts.set(name, count ?? 0);
    }),
  );

  return counts;
}
