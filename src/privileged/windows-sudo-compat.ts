import path from 'node:path';
import { validateAdminRequestProgram } from './approval-store.js';

export interface WindowsSudoCompatibilityInput {
  program: string;
  args: string[];
  cwd?: string;
}

export interface WindowsSudoCompatibilityResult extends WindowsSudoCompatibilityInput {
  sudoCompatibility: boolean;
  authorization: 'owner-approved-runas-uac' | 'existing-admin-request';
}

/**
 * Windows 11's native sudo.exe can be disabled, and invoking it from an MCP
 * service cannot safely interact with its elevation prompt. Accept the *intent*
 * expressed as sudo <direct-executable> [argv] only via admin_request; persist
 * the underlying executable and require the existing owner-local approval,
 * command-hash check, and RunAs/UAC helper. Never spawn sudo.exe or a shell.
 */
export function normalizeWindowsSudoRequest(
  input: WindowsSudoCompatibilityInput,
  platform: NodeJS.Platform = process.platform
): WindowsSudoCompatibilityResult {
  const program = input.program.trim();
  if (platform !== 'win32' || (program.toLowerCase() !== 'sudo' && program.toLowerCase() !== 'sudo.exe')) {
    return { ...input, authorization: 'existing-admin-request', sudoCompatibility: false };
  }
  const argv = [...input.args];
  if (argv[0] === '--') argv.shift();
  if (argv.length === 0) {
    throw new Error('WINDOWS_SUDO_TARGET_REQUIRED: provide an executable after sudo, such as sudo winget.exe --version.');
  }
  const target = argv.shift()!.trim();
  if (!target || target.startsWith('-') || /[\r\n\0]/.test(target)) {
    throw new Error('WINDOWS_SUDO_FLAGS_UNSUPPORTED: sudo flags and invalid executable names are not supported by the owner-approved UAC compatibility path.');
  }
  const basename = path.win32.basename(target).toLowerCase();
  if (basename === 'sudo' || basename === 'sudo.exe') {
    throw new Error('WINDOWS_SUDO_NESTED: nested sudo elevation is not supported.');
  }
  if (!basename.endsWith('.exe')) {
    throw new Error('WINDOWS_SUDO_DIRECT_EXE_REQUIRED: provide a direct .exe, never .bat/.cmd/.ps1 or a shell command.');
  }
  validateAdminRequestProgram(target, 'win32');
  // The resolved command (not 'sudo') is what the owner reviews and approves.
  return {
    program: target,
    args: argv,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    sudoCompatibility: true,
    authorization: 'owner-approved-runas-uac'
  };
}
