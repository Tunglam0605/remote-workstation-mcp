import os from 'node:os';

export function validateSerialPortPath(value: string, platform = os.platform()): string {
  const port = value.trim();
  if (!port || /[\r\n\0]/.test(port)) throw new Error('Invalid serial port path.');
  if (platform === 'win32') {
    if (!/^COM[1-9][0-9]{0,3}$/i.test(port)) throw new Error('Invalid Windows serial port; expected COM1..COM9999.');
    return port.toUpperCase();
  }
  if (platform === 'linux') {
    if (!port.startsWith('/dev/') || port.includes('..') || !/^\/dev\/[A-Za-z0-9._/-]+$/.test(port)) {
      throw new Error('Invalid Linux serial port; expected a safe /dev/... device path.');
    }
    return port;
  }
  if (!port.startsWith('/dev/') || port.includes('..') || !/^\/dev\/[A-Za-z0-9._/-]+$/.test(port)) {
    throw new Error('Invalid serial port path.');
  }
  return port;
}
