export function validateOpenOcdTargetConfig(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (!/^target\/[A-Za-z0-9_.+-]+\.cfg$/.test(normalized)) {
    throw new Error('OpenOCD targetConfig must be a packaged target/<name>.cfg identifier; arbitrary Tcl/config paths are not allowed.');
  }
  return normalized;
}

export function validateProbeSerial(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9_.:-]+$/.test(value)) throw new Error('probeSerial contains unsupported characters.');
  return value;
}
