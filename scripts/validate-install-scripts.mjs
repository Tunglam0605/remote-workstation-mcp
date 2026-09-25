#!/usr/bin/env node
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const policy = pkg.allowScripts ?? {};

function packageNameFromLockPath(lockPath) {
  const marker = 'node_modules/';
  const index = lockPath.lastIndexOf(marker);
  if (index < 0) return undefined;
  const tail = lockPath.slice(index + marker.length);
  if (!tail) return undefined;
  const parts = tail.split('/');
  return tail.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const installScriptPackages = [];
for (const [lockPath, record] of Object.entries(lock.packages ?? {})) {
  if (!record?.hasInstallScript) continue;
  const name = packageNameFromLockPath(lockPath);
  const version = typeof record.version === 'string' ? record.version : undefined;
  if (!name || !version) throw new Error(`Install-script dependency has no stable identity: ${lockPath}`);
  installScriptPackages.push({ name, version, optional: record.optional === true, os: record.os });
}

const uncovered = [];
for (const item of installScriptPackages) {
  const pinned = `${item.name}@${item.version}`;
  if (policy[pinned] === true) continue;
  if (policy[item.name] === false) continue;
  uncovered.push(pinned);
}

const stale = Object.entries(policy).flatMap(([key, allowed]) => {
  if (allowed === false) {
    return installScriptPackages.some(item => item.name === key) ? [] : [key];
  }
  if (allowed !== true) return [key];
  return installScriptPackages.some(item => `${item.name}@${item.version}` === key) ? [] : [key];
});

if (uncovered.length || stale.length) {
  if (uncovered.length) console.error(`Unreviewed install-script dependencies: ${uncovered.join(', ')}`);
  if (stale.length) console.error(`Stale/invalid allowScripts entries: ${stale.join(', ')}`);
  process.exit(1);
}

console.log(`Install-script policy valid: ${installScriptPackages.length} dependency package(s), ${Object.keys(policy).length} explicit policy entries.`);
