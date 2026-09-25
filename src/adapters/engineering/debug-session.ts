import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { DebugSessionSnapshot } from '../../engineering/types.js';
import { PolicyEngine } from '../../policy.js';
import { PathGuard } from '../../security/path-guard.js';
import { resolveResourceOwner, type ResourceOwnerSource } from '../../security/execution-context.js';
import { buildSafeEnvironment } from '../../security/env-filter.js';
import { decodeCortexMFault } from './fault-decode.js';
import { resolveFirstExecutable } from './executable-resolver.js';
import { openOcdAdapterSpeedArgs, openOcdSearchPathArgs, resolveOpenOcdExecutable, validateAdapterSpeedKhz } from './openocd-provider.js';
import { validateOpenOcdTargetConfig, validateProbeSerial } from './openocd-policy.js';
import { FirmwareProjectInspector, stm32OpenOcdTargetConfig } from './project-inspector.js';
import { resolveExistingProjectPath } from './project-path.js';
import { EngineeringResourceManager } from './resource-manager.js';
import { parseDebugBreakpointNumber, parseDebugDisassembly, parseDebugLocals } from './debug-mi-analysis.js';
import { miList, miResultField, miString, miTuple, parseMiResults, type MiValue } from './gdb-mi-parser.js';

interface MiResult { token: number; resultClass: string; payload: string; raw: string; }
interface AsyncRecord { prefix: string; body: string; raw: string; }

function quoteMi(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function safeExpression(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:(?:\.|->)[A-Za-z_][A-Za-z0-9_]*|\[[0-9]+\])*$/.test(value)) {
    throw new Error('Expression is outside the safe variable-expression grammar.');
  }
}

function safeBreakpoint(value: string): void {
  if (!/^(?:[A-Za-z_][A-Za-z0-9_:]*|[A-Za-z0-9_.-]+:[1-9][0-9]*)$/.test(value)) {
    throw new Error('Breakpoint must be a function name or basename:line.');
  }
}

