import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateInventory } from '../scripts/check-project-growth.mjs';

const budget = {
  groups: { 'src/': { files: 2, bytes: 1000 }, 'assets/': { files: 2, bytes: 400 } },
  legacySourceExceptions: { 'src/legacy.ts': 750 },
  maxSourceFileBytes: 400,
  monitoredSourceFileBytes: 300,
  maxAssetFileBytes: 300,
};

describe('project growth boundaries', () => {
  it('permits small modules and grandfathered code within budget', () => {
    const result = evaluateInventory([
      { path: 'src/new.ts', bytes: 350 },
      { path: 'src/legacy.ts', bytes: 600 },
      { path: 'assets/brand.png', bytes: 200 },
    ], budget);
    assert.equal(result.ok, true);
    assert.equal(result.groups['src/'].files, 2);
    assert.equal(result.totalFiles, 3);
    assert.equal(result.monitoredSourceModules.length, 2);
  });

  it('blocks monolithic code and oversized folders', () => {
    const result = evaluateInventory([
      { path: 'src/oversized.ts', bytes: 401 },
      { path: 'src/another.ts', bytes: 500 },
      { path: 'src/third.ts', bytes: 150 },
    ], budget);
    assert.equal(result.ok, false);
    assert.match(result.issues.join('\n'), /source module too large/);
    assert.match(result.issues.join('\n'), /file-count budget exceeded/);
    assert.match(result.issues.join('\n'), /size budget exceeded/);
  });

  it('checks image sizes without deleting existing graphics', () => {
    const result = evaluateInventory([{ path: 'assets/giant.png', bytes: 350 }], budget);
    assert.equal(result.ok, false);
    assert.match(result.issues.join('\n'), /asset too large/);
  });

  it('rejects unmanaged root tarballs but not nested examples', () => {
    const result = evaluateInventory([
      { path: 'remote-workstation-mcp-0.70.0-dev.8.tgz', bytes: 10 },
      { path: 'docs/examples/spec.zip', bytes: 10 },
    ], budget);
    assert.equal(result.ok, false);
    assert.match(result.issues.join('\n'), /unmanaged root archive/);
    assert.equal(result.issues.filter(x => x.includes('unmanaged root archive')).length, 1);
  });

  it('rejects duplicate paths and invalid sizes', () => {
    const result = evaluateInventory([
      { path: 'src/one.ts', bytes: 3 },
      { path: 'src/one.ts', bytes: 3 },
      { path: 'src/bad.ts', bytes: -1 },
    ], budget);
    assert.equal(result.ok, false);
    assert.match(result.issues.join('\n'), /duplicate path/);
    assert.match(result.issues.join('\n'), /invalid file size/);
  });
});
