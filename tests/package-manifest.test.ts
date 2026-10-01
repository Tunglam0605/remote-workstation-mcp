import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('production package ships runtime JavaScript without TypeScript build byproducts', async () => {
  const manifest = JSON.parse(await fs.readFile('package.json', 'utf8')) as {
    files?: string[];
    bin?: Record<string, string>;
  };

  const files = manifest.files ?? [];
  assert.ok(files.includes('dist/**/*.js'), 'production package must include compiled runtime JavaScript');
  assert.equal(files.includes('dist/'), false, 'blanket dist/ packaging would re-include .d.ts and source maps');
  assert.equal(files.some(entry => entry.includes('*.map') || entry.includes('*.d.ts')), false);

  for (const target of Object.values(manifest.bin ?? {})) {
    assert.match(target, /^dist\/.*\.js$/);
  }
});
