import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { setupHtml } from '../src/setup/ui.js';
import { seasonalThemeCss, seasonalThemeScript } from '../src/setup/seasonal-theme.js';

function resolveAt(iso: string): string {
  const store = new Map<string, string>();
  const context = vm.createContext({
    Intl,
    Date,
    Math,
    String,
    Number,
    Object,
    Array,
    Set,
    console,
    localStorage: {
      getItem(key: string) { return store.get(key) ?? null; },
      setItem(key: string, value: string) { store.set(key, value); }
    }
  });
  vm.runInContext(seasonalThemeScript, context);
  return vm.runInContext(`ccResolveTheme(new Date(${JSON.stringify(iso)})).id`, context) as string;
}

test('seasonal theme assets are injected into Control Center HTML', () => {
  const html = setupHtml('test-token');
  assert.match(html, /cc-seasonal-hero/);
  assert.match(html, /initSeasonalThemeSystem\(\)/);
  assert.match(html, /CC_LUNAR_EVENT_DATES/);
  assert.match(html, /mid-autumn/);
  assert.match(html, /hung-kings/);
  assert.match(html, /national-day/);
  assert.ok(seasonalThemeCss.includes('prefers-reduced-motion'));
});

test('event-first resolver activates Vietnamese event themes before seasonal fallback', () => {
  assert.equal(resolveAt('2026-09-22T01:00:00Z'), 'mid-autumn');
  assert.equal(resolveAt('2026-02-15T01:00:00Z'), 'tet');
  assert.equal(resolveAt('2026-04-29T01:00:00Z'), 'liberation-day');
  assert.equal(resolveAt('2026-09-01T01:00:00Z'), 'national-day');
});

test('resolver falls back to four seasonal themes outside event windows', () => {
  assert.equal(resolveAt('2026-03-18T01:00:00Z'), 'spring');
  assert.equal(resolveAt('2026-07-15T01:00:00Z'), 'summer');
  assert.equal(resolveAt('2026-08-12T01:00:00Z'), 'autumn');
  assert.equal(resolveAt('2026-12-10T01:00:00Z'), 'winter');
});

test('lunar event table covers 2026 through 2030', () => {
  for (const year of [2026, 2027, 2028, 2029, 2030]) {
    assert.ok(seasonalThemeScript.includes(String(year)));
  }
  assert.ok(seasonalThemeScript.includes("'2026-09-25'"));
  assert.ok(seasonalThemeScript.includes("'2028-10-03'"));
  assert.ok(seasonalThemeScript.includes("'2030-09-12'"));
});
