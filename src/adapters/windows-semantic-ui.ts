import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type WindowsUiControlType =
  | 'button' | 'calendar' | 'checkbox' | 'combobox' | 'custom' | 'dataitem'
  | 'document' | 'edit' | 'group' | 'header' | 'headeritem' | 'hyperlink'
  | 'image' | 'list' | 'listitem' | 'menu' | 'menubar' | 'menuitem' | 'pane'
  | 'progressbar' | 'radiobutton' | 'scrollbar' | 'separator' | 'slider'
  | 'spinner' | 'splitbutton' | 'statusbar' | 'tab' | 'tabitem' | 'table'
  | 'text' | 'thumb' | 'titlebar' | 'toolbar' | 'tree' | 'treeitem' | 'window';

export interface WindowsUiLocator {
  automationId?: string;
  names?: string[];
  controlType?: WindowsUiControlType;
  className?: string;
}

export interface WindowsUiNode {
  depth: number;
  processId: number;
  name: string;
  automationId: string;
  className: string;
  controlType: string;
  enabled: boolean;
  offscreen: boolean;
  keyboardFocusable: boolean;
  patterns: string[];
}

export interface WindowsUiStatus {
  ok: true;
  supported: true;
  provider: 'windows-uia';
  helperElevated: boolean;
  uiAccessEnabledByRwmcp: false;
  rootAvailable: boolean;
  allowedActions: string[];
}

export interface WindowsUiWindowsResult {
  ok: true;
  provider: 'windows-uia';
  windowCount: number;
  windows: WindowsUiNode[];
}

export interface WindowsUiInspectResult {
  ok: true;
  provider: 'windows-uia';
  windowCount: number;
  nodeCount: number;
  truncated: boolean;
  nodes: WindowsUiNode[];
}

interface WindowsUiActionResult {
  ok: true;
  provider: 'windows-uia';
  action?: string;
  element: WindowsUiNode;
}

interface WindowsUiAdapterOptions {
  platform?: NodeJS.Platform;
  scriptPath?: string;
  powershell?: string;
  timeoutMs?: number;
  executor?: (request: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
}

const CONTROL_TYPES = new Set<WindowsUiControlType>([
  'button', 'calendar', 'checkbox', 'combobox', 'custom', 'dataitem', 'document',
  'edit', 'group', 'header', 'headeritem', 'hyperlink', 'image', 'list', 'listitem',
  'menu', 'menubar', 'menuitem', 'pane', 'progressbar', 'radiobutton', 'scrollbar',
  'separator', 'slider', 'spinner', 'splitbutton', 'statusbar', 'tab', 'tabitem',
  'table', 'text', 'thumb', 'titlebar', 'toolbar', 'tree', 'treeitem', 'window'
]);

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  const text = value.trim();
  if (!text || text.length > max || text.includes('\0')) throw new Error(`${label} is empty, too long or invalid.`);
  return text;
}

export function validateWindowsUiLocator(locator: WindowsUiLocator): WindowsUiLocator {
  if (!locator || typeof locator !== 'object') throw new Error('Windows UI locator is required.');
  const output: WindowsUiLocator = {};
  if (locator.automationId !== undefined) {
    output.automationId = boundedString(locator.automationId, 'locator.automationId', 256);
  }
  if (locator.names !== undefined) {
    if (!Array.isArray(locator.names) || locator.names.length < 1 || locator.names.length > 8) {
      throw new Error('locator.names must contain 1..8 exact aliases.');
    }
    output.names = locator.names.map((name, index) => boundedString(name, `locator.names[${index}]`, 256));
  }
  if (!output.automationId && !output.names?.length) {
    throw new Error('Windows UI locator requires automationId or exact name aliases.');
  }
  if (locator.controlType !== undefined) {
    if (!CONTROL_TYPES.has(locator.controlType)) throw new Error('Unsupported Windows UI controlType.');
    output.controlType = locator.controlType;
  }
  if (locator.className !== undefined) {
    output.className = boundedString(locator.className, 'locator.className', 256);
  }
  return output;
}

function validateExecutable(filename: string): string {
  const resolved = path.resolve(boundedString(filename, 'expectedExecutablePath', 4096));
  if (!path.isAbsolute(resolved)) throw new Error('expectedExecutablePath must be absolute.');
  return resolved;
}

function validateProcessId(processId: number): number {
  if (!Number.isInteger(processId) || processId < 1 || processId > 0x7fffffff) {
    throw new Error('processId must be a positive 32-bit integer.');
  }
  return processId;
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15_000) {
    throw new Error('UI Automation timeoutMs must be 100..15000.');
  }
  return timeoutMs;
}

