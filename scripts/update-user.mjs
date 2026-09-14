#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const home = os.homedir();
const dataHome = process.env.RWMCP_HOME ?? path.join(home, '.local/share/remote-workstation-mcp');
const repository = process.env.RWMCP_UPDATE_REPO ?? 'Tunglam0605/remote-workstation-mcp';
const checkOnly = process.argv.includes('--check');
const scheduled = process.argv.includes('--scheduled');
const updateMode = process.env.RWMCP_UPDATE_MODE ?? 'notify';
const validModes = new Set(['off', 'notify', 'auto_patch', 'auto']);
if (!validModes.has(updateMode)) throw new Error(`Invalid RWMCP_UPDATE_MODE '${updateMode}'.`);
if (scheduled && updateMode === 'off') process.exit(0);

async function readInstalledVersion() {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dataHome, 'current', 'package.json'), 'utf8'));
    return String(pkg.version);
  } catch {
    return undefined;
  }
}

async function latestRelease() {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'remote-workstation-mcp-updater' },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`GitHub releases API returned HTTP ${response.status}`);
  return response.json();
}

function normalize(value) {
  return String(value).trim().replace(/^v/, '');
}

function semver(value) {
  const match = normalize(value).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : undefined;
}

function compareSemver(leftValue, rightValue) {
  const left = semver(leftValue);
  const right = semver(rightValue);
  if (!left || !right) throw new Error(`Cannot compare invalid semantic versions '${leftValue}' and '${rightValue}'.`);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  return 0;
}

function scheduledMayApply(installed, latest) {
  if (!scheduled) return true;
  if (updateMode === 'auto') return true;
  if (updateMode !== 'auto_patch') return false;
  const current = installed && semver(installed);
  const target = semver(latest);
  return Boolean(current && target && current.major === target.major && current.minor === target.minor && target.patch > current.patch);
}

async function download(url, target) {
  const response = await fetch(url, { headers: { 'User-Agent': 'remote-workstation-mcp-updater' }, redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(target, buffer, { mode: 0o600 });
  return buffer;
}

async function restartService() {
  try {
    await exec('systemctl', ['--user', 'restart', 'remote-workstation-mcp.service']);
  } catch (error) {
    throw new Error(`Failed to restart user service: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function waitForHealth(expectedVersion) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:8765/healthz', { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const body = await response.json();
        if (body?.ok === true && body?.version === expectedVersion) return true;
      }
    } catch {
      // Service may still be restarting.
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

const installed = await readInstalledVersion();
const release = await latestRelease();
const latest = normalize(release.tag_name);
if (!semver(latest)) throw new Error(`Latest GitHub release tag '${release.tag_name}' is not a supported semantic version.`);

let comparison;
if (installed !== undefined) {
  if (!semver(installed)) throw new Error(`Installed version '${installed}' is not a supported semantic version.`);
  comparison = compareSemver(latest, installed);
}
const updateAvailable = installed === undefined || comparison > 0;
const installedIsNewer = comparison !== undefined && comparison < 0;

console.log(JSON.stringify({
  installed,
  latest,
  release: release.html_url,
  updateAvailable,
  installedIsNewer,
  mode: updateMode,
  scheduled
}, null, 2));

// Never downgrade automatically or manually. A downgrade must be an explicit rollback to a locally retained version slot.
if (checkOnly || !updateAvailable || installedIsNewer || !scheduledMayApply(installed, latest)) process.exit(0);

const tgzAsset = release.assets.find(asset => asset.name === `remote-workstation-mcp-v${latest}.tgz`);
const sumsAsset = release.assets.find(asset => asset.name === 'SHA256SUMS.txt');
if (!tgzAsset || !sumsAsset) throw new Error('Release is missing the package or SHA256SUMS.txt asset.');

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-update-'));
try {
  const tgzPath = path.join(temp, tgzAsset.name);
  const sumsPath = path.join(temp, 'SHA256SUMS.txt');
  const archive = await download(tgzAsset.browser_download_url, tgzPath);
  await download(sumsAsset.browser_download_url, sumsPath);
  const sums = await fs.readFile(sumsPath, 'utf8');
  const expectedLine = sums.split(/\r?\n/).find(line => line.trim().endsWith(`  ${tgzAsset.name}`) || line.trim().endsWith(` *${tgzAsset.name}`));
  if (!expectedLine) throw new Error('Package checksum is missing from SHA256SUMS.txt.');
  const expected = expectedLine.trim().split(/\s+/)[0].toLowerCase();
  const actual = crypto.createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) throw new Error(`Checksum mismatch: expected ${expected}, got ${actual}.`);

  const versionDir = path.join(dataHome, 'versions', latest);
  await fs.rm(versionDir, { recursive: true, force: true });
  await fs.mkdir(versionDir, { recursive: true });
  await exec('tar', ['-xzf', tgzPath, '--strip-components=1', '-C', versionDir]);
  await exec('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: versionDir });

  const current = path.join(dataHome, 'current');
  const previous = path.join(dataHome, 'previous');
  let oldTarget;
  try { oldTarget = await fs.realpath(current); } catch { oldTarget = undefined; }
  if (oldTarget) {
    await fs.rm(previous, { force: true });
    await fs.symlink(oldTarget, previous);
  }
  const candidate = path.join(dataHome, '.current-next');
  await fs.rm(candidate, { force: true });
  await fs.symlink(versionDir, candidate);
  await fs.rename(candidate, current);

  try {
    await restartService();
    if (!(await waitForHealth(latest))) throw new Error('Health check failed after upgrade.');
    console.log(`Upgrade successful: ${installed ?? 'unknown'} -> ${latest}`);
  } catch (error) {
    if (!oldTarget) throw error;
    const rollbackLink = path.join(dataHome, '.current-rollback');
    await fs.rm(rollbackLink, { force: true });
    await fs.symlink(oldTarget, rollbackLink);
    await fs.rename(rollbackLink, current);
    await restartService();
    throw new Error(`Upgrade failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
  }
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
