import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import type { PermissionLease } from './model.js';

const leaseSchema = z.object({
  mode: z.enum(['elevated', 'full_control']),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  reason: z.string().max(500).optional(),
  clientId: z.string().min(1).max(128).optional()
});

export function permissionLeasePath(explicitPath?: string): string {
  return path.resolve(explicitPath ?? process.env.RWMCP_LEASE ?? 'runtime/permission-lease.json');
}

export async function loadPermissionLease(explicitPath?: string): Promise<PermissionLease | undefined> {
  const selected = permissionLeasePath(explicitPath);
  try {
    const raw = await fs.readFile(selected, 'utf8');
    const parsed = leaseSchema.parse(JSON.parse(raw));
    const issuedAt = Date.parse(parsed.issuedAt);
    const expiresAt = Date.parse(parsed.expiresAt);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
      throw new Error('Permission lease timestamps are invalid.');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
