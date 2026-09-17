#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compareSemver, isPatchUpgrade, normalizeVersion, parseSemver } from './lib/semver.mjs';
import { fetchReleaseAsset, verifySha256 } from './lib/release-download.mjs';

const exec = promisify(execFile);
const home = os.homedir();
const dataHome = process.env.RWMCP_HOME ?? path.join(home, '.local/share/remote-workstation-mcp');
const configHome = process.env.RWMCP_CONFIG_HOME ?? path.join(home, '.config/remote-workstation-mcp');
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

function scheduledMayApply(installed, latest) {
  if (!scheduled) return true;
  if (updateMode === 'auto') return true;
  if (updateMode !== 'auto_patch' || !installed) return false;
  return isPatchUpgrade(installed, latest);
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function managedMcpPort() {
  try {
    const text = await fs.readFile(path.join(configHome, 'openai.env'), 'utf8');
    const match = /^RWMCP_PORT=(?:["']?)(\d+)/m.exec(text);
    if (match) return Number(match[1]);
  } catch {}
  try {
    const settings = JSON.parse((await fs.readFile(path.join(configHome, 'settings.json'), 'utf8')).replace(/^\uFEFF/, ''));
    const value = Number(settings?.mcpPort);
    if (Number.isInteger(value) && value >= 1024 && value <= 65535) return value;
  } catch {}
  const envPort = Number(process.env.RWMCP_PORT);
  return Number.isInteger(envPort) && envPort >= 1024 && envPort <= 65535 ? envPort : 8683;
}

async function managedServiceName() {
  const direct = path.join(home, '.config/systemd/user/remote-workstation-mcp-openai.service');
  return await exists(direct) ? 'remote-workstation-mcp-openai.service' : 'remote-workstation-mcp.service';
}

function linuxUserSystemdEnv() {
  const env = { ...process.env };
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const runtimeDir = env.XDG_RUNTIME_DIR || (uid !== undefined ? `/run/user/${uid}` : undefined);
  if (runtimeDir) {
    env.XDG_RUNTIME_DIR = runtimeDir;
    env.DBUS_SESSION_BUS_ADDRESS ||= `unix:path=${runtimeDir}/bus`;
  }
  return env;
}

async function restartService() {
  const service = await managedServiceName();
  try {
    await exec('systemctl', ['--user', 'restart', service], { env: linuxUserSystemdEnv() });
  } catch (error) {
    throw new Error(`Failed to restart ${service}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function waitForHealth(expectedVersion) {
  const port = await managedMcpPort();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
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
const latest = normalizeVersion(release.tag_name);
if (!parseSemver(latest)) throw new Error(`Latest GitHub release tag '${release.tag_name}' is not a supported semantic version.`);

let comparison;
if (installed !== undefined) {
  if (!parseSemver(installed)) throw new Error(`Installed version '${installed}' is not a supported semantic version.`);
  comparison = compareSemver(latest, installed);
}
const updateAvailable = installed === undefined || comparison > 0;
const installedIsNewer = comparison !== undefined && comparison < 0;
const installedParts = installed ? parseSemver(installed) : undefined;
const latestParts = parseSemver(latest);
const updateKind = updateAvailable && installedParts && latestParts
  ? latestParts.major !== installedParts.major ? 'major'
    : latestParts.minor !== installedParts.minor ? 'minor'
      : 'patch'
  : undefined;
const automaticInstallAllowed = Boolean(
  scheduled && updateMode === 'auto_patch' && installed && isPatchUpgrade(installed, latest)
) || Boolean(scheduled && updateMode === 'auto');

console.log(JSON.stringify({
  installed,
  latest,
  release: release.html_url,
  updateAvailable,
  installedIsNewer,
  updateKind,
  automaticPolicy: 'patch',
  automaticInstallAllowed,
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
  const archive = await fetchReleaseAsset(tgzAsset);
  const sumsBuffer = await fetchReleaseAsset(sumsAsset);
  await fs.writeFile(tgzPath, archive, { mode: 0o600 });
  await fs.writeFile(sumsPath, sumsBuffer, { mode: 0o600 });
  const sums = sumsBuffer.toString('utf8');
  const expectedLine = sums.split(/\r?\n/).find(line => line.trim().endsWith(`  ${tgzAsset.name}`) || line.trim().endsWith(` *${tgzAsset.name}`));
  if (!expectedLine) throw new Error('Package checksum is missing from SHA256SUMS.txt.');
  const expected = expectedLine.trim().split(/\s+/)[0].toLowerCase();
  verifySha256(archive, expected);

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
