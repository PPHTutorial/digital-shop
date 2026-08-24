/**
 * Field kit.
 *
 * Turns one schema field declaration into a live control. Every renderer has
 * the same contract:
 *
 *   render(fieldDef, value, context) -> { element, setValue, focus, destroy? }
 *
 * `context.onChange(nextValue)` is called on every meaningful edit; the editor
 * decides when to persist.
 */

import { icon } from '../icons.js';
import { esc, html, raw, el, debounce } from '../dom.js';
import { slugify, formatBytes } from '../format.js';
import { CONFIG } from '../config.js';
import { optionValues, optionLabel, validateField, blocksLength } from './validate.js';
import { createBlockEditor } from './blocks.js';
import { openAssetPicker, uploadProtectedFile } from './assets.js';
import { referenceOptions } from './store.js';
import { getType, hasType } from './schema.js';
import { toast } from '../ui.js';

/* ==========================================================================
   Shared chrome
   ========================================================================== */

function wrapper(fieldDef, controlNode, { counterFor } = {}) {
  const root = el('div', { class: 'f', dataset: { field: fieldDef.name } });

  const head = el('div', { class: 'f__head' });
  head.append(
    el('label', {
      class: 'f__label',
      for: `f-${fieldDef.name}`,
      html: `${esc(fieldDef.title)}${fieldDef.required ? '<span class="req"> *</span>' : ''}`,
    }),
  );

  let counter = null;
  if (fieldDef.max && counterFor) {
    counter = el('span', { class: 'f__counter' });
    head.append(counter);
  }
  root.append(head);

  if (fieldDef.description) {
    root.append(el('p', { class: 'f__desc', text: fieldDef.description }));
  }

  root.append(controlNode);

  const error = el('p', { class: 'field__error', hidden: true });
  root.append(error);

  return {
    root,
    setError(message) {
      if (message) {
        error.hidden = false;
        error.innerHTML = `${icon('alertCircle', 13)}<span>${esc(message)}</span>`;
        root.classList.add('f--invalid');
      } else {
        error.hidden = true;
        error.textContent = '';
        root.classList.remove('f--invalid');
      }
    },
    setCount(length) {
      if (!counter) return;
      counter.textContent = `${length} / ${fieldDef.max}`;
      counter.classList.toggle('is-over', length > fieldDef.max);
    },
  };
}

/* ==========================================================================
   Renderers
   ========================================================================== */

