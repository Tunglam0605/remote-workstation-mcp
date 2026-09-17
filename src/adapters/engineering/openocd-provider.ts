import path from 'node:path';
import type { EngineeringCommandResult, OpenOcdDiagnostic } from '../../engineering/types.js';
import { resolveExecutable, resolveFirstExecutable } from './executable-resolver.js';


export interface ResolvedOpenOcdExecutable {
  path: string;
  source: 'owner-override' | 'path';
}

export async function resolveOpenOcdExecutable(): Promise<ResolvedOpenOcdExecutable | undefined> {
  const configured = process.env.RWMCP_OPENOCD_EXECUTABLE?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error('RWMCP_OPENOCD_EXECUTABLE must be an absolute path controlled by the workstation owner.');
    }
    const resolved = await resolveExecutable(configured);
    if (!resolved) throw new Error(`Configured OpenOCD executable does not exist: ${configured}`);
    return { path: resolved, source: 'owner-override' };
  }
  const found = await resolveFirstExecutable(['openocd']);
  return found ? { path: found.path, source: 'path' } : undefined;
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
