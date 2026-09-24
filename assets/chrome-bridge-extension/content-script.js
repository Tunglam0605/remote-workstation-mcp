'use strict';

const refs = new Map();
let serial = 0;
const ROLES = new Set(['heading','link','button','textbox','checkbox','radio','combobox']);

function clean(value, max = 256) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function visible(element) {
  if (!(element instanceof Element)) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
}

function enabled(element) {
  return !(element instanceof HTMLButtonElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement) || !element.disabled;
}

function roleOf(element) {
  const explicit = clean(element.getAttribute('role'), 32).toLowerCase();
  if (ROLES.has(explicit)) return explicit;
  if (/^H[1-6]$/.test(element.tagName)) return 'heading';
  if (element instanceof HTMLAnchorElement && element.href) return 'link';
  if (element instanceof HTMLButtonElement) return 'button';
  if (element instanceof HTMLTextAreaElement) return 'textbox';
  if (element instanceof HTMLSelectElement) return 'combobox';
  if (element instanceof HTMLInputElement) {
    const type = (element.type || 'text').toLowerCase();
    if (type === 'password') return '';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (['button', 'submit', 'reset'].includes(type)) return 'button';
    if (['text', 'search', 'email', 'tel', 'url', 'number'].includes(type)) return 'textbox';
  }
  if (element.getAttribute('contenteditable') === 'true') return 'textbox';
  return '';
}

function labelledBy(element) {
  const ids = clean(element.getAttribute('aria-labelledby'), 512).split(' ').filter(Boolean);
  return clean(ids.map(id => document.getElementById(id)?.textContent || '').join(' '));
}

function associatedLabel(element) {
  if (!(element instanceof HTMLElement)) return '';
  const id = element.id;
  if (id) {
    const label = document.querySelector('label[for="' + CSS.escape(id) + '"]');
    if (label) return clean(label.textContent);
  }
  const parent = element.closest('label');
  return parent ? clean(parent.textContent) : '';
}

function nameOf(element) {
  return clean(
    element.getAttribute('aria-label') ||
    labelledBy(element) ||
    associatedLabel(element) ||
    element.getAttribute('alt') ||
    element.getAttribute('title') ||
    element.getAttribute('placeholder') ||
    (element instanceof HTMLInputElement ? element.value : '') ||
    element.textContent
  );
}

function semanticElements() {
  const selector = [
    'h1','h2','h3','h4','h5','h6','a[href]','button','textarea','select',
    'input:not([type="password"])','[contenteditable="true"]',
    '[role="heading"]','[role="link"]','[role="button"]','[role="textbox"]',
    '[role="checkbox"]','[role="radio"]','[role="combobox"]'
  ].join(',');
  const seen = new Set();
  const ordinals = new Map();
  const result = [];

  for (const element of document.querySelectorAll(selector)) {
    if (seen.has(element)) continue;
    seen.add(element);
    const role = roleOf(element);
    if (!role || !ROLES.has(role)) continue;
    const name = nameOf(element);
    const key = role + '\u0000' + name;
    const ordinal = ordinals.get(key) || 0;
    ordinals.set(key, ordinal + 1);
    result.push({ element, role, name, ordinal, visible: visible(element), enabled: enabled(element) });
  }
  return result;
}

function publish(items) {
  refs.clear();
  serial += 1;
  return items.map((item, index) => {
    const elementId = 'xc_' + serial + '_' + (index + 1);
    refs.set(elementId, { role: item.role, name: item.name, ordinal: item.ordinal });
    return { elementId, role: item.role, name: item.name, visible: item.visible, enabled: item.enabled };
  });
}

function resolveRef(elementId) {
  const ref = refs.get(elementId);
  if (!ref) throw Object.assign(new Error('Semantic reference is stale; inspect the page again.'), { code: 'ELEMENT_STALE' });
  const matches = semanticElements().filter(item => item.role === ref.role && item.name === ref.name);
  const item = matches.find(candidate => candidate.ordinal === ref.ordinal);
  if (!item) throw Object.assign(new Error('Semantic reference no longer resolves; inspect the page again.'), { code: 'ELEMENT_STALE' });
  return item;
}

function setNativeValue(element, value) {
  if (element instanceof HTMLInputElement) {
    if (element.type === 'password') throw Object.assign(new Error('Password fields are never writable through RWMCP.'), { code: 'CREDENTIAL_FIELD_DENIED' });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(element, value);
  } else if (element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(element, value);
  } else if (element.getAttribute('contenteditable') === 'true') {
    element.textContent = value;
  } else {
    throw Object.assign(new Error('Element is not a writable text control.'), { code: 'NOT_WRITABLE' });
  }

  element.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    inputType: 'insertText',
    data: value
  }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (!message || typeof message.op !== 'string') {
      throw Object.assign(new Error('Invalid content command.'), { code: 'INVALID_COMMAND' });
    }

    if (message.op === 'inspect') {
      const maxItems = Math.max(1, Math.min(50, Number(message.maxItems || 30)));
      const all = semanticElements();
      return {
        title: clean(document.title),
        url: location.href,
        elements: publish(all.slice(0, maxItems)),
        truncated: all.length > maxItems
      };
    }

    if (message.op === 'find') {
      const role = clean(message.role, 32);
      const name = clean(message.name, 256);
      const maxItems = Math.max(1, Math.min(50, Number(message.maxItems || 20)));
      const all = semanticElements().filter(item => item.role === role && item.name === name);
      return { matches: publish(all.slice(0, maxItems)), truncated: all.length > maxItems };
    }

    if (message.op === 'extract') {
      const maxChars = Math.max(1, Math.min(16000, Number(message.maxChars || 8000)));
      const text = clean(document.body?.innerText || '', 16000);
      return {
        title: clean(document.title),
        url: location.href,
        text: text.slice(0, maxChars),
        truncated: text.length > maxChars
      };
    }

    if (message.op === 'click') {
      const item = resolveRef(clean(message.elementId, 96));
      if (!item.visible || !item.enabled) {
        throw Object.assign(new Error('Element is not actionable.'), { code: 'NOT_ACTIONABLE' });
      }
      item.element.click();
      refs.clear();
      return { action: 'click', role: item.role, name: item.name };
    }

    if (message.op === 'fill') {
      const item = resolveRef(clean(message.elementId, 96));
      if (item.role !== 'textbox' || !item.visible || !item.enabled) {
        throw Object.assign(new Error('Element is not a writable textbox.'), { code: 'NOT_WRITABLE' });
      }
      setNativeValue(item.element, String(message.value ?? '').slice(0, 8000));
      refs.clear();
      return { action: 'fill', role: item.role, name: item.name };
    }

    throw Object.assign(new Error('Content command is not allowed.'), { code: 'COMMAND_DENIED' });
  })().then(
    result => sendResponse({ ok: true, result }),
    error => sendResponse({
      ok: false,
      error: {
        code: String(error?.code || 'CONTENT_ERROR').slice(0, 64),
        message: String(error?.message || 'Content request failed.').slice(0, 1024)
      }
    })
  );
  return true;
});
