#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import YAML from 'yaml';

const exec = promisify(execFile);
const jsonMode = process.argv.includes('--json');
const strict = process.argv.includes('--strict');
const home = os.homedir();
const dataHome = process.env.RWMCP_HOME ?? path.join(home, '.local/share/remote-workstation-mcp');
const configHome = process.env.RWMCP_CONFIG_HOME ?? path.join(home, '.config/remote-workstation-mcp');
const policyPath = process.env.RWMCP_POLICY ?? path.join(configHome, 'policy.yaml');
const hostsPath = process.env.RWMCP_HOSTS ?? path.join(configHome, 'hosts.yaml');
const updatePath = path.join(configHome, 'update.env');
const currentPath = path.join(dataHome, 'current');
const localServiceName = 'remote-workstation-mcp.service';
const directServiceName = 'remote-workstation-mcp-openai.service';
const directServicePath = path.join(home, '.config/systemd/user', directServiceName);
const timerName = 'remote-workstation-mcp-update.timer';
const checks = [];

function add(id, ok, level, detail) {
  checks.push({ id, ok, level, detail });
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function managedMcpPort() {
  const directEnv = path.join(configHome, 'openai.env');
  try {
    const text = await fs.readFile(directEnv, 'utf8');
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

async function commandExists(command) {
  try {
    const { stdout } = await exec('which', [command], { timeout: 3000 });
    return stdout.trim() || true;
  } catch {
    return false;
  }
}

async function checkPrivateFile(id, target, required) {
  if (!(await exists(target))) {
    add(id, !required, required ? 'error' : 'warn', `missing: ${target}`);
    return;
  }
  const stat = await fs.stat(target);
  const publicBits = stat.mode & 0o077;
  add(id, publicBits === 0, publicBits === 0 ? 'ok' : 'warn', `${target} mode=${(stat.mode & 0o777).toString(8)}`);
}

async function checkYaml(target, kind) {
  if (!(await exists(target))) return;
  try {
    const parsed = YAML.parse(await fs.readFile(target, 'utf8'));
    if (!parsed || parsed.version !== 1) throw new Error('version must be 1');
    add(`${kind}.yaml`, true, 'ok', `${target} parses successfully`);
    if (kind === 'policy' && Array.isArray(parsed.workspaces)) {
      for (const ws of parsed.workspaces) {
        if (!ws?.root) continue;
        const root = path.resolve(String(ws.root).replace(/^~(?=\/|$)/, home));
        add(`workspace.${ws.id ?? 'unknown'}`, await exists(root), 'warn', root);
      }
    }
  } catch (error) {
    add(`${kind}.yaml`, false, 'error', `${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
add('node.version', nodeMajor >= 22, nodeMajor >= 22 ? 'ok' : 'error', process.version);

const requiredCommands = new Set(['npm', 'tar']);
for (const command of ['npm', 'git', 'tar', 'curl']) {
  const found = await commandExists(command);
  const required = requiredCommands.has(command);
  add(`command.${command}`, Boolean(found), found ? 'ok' : required ? 'error' : 'warn', found ? String(found) : 'not found');
}

await checkPrivateFile('config.policy.permissions', policyPath, true);
await checkPrivateFile('config.hosts.permissions', hostsPath, false);
await checkPrivateFile('config.update.permissions', updatePath, false);
await checkYaml(policyPath, 'policy');
await checkYaml(hostsPath, 'hosts');

if (await exists(currentPath)) {
  try {
    const real = await fs.realpath(currentPath);
    const pkg = JSON.parse(await fs.readFile(path.join(real, 'package.json'), 'utf8'));
    add('install.current', true, 'ok', `${currentPath} -> ${real} (v${pkg.version})`);
  } catch (error) {
    add('install.current', false, 'error', error instanceof Error ? error.message : String(error));
  }
} else {
  add('install.current', false, 'warn', `managed install not found at ${currentPath}`);
}

const serviceName = await exists(directServicePath) ? directServiceName : localServiceName;
const mcpPort = await managedMcpPort();
const systemctl = await commandExists('systemctl');
if (systemctl) {
  for (const [id, unit] of [['service', serviceName], ['update_timer', timerName]]) {
    try {
      const { stdout } = await exec('systemctl', ['--user', 'is-active', unit], { timeout: 5000 });
      const state = stdout.trim();
      add(`systemd.${id}`, state === 'active', state === 'active' ? 'ok' : 'warn', `${unit}: ${state}`);
    } catch (error) {
      const detail = error?.stdout?.trim?.() || error?.stderr?.trim?.() || 'inactive/not installed';
      add(`systemd.${id}`, false, 'warn', `${unit}: ${detail}`);
    }
  }
} else {
  add('systemd', false, 'warn', 'systemctl not available; stdio/manual operation is still possible');
}

try {
  const response = await fetch(`http://127.0.0.1:${mcpPort}/healthz`, { signal: AbortSignal.timeout(1500) });
  const body = response.ok ? await response.json() : undefined;
  add('http.health', Boolean(response.ok && body?.ok === true), response.ok && body?.ok === true ? 'ok' : 'warn', body ? JSON.stringify(body) : `HTTP ${response.status}`);
} catch (error) {
  add('http.health', false, 'warn', `loopback HTTP service unavailable: ${error instanceof Error ? error.message : String(error)}`);
}

const errors = checks.filter(item => !item.ok && item.level === 'error').length;
const warnings = checks.filter(item => !item.ok && item.level === 'warn').length;
const summary = {
  ok: errors === 0,
  strictOk: errors === 0 && warnings === 0,
  errors,
  warnings,
  dataHome,
  configHome,
  checks
};

if (jsonMode) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  for (const check of checks) {
    const mark = check.ok ? 'PASS' : check.level === 'error' ? 'FAIL' : 'WARN';
    console.log(`${mark.padEnd(4)}  ${check.id.padEnd(30)} ${check.detail}`);
  }
  console.log(`\nDoctor: ${errors} error(s), ${warnings} warning(s)`);
}

if (errors > 0 || (strict && warnings > 0)) process.exitCode = 1;
