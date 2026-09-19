import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { SerialPort } from 'serialport';
import type { HardwareDevice, SerialDeviceResolution, SerialDeviceSelector } from '../../engineering/types.js';

const execFileAsync = promisify(execFile);
const ST_VID = '0483';

function normHex(value?: string): string | undefined {
  if (!value) return undefined;
  return value.replace(/^0x/i, '').toUpperCase().padStart(4, '0');
}

function stableDeviceId(kind: string, provider: string, identity: string): string {
  return `${kind}:${provider}:${identity.replace(/[^A-Za-z0-9_.:-]+/g, '_')}`;
}

function normalizeSelectorHex(value?: string): string | undefined {
  return value ? normHex(value) : undefined;
}

export function resolveSerialDevice(devices: HardwareDevice[], selector: SerialDeviceSelector): SerialDeviceResolution {
  const stableIdentityPresent = Boolean(
    selector.deviceId ||
    selector.serialNumber ||
    (selector.vendorId && selector.productId)
  );
  if (!stableIdentityPresent) {
    throw new Error('Serial selector must include deviceId, serialNumber, or both vendorId and productId.');
  }

  const vendorId = normalizeSelectorHex(selector.vendorId);
  const productId = normalizeSelectorHex(selector.productId);
  const manufacturer = selector.manufacturer?.trim().toLowerCase();
  const nameContains = selector.nameContains?.trim().toLowerCase();

  const matches = devices.filter(device => {
    if (device.kind !== 'serial' || !device.path) return false;
    if (selector.deviceId && device.id !== selector.deviceId) return false;
    if (selector.serialNumber && device.serialNumber !== selector.serialNumber) return false;
    if (vendorId && normHex(device.vendorId) !== vendorId) return false;
    if (productId && normHex(device.productId) !== productId) return false;
    if (manufacturer && (device.manufacturer ?? '').trim().toLowerCase() !== manufacturer) return false;
    if (nameContains && !device.name.toLowerCase().includes(nameContains)) return false;
    return true;
  });

  if (matches.length === 0) {
    throw new Error('No serial device matches the configured stable selector.');
  }
  if (matches.length > 1) {
    const ids = matches.slice(0, 8).map(item => item.id).join(', ');
    throw new Error(`Serial selector is ambiguous: ${matches.length} devices match (${ids}). Add serialNumber/deviceId or narrow VID/PID.`);
  }

  const device = matches[0]!;
  return { selector: { ...selector }, device, path: device.path! };
}

export class HardwareDiscoveryAdapter {
  async resolveSerial(selector: SerialDeviceSelector): Promise<SerialDeviceResolution> {
    return resolveSerialDevice(await this.list(), selector);
  }

  async list(): Promise<HardwareDevice[]> {
    const [serial, probes] = await Promise.all([this.serialDevices(), this.debugProbes()]);
    const merged = new Map<string, HardwareDevice>();
    for (const device of [...serial, ...probes]) merged.set(device.id, device);
    return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async inspect(id: string): Promise<HardwareDevice> {
    const device = (await this.list()).find(item => item.id === id);
    if (!device) throw new Error(`Unknown hardware device '${id}'.`);
    return device;
  }

  private async serialDevices(): Promise<HardwareDevice[]> {
    let ports: Awaited<ReturnType<typeof SerialPort.list>> = [];
    try {
      ports = await SerialPort.list();
    } catch {
      return [];
    }
    return ports.map(portInfo => {
      const identity = portInfo.serialNumber || portInfo.path;
      return {
        id: stableDeviceId('serial', 'serialport', identity),
        kind: 'serial' as const,
        name: portInfo.manufacturer || portInfo.pnpId || portInfo.path,
        path: portInfo.path,
        serialNumber: portInfo.serialNumber,
        vendorId: normHex(portInfo.vendorId),
        productId: normHex(portInfo.productId),
        manufacturer: portInfo.manufacturer,
        provider: 'serialport',
        capabilities: ['serial-monitor', 'serial-write']
      };
    });
  }

  private async debugProbes(): Promise<HardwareDevice[]> {
    if (os.platform() === 'win32') return this.windowsDebugProbes();
    if (os.platform() === 'linux') return this.linuxDebugProbes();
    return [];
  }

  private async windowsDebugProbes(): Promise<HardwareDevice[]> {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like 'USB\\VID_0483&PID_374*' } |",
      'Select-Object FriendlyName,InstanceId | ConvertTo-Json -Compress'
    ].join(' ');
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 512 * 1024
      });
      if (!stdout.trim()) return [];
      const parsed = JSON.parse(stdout) as Record<string, unknown> | Array<Record<string, unknown>>;
      const records = Array.isArray(parsed) ? parsed : [parsed];
      return records.flatMap(record => {
        const instanceId = String(record.InstanceId ?? '');
        const match = instanceId.match(/VID_([0-9A-F]{4})&PID_([0-9A-F]{4})\\([^\\]+)$/i);
        if (!match) return [];
        const serial = match[3]?.includes('&') ? undefined : match[3];
        const identity = serial || instanceId;
        return [{
          id: stableDeviceId('debug-probe', 'windows-pnp', identity),
          kind: 'debug-probe' as const,
          name: String(record.FriendlyName ?? 'ST-Link'),
          serialNumber: serial,
          vendorId: normHex(match[1]),
          productId: normHex(match[2]),
          manufacturer: 'STMicroelectronics',
          provider: 'windows-pnp',
          capabilities: ['swd', 'openocd', 'gdb']
        }];
      });
    } catch {
      return [];
    }
  }

  private async linuxDebugProbes(): Promise<HardwareDevice[]> {
    const root = '/sys/bus/usb/devices';
    let entries: string[];
    try { entries = await fs.readdir(root); } catch { return []; }
    const devices: HardwareDevice[] = [];
    for (const entry of entries) {
      const deviceRoot = path.join(root, entry);
      try {
        const vendorId = (await fs.readFile(path.join(deviceRoot, 'idVendor'), 'utf8')).trim().toUpperCase();
        const productId = (await fs.readFile(path.join(deviceRoot, 'idProduct'), 'utf8')).trim().toUpperCase();
        if (vendorId !== ST_VID || !productId.startsWith('374')) continue;
        let serial: string | undefined;
        try {
          const raw = (await fs.readFile(path.join(deviceRoot, 'serial'), 'utf8')).trim();
          if (/^[A-Za-z0-9_.:-]+$/.test(raw)) serial = raw;
        } catch { /* optional */ }
        const identity = serial || `${vendorId}:${productId}:${entry}`;
        devices.push({
          id: stableDeviceId('debug-probe', 'linux-sysfs', identity),
          kind: 'debug-probe',
          name: `ST-Link ${productId}`,
          serialNumber: serial,
          vendorId,
          productId,
          manufacturer: 'STMicroelectronics',
          provider: 'linux-sysfs',
          capabilities: ['swd', 'openocd', 'gdb']
        });
      } catch { /* non-USB sysfs node */ }
    }
    return devices;
  }
}
