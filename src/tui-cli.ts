#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { SERVER_VERSION } from './capabilities.js';
import {
  readTuiRuntimeState,
  restartManagedRuntime,
  setAccessMode,
  setDeviceName,
  setMcpPort,
  setRuntimeApiKey,
  setTunnelId
} from './tui/config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stdin = process.stdin;
const stdout = process.stdout;

if (process.argv.includes('--status')) {
  const state = await readTuiRuntimeState(repoRoot);
  const safe = {
    version: SERVER_VERSION,
    deviceName: state.deviceName,
    platform: state.platform,
    service: state.service,
    tunnelReady: state.tunnelReady,
    mcpPort: state.mcpPort,
    accessMode: state.accessMode,
    tunnelId: state.tunnelId,
    workspace: { name: state.workspaceLabel, root: state.workspaceRoot },
    runtimeApiKeyConfigured: state.runtimeKeyConfigured
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(safe, null, 2));
  else {
    console.log(`Remote Workstation MCP v${SERVER_VERSION}`);
    console.log(`Device: ${safe.deviceName}`);
    console.log(`Service: ${safe.service}`);
    console.log(`Tunnel: ${safe.tunnelReady === true ? 'READY' : safe.tunnelReady === false ? 'NOT READY' : 'n/a'}`);
    console.log(`MCP: 127.0.0.1:${safe.mcpPort}`);
    console.log(`Access: ${safe.accessMode}`);
    console.log(`Workspace: ${safe.workspace.name} -> ${safe.workspace.root}`);
    console.log(`Runtime API key: ${safe.runtimeApiKeyConfigured ? 'configured (hidden)' : 'not configured'}`);
  }
  process.exit(0);
}

if (!stdin.isTTY || !stdout.isTTY) {
  console.error('Remote Workstation TUI requires an interactive terminal. Use --status --json for non-interactive status.');
  process.exit(2);
}

const ESC = '\u001b[';
const clear = () => stdout.write(`${ESC}2J${ESC}H`);
const cyan = (text: string) => `${ESC}36m${text}${ESC}0m`;
const green = (text: string) => `${ESC}32m${text}${ESC}0m`;
const yellow = (text: string) => `${ESC}33m${text}${ESC}0m`;
const dim = (text: string) => `${ESC}2m${text}${ESC}0m`;
const bold = (text: string) => `${ESC}1m${text}${ESC}0m`;

interface MenuItem {
  label: string;
  hint: string;
  action: () => Promise<string | void>;
}

function line(label: string, value: string): string {
  return `  ${label.padEnd(14)} ${value}`;
}

async function promptText(label: string, current = ''): Promise<string> {
  stdin.setRawMode(false);
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  const answer = await rl.question(`${label}${current ? ` [${current}]` : ''}: `);
  rl.close();
  stdin.setRawMode(true);
  stdin.resume();
  return (answer || current).trim();
}

