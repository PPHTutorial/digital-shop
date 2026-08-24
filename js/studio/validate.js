/**
 * Schema validation.
 *
 * Runs in the browser to keep the editor responsive, and again inside the
 * `cms` Edge Function before anything is written. The two share this module,
 * so a rule can never drift between the client and the server.
 */

const URL_PATTERN = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isBlank(value) {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Date) return Number.isNaN(value.getTime());
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** Length of a value for `max`/`min` purposes, by field type. */
function measure(value) {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'number') return value;
  return 0;
}

/** Approximate plain-text length of a block array, for the counter. */
export function blocksLength(blocks) {
  if (!Array.isArray(blocks)) return 0;
  return blocks.reduce((total, block) => total + (typeof block?.text === 'string' ? block.text.length : 0), 0);
}

/**
 * Validates one field value.
 * @returns {string|null} the message, or null when the value is acceptable
 */
export function validateField(fieldDef, value, doc = {}) {
  const label = fieldDef.title || fieldDef.name;

  if (fieldDef.required && isBlank(value)) {
    return `${label} is required.`;
  }

  // Everything below only applies once a value is actually present.
  if (isBlank(value)) return null;

  switch (fieldDef.type) {
    case 'string':
    case 'text': {
      const text = String(value);
      if (fieldDef.max && text.length > fieldDef.max) {
        return `${label} must be ${fieldDef.max} characters or fewer (currently ${text.length}).`;
      }
      if (fieldDef.min && text.length < fieldDef.min) {
        return `${label} must be at least ${fieldDef.min} characters.`;
      }
      if (fieldDef.pattern && !new RegExp(fieldDef.pattern).test(text)) {
        return fieldDef.patternMessage || `${label} is not in the expected format.`;
      }
      break;
    }

    case 'slug': {
      const text = String(value);
      if (!SLUG_PATTERN.test(text)) {
        return `${label} may contain only lowercase letters, numbers, and single hyphens.`;
      }
      if (text.length > 96) return `${label} must be 96 characters or fewer.`;
      break;
    }

    case 'url':
      if (!URL_PATTERN.test(String(value))) return `${label} must be a full URL starting with http:// or https://.`;
      break;

    case 'email':
      if (!EMAIL_PATTERN.test(String(value))) return `${label} must be a valid email address.`;
      break;

    case 'number': {
      const number = Number(value);
      if (!Number.isFinite(number)) return `${label} must be a number.`;
      if (fieldDef.min != null && number < fieldDef.min) return `${label} must be at least ${fieldDef.min}.`;
      if (fieldDef.max != null && number > fieldDef.max) return `${label} must be at most ${fieldDef.max}.`;
      if (fieldDef.integer && !Number.isInteger(number)) return `${label} must be a whole number.`;
      break;
    }

    case 'select':
      if (fieldDef.options && !optionValues(fieldDef).includes(String(value))) {
        return `${label} must be one of: ${optionValues(fieldDef).join(', ')}.`;
      }
      break;

    case 'multiselect':
    case 'tags':
    case 'gallery':
    case 'array': {
      if (!Array.isArray(value)) return `${label} must be a list.`;
      if (fieldDef.max && value.length > fieldDef.max) return `${label} allows at most ${fieldDef.max} entries.`;
      if (fieldDef.min && value.length < fieldDef.min) return `${label} needs at least ${fieldDef.min} entries.`;
      break;
    }

    case 'date':
    case 'datetime': {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return `${label} is not a valid date.`;
      break;
    }

    case 'blocks': {
      if (!Array.isArray(value)) return `${label} is malformed.`;
      if (fieldDef.max && blocksLength(value) > fieldDef.max) {
        return `${label} must be ${fieldDef.max} characters or fewer.`;
      }
      break;
    }

    default:
      break;
  }

  if (typeof fieldDef.validate === 'function') {
    const custom = fieldDef.validate(value, doc);
    if (typeof custom === 'string') return custom;
  }

  if (fieldDef.max && ['string', 'text'].includes(fieldDef.type) === false && measure(value) > fieldDef.max) {
    return `${label} exceeds the maximum of ${fieldDef.max}.`;
  }

  return null;
}

/** Normalises `options` — a plain array or an array of {value,label} pairs. */
export function optionValues(fieldDef) {
  return (fieldDef.options || []).map((option) => (typeof option === 'string' ? option : option.value));
}

export function optionLabel(fieldDef, value) {
  const found = (fieldDef.options || []).find((option) =>
    typeof option === 'string' ? option === value : option.value === value,
  );
  if (!found) return String(value ?? '');
  return typeof found === 'string' ? found : found.label;
}

/**
 * Validates a whole document against its type.
 * @returns {Array<{path: string, field: string, label: string, message: string}>}
 */
export function validateDocument(type, doc = {}) {
  const problems = [];

  const walk = (fields, values, pathPrefix) => {
    for (const fieldDef of fields) {
      if (fieldDef.hidden) continue;
      const path = pathPrefix ? `${pathPrefix}.${fieldDef.name}` : fieldDef.name;
      const value = values?.[fieldDef.name];

      const message = validateField(fieldDef, value, doc);
      if (message) {
        problems.push({ path, field: fieldDef.name, label: fieldDef.title || fieldDef.name, message });
        continue;
      }

      if (fieldDef.type === 'object' && fieldDef.fields && value && typeof value === 'object') {
        walk(fieldDef.fields, value, path);
      }

      if (fieldDef.type === 'array' && fieldDef.of?.fields && Array.isArray(value)) {
        value.forEach((entry, index) => {
          walk(fieldDef.of.fields, entry, `${path}[${index}]`);
        });
      }
    }
  };

  walk(type.fields, doc, '');

  // Cross-field rules that no single field can express on its own.
  if (type.name === 'product') {
    const price = Number(doc.price);
    const original = doc.original_price == null || doc.original_price === '' ? null : Number(doc.original_price);
    if (original != null && Number.isFinite(original) && Number.isFinite(price) && original <= price) {
      problems.push({
        path: 'original_price',
        field: 'original_price',
        label: 'Compare-at price',
        message: 'The compare-at price must be higher than the price, or left empty.',
      });
    }
  }

  if (type.name === 'promotion') {
    if (doc.discount_type === 'percent' && Number(doc.discount_value) > 100) {
      problems.push({
        path: 'discount_value',
        field: 'discount_value',
        label: 'Discount value',
        message: 'A percentage discount cannot exceed 100.',
      });
    }
    if (doc.starts_at && doc.ends_at && new Date(doc.ends_at) <= new Date(doc.starts_at)) {
      problems.push({
        path: 'ends_at',
        field: 'ends_at',
        label: 'Ends',
        message: 'The end date must be after the start date.',
      });
    }
  }

  if (type.name === 'announcement' && doc.starts_at && doc.ends_at) {
    if (new Date(doc.ends_at) <= new Date(doc.starts_at)) {
      problems.push({
        path: 'ends_at',
        field: 'ends_at',
        label: 'Hide after',
        message: 'The end time must be after the start time.',
      });
    }
  }

  return problems;
}

/** True when a document has no validation problems. */
export function isValid(type, doc) {
  return validateDocument(type, doc).length === 0;
}
