import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EngineeringCommandResult, OpenOcdDiagnostic } from '../../engineering/types.js';
import { resolveExecutable, resolveFirstExecutable } from './executable-resolver.js';

export interface ResolvedOpenOcdExecutable {
  path: string;
  source: 'owner-override' | 'path' | 'known-install';
  scriptsPath?: string;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function validOpenOcdScriptsRoot(candidate: string): Promise<string | undefined> {
  if (!path.isAbsolute(candidate)) return undefined;
  const required = path.join(candidate, 'interface', 'stlink.cfg');
  return await exists(required) ? path.resolve(candidate) : undefined;
}

async function resolveConfiguredScriptsRoot(): Promise<string | undefined> {
  const configured = process.env.RWMCP_OPENOCD_SCRIPTS?.trim();
  if (!configured) return undefined;
  if (!path.isAbsolute(configured)) {
    throw new Error('RWMCP_OPENOCD_SCRIPTS must be an absolute path controlled by the workstation owner.');
  }
  const resolved = await validOpenOcdScriptsRoot(configured);
  if (!resolved) throw new Error(`Configured OpenOCD scripts directory does not contain interface/stlink.cfg: ${configured}`);
  return resolved;
}

async function discoverAdjacentScripts(executable: string): Promise<string | undefined> {
  const bin = path.dirname(executable);
  const prefix = path.dirname(bin);
  for (const candidate of [
    path.join(prefix, 'share', 'openocd', 'scripts'),
    path.join(prefix, 'scripts'),
    path.join(bin, '..', 'share', 'openocd', 'scripts')
  ]) {
    const resolved = await validOpenOcdScriptsRoot(candidate);
    if (resolved) return resolved;
  }
  return undefined;
}

async function normalizeCubeIdeRoot(candidate: string): Promise<string | undefined> {
  if (!path.isAbsolute(candidate)) return undefined;
  for (const root of [candidate, path.join(candidate, 'STM32CubeIDE')]) {
    if (await exists(path.join(root, 'plugins'))) return path.resolve(root);
  }
  return undefined;
}

async function newestPluginDirectories(pluginsRoot: string, prefix: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(pluginsRoot, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
      .map(entry => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: 'base' }))
      .map(name => path.join(pluginsRoot, name));
  } catch {
    return [];
  }
}

async function configuredAndKnownCubeIdeRoots(): Promise<string[]> {
  const candidates: string[] = [];
  const configured = process.env.RWMCP_STM32CUBEIDE_HOME?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error('RWMCP_STM32CUBEIDE_HOME must be an absolute path controlled by the workstation owner.');
    }
    candidates.push(configured);
  }

  if (os.platform() === 'win32') {
    const stRoot = process.env.RWMCP_ST_HOME?.trim() || 'C:\\ST';
    if (path.isAbsolute(stRoot)) {
      try {
        const entries = await fs.readdir(stRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && /^STM32CubeIDE(?:_|$)/i.test(entry.name)) {
            candidates.push(path.join(stRoot, entry.name));
          }
        }
      } catch {
        // Optional known-install root.
      }
    }

    const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
      .filter((value): value is string => Boolean(value));
    for (const base of programFiles) {
      candidates.push(
        path.join(base, 'STMicroelectronics', 'STM32Cube', 'STM32CubeIDE'),
        path.join(base, 'STMicroelectronics', 'STM32CubeIDE')
      );
    }
  }

  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = await normalizeCubeIdeRoot(candidate);
    if (!normalized) continue;
    const key = os.platform() === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(normalized);
  }
  return roots;
}

async function discoverCubeIdeOpenOcd(): Promise<ResolvedOpenOcdExecutable | undefined> {
  for (const ideRoot of await configuredAndKnownCubeIdeRoots()) {
    const plugins = path.join(ideRoot, 'plugins');
    const externalTools = await newestPluginDirectories(
      plugins,
      'com.st.stm32cube.ide.mcu.externaltools.openocd.win32_'
    );
    const debugPlugins = await newestPluginDirectories(
      plugins,
      'com.st.stm32cube.ide.mcu.debug.openocd_'
    );

    let executable: string | undefined;
    for (const plugin of externalTools) {
      const candidate = path.join(plugin, 'tools', 'bin', 'openocd.exe');
      if (await exists(candidate)) {
        executable = path.resolve(candidate);
        break;
      }
    }
    if (!executable) continue;

    let scriptsPath: string | undefined;
    for (const plugin of debugPlugins) {
      const candidate = path.join(plugin, 'resources', 'openocd', 'st_scripts');
      const resolved = await validOpenOcdScriptsRoot(candidate);
      if (resolved) {
        scriptsPath = resolved;
        break;
      }
    }
    if (!scriptsPath) {
      scriptsPath = await discoverAdjacentScripts(executable);
    }
    if (!scriptsPath) continue;

    return { path: executable, source: 'known-install', scriptsPath };
  }
  return undefined;
}