const renderers = {
  /* --- Text ------------------------------------------------------------- */
  string(fieldDef, value, { onChange }) {
    const input = el('input', {
      class: `input${fieldDef.mono ? ' input--mono' : ''}`,
      id: `f-${fieldDef.name}`,
      type: fieldDef.inputType || 'text',
      value: value ?? '',
      placeholder: fieldDef.placeholder || '',
      maxlength: fieldDef.max || null,
      readonly: fieldDef.readOnly || null,
    });

    const chrome = wrapper(fieldDef, input, { counterFor: true });
    chrome.setCount(String(value ?? '').length);

    input.addEventListener('input', () => {
      if (fieldDef.uppercase) input.value = input.value.toUpperCase();
      chrome.setCount(input.value.length);
      onChange(input.value);
    });

    return { ...chrome, setValue: (next) => { input.value = next ?? ''; chrome.setCount(input.value.length); }, focus: () => input.focus() };
  },

  text(fieldDef, value, { onChange }) {
    const input = el('textarea', {
      class: 'textarea',
      id: `f-${fieldDef.name}`,
      rows: fieldDef.rows || 4,
      placeholder: fieldDef.placeholder || '',
      readonly: fieldDef.readOnly || null,
    });
    input.value = value ?? '';

    const chrome = wrapper(fieldDef, input, { counterFor: true });
    chrome.setCount(String(value ?? '').length);

    input.addEventListener('input', () => {
      chrome.setCount(input.value.length);
      onChange(input.value);
    });

    return { ...chrome, setValue: (next) => { input.value = next ?? ''; chrome.setCount(input.value.length); }, focus: () => input.focus() };
  },

  url(fieldDef, value, context) {
    return renderers.string({ ...fieldDef, inputType: 'url', placeholder: fieldDef.placeholder || 'https://' }, value, context);
  },

  email(fieldDef, value, context) {
    return renderers.string({ ...fieldDef, inputType: 'email' }, value, context);
  },

  /* --- Slug -------------------------------------------------------------- */
  slug(fieldDef, value, { onChange, getDoc }) {
    const control = el('div', { class: 'slugfield' });
    const input = el('input', {
      class: 'input',
      id: `f-${fieldDef.name}`,
      type: 'text',
      value: value ?? '',
      spellcheck: 'false',
      autocapitalize: 'off',
    });
    const generate = el('button', { class: 'btn', type: 'button', title: 'Generate from the title' }, 'Generate');

    if (fieldDef.prefix) control.append(el('span', { class: 'slugfield__prefix', text: fieldDef.prefix }));
    control.append(input, generate);

    const chrome = wrapper(fieldDef, control);

    input.addEventListener('input', () => onChange(input.value));
    input.addEventListener('blur', () => {
      const cleaned = slugify(input.value);
      if (cleaned !== input.value) {
        input.value = cleaned;
        onChange(cleaned);
      }
    });

    generate.addEventListener('click', () => {
      const source = fieldDef.source ? getDoc()?.[fieldDef.source] : '';
      const next = slugify(source || '');
      if (!next) {
        toast('Fill in the title first.', 'info');
        return;
      }
      input.value = next;
      onChange(next);
    });

    return { ...chrome, setValue: (next) => { input.value = next ?? ''; }, focus: () => input.focus() };
  },

  /* --- Number ------------------------------------------------------------ */
  number(fieldDef, value, { onChange }) {
    const control = fieldDef.prefix ? el('span', { class: 'input-affix input-affix--text' }) : el('div');
    const input = el('input', {
      class: 'input',
      id: `f-${fieldDef.name}`,
      type: 'number',
      value: value ?? '',
      step: fieldDef.step ?? 'any',
      min: fieldDef.min ?? null,
      max: fieldDef.max ?? null,
      readonly: fieldDef.readOnly || null,
    });

    if (fieldDef.prefix) control.append(el('span', { class: 'input-affix__text', text: fieldDef.prefix }));
    control.append(input);

    const chrome = wrapper(fieldDef, control);

    input.addEventListener('input', () => {
      onChange(input.value === '' ? null : Number(input.value));
    });

    return { ...chrome, setValue: (next) => { input.value = next ?? ''; }, focus: () => input.focus() };
  },

  /* --- Boolean ----------------------------------------------------------- */
  boolean(fieldDef, value, { onChange }) {
    const control = el('label', { class: 'switch' });
    const input = el('input', { type: 'checkbox', id: `f-${fieldDef.name}`, disabled: fieldDef.readOnly || null });
    input.checked = Boolean(value);
    control.append(input, el('span', { class: 'switch__track' }), el('span', { text: fieldDef.title }));

    // The switch carries its own label, so the standard head is suppressed.
    const root = el('div', { class: 'f', dataset: { field: fieldDef.name } });
    root.append(control);
    if (fieldDef.description) root.append(el('p', { class: 'f__desc', text: fieldDef.description }));

    input.addEventListener('change', () => onChange(input.checked));

    return {
      root,
      setError() {},
      setCount() {},
      setValue: (next) => { input.checked = Boolean(next); },
      focus: () => input.focus(),
    };
  },

  /* --- Choice ------------------------------------------------------------ */
  select(fieldDef, value, { onChange }) {
    const select = el('select', { class: 'select', id: `f-${fieldDef.name}`, disabled: fieldDef.readOnly || null });
    if (!fieldDef.required) select.append(el('option', { value: '' }, '—'));
    for (const option of fieldDef.options || []) {
      const optionValue = typeof option === 'string' ? option : option.value;
      const label = typeof option === 'string' ? option : option.label;
      select.append(el('option', { value: optionValue, selected: optionValue === value || null }, label));
    }
    select.value = value ?? '';

    const chrome = wrapper(fieldDef, select);
    select.addEventListener('change', () => onChange(select.value || null));

    return { ...chrome, setValue: (next) => { select.value = next ?? ''; }, focus: () => select.focus() };
  },

  multiselect(fieldDef, value, { onChange }) {
    const chosen = Array.isArray(value) ? [...value] : [];
    const control = el('div', { class: 'row row--wrap row-2' });

    const paint = () => {
      control.innerHTML = '';
      for (const option of fieldDef.options || []) {
        const optionValue = typeof option === 'string' ? option : option.value;
        const label = typeof option === 'string' ? option : option.label;
        const index = chosen.indexOf(optionValue);
        const button = el(
          'button',
          {
            class: 'chip',
            type: 'button',
            'aria-pressed': String(index !== -1),
            onclick: () => {
              if (index === -1) chosen.push(optionValue);
              else chosen.splice(index, 1);
              paint();
              onChange([...chosen]);
            },
          },
          label,
        );
        control.append(button);
      }
    };

    paint();
    const chrome = wrapper(fieldDef, control);
    return {
      ...chrome,
      setValue: (next) => {
        chosen.length = 0;
        chosen.push(...(Array.isArray(next) ? next : []));
        paint();
      },
      focus: () => control.querySelector('button')?.focus(),
    };
  },

  tags(fieldDef, value, { onChange }) {
    const tags = Array.isArray(value) ? [...value] : [];
    const control = el('div', { class: 'taginput' });
    const input = el('input', { id: `f-${fieldDef.name}`, type: 'text', placeholder: 'Add a tag and press Enter' });

    const paint = () => {
      control.querySelectorAll('.taginput__tag').forEach((node) => node.remove());
      for (const [index, tag] of tags.entries()) {
        const chip = el('span', { class: 'taginput__tag' });
        chip.append(
          document.createTextNode(tag),
          el('button', {
            type: 'button',
            'aria-label': `Remove ${tag}`,
            html: icon('x', 11),
            onclick: () => {
              tags.splice(index, 1);
              paint();
              onChange([...tags]);
            },
          }),
        );
        control.insertBefore(chip, input);
      }
    };

    const commit = () => {
      const raw = input.value.trim().replace(/,$/, '');
      if (!raw) return;
      if (fieldDef.max && tags.length >= fieldDef.max) {
        toast(`At most ${fieldDef.max} tags.`, 'info');
        return;
      }
      if (!tags.includes(raw)) {
        tags.push(raw);
        paint();
        onChange([...tags]);
      }
      input.value = '';
    };

    control.append(input);
    paint();

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Backspace' && !input.value && tags.length) {
        tags.pop();
        paint();
        onChange([...tags]);
      }
    });
    input.addEventListener('blur', commit);

    const chrome = wrapper(fieldDef, control);
    return {
      ...chrome,
      setValue: (next) => {
        tags.length = 0;
        tags.push(...(Array.isArray(next) ? next : []));
        paint();
      },
      focus: () => input.focus(),
    };
  },

  /* --- Dates ------------------------------------------------------------- */
  date(fieldDef, value, { onChange }) {
    return dateControl(fieldDef, value, onChange, 'date');
  },

  datetime(fieldDef, value, { onChange }) {
    return dateControl(fieldDef, value, onChange, 'datetime-local');
  },

  /* --- Media ------------------------------------------------------------- */
  image(fieldDef, value, { onChange }) {
    const control = el('div', { class: 'imagefield' });
    const preview = el('div', { class: 'imagefield__preview' });
    const actions = el('div', { class: 'row row-2' });

    const currentUrl = () => (typeof value === 'string' ? value : value?.url || '');
    let url = currentUrl();

    const paint = () => {
      preview.innerHTML = url
        ? `<img src="${esc(url)}" alt="" />`
        : `<span class="empty">${icon('image')}<span class="empty__body">No image selected</span></span>`;
      removeButton.hidden = !url;
    };

    const chooseButton = el(
      'button',
      {
        class: 'btn btn--sm',
        type: 'button',
        onclick: async () => {
          const picked = await openAssetPicker({ aspect: fieldDef.aspect ?? 3 / 2 });
          if (!picked) return;
          url = picked.url;
          paint();
          onChange(url);
        },
      },
      'Choose image',
    );

    const removeButton = el(
      'button',
      {
        class: 'btn btn--sm btn--ghost',
        type: 'button',
        hidden: true,
        onclick: () => {
          url = '';
          paint();
          onChange(null);
        },
      },
      'Remove',
    );

    actions.append(chooseButton, removeButton);
    control.append(preview, actions);
    paint();

    const chrome = wrapper(fieldDef, control);
    return {
      ...chrome,
      setValue: (next) => {
        url = typeof next === 'string' ? next : next?.url || '';
        paint();
      },
      focus: () => chooseButton.focus(),
    };
  },

  gallery(fieldDef, value, { onChange }) {
    const urls = Array.isArray(value) ? [...value] : [];
    const control = el('div', { class: 'stack-3' });
    const grid = el('div', { class: 'assets' });

    const paint = () => {
      grid.innerHTML = '';
      urls.forEach((url, index) => {
        const cell = el('div', { class: 'asset' });
        cell.innerHTML = `<span class="asset__media"><img src="${esc(url)}" alt="" loading="lazy"></span>`;
        const bar = el('div', { class: 'asset__meta row row--between row-1' });
        bar.append(
          el('span', { class: 'asset__size', text: `#${index + 1}` }),
          el('button', {
            class: 'btn btn--xs btn--ghost',
            type: 'button',
            'aria-label': 'Remove image',
            html: icon('trash', 12),
            onclick: () => {
              urls.splice(index, 1);
              paint();
              onChange([...urls]);
            },
          }),
        );
        cell.append(bar);
        grid.append(cell);
      });
      addButton.disabled = Boolean(fieldDef.max && urls.length >= fieldDef.max);
    };

    const addButton = el(
      'button',
      {
        class: 'btn btn--sm',
        type: 'button',
        onclick: async () => {
          const picked = await openAssetPicker({ aspect: fieldDef.aspect ?? 3 / 2, title: 'Add to gallery' });
          if (!picked) return;
          urls.push(picked.url);
          paint();
          onChange([...urls]);
        },
      },
      'Add image',
    );

    control.append(grid, addButton);
    paint();

    const chrome = wrapper(fieldDef, control);
    return {
      ...chrome,
      setValue: (next) => {
        urls.length = 0;
        urls.push(...(Array.isArray(next) ? next : []));
        paint();
      },
      focus: () => addButton.focus(),
    };
  },

  file(fieldDef, value, { onChange, onMeta }) {
    const control = el('div', { class: 'stack-3' });
    const state = el('div', { class: 'refchip' });
    const input = el('input', { type: 'file', hidden: true });

    let path = value ?? '';

    const paint = (message) => {
      state.innerHTML = '';
      state.append(
        el('span', { class: 'none', html: icon(path ? 'file' : 'cloud') }),
        el('span', { class: 'refchip__title mono', text: message || path || 'No file attached' }),
      );
      if (path) {
        state.append(
          el('button', {
            class: 'btn btn--xs btn--ghost',
            type: 'button',
            html: icon('trash', 12),
            'aria-label': 'Detach file',
            onclick: () => {
              path = '';
              paint();
              onChange(null);
            },
          }),
        );
      }
    };

    const pickButton = el(
      'button',
      { class: 'btn btn--sm', type: 'button', onclick: () => input.click() },
      path ? 'Replace file' : 'Upload file',
    );

    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      paint(`Uploading ${file.name}…`);
      pickButton.disabled = true;
      try {
        const uploaded = await uploadProtectedFile(file);
        path = uploaded.path;
        onChange(path);
        onMeta?.({
          file_type: (file.name.split('.').pop() || '').toUpperCase(),
          file_size_bytes: file.size,
        });
        paint();
        toast(`${file.name} uploaded (${formatBytes(file.size)}).`);
      } catch (error) {
        paint();
        toast(error.message, 'error');
      } finally {
        pickButton.disabled = false;
        input.value = '';
      }
    });

    control.append(state, el('div', { class: 'row row-2' }, pickButton), input);
    paint();

    const chrome = wrapper(fieldDef, control);
    return { ...chrome, setValue: (next) => { path = next ?? ''; paint(); }, focus: () => pickButton.focus() };
  },

  /* --- Reference ---------------------------------------------------------- */
  reference(fieldDef, value, { onChange }) {
    const control = el('div', { class: 'reffield' });
    const select = el('select', { class: 'select', id: `f-${fieldDef.name}` });
    select.append(el('option', { value: '' }, 'Loading…'));
    control.append(select);

    const chrome = wrapper(fieldDef, control);

    const load = async () => {
      if (!hasType(fieldDef.to)) {
        select.innerHTML = '';
        select.append(el('option', { value: '' }, `Unknown type "${fieldDef.to}"`));
        return;
      }
      try {
        const targetType = getType(fieldDef.to);
        const options = await referenceOptions(targetType);
        select.innerHTML = '';
        if (!fieldDef.required) select.append(el('option', { value: '' }, '—'));
        for (const option of options) {
          // `valueField` stores a human key (e.g. category name) instead of an id.
          const optionValue = fieldDef.valueField ? option.label : option.id;
          select.append(el('option', { value: optionValue }, option.label));
        }
        select.value = value ?? '';
      } catch (error) {
        select.innerHTML = '';
        select.append(el('option', { value: '' }, error.message));
      }
    };

    select.addEventListener('change', () => onChange(select.value || null));
    load();

    return { ...chrome, setValue: (next) => { select.value = next ?? ''; }, focus: () => select.focus() };
  },

  /* --- Rich text ---------------------------------------------------------- */
  blocks(fieldDef, value, { onChange }) {
    const editor = createBlockEditor({
      value: Array.isArray(value) ? value : [],
      placeholder: fieldDef.placeholder || 'Start writing…',
      pickImage: () => openAssetPicker({ title: 'Insert an image' }),
      onChange: (blocks) => {
        chrome.setCount(blocksLength(blocks));
        onChange(blocks);
      },
    });

    const chrome = wrapper(fieldDef, editor.element, { counterFor: true });
    chrome.setCount(blocksLength(value));

    return {
      ...chrome,
      setValue: (next) => editor.setValue(next),
      focus: () => editor.focus(),
      destroy: () => editor.destroy(),
    };
  },

  /* --- Composites ---------------------------------------------------------- */
  object(fieldDef, value, context) {
    const current = value && typeof value === 'object' ? { ...value } : {};
    const box = el('div', { class: 'fieldset' });
    const body = el('div', { class: 'fieldset__body' });
    const children = [];

    for (const childDef of fieldDef.fields || []) {
      const child = renderField(childDef, current[childDef.name], {
        ...context,
        onChange: (next) => {
          current[childDef.name] = next;
          context.onChange({ ...current });
        },
      });
      children.push({ def: childDef, control: child });
      body.append(child.root);
    }

    if (fieldDef.collapsible) {
      const details = el('details', { class: 'fieldset', open: fieldDef.collapsed ? null : true });
      details.append(el('summary', { class: 'f__label', style: 'padding:12px 16px;cursor:pointer', text: fieldDef.title }));
      details.append(body);
      return {
        root: details,
        setError() {},
        setCount() {},
        setValue: (next) => children.forEach(({ def, control }) => control.setValue?.(next?.[def.name])),
      };
    }

    box.append(el('legend', { text: fieldDef.title }), body);
    return {
      root: box,
      setError() {},
      setCount() {},
      setValue: (next) => children.forEach(({ def, control }) => control.setValue?.(next?.[def.name])),
    };
  },

  array(fieldDef, value, context) {
    const items = Array.isArray(value) ? structuredClone(value) : [];
    const control = el('div', { class: 'arrayfield' });
    const list = el('div', { class: 'arrayfield__items' });
    const foot = el('div', { class: 'arrayfield__foot' });

    const labelFor = (entry, index) => {
      const key = fieldDef.of?.labelField;
      const label = key ? entry?.[key] : null;
      return label || `${fieldDef.of?.title || 'Item'} ${index + 1}`;
    };

    const editItem = (index) => {
      openObjectDialog(fieldDef.of, items[index], (next) => {
        items[index] = next;
        paint();
        context.onChange(structuredClone(items));
      });
    };

    const paint = () => {
      list.innerHTML = '';
      if (!items.length) {
        list.append(el('p', { class: 'arrayfield__empty', text: 'Nothing added yet.' }));
      }

      items.forEach((entry, index) => {
        const row = el('div', { class: 'arrayitem', draggable: 'true', dataset: { index: String(index) } });
        row.append(
          el('span', { class: 'arrayitem__grip', html: icon('grip'), title: 'Drag to reorder' }),
          el('button', {
            class: 'arrayitem__label fill',
            type: 'button',
            style: 'text-align:left',
            text: labelFor(entry, index),
            onclick: () => editItem(index),
          }),
          el('span', { class: 'row row-1' },
            el('button', {
              class: 'btn btn--xs btn--ghost',
              type: 'button',
              html: icon('edit', 12),
              'aria-label': 'Edit',
              onclick: () => editItem(index),
            }),
            el('button', {
              class: 'btn btn--xs btn--ghost',
              type: 'button',
              html: icon('trash', 12),
              'aria-label': 'Remove',
              onclick: () => {
                items.splice(index, 1);
                paint();
                context.onChange(structuredClone(items));
              },
            }),
          ),
        );
        list.append(row);
      });

      addButton.disabled = Boolean(fieldDef.max && items.length >= fieldDef.max);
    };

    const addButton = el(
      'button',
      {
        class: 'btn btn--sm',
        type: 'button',
        onclick: () =>
          openObjectDialog(fieldDef.of, {}, (next) => {
            items.push(next);
            paint();
            context.onChange(structuredClone(items));
          }),
      },
      `Add ${fieldDef.of?.title?.toLowerCase() || 'item'}`,
    );

    foot.append(addButton);
    control.append(list, foot);
    paint();

    // Drag to reorder.
    let dragIndex = null;
    list.addEventListener('dragstart', (event) => {
      const row = event.target.closest('.arrayitem');
      if (!row) return;
      dragIndex = Number(row.dataset.index);
      row.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      const row = event.target.closest('.arrayitem');
      list.querySelectorAll('.is-drop-target').forEach((n) => n.classList.remove('is-drop-target'));
      row?.classList.add('is-drop-target');
    });
    list.addEventListener('drop', (event) => {
      event.preventDefault();
      const row = event.target.closest('.arrayitem');
      if (row && dragIndex != null) {
        const target = Number(row.dataset.index);
        const [moved] = items.splice(dragIndex, 1);
        items.splice(target, 0, moved);
        context.onChange(structuredClone(items));
      }
      dragIndex = null;
      paint();
    });
    list.addEventListener('dragend', () => {
      dragIndex = null;
      paint();
    });

    const chrome = wrapper(fieldDef, control);
    return {
      ...chrome,
      setValue: (next) => {
        items.length = 0;
        items.push(...(Array.isArray(next) ? structuredClone(next) : []));
        paint();
      },
      focus: () => addButton.focus(),
    };
  },
};

