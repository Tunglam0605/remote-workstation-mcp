import os from 'node:os';

const NEVER_INHERIT = /(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIAL)/i;
const WINDOWS_RUNTIME_ENV = ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT'] as const;

function readEnv(source: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = source[name];
  if (direct !== undefined || os.platform() !== 'win32') return direct;
  const actualKey = Object.keys(source).find(key => key.toLowerCase() === name.toLowerCase());
  return actualKey ? source[actualKey] : undefined;
}

export function buildSafeEnvironment(allowNames: string[], source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of allowNames) {
    if (NEVER_INHERIT.test(name)) continue;
    const value = readEnv(source, name);
    if (value !== undefined) result[name] = value;
  }

  // Windows system executables and PowerShell depend on a small set of OS runtime
  // variables even when the owner's general child-process environment is tightly
  // allowlisted. These names contain no credentials and are added only on Windows.
  if (os.platform() === 'win32') {
    for (const name of WINDOWS_RUNTIME_ENV) {
      const value = readEnv(source, name);
      if (value !== undefined) result[name] = value;
    }
  }

  return result;
}