async function promptSecret(label: string): Promise<string> {
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write(`${label}: `);
  return await new Promise<string>(resolve => {
    let value = '';
    const handler = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
        .replace(/\u001b\[200~/g, '')
        .replace(/\u001b\[201~/g, '');
      for (const char of text) {
        if (char === '\r' || char === '\n') {
          stdin.off('data', handler);
          stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (char === '\u0003' || char === '\u001b') {
          stdin.off('data', handler);
          stdout.write('\n');
          resolve('');
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    stdin.on('data', handler);
  });
}

function readKey(): Promise<string> {
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise(resolve => {
    const handler = (chunk: Buffer) => {
      const value = chunk.toString('utf8');
      stdin.off('data', handler);
      if (value === '\u0003') resolve('q');
      else if (value === '\r' || value === '\n') resolve('enter');
      else if (value === '\u001b[A') resolve('up');
      else if (value === '\u001b[B') resolve('down');
      else if (value === '\u001b') resolve('escape');
      else resolve(value.toLowerCase());
    };
    stdin.on('data', handler);
  });
}

async function chooseAccessMode(current: string): Promise<'read_only' | 'workspace' | 'full_control'> {
  const values = ['read_only', 'workspace', 'full_control'] as const;
  const labels = ['Read only', 'Workspace', 'Full access'];
  let index = Math.max(0, values.indexOf(current as typeof values[number]));
  while (true) {
    clear();
    console.log(bold('Select access mode'));
    console.log(dim('↑/↓ move   Enter select   Esc cancel\n'));
    labels.forEach((label, i) => console.log(`${i === index ? cyan('›') : ' '} ${label}`));
    const key = await readKey();
    if (key === 'up') index = (index + values.length - 1) % values.length;
    else if (key === 'down') index = (index + 1) % values.length;
    else if (key === 'enter') return values[index]!;
    else if (key === 'escape' || key === 'q') return current as typeof values[number];
  }
}

let selected = 0;
let message = '';
let running = true;

try {
  while (running) {
    const state = await readTuiRuntimeState(repoRoot);
    const items: MenuItem[] = [
      {
        label: 'Access mode',
        hint: state.accessMode,
        action: async () => {
          const mode = await chooseAccessMode(state.accessMode);
          if (mode === state.accessMode) return 'Access mode unchanged.';
          await setAccessMode(repoRoot, mode);
          await restartManagedRuntime(repoRoot);
          return `Access mode changed to ${mode}; runtime restarted.`;
        }
      },
      {
        label: 'MCP port',
        hint: String(state.mcpPort),
        action: async () => {
          const port = Number(await promptText('MCP port', String(state.mcpPort)));
          await setMcpPort(port);
          await restartManagedRuntime(repoRoot);
          return `MCP port changed to ${port}; runtime restarted.`;
        }
      },
      {
        label: 'Device name',
        hint: state.deviceName,
        action: async () => {
          const value = await promptText('Device name', state.deviceName);
          await setDeviceName(value);
          await restartManagedRuntime(repoRoot);
          return `Device name changed to ${value}; runtime restarted.`;
        }
      },
      {
        label: 'Tunnel ID',
        hint: state.tunnelId || '(not configured)',
        action: async () => {
          const value = await promptText('Tunnel ID', state.tunnelId);
          await setTunnelId(value);
          await restartManagedRuntime(repoRoot);
          return 'Tunnel ID saved; runtime restarted.';
        }
      },
      {
        label: 'Runtime API key',
        hint: state.runtimeKeyConfigured ? 'configured (hidden)' : 'not configured',
        action: async () => {
          const value = await promptSecret('Runtime API key');
          if (!value) return 'Runtime API key unchanged.';
          await setRuntimeApiKey(value);
          await restartManagedRuntime(repoRoot);
          return 'Runtime API key replaced securely; runtime restarted.';
        }
      },
      {
        label: 'Restart runtime',
        hint: state.service,
        action: async () => await restartManagedRuntime(repoRoot)
      },
      {
        label: 'Refresh',
        hint: 'reload status',
        action: async () => 'Status refreshed.'
      },
      {
        label: 'Exit',
        hint: 'close TUI',
        action: async () => { running = false; }
      }
    ];

    selected = Math.min(selected, items.length - 1);
    clear();
    console.log(bold(`Remote Workstation MCP v${SERVER_VERSION}`));
    console.log(dim('Terminal Control Center / TUI'));
    console.log('');
    console.log(line('Device', state.deviceName));
    console.log(line('Platform', state.platform));
    console.log(line('Service', state.service === 'active' ? green(state.service) : yellow(state.service)));
    console.log(line('Tunnel', state.tunnelReady === true ? green('READY') : state.tunnelReady === false ? yellow('NOT READY') : 'n/a'));
    console.log(line('MCP', `127.0.0.1:${state.mcpPort}`));
    console.log(line('Access', state.accessMode));
    console.log(line('Workspace', `${state.workspaceLabel} → ${state.workspaceRoot}`));
    console.log('');
    console.log(dim('↑/↓ select   Enter edit/run   r refresh   q quit'));
    console.log('');
    items.forEach((item, index) => {
      const marker = index === selected ? cyan('›') : ' ';
      const labelText = index === selected ? bold(item.label) : item.label;
      console.log(`${marker} ${labelText.padEnd(24)} ${dim(item.hint)}`);
    });
    if (message) console.log(`\n${message}`);

    const key = await readKey();
    if (key === 'up') selected = (selected + items.length - 1) % items.length;
    else if (key === 'down') selected = (selected + 1) % items.length;
    else if (key === 'r') message = 'Status refreshed.';
    else if (key === 'q' || key === 'escape') running = false;
    else if (key === 'enter') {
      try {
        const result = await items[selected]!.action();
        message = result || '';
      } catch (error) {
        message = yellow(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
} finally {
  stdin.setRawMode(false);
  clear();
  console.log('Remote Workstation TUI closed.');
}