import { existsSync } from 'node:fs';
import path from 'node:path';

export interface NpmLaunchOptions {
  platform: string;
  env: NodeJS.ProcessEnv;
  nodeExecutable: string;
}

export interface ProcessLaunch {
  program: string;
  args: string[];
}

/**
 * Resolve only the owner-authorized Windows npm shim to its JavaScript entry point.
 * The caller MUST check policy for the original requested executable first.
 * Never route arbitrary .cmd files through a shell or interpolate arguments.
 */
export function resolveAuthorizedNpmLaunch(
  program: string,
  args: string[],
  options: NpmLaunchOptions
): ProcessLaunch {
  const requestedName = path.win32.basename(program).toLowerCase();
  if (options.platform !== 'win32' || (requestedName !== 'npm' && requestedName !== 'npm.cmd')) {
    return { program, args: [...args] };
  }

  const explicitDirectory = path.win32.dirname(program);
  const directories = explicitDirectory === '.'
    ? (options.env.PATH ?? options.env.Path ?? '').split(path.win32.delimiter).filter(Boolean)
    : [explicitDirectory];

  for (const rawDirectory of directories) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, '');
    if (!directory) continue;
    const shim = path.win32.join(directory, 'npm.cmd');
    const cli = path.win32.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(shim) && existsSync(cli)) {
      return { program: options.nodeExecutable, args: [cli, ...args] };
    }
  }

  throw new Error('Authorized Windows npm has no colocated npm.cmd / npm-cli.js companion on PATH.');
}
