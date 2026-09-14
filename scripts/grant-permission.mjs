#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const home = os.homedir();
const dataHome = process.env.RWMCP_HOME ?? path.join(home, '.local/share/remote-workstation-mcp');
const leasePath = path.resolve(process.env.RWMCP_LEASE ?? path.join(dataHome, 'runtime/permission-lease.json'));
const args = process.argv.slice(2);

function value(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseTtl(input) {
  const match = String(input ?? '').match(/^(\d+)(s|m|h)$/);
  if (!match) throw new Error('TTL must look like 30m, 2h or 600s.');
  const amount = Number(match[1]);
  const multiplier = match[2] === 's' ? 1000 : match[2] === 'm' ? 60_000 : 3_600_000;
  const ms = amount * multiplier;
  if (ms < 10_000 || ms > 24 * 60 * 60 * 1000) throw new Error('TTL must be between 10 seconds and 24 hours.');
  return ms;
}

async function restartIfAvailable() {
  try {
    await exec('systemctl', ['--user', 'restart', 'remote-workstation-mcp.service']);
  } catch {
    // The owner may be running a stdio profile instead of the managed HTTP service.
  }
}

async function readLease() {
  try {
    return JSON.parse(await fs.readFile(leasePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

if (args.includes('--status')) {
  const lease = await readLease();
  console.log(JSON.stringify({ path: leasePath, lease, active: Boolean(lease && Date.parse(lease.expiresAt) > Date.now()) }, null, 2));
  process.exit(0);
}

if (args.includes('--revoke')) {
  await fs.rm(leasePath, { force: true });
  await restartIfAvailable();
  console.log(`Permission lease revoked: ${leasePath}`);
  process.exit(0);
}

const mode = value('--mode');
if (mode !== 'elevated' && mode !== 'full_control') {
  throw new Error('Use --mode elevated or --mode full_control.');
}
const ttlMs = parseTtl(value('--ttl') ?? '30m');
const clientId = value('--client-id') ?? process.env.RWMCP_CLIENT_ID;
const reason = value('--reason');
const now = new Date();
const lease = {
  mode,
  issuedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  ...(clientId ? { clientId } : {}),
  ...(reason ? { reason } : {})
};

await fs.mkdir(path.dirname(leasePath), { recursive: true });
await fs.writeFile(leasePath, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
await fs.chmod(leasePath, 0o600);
await restartIfAvailable();
console.log(JSON.stringify({ path: leasePath, lease }, null, 2));
console.log('This lease only enables actions also allowed by the local policy gates. It expires automatically.');