export async function resolveOpenOcdExecutable(): Promise<ResolvedOpenOcdExecutable | undefined> {
  const configuredScripts = await resolveConfiguredScriptsRoot();
  const configured = process.env.RWMCP_OPENOCD_EXECUTABLE?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error('RWMCP_OPENOCD_EXECUTABLE must be an absolute path controlled by the workstation owner.');
    }
    const resolved = await resolveExecutable(configured);
    if (!resolved) throw new Error(`Configured OpenOCD executable does not exist: ${configured}`);
    const scriptsPath = configuredScripts ?? await discoverAdjacentScripts(resolved);
    return {
      path: resolved,
      source: 'owner-override',
      ...(scriptsPath ? { scriptsPath } : {})
    };
  }

  const found = await resolveFirstExecutable(['openocd']);
  if (found) {
    const scriptsPath = configuredScripts ?? await discoverAdjacentScripts(found.path);
    return { path: found.path, source: 'path', ...(scriptsPath ? { scriptsPath } : {}) };
  }

  const known = await discoverCubeIdeOpenOcd();
  if (known) {
    return {
      ...known,
      ...(configuredScripts ? { scriptsPath: configuredScripts } : {})
    };
  }
  return undefined;
}

export function openOcdSearchPathArgs(resolved: ResolvedOpenOcdExecutable): string[] {
  const scripts = resolved.scriptsPath?.trim();
  if (!scripts) return [];
  if (!path.isAbsolute(scripts) || /[\0\r\n]/.test(scripts)) {
    throw new Error('Resolved OpenOCD scripts path must be an absolute path without control characters.');
  }
  return ['-s', scripts];
}

const MIN_ADAPTER_SPEED_KHZ = 50;
const MAX_ADAPTER_SPEED_KHZ = 24_000;

export function validateAdapterSpeedKhz(value?: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < MIN_ADAPTER_SPEED_KHZ || value > MAX_ADAPTER_SPEED_KHZ) {
    throw new Error(`adapterSpeedKhz must be an integer between ${MIN_ADAPTER_SPEED_KHZ} and ${MAX_ADAPTER_SPEED_KHZ}.`);
  }
  return value;
}

function diagnostic(code: OpenOcdDiagnostic['code'], message: string, retryable: boolean, hint?: string): OpenOcdDiagnostic {
  return { code, ok: code === 'ok', retryable, message, ...(hint ? { hint } : {}) };
}

export function classifyOpenOcdResult(result: EngineeringCommandResult): OpenOcdDiagnostic {
  if (result.timedOut) {
    return diagnostic('backend-timeout', 'OpenOCD exceeded the bounded execution deadline.', true, 'Check target/probe connectivity and retry at a lower SWD clock if needed.');
  }
  if (result.exitCode === 0) return diagnostic('ok', 'OpenOCD completed successfully.', false);

  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (/libusb_error_access|access denied|permission denied/.test(text)) {
    return diagnostic('probe-permission-denied', 'The debug probe is present but cannot be opened with the current OS permissions.', false, 'Check udev/USB permissions or whether another privileged process owns the probe.');
  }
  if (/unable to find.*(cmsis-dap|st-?link|debug adapter)|no device found|open failed.*st-?link|couldn.?t find.*st-?link/.test(text)) {
    return diagnostic('probe-not-found', 'OpenOCD could not find the requested debug probe.', true, 'Confirm the probe is connected and the selected serial number matches the intended ST-Link.');
  }
  if (/target voltage.*(low|too low|not detected)|target voltage: *0(?:\.0+)?v|no target voltage/.test(text)) {
    return diagnostic('target-power-invalid', 'Target voltage is missing or outside a usable range.', true, 'Verify target power, common ground, and SWD wiring before retrying.');
  }
  if (/target examination failed|failed to examine|unable to halt|timed out while waiting for target halted|init mode failed/.test(text)) {
    return diagnostic('target-connect-failed', 'OpenOCD reached the probe but could not establish a usable target debug session.', true, 'Check target config, reset state and SWD clock; use connect-under-reset only through a future typed workflow.');
  }
  if (/verify_image failed|contents mismatch|verification failed|verify failed/.test(text)) {
    return diagnostic('verify-failed', 'Program verification failed.', true, 'Do not continue as if flashing succeeded; inspect power, flash protection and the selected artifact.');
  }
  if (/can.?t find .*target\/.*\.cfg|unable to find .*target\/.*\.cfg|script.*not found|no such file.*\.cfg/.test(text)) {
    return diagnostic('target-config-not-found', 'OpenOCD could not load the selected target configuration.', false, 'Install a compatible OpenOCD package or choose a supported packaged target/*.cfg identifier.');
  }
  return diagnostic('backend-failed', 'OpenOCD exited with an unclassified backend error.', true, 'Inspect the bounded stdout/stderr returned with this operation before retrying.');
}

export function openOcdAdapterSpeedArgs(adapterSpeedKhz?: number): string[] {
  const speed = validateAdapterSpeedKhz(adapterSpeedKhz);
  return speed === undefined ? [] : ['-c', `adapter speed ${speed}`];
}