function normalizeNode(value: any): WindowsUiNode {
  return {
    depth: Number.isInteger(value?.depth) ? value.depth : 0,
    processId: Number.isInteger(value?.processId) ? value.processId : 0,
    name: typeof value?.name === 'string' ? value.name.slice(0, 512) : '',
    automationId: typeof value?.automationId === 'string' ? value.automationId.slice(0, 256) : '',
    className: typeof value?.className === 'string' ? value.className.slice(0, 256) : '',
    controlType: typeof value?.controlType === 'string' ? value.controlType.slice(0, 64) : '',
    enabled: value?.enabled === true,
    offscreen: value?.offscreen !== false,
    keyboardFocusable: value?.keyboardFocusable === true,
    patterns: Array.isArray(value?.patterns)
      ? value.patterns.filter((item: unknown): item is string => typeof item === 'string').slice(0, 24).map((item: string) => item.slice(0, 128))
      : []
  };
}

async function runPowerShell(
  powershell: string,
  scriptPath: string,
  request: Record<string, unknown>,
  timeoutMs: number
): Promise<unknown> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-uia-'));
  const inputPath = path.join(tempRoot, `${randomUUID()}.json`);
  try {
    await fs.writeFile(inputPath, JSON.stringify(request), 'utf8');
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(powershell, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-MTA', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath, '-InputPath', inputPath
      ], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const maxBytes = 2 * 1024 * 1024;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (child.pid && process.platform === 'win32') {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore'
          });
          killer.unref();
        } else {
          child.kill('SIGKILL');
        }
        reject(new Error(`WINDOWS_UIA_TIMEOUT: helper exceeded ${timeoutMs} ms.`));
      }, timeoutMs);

      const append = (target: Buffer[], chunk: Buffer, currentBytes: number) => {
        if (currentBytes >= maxBytes) return currentBytes;
        const remaining = maxBytes - currentBytes;
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        target.push(Buffer.from(slice));
        return currentBytes + slice.length;
      };
      child.stdout.on('data', chunk => { stdoutBytes = append(stdout, Buffer.from(chunk), stdoutBytes); });
      child.stderr.on('data', chunk => { stderrBytes = append(stderr, Buffer.from(chunk), stderrBytes); });
      child.once('error', error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString('utf8').trim(),
          stderr: Buffer.concat(stderr).toString('utf8').trim()
        });
      });
    });

    if (!result.stdout) throw new Error(`WINDOWS_UIA_PROTOCOL_ERROR: ${result.stderr.slice(0, 512) || 'helper returned no JSON'}`);
    let parsed: any;
    try { parsed = JSON.parse(result.stdout); } catch {
      throw new Error(`WINDOWS_UIA_PROTOCOL_ERROR: ${result.stdout.slice(0, 512)} ${result.stderr.slice(0, 512)}`);
    }
    if (result.code !== 0 || parsed?.ok !== true) {
      const message = typeof parsed?.error === 'string' ? parsed.error : result.stderr || `helper exited ${result.code}`;
      throw new Error(`WINDOWS_UIA_FAILED: ${message.slice(0, 1024)}`);
    }
    return parsed;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export class WindowsSemanticUiAdapter {
  private readonly platform: NodeJS.Platform;
  private readonly scriptPath: string;
  private readonly powershell: string;
  private readonly timeoutMs: number;
  private readonly executor?: (request: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;

  constructor(options: WindowsUiAdapterOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.scriptPath = options.scriptPath ?? path.resolve('scripts/ui/windows-ui-automation.ps1');
    this.powershell = options.powershell ?? 'powershell.exe';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.executor = options.executor;
  }

  supported(): boolean {
    return this.platform === 'win32';
  }

  private async execute(request: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<any> {
    if (!this.supported()) throw new Error('WINDOWS_UIA_UNAVAILABLE: semantic UI Automation is Windows-specific.');
    const boundedTimeout = validateTimeout(timeoutMs);
    if (this.executor) return await this.executor(request, boundedTimeout);
    await fs.access(this.scriptPath);
    return await runPowerShell(this.powershell, this.scriptPath, request, boundedTimeout);
  }

  async status(): Promise<WindowsUiStatus | { supported: false; provider: 'windows-uia'; reason: string }> {
    if (!this.supported()) return { supported: false, provider: 'windows-uia', reason: 'Windows-only provider' };
    const value = await this.execute({ action: 'status' });
    return {
      ok: true,
      supported: true,
      provider: 'windows-uia',
      helperElevated: value?.helperElevated === true,
      uiAccessEnabledByRwmcp: false,
      rootAvailable: value?.rootAvailable === true,
      allowedActions: Array.isArray(value?.allowedActions)
        ? value.allowedActions.filter((item: unknown): item is string => typeof item === 'string').slice(0, 16)
        : []
    };
  }

  async windows(expectedExecutablePath: string): Promise<WindowsUiWindowsResult> {
    const value = await this.execute({
      action: 'windows',
      expectedExecutablePath: validateExecutable(expectedExecutablePath)
    });
    const windows = Array.isArray(value?.windows) ? value.windows.slice(0, 32).map(normalizeNode) : [];
    return { ok: true, provider: 'windows-uia', windowCount: windows.length, windows };
  }

  async inspect(
    expectedExecutablePath: string,
    options: { processId?: number; maxDepth?: number; maxNodes?: number } = {}
  ): Promise<WindowsUiInspectResult> {
    const maxDepth = options.maxDepth ?? 6;
    const maxNodes = options.maxNodes ?? 512;
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 12) throw new Error('maxDepth must be 0..12.');
    if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 1024) throw new Error('maxNodes must be 1..1024.');
    const request: Record<string, unknown> = {
      action: 'inspect',
      expectedExecutablePath: validateExecutable(expectedExecutablePath),
      maxDepth,
      maxNodes
    };
    if (options.processId !== undefined) request.processId = validateProcessId(options.processId);
    const value = await this.execute(request);
    const nodes = Array.isArray(value?.nodes) ? value.nodes.slice(0, maxNodes).map(normalizeNode) : [];
    return {
      ok: true,
      provider: 'windows-uia',
      windowCount: Number.isInteger(value?.windowCount) ? value.windowCount : 0,
      nodeCount: nodes.length,
      truncated: value?.truncated === true,
      nodes
    };
  }

  private async elementAction(
    action: 'wait' | 'invoke' | 'set-value' | 'select' | 'toggle' | 'expand' | 'collapse' | 'focus',
    expectedExecutablePath: string,
    processId: number,
    locator: WindowsUiLocator,
    extra: Record<string, unknown> = {},
    timeoutMs = 5_000
  ): Promise<WindowsUiActionResult> {
    const value = await this.execute({
      action,
      expectedExecutablePath: validateExecutable(expectedExecutablePath),
      processId: validateProcessId(processId),
      locator: validateWindowsUiLocator(locator),
      timeoutMs: validateTimeout(timeoutMs),
      ...extra
    }, timeoutMs);
    return {
      ok: true,
      provider: 'windows-uia',
      action: typeof value?.action === 'string' ? value.action : action,
      element: normalizeNode(value?.element)
    };
  }

  async wait(expectedExecutablePath: string, processId: number, locator: WindowsUiLocator, timeoutMs = 5_000) {
    return await this.elementAction('wait', expectedExecutablePath, processId, locator, {}, timeoutMs);
  }

  async invoke(expectedExecutablePath: string, processId: number, locator: WindowsUiLocator, timeoutMs = 5_000) {
    return await this.elementAction('invoke', expectedExecutablePath, processId, locator, {}, timeoutMs);
  }

  async setValue(expectedExecutablePath: string, processId: number, locator: WindowsUiLocator, value: string, timeoutMs = 5_000) {
    if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) throw new Error('UIA value is invalid or exceeds 4096 characters.');
    return await this.elementAction('set-value', expectedExecutablePath, processId, locator, { value }, timeoutMs);
  }

  async select(expectedExecutablePath: string, processId: number, locator: WindowsUiLocator, timeoutMs = 5_000) {
    return await this.elementAction('select', expectedExecutablePath, processId, locator, {}, timeoutMs);
  }

  async toggle(
    expectedExecutablePath: string,
    processId: number,
    locator: WindowsUiLocator,
    toggleState: 'on' | 'off' | 'indeterminate',
    timeoutMs = 5_000
  ) {
    return await this.elementAction('toggle', expectedExecutablePath, processId, locator, { toggleState }, timeoutMs);
  }

  async expand(expectedExecutablePath: string, processId: number, locator: WindowsUiLocator, timeoutMs = 5_000) {
    return await this.elementAction('expand', expectedExecutablePath, processId, locator, {}, timeoutMs);
  }

  async collapse(expectedExecutablePath: string, processId: number, locator: WindowsUiLocator, timeoutMs = 5_000) {
    return await this.elementAction('collapse', expectedExecutablePath, processId, locator, {}, timeoutMs);
  }

  async focus(expectedExecutablePath: string, processId: number, locator: WindowsUiLocator, timeoutMs = 5_000) {
    return await this.elementAction('focus', expectedExecutablePath, processId, locator, {}, timeoutMs);
  }
}
