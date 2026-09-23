const translations = new Map();
const listeners = new Set();
const preferenceKey = 'moonlight-language';
let language = 'vi';
try {
  const saved = globalThis.localStorage?.getItem(preferenceKey);
  if (saved === 'en' || saved === 'vi') language = saved;
} catch { /* Storage can be unavailable in private or restricted browsers. */ }

export function registerTranslations(dict) {
  for (const [source, translated] of Object.entries(dict)) {
    if (typeof translated === 'string') translations.set(source, translated);
  }
}

export function t(source, params = {}) {
  const text = language === 'vi' ? (translations.get(source) ?? source) : source;
  return String(text).replace(/\{([\w]+)\}/g, (placeholder, key) =>
    Object.hasOwn(params, key) ? String(params[key]) : placeholder);
}

export const getLanguage = () => language;

export function setLanguage(next) {
  if ((next !== 'vi' && next !== 'en') || next === language) return;
  language = next;
  try { globalThis.localStorage?.setItem(preferenceKey, language); } catch { /* Keep the in-memory preference. */ }
  for (const listener of listeners) listener(language);
}

export function onLanguageChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}
