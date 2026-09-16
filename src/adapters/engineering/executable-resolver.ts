import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function resolveExecutable(command: string): Promise<string | undefined> {
  const direct = path.isAbsolute(command) || command.includes('/') || command.includes('\\');
  if (direct) {
    try { await fs.access(command); return path.resolve(command); } catch { return undefined; }
  }
  const directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const hasExtension = path.extname(command) !== '';
  const extensions = os.platform() === 'win32'
    ? (hasExtension ? [''] : (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';'))
    : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try { await fs.access(candidate); return candidate; } catch { /* continue */ }
    }
  }
  return undefined;
}

export async function resolveFirstExecutable(candidates: string[]): Promise<{ name: string; path: string } | undefined> {
  for (const candidate of candidates) {
    const resolved = await resolveExecutable(candidate);
    if (resolved) return { name: candidate, path: resolved };
  }
  return undefined;
}
