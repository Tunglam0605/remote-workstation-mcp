import assert from 'node:assert/strict';
import test from 'node:test';

let instance = 0;
const fresh = () => import(`../assets/moonlight/i18n.js?test=${++instance}`);

test('locale defaults to Vietnamese and translates with literal placeholder values', async () => {
  const locale = await fresh();
  assert.equal(locale.getLanguage(), 'vi');
  locale.registerTranslations({ 'Hello {name}': 'Xin chào {name}' });
  assert.equal(locale.t('Hello {name}', { name: '$& <owner>' }), 'Xin chào $& <owner>');
  assert.equal(locale.t('Unknown {id}', { id: 0 }), 'Unknown 0');
  assert.equal(locale.t('Missing {value}'), 'Missing {value}');
  locale.setLanguage('en');
  assert.equal(locale.t('Hello {name}', { name: 'Owner' }), 'Hello Owner');
});

test('locale validates changes, notifies once, and allows unsubscribe', async () => {
  const locale = await fresh();
  const changes: string[] = [];
  const unsubscribe = locale.onLanguageChange((language: string) => changes.push(language));
  locale.setLanguage('fr');
  assert.equal(locale.getLanguage(), 'vi');
  locale.setLanguage('en');
  locale.setLanguage('en');
  assert.deepEqual(changes, ['en']);
  unsubscribe();
  locale.setLanguage('vi');
  assert.deepEqual(changes, ['en']);
});

test('locale persists only its preference and handles blocked storage', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const saved = new Map<string, string>([['moonlight-language', 'en']]);
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value)
    } });
    const locale = await fresh();
    assert.equal(locale.getLanguage(), 'en');
    locale.setLanguage('vi');
    assert.deepEqual([...saved], [['moonlight-language', 'vi']]);
    saved.set('moonlight-language', 'invalid');
    assert.equal((await fresh()).getLanguage(), 'vi');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
    const blocked = await fresh();
    assert.equal(blocked.getLanguage(), 'vi');
    assert.doesNotThrow(() => blocked.setLanguage('en'));
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
