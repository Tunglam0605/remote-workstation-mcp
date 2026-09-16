import * as pty from 'node-pty';
import { SerialPort } from 'serialport';

const ports = await SerialPort.list();
if (!Array.isArray(ports)) throw new Error('SerialPort.list() did not return an array.');

const terminal = pty.spawn(process.execPath, ['-e', "console.log('RWMCP_NATIVE_SMOKE_OK')"], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
  ...(process.platform === 'win32' ? { useConpty: true } : {})
});
let output = '';
const exit = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('PTY smoke timed out.')), 10000);
  terminal.onData(data => { output += data; });
  terminal.onExit(event => { clearTimeout(timer); resolve(event); });
});
try { terminal.kill(); } catch {}
if (!output.includes('RWMCP_NATIVE_SMOKE_OK')) throw new Error(`PTY output missing marker: ${JSON.stringify(output)}`);
if (exit.exitCode !== 0) throw new Error(`PTY exited with ${exit.exitCode}.`);
console.log(JSON.stringify({ serialPorts: ports.length, pty: true, exitCode: exit.exitCode }));
