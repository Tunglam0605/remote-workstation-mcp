import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseWorktrees, summarize } from '../scripts/report-worktree-footprint.mjs';

describe('worktree footprint diagnostics', () => {
  it('finds owner session trees in Git porcelain format', () => {
    const porcelain = [
      'worktree C:/repo/main',
      'HEAD 12345',
      'branch refs/heads/main',
      '',
      'worktree C:/repo/main.rwmcp-01234567-89ab-4cde-8012-123456789abc',
      'HEAD 67890',
      'branch refs/heads/session',
      '',
    ].join('\n');
    const output = parseWorktrees(porcelain);
    assert.equal(output.length, 2);
    assert.equal(output[0].sessionOwned, false);
    assert.equal(output[1].sessionOwned, true);
  });

  it('warns on many worktrees without deleting any', () => {
    const rows = [
      { sessionOwned: true, bytes: 100, inaccessible: 0 },
      { sessionOwned: true, bytes: 200, inaccessible: 0 },
      { sessionOwned: false, bytes: 99999, inaccessible: 0 },
    ];
    assert.deepEqual(summarize(rows, 1, 1000), {
      sessionWorktrees: 2, bytes: 300, warning: true,
      warningCount: 1, warningBytes: 1000, inaccessible: 0,
    });
    assert.equal(summarize(rows, 10, 1000).warning, false);
  });
});
