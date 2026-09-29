import { t } from './i18n.js';

export const text = (value) => value == null || value === '' ? '—' : String(value);

export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value == null) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (name === 'checked') node.checked = Boolean(value);
    else node.setAttribute(name, value);
  }
  for (const child of children.flat()) if (child != null) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  return node;
}

export function resource(store, name) { return store.getState?.()[name] || {}; }

export function section(title, description, extraClass = '') {
  const header = el('header', { class: 'moon-section-header' },
    el('h3', { text: t(title) }),
    description && el('p', { text: t(description) })
  );
  return el('section', { class: `moon-section ${extraClass}`.trim() }, header);
}

export function field(label, control, hint, extraClass = '') {
  return el('label', { class: `moon-field ${extraClass}`.trim() },
    el('span', { text: t(label) }),
    control,
    hint && el('small', { text: t(hint) })
  );
}

export function button(label, handler, className = 'secondary-button') {
  return el('button', {
    type: 'button',
    class: className,
    text: t(label),
    onclick: (event) => {
      const control = event.currentTarget;
      control.disabled = true;
      void Promise.resolve(handler(event)).catch(() => {}).finally(() => { control.disabled = false; });
    }
  });
}

export function selectValue(value, choices) {
  const select = el('select');
  for (const [id, label] of choices) select.append(el('option', { value: id, text: t(label), selected: id === value ? '' : null }));
  return select;
}

export function requestError(error) { return error?.message || t('The control center rejected this request.'); }
export function emptyState(message) { return el('div', { class: 'moon-empty' }, el('p', { class: 'moon-muted', text: t(message) })); }
