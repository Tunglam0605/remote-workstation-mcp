import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupConfigDir } from '../setup/settings.js';
import { currentPrincipal } from '../security/request-principal.js';

export type AdminRequestState = 'pending' | 'approved' | 'denied' | 'running' | 'succeeded' | 'failed' | 'expired';

export interface AdminRequestResult {
  exitCode: number | null;
  output: string;
  finishedAt: string;
  error?: string;
}

export interface AdminRequest {
  version: 1;
  id: string;
  state: AdminRequestState;
  createdAt: string;
  expiresAt: string;
  clientId: string;
  clientType: string;
  program: string;
  args: string[];
  cwd?: string;
  reason: string;
  commandHash: string;
  approvedAt?: string;
  deniedAt?: string;
  startedAt?: string;
  result?: AdminRequestResult;
}

const REQUEST_TTL_MS = 5 * 60_000;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function adminApprovalDir(): string {
  return path.resolve(process.env.RWMCP_ADMIN_APPROVAL_DIR?.trim() || path.join(setupConfigDir(), 'runtime', 'admin-approvals'));
}

export function adminRequestPath(id: string): string {
  if (!ID_RE.test(id)) throw new Error('Invalid admin request id.');
  return path.join(adminApprovalDir(), `${id}.json`);
}

function commandHash(input: { clientId: string; program: string; args: string[]; cwd?: string; reason: string }): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    clientId: input.clientId,
    program: input.program,
    args: input.args,
    cwd: input.cwd ?? '',
    reason: input.reason
  })).digest('hex');
}

async function atomicWrite(file: string, value: AdminRequest): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}
`;
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
}

async function readRaw(id: string): Promise<AdminRequest> {
  const raw = JSON.parse(await fs.readFile(adminRequestPath(id), 'utf8')) as AdminRequest;
  if (raw.version !== 1 || raw.id !== id) throw new Error('Admin request file is invalid.');
  return raw;
}

async function expireIfNeeded(request: AdminRequest): Promise<AdminRequest> {
  if (request.state !== 'pending') return request;
  const expiry = Date.parse(request.expiresAt);
  if (Number.isFinite(expiry) && expiry > Date.now()) return request;
  const expired: AdminRequest = { ...request, state: 'expired' };
  await atomicWrite(adminRequestPath(request.id), expired);
  return expired;
}

export async function createAdminRequest(input: { program: string; args?: string[]; cwd?: string; reason: string }): Promise<AdminRequest> {
  const principal = currentPrincipal();
  const clientId = principal?.id ?? process.env.RWMCP_CLIENT_ID ?? 'local';
  const clientType = principal?.type ?? process.env.RWMCP_CLIENT_TYPE ?? 'mcp-client';
  const program = input.program.trim();
  const args = [...(input.args ?? [])];
  const reason = input.reason.trim();
  const cwd = input.cwd?.trim();
  if (!program) throw new Error('program is required.');
  if (/[\0\r\n]/.test(program)) throw new Error('program contains invalid control characters.');
  if (!reason) throw new Error('reason is required.');
  if (args.length > 100) throw new Error('Admin request supports at most 100 arguments.');
  if (args.some(argument => argument.includes('\0'))) throw new Error('arguments may not contain NUL characters.');
  if (cwd && !path.isAbsolute(cwd)) throw new Error('cwd must be an absolute path when supplied.');
  const id = crypto.randomUUID();
  const createdAt = new Date();
  const request: AdminRequest = {
    version: 1,
    id,
    state: 'pending',
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + REQUEST_TTL_MS).toISOString(),
    clientId,
    clientType,
    program,
    args,
    ...(cwd ? { cwd } : {}),
    reason,
    commandHash: commandHash({ clientId, program, args, cwd, reason })
  };
  await atomicWrite(adminRequestPath(id), request);
  return request;
}

export async function readAdminRequest(id: string): Promise<AdminRequest> {
  return await expireIfNeeded(await readRaw(id));
}

export async function listAdminRequests(): Promise<AdminRequest[]> {
  const dir = adminApprovalDir();
  let names: string[];
  try { names = await fs.readdir(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const requests: AdminRequest[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!ID_RE.test(id)) continue;
    try { requests.push(await readAdminRequest(id)); } catch { /* skip corrupt entries */ }
  }
  return requests.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export async function approveAdminRequest(id: string, expectedCommandHash: string): Promise<{ request: AdminRequest; file: string; fileSha256: string }> {
  if (!/^[a-f0-9]{64}$/i.test(expectedCommandHash)) throw new Error('expectedCommandHash must be a SHA-256 hex digest.');
  const current = await readAdminRequest(id);
  if (current.state !== 'pending') throw new Error(`Admin request is ${current.state}; only pending requests can be approved.`);
  if (current.commandHash.toLowerCase() !== expectedCommandHash.toLowerCase()) {
    throw new Error('Admin request changed after it was displayed; refresh and review it again before approving.');
  }
  const approved: AdminRequest = { ...current, state: 'approved', approvedAt: new Date().toISOString() };
  const file = adminRequestPath(id);
  await atomicWrite(file, approved);
  const bytes = await fs.readFile(file);
  return { request: approved, file, fileSha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

export async function denyAdminRequest(id: string): Promise<AdminRequest> {
  const current = await readAdminRequest(id);
  if (current.state !== 'pending') throw new Error(`Admin request is ${current.state}; only pending requests can be denied.`);
  const denied: AdminRequest = { ...current, state: 'denied', deniedAt: new Date().toISOString() };
  await atomicWrite(adminRequestPath(id), denied);
  return denied;
}

export async function markAdminRequestRunning(id: string): Promise<AdminRequest> {
  const current = await readAdminRequest(id);
  if (current.state !== 'approved') throw new Error(`Admin request is ${current.state}; only approved requests can start.`);
  const running: AdminRequest = { ...current, state: 'running', startedAt: new Date().toISOString() };
  await atomicWrite(adminRequestPath(id), running);
  return running;
}

export async function finishAdminRequest(
  id: string,
  result: { exitCode: number | null; output?: string; error?: string }
): Promise<AdminRequest> {
  const current = await readAdminRequest(id);
  if (current.state !== 'running') throw new Error(`Admin request is ${current.state}; only running requests can finish.`);
  const exitCode = result.exitCode;
  const succeeded = exitCode === 0 && !result.error;
  const finished: AdminRequest = {
    ...current,
    state: succeeded ? 'succeeded' : 'failed',
    result: {
      exitCode,
      output: (result.output ?? '').slice(-262144),
      finishedAt: new Date().toISOString(),
      ...(result.error ? { error: result.error.slice(0, 4096) } : {})
    }
  };
  await atomicWrite(adminRequestPath(id), finished);
  return finished;
}
