import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function readRuntimeEpoch(filePath: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, 'utf8')) as { epoch?: unknown };
    return typeof value.epoch === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value.epoch)
      ? value.epoch
      : undefined;
  } catch {
    return undefined;
  }
}

export async function startRuntimeEpoch(filePath: string): Promise<string> {
  const epoch = crypto.randomUUID();
  const target = path.resolve(filePath);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(temporary, JSON.stringify({ epoch }), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return epoch;
}