function dateControl(fieldDef, value, onChange, inputType) {
  const input = el('input', {
    class: 'input',
    id: `f-${fieldDef.name}`,
    type: inputType,
    readonly: fieldDef.readOnly || null,
  });

  const toInput = (raw) => {
    if (!raw) return '';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return '';
    return inputType === 'date' ? date.toISOString().slice(0, 10) : date.toISOString().slice(0, 16);
  };

  input.value = toInput(value);

  const chrome = wrapper(fieldDef, input);
  input.addEventListener('change', () => {
    if (!input.value) {
      onChange(null);
      return;
    }
    const date = new Date(input.value);
    onChange(Number.isNaN(date.getTime()) ? null : date.toISOString());
  });

  return { ...chrome, setValue: (next) => { input.value = toInput(next); }, focus: () => input.focus() };
}

/* ==========================================================================
   Nested object dialog — used by array fields
   ========================================================================== */

function openObjectDialog(objectDef, initial, onDone) {
  const draft = structuredClone(initial || {});
  const dialog = el('dialog', { class: 'dialog dialog--narrow' });

  const body = el('div', { class: 'dialog__body stack-5' });
  const controls = [];

  for (const childDef of objectDef?.fields || []) {
    const control = renderField(childDef, draft[childDef.name], {
      getDoc: () => draft,
      onChange: (next) => {
        draft[childDef.name] = next;
      },
    });
    controls.push({ def: childDef, control });
    body.append(control.root);
  }

  const save = el('button', { class: 'btn btn--primary', type: 'button' }, 'Done');
  const cancel = el('button', { class: 'btn', type: 'button' }, 'Cancel');

  dialog.append(
    el('div', { class: 'dialog__head' }, el('h2', { class: 'dialog__title', text: objectDef?.title || 'Item' })),
    body,
    el('div', { class: 'dialog__foot' }, cancel, save),
  );

  const close = () => {
    dialog.close();
    dialog.remove();
  };

  cancel.addEventListener('click', close);
  save.addEventListener('click', () => {
    let firstError = null;
    for (const { def, control } of controls) {
      const message = validateField(def, draft[def.name], draft);
      control.setError?.(message);
      if (message && !firstError) firstError = control;
    }
    if (firstError) {
      firstError.focus?.();
      return;
    }
    onDone(draft);
    close();
  });

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });

  document.body.append(dialog);
  dialog.showModal();
  controls[0]?.control.focus?.();
}

/* ==========================================================================
   Entry point
   ========================================================================== */

/**
 * Renders one field.
 *
 * @param {object} fieldDef schema field
 * @param {*} value current value
 * @param {object} context { onChange, getDoc, onMeta }
 */
export function renderField(fieldDef, value, context) {
  const renderer = renderers[fieldDef.type] || renderers.string;
  const control = renderer(fieldDef, value, {
    getDoc: () => ({}),
    onChange: () => {},
    ...context,
  });
  control.def = fieldDef;
  return control;
}

export { debounce, raw, html, CONFIG, optionValues, optionLabel };
