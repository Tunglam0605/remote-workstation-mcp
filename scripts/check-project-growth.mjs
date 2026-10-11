#!/usr/bin/env node
/**
 * Git-aware growth budget for the distributable RWMCP repository.
 * Grandfather a few oversized modules while requiring new capabilities to remain modular.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'config', 'project-growth-budget.json');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js']);

export function collectInventory(root = ROOT) {
  const stdout = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, maxBuffer: 12 * 1024 * 1024
  });
  const names = [...new Set(stdout.toString('utf8').split('\0').filter(Boolean))].sort();
  const entries = [];
  for (const name of names) {
    const relative = name.replaceAll('\\', '/');
    if (relative.startsWith('../') || path.posix.isAbsolute(relative)) continue;
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) continue;
    const info = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!info || !info.isFile()) continue;
    entries.push({ path: relative, bytes: info.size });
  }
  return entries;
}

export function evaluateInventory(entries, configuration) {
  const issues = [];
  const groups = {};
  const prefixes = Object.entries(configuration.groups);
  for (const [name] of prefixes) groups[name] = { files: 0, bytes: 0 };
  const monitored = [];
  let totalBytes = 0;
  const seen = new Set();
  for (const entry of entries) {
    const name = entry.path.replaceAll('\\', '/');
    if (seen.has(name)) {
      issues.push('duplicate path: ' + name);
      continue;
    }
    seen.add(name);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      issues.push('invalid file size: ' + name);
      continue;
    }
    totalBytes += entry.bytes;
    if (/^[^/]+\.(?:tgz|tar|zip)$/i.test(name)) {
      issues.push('unmanaged root archive: ' + name + ' (move to external build-artifact storage)');
    }
    for (const [group] of prefixes) {
      if (!name.startsWith(group)) continue;
      groups[group].files += 1;
      groups[group].bytes += entry.bytes;
      break;
    }
    if ((name.startsWith('src/') || name.startsWith('scripts/')) && SOURCE_EXTENSIONS.has(path.posix.extname(name))) {
      const max = configuration.legacySourceExceptions[name] ?? configuration.maxSourceFileBytes;
      if (entry.bytes > max) {
        issues.push('source module too large: ' + name + ' (' + entry.bytes + ' > ' + max + ' bytes)');
      }
      if (entry.bytes > configuration.monitoredSourceFileBytes) {
        monitored.push({ path: name, bytes: entry.bytes, limit: max });
      }
    }
    if (name.startsWith('assets/') && entry.bytes > configuration.maxAssetFileBytes) {
      issues.push('asset too large: ' + name + ' (' + entry.bytes + ' > ' + configuration.maxAssetFileBytes + ' bytes)');
    }
  }
  for (const [group, limits] of prefixes) {
    const actual = groups[group];
    if (actual.files > limits.files) {
      issues.push('file-count budget exceeded: ' + group + ' ' + actual.files + ' > ' + limits.files);
    }
    if (actual.bytes > limits.bytes) {
      issues.push('size budget exceeded: ' + group + ' ' + actual.bytes + ' > ' + limits.bytes + ' bytes');
    }
  }
  monitored.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  return { ok: issues.length === 0, totalFiles: seen.size, totalBytes, groups,
    monitoredSourceModules: monitored, issues };
}

function main() {
  const configuration = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const result = evaluateInventory(collectInventory(), configuration);
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    console.log('Project growth: ' + (result.ok ? 'OK' : 'FAILED') + ' (' +
      result.totalFiles + ' files, ' + (result.totalBytes / 1024 / 1024).toFixed(2) +
      ' MiB; tracked and nonignored candidates)');
    for (const [group, current] of Object.entries(result.groups)) {
      const max = configuration.groups[group];
      console.log('  ' + group.padEnd(12) + ' ' + String(current.files).padStart(3) + '/' +
        String(max.files).padEnd(3) + ' files  ' + (current.bytes / 1024 / 1024).toFixed(2) +
        '/' + (max.bytes / 1024 / 1024).toFixed(2) + ' MiB');
    }
    console.log('  Monitored large modules: ' + result.monitoredSourceModules.length);
    for (const issue of result.issues) console.error('  FAIL ' + issue);
    if (!result.ok) console.error('Growth requires reviewed changes; see docs/PROJECT_GROWTH_POLICY.md');
  }
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
