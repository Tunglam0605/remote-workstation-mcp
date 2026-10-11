#!/usr/bin/env node
/**
 * Read-only, cross-platform footprint inventory for local Git Work Session worktrees.
 * Session state and delete eligibility MUST come from the authorized Work Session API.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_TREE = /\.rwmcp-[0-9a-fA-F-]{36}$/;

export function parseWorktrees(text) {
  const trees = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('worktree ')) continue;
    const folder = line.slice('worktree '.length).trim();
    if (folder) trees.push({ path: folder, sessionOwned: SESSION_TREE.test(folder) });
  }
  return trees;
}

export function folderUsage(directory) {
  const usage = { bytes: 0, files: 0, inaccessible: 0 };
  const queue = [directory];
  while (queue.length > 0) {
    const current = queue.pop();
    let list;
    try {
      list = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      usage.inaccessible += 1;
      continue;
    }
    for (const entry of list) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) {
        try {
          usage.bytes += fs.statSync(full).size;
          usage.files += 1;
        } catch {
          usage.inaccessible += 1;
        }
      }
      // Symlinks/reparse points are not followed.
    }
  }
  return usage;
}

export function summarize(rows, limitCount = 12, limitBytes = 2 * 1024 ** 3) {
  const sessions = rows.filter(row => row.sessionOwned);
  const bytes = sessions.reduce((n, row) => n + row.bytes, 0);
  const count = sessions.length;
  return {
    sessionWorktrees: count, bytes,
    warning: count > limitCount || bytes > limitBytes,
    warningCount: limitCount, warningBytes: limitBytes,
    inaccessible: sessions.reduce((n, row) => n + row.inaccessible, 0),
  };
}

function main() {
  const porcelain = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 3 * 1024 * 1024
  });
  const data = parseWorktrees(porcelain);
  const rows = data.map(row => ({ ...row, ...folderUsage(row.path) }));
  const summary = summarize(rows);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ summary, worktrees: rows }, null, 2));
    return;
  }
  console.log('Worktree footprint: ' + summary.sessionWorktrees + ' session worktrees, ' +
    (summary.bytes / 1024 ** 3).toFixed(2) + ' GiB');
  console.log('  Warning threshold: ' + summary.warningCount + ' trees / ' +
    (summary.warningBytes / 1024 ** 3).toFixed(2) + ' GiB');
  const largest = rows.filter(row => row.sessionOwned).sort((a, b) => b.bytes - a.bytes).slice(0, 8);
  for (const row of largest) {
    console.log('  ' + path.basename(row.path) + ': ' + (row.bytes / 1024 ** 2).toFixed(1) + ' MiB');
  }
  if (summary.inaccessible > 0) console.warn('  Unreadable paths: ' + summary.inaccessible);
  if (summary.warning) console.warn('  WARNING: Worktree accumulation. Inspect Work Session lifecycle before cleanup.');
  console.log('  Never use git worktree prune/remove --force for session-owned worktrees.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