class GdbMiClient {
  private process?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextToken = 1;
  private readonly pending = new Map<number, { resolve: (result: MiResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly asyncRecords: AsyncRecord[] = [];

  constructor(private readonly env: NodeJS.ProcessEnv, private readonly timeoutMs = 5000) {}

  start(program: string, cwd: string): void {
    if (this.process && this.process.exitCode === null) throw new Error('GDB is already running.');
    const child = spawn(program, ['--interpreter=mi2', '--nx', '--quiet'], { cwd, shell: false, windowsHide: true, env: this.env });
    this.process = child;
    child.stdout.on('data', chunk => this.onData(chunk.toString('utf8')));
    child.stderr.on('data', chunk => this.onData(chunk.toString('utf8')));
    child.on('error', error => this.failAll(new Error(`GDB process error: ${error.message}`)));
    child.on('close', code => this.failAll(new Error(`GDB exited with code ${code}.`)));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) break;
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    const result = line.match(/^(\d+)\^([A-Za-z-]+)(?:,(.*))?$/);
    if (result) {
      const token = Number(result[1]);
      const pending = this.pending.get(token);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(token);
      const value = { token, resultClass: result[2]!, payload: result[3] ?? '', raw: line };
      if (value.resultClass === 'error') pending.reject(new Error(miResultField(value.payload, 'msg') ?? value.raw));
      else pending.resolve(value);
      return;
    }
    const async = line.match(/^([*+=])(.+)$/);
    if (async) {
      this.asyncRecords.push({ prefix: async[1]!, body: async[2]!, raw: line });
      if (this.asyncRecords.length > 500) this.asyncRecords.splice(0, this.asyncRecords.length - 500);
    }
  }

  command(command: string, accepted: string[] = ['done']): Promise<MiResult> {
    const process = this.process;
    if (!process || process.exitCode !== null || !process.stdin.writable) throw new Error('GDB is not running.');
    const token = this.nextToken++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(token);
        reject(new Error(`Timed out waiting for GDB/MI token ${token}.`));
      }, this.timeoutMs);
      this.pending.set(token, {
        timer,
        resolve: result => {
          if (!accepted.includes(result.resultClass)) reject(new Error(`Unexpected GDB/MI result ^${result.resultClass} for token ${token}.`));
          else resolve(result);
        },
        reject
      });
      process.stdin.write(`${token}${command}\n`);
    });
  }

  async waitStopped(afterIndex: number, timeoutMs = this.timeoutMs): Promise<AsyncRecord> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const record = this.asyncRecords.slice(afterIndex).find(item => item.prefix === '*' && item.body.startsWith('stopped'));
      if (record) return record;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for GDB stopped event.');
  }

  async interrupt(): Promise<AsyncRecord> {
    const index = this.asyncRecords.length;
    await this.command('-exec-interrupt', ['done', 'running']);
    return this.waitStopped(index);
  }

  async step(command: '-exec-step' | '-exec-next'): Promise<AsyncRecord> {
    const index = this.asyncRecords.length;
    await this.command(command, ['running', 'done']);
    return this.waitStopped(index, 10_000);
  }

  async close(): Promise<void> {
    const process = this.process;
    if (!process) return;
    try { await this.command('-gdb-exit', ['exit', 'done']); } catch { /* best effort */ }
    if (process.exitCode === null) process.kill('SIGTERM');
    this.process = undefined;
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

type ManagedDebug = DebugSessionSnapshot & {
  ownerId: string;
  openocd: ChildProcessWithoutNullStreams;
  gdb: GdbMiClient;
  leaseId: string;
  openocdOutput: string;
};

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitPort(port: number, process: ChildProcessWithoutNullStreams, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`OpenOCD exited before GDB port became ready (code ${process.exitCode}).`);
    const ok = await new Promise<boolean>(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(200);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for OpenOCD GDB port ${port}.`);
}

export class DebugSessionManager {
  private readonly sessions = new Map<string, ManagedDebug>();
  private readonly inspector: FirmwareProjectInspector;

  constructor(
    private readonly policy: PolicyEngine,
    private readonly paths: PathGuard,
    private readonly resources: EngineeringResourceManager,
    private readonly ownerIdSource: ResourceOwnerSource = 'unknown'
  ) {
    this.inspector = new FirmwareProjectInspector(paths);
  }

  private ownerId(): string {
    return resolveResourceOwner(this.ownerIdSource).key;
  }

  private owned(id: string): ManagedDebug {
    const session = this.sessions.get(id);
    if (!session || session.ownerId !== this.ownerId()) throw new Error(`Unknown debug session '${id}'.`);
    return session;
  }

  async capabilities() {
    const [openocd, gdb] = await Promise.all([
      resolveOpenOcdExecutable(),
      resolveFirstExecutable(['arm-none-eabi-gdb', 'gdb-multiarch', 'gdb'])
    ]);
    return {
      provider: 'gdb-mi+openocd',
      openocd,
      gdb,
      operations: ['halt', 'resume', 'step', 'next', 'stack', 'registers', 'locals', 'variable', 'disassemble', 'breakpoint', 'watchpoint', 'memory-read', 'fault-snapshot'],
      intentionallyUnavailable: ['arbitrary-gdb-command', 'arbitrary-tcl-command', 'memory-write', 'gdb-flash']
    };
  }

  async start(options: { workspace: string; projectPath?: string; symbols: string; probeSerial?: string; targetConfig?: string; adapterSpeedKhz?: number }): Promise<DebugSessionSnapshot> {
    this.policy.assertHardwareMutation();
    const projectPath = options.projectPath ?? '.';
    const project = await this.inspector.inspect(options.workspace, projectPath);
    const targetConfigRaw = options.targetConfig ?? stm32OpenOcdTargetConfig(project.target);
    if (!targetConfigRaw) throw new Error('Unable to determine OpenOCD target config for debug session.');
    const targetConfig = validateOpenOcdTargetConfig(targetConfigRaw);
    if (!options.probeSerial) throw new Error('debug_session_start requires an explicit probeSerial in v0.9.0.');
    validateProbeSerial(options.probeSerial);
    const symbols = await resolveExistingProjectPath(this.paths, options.workspace, projectPath, options.symbols, 'symbols');
    if (!['.elf', '.axf'].includes(path.extname(symbols).toLowerCase())) throw new Error('Debug symbols must be an ELF or AXF file.');
    await fs.access(symbols);
    const cwd = await this.paths.resolveExisting(options.workspace, projectPath);
    const openocd = await resolveOpenOcdExecutable();
    const gdbExec = await resolveFirstExecutable(['arm-none-eabi-gdb', 'gdb-multiarch', 'gdb']);
    if (!openocd) throw new Error('OpenOCD is unavailable.');
    if (!gdbExec) throw new Error('GDB is unavailable.');
    const adapterSpeedKhz = validateAdapterSpeedKhz(options.adapterSpeedKhz);
    const resourceId = `debug-probe:${options.probeSerial ?? 'auto'}`;
    const lease = this.resources.acquire(resourceId, 'debugging');
    const port = await reservePort();
    const args = [...openOcdSearchPathArgs(openocd), '-c', 'bindto 127.0.0.1', '-f', 'interface/stlink.cfg', '-c', 'transport select swd', '-f', targetConfig,
      ...(options.probeSerial ? ['-c', `adapter serial ${options.probeSerial}`] : []),
      ...openOcdAdapterSpeedArgs(adapterSpeedKhz),
      '-c', `gdb port ${port}`, '-c', 'telnet port disabled', '-c', 'tcl port disabled', '-c', 'gdb flash_program disable', '-c', 'init'];
    const env = buildSafeEnvironment(this.policy.config.process.inheritEnv);
    const openocdProcess = spawn(openocd.path, args, { cwd, shell: false, windowsHide: true, env });
    let output = '';
    openocdProcess.stdout.on('data', chunk => { output = (output + chunk.toString('utf8')).slice(-64 * 1024); });
    openocdProcess.stderr.on('data', chunk => { output = (output + chunk.toString('utf8')).slice(-64 * 1024); });
    try {
      await waitPort(port, openocdProcess);
      const gdb = new GdbMiClient(env);
      gdb.start(gdbExec.path, cwd);
      await gdb.command('-gdb-set mi-async on');
      await gdb.command(`-file-exec-and-symbols "${quoteMi(symbols)}"`);
      await gdb.command(`-target-select extended-remote 127.0.0.1:${port}`, ['connected', 'done']);
      const id = randomUUID();
      const managed: ManagedDebug = {
        id, workspace: options.workspace, resourceId, probeSerial: options.probeSerial, symbols,
        targetConfig, gdbPort: port, status: 'connected', startedAt: new Date().toISOString(),
        ownerId: this.ownerId(), openocd: openocdProcess, gdb, leaseId: lease.id, openocdOutput: output
      };
      this.sessions.set(id, managed);
      openocdProcess.on('close', code => {
        if (managed.status === 'connected') {
          managed.status = 'failed';
          managed.error = `OpenOCD exited with code ${code}.`;
          this.resources.releaseInternal(managed.leaseId);
        }
      });
      return this.snapshot(managed);
    } catch (error) {
      openocdProcess.kill('SIGTERM');
      this.resources.releaseInternal(lease.id);
      throw new Error(`${(error as Error).message}${output ? ` OpenOCD: ${output.slice(-2000)}` : ''}`);
    }
  }

  async halt(id: string) {
    this.policy.assertHardwareMutation();
    return this.owned(id).gdb.interrupt();
  }

  async resume(id: string) {
    this.policy.assertHardwareMutation();
    return this.owned(id).gdb.command('-exec-continue', ['running', 'done']);
  }

  async step(id: string, kind: 'step' | 'next') {
    this.policy.assertHardwareMutation();
    return this.owned(id).gdb.step(kind === 'step' ? '-exec-step' : '-exec-next');
  }

  async stack(id: string, maxFrames = 16) {
    if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > 64) throw new Error('maxFrames must be in range 1..64.');
    const result = await this.owned(id).gdb.command(`-stack-list-frames 0 ${maxFrames - 1}`);
    const root = parseMiResults(result.payload);
    const stack = miList(root.stack) ?? [];
    return stack.flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !('key' in item) || item.key !== 'frame') return [];
      const frame = miTuple(item.value);
      if (!frame) return [];
      const levelRaw = miString(frame.level);
      const lineRaw = miString(frame.line);
      return [{
        level: levelRaw && /^\d+$/.test(levelRaw) ? Number(levelRaw) : 0,
        address: miString(frame.addr),
        function: miString(frame.func),
        file: miString(frame.file),
        fullname: miString(frame.fullname),
        line: lineRaw && /^\d+$/.test(lineRaw) ? Number(lineRaw) : undefined
      }];
    }).slice(0, maxFrames);
  }

  async registers(id: string) {
    const session = this.owned(id);
    const names = await session.gdb.command('-data-list-register-names');
    const values = await session.gdb.command('-data-list-register-values x');
    const nameRoot = parseMiResults(names.payload);
    const valueRoot = parseMiResults(values.payload);
    const nameList = (miList(nameRoot['register-names']) ?? []).map(item => typeof item === 'string' ? item : '');
    const rows = miList(valueRoot['register-values']) ?? [];
    return rows.flatMap(item => {
      const row = miTuple(item as MiValue);
      if (!row) return [];
      const numberRaw = miString(row.number);
      const value = miString(row.value);
      if (!numberRaw || !/^\d+$/.test(numberRaw) || value === undefined) return [];
      const number = Number(numberRaw);
      return [{ number, name: nameList[number] || `reg${number}`, value }];
    });
  }

  async variable(id: string, expression: string) {
    safeExpression(expression);
    const result = await this.owned(id).gdb.command(`-data-evaluate-expression "${quoteMi(expression)}"`);
    return { expression, value: miResultField(result.payload, 'value') };
  }

  async locals(id: string, maxVariables = 64) {
    if (!Number.isInteger(maxVariables) || maxVariables < 1 || maxVariables > 128) throw new Error('maxVariables must be in range 1..128.');
    const result = await this.owned(id).gdb.command('-stack-list-variables --simple-values');
    return parseDebugLocals(result.payload, maxVariables);
  }

  async disassemble(id: string, options: { address?: number; beforeBytes?: number; afterBytes?: number; maxInstructions?: number } = {}) {
    const beforeBytes = options.beforeBytes ?? 32;
    const afterBytes = options.afterBytes ?? 96;
    const maxInstructions = options.maxInstructions ?? 128;
    if (!Number.isInteger(beforeBytes) || beforeBytes < 0 || beforeBytes > 256) throw new Error('beforeBytes must be in range 0..256.');
    if (!Number.isInteger(afterBytes) || afterBytes < 2 || afterBytes > 512) throw new Error('afterBytes must be in range 2..512.');
    if (!Number.isInteger(maxInstructions) || maxInstructions < 1 || maxInstructions > 256) throw new Error('maxInstructions must be in range 1..256.');
    let center = options.address;
    if (center === undefined) {
      const regs = await this.registers(id);
      const pc = regs.find(item => item.name.toLowerCase() === 'pc')?.value;
      if (!pc || !/^0x[0-9a-f]+$/i.test(pc)) throw new Error('Unable to resolve PC register for disassembly.');
      center = Number.parseInt(pc.slice(2), 16);
    }
    if (!Number.isInteger(center) || center < 0 || center > 0xffffffff) throw new Error('address must be a 32-bit unsigned integer.');
    const aligned = center - (center % 2);
    const start = Math.max(0, aligned - beforeBytes);
    const end = Math.min(0xffffffff, aligned + afterBytes);
    if (end <= start) throw new Error('Invalid disassembly range.');
    const result = await this.owned(id).gdb.command(`-data-disassemble -s 0x${start.toString(16)} -e 0x${end.toString(16)} -- 0`);
    return { centerAddress: aligned, startAddress: start, endAddress: end, instructions: parseDebugDisassembly(result.payload, maxInstructions) };
  }

  async addWatchpoint(id: string, expression: string, access: 'write' | 'read' | 'access' = 'write') {
    this.policy.assertHardwareMutation();
    safeExpression(expression);
    const flag = access === 'read' ? '-r ' : access === 'access' ? '-a ' : '';
    const result = await this.owned(id).gdb.command(`-break-watch ${flag}\"${quoteMi(expression)}\"`);
    return { number: parseDebugBreakpointNumber(result.payload), expression, access, kind: 'watchpoint', hardwareGuaranteed: access === 'read' || access === 'access' };
  }

  async removeWatchpoint(id: string, number: number) {
    return this.removeBreakpoint(id, number);
  }

  async addBreakpoint(id: string, location: string) {
    this.policy.assertHardwareMutation();
    safeBreakpoint(location);
    const result = await this.owned(id).gdb.command(`-break-insert -h "${quoteMi(location)}"`);
    const number = parseDebugBreakpointNumber(result.payload);
    return { number, location, kind: 'hardware-breakpoint' };
  }

  async removeBreakpoint(id: string, number: number) {
    this.policy.assertHardwareMutation();
    if (!Number.isInteger(number) || number < 1 || number > 9999) throw new Error('Breakpoint number out of range.');
    await this.owned(id).gdb.command(`-break-delete ${number}`);
    return { removed: number };
  }

  async memoryRead(id: string, address: number, length: number) {
    if (!Number.isInteger(address) || address < 0 || address > 0xffffffff) throw new Error('address must be a 32-bit unsigned integer.');
    if (!Number.isInteger(length) || length < 1 || length > 4096) throw new Error('length must be in range 1..4096.');
    const result = await this.owned(id).gdb.command(`-data-read-memory-bytes 0x${address.toString(16)} ${length}`);
    const root = parseMiResults(result.payload);
    const memory = miList(root.memory);
    const first = memory?.[0];
    const row = miTuple(first as MiValue);
    const contents = row ? miString(row.contents) : miResultField(result.payload, 'contents');
    if (!contents || !/^[0-9a-fA-F]+$/.test(contents)) throw new Error('GDB did not return a valid memory byte string.');
    return { address, length, hex: contents.toLowerCase() };
  }

  async faultSnapshot(id: string) {
    const regs = await this.registers(id);
    const byName = new Map(regs.map(item => [item.name.toLowerCase(), item.value]));
    const readU32 = async (address: number) => {
      const memory = await this.memoryRead(id, address, 4);
      const bytes = Buffer.from(memory.hex, 'hex');
      return bytes.readUInt32LE(0);
    };
    const [shcsr, cfsr, hfsr, dfsr, mmfar, bfar, afsr] = await Promise.all([
      readU32(0xE000ED24), readU32(0xE000ED28), readU32(0xE000ED2C), readU32(0xE000ED30),
      readU32(0xE000ED34), readU32(0xE000ED38), readU32(0xE000ED3C)
    ]);
    return {
      core: { pc: byName.get('pc'), lr: byName.get('lr'), sp: byName.get('sp') ?? byName.get('r13'), xpsr: byName.get('xpsr') },
      decoded: decodeCortexMFault({ cfsr, hfsr, dfsr, mmfar, bfar, afsr, shcsr })
    };
  }

  async stop(id: string): Promise<DebugSessionSnapshot> {
    const session = this.owned(id);
    await session.gdb.close();
    if (session.openocd.exitCode === null) session.openocd.kill('SIGTERM');
    session.status = 'stopped';
    this.resources.releaseInternal(session.leaseId);
    return this.snapshot(session);
  }

  list(): DebugSessionSnapshot[] {
    const owner = this.ownerId();
    return [...this.sessions.values()].filter(item => item.ownerId === owner).map(item => this.snapshot(item));
  }

  private snapshot(session: ManagedDebug): DebugSessionSnapshot {
    const { ownerId: _owner, openocd: _openocd, gdb: _gdb, leaseId: _lease, openocdOutput: _output, ...snapshot } = session;
    return { ...snapshot };
  }
}
