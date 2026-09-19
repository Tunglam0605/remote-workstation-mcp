import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface ExecutableResolveOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT ?? process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM';
  const items = raw.split(';').map(item => item.trim()).filter(Boolean);
  return items.length > 0 ? items : ['.EXE', '.CMD', '.BAT', '.COM'];
}

async function executable(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an already policy-approved executable token without invoking a shell.
 *
 * Security boundary: callers must perform their policy allowlist check before
 * calling this helper. This function only turns that approved token into the
 * concrete executable path used by a provider/worker.
 */
export async function resolveExecutablePath(
  command: string,
  options: ExecutableResolveOptions = {}
): Promise<string | undefined> {
  const platform = options.platform ?? os.platform();
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const hasPathComponent =
    path.isAbsolute(command) ||
    command.includes('/') ||
    command.includes('\\');

  if (hasPathComponent) {
    const candidate = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return await executable(candidate) ? candidate : undefined;
  }

  const pathValue = env.PATH ?? process.env.PATH ?? '';
  const directories = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = platform === 'win32' ? windowsExtensions(env) : [''];
  const commandExt = platform === 'win32' ? path.extname(command).toLowerCase() : '';
  const normalizedExtensions = extensions.map(item => item.toLowerCase());
  const names = platform === 'win32' && commandExt && normalizedExtensions.includes(commandExt)
    ? [command]
    : platform === 'win32'
      ? extensions.map(extension => `${command}${extension}`)
      : [command];

  for (const directory of directories) {
    const base = path.isAbsolute(directory) ? directory : path.resolve(cwd, directory);
    for (const name of names) {
      const candidate = path.join(base, name);
      if (await executable(candidate)) return candidate;
    }
  }

  return undefined;
}
