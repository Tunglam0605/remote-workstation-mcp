import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KicadProjectFiles } from '../../engineering/types.js';
import { PolicyEngine } from '../../policy.js';
import { PathGuard } from '../../security/path-guard.js';
import { EngineeringCommandRunner } from './command-runner.js';
import { resolveExecutable, resolveFirstExecutable } from './executable-resolver.js';
import { resolveExistingProjectPath } from './project-path.js';
import { parseKicadBomCsv } from './kicad-bom.js';
import { analyzeKicadDesign, type KicadDesignReviewOptions } from './kicad-design-review.js';
import { analyzeKicadLayoutOptimization, type KicadLayoutOptimizationOptions } from './kicad-layout-optimization.js';
import { analyzeKicadConstraints, type KicadConstraintsReviewOptions } from './kicad-constraints-review.js';
import { defaultKicadLibraryPaths, footprintMatchesFilters, resolveKicadFootprint, resolveKicadSymbol, searchKicadFootprints, searchKicadSymbols } from './kicad-library.js';
import { parseKicadSexprNetlist, synthesizeKicadSchematic, verifyKicadSchematicNetlist, type KicadSchematicNetSpec, type KicadSchematicSynthesisOptions } from './kicad-schematic-synthesis.js';
import { canonicalKicadBoardNetName, synthesizeKicadBoard } from './kicad-board-synthesis.js';
import { planKicadSemanticPlacement, type KicadPlacementHint } from './kicad-semantic-placement.js';
import { atomicReplace, createKicadBackup, inspectKicadDocument, patchKicadDocument, sha256Text, type KicadEditOperation } from './kicad-edit.js';
import { EngineeringResourceManager } from './resource-manager.js';

const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_VIOLATIONS = 200;
const MAX_ITEMS_PER_VIOLATION = 16;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function boundedViolation(value: unknown) {
  const record = asRecord(value);
  const items = asArray(record.items).slice(0, MAX_ITEMS_PER_VIOLATION).map(item => {
    const entry = asRecord(item);
    return {
      ...(typeof entry.uuid === 'string' ? { uuid: entry.uuid } : {}),
      ...(typeof entry.description === 'string' ? { description: entry.description.slice(0, 1024) } : {}),
      ...(entry.pos && typeof entry.pos === 'object' ? { pos: entry.pos } : {})
    };
  });
  return {
    ...(typeof record.type === 'string' ? { type: record.type } : {}),
    ...(typeof record.description === 'string' ? { description: record.description.slice(0, 2048) } : {}),
    ...(typeof record.severity === 'string' ? { severity: record.severity } : {}),
    ...(typeof record.excluded === 'boolean' ? { excluded: record.excluded } : {}),
    itemCount: asArray(record.items).length,
    items,
    itemsTruncated: asArray(record.items).length > items.length
  };
}

function severitySummary(values: unknown[]) {
  const summary: Record<string, number> = {};
  for (const value of values) {
    const severity = asRecord(value).severity;
    if (typeof severity !== 'string') continue;
    summary[severity] = (summary[severity] ?? 0) + 1;
  }
  return summary;
}

function activeItems(items: unknown[]): unknown[] {
  return items.filter(item => asRecord(item).excluded !== true);
}

function summarizeDrc(value: unknown) {
  const report = asRecord(value);
  const violations = asArray(report.violations);
  const unconnected = asArray(report.unconnected_items);
  const parity = asArray(report.schematic_parity);
  const all = [...violations, ...unconnected, ...parity];
  const bounded = all.slice(0, MAX_VIOLATIONS).map(boundedViolation);
  return {
    schema: typeof report.$schema === 'string' ? report.$schema : undefined,
    source: typeof report.source === 'string' ? path.basename(report.source) : undefined,
    kicadVersion: typeof report.kicad_version === 'string' ? report.kicad_version : undefined,
    coordinateUnits: typeof report.coordinate_units === 'string' ? report.coordinate_units : undefined,
    includedSeverities: asArray(report.included_severities).filter((item): item is string => typeof item === 'string').slice(0, 16),
    counts: {
      violations: violations.length,
      unconnected: unconnected.length,
      schematicParity: parity.length,
      total: all.length,
      excluded: all.filter(item => asRecord(item).excluded === true).length,
      bySeverity: severitySummary(all),
      active: {
        violations: activeItems(violations).length,
        unconnected: activeItems(unconnected).length,
        schematicParity: activeItems(parity).length,
        total: activeItems(all).length,
        bySeverity: severitySummary(activeItems(all))
      },
      ignoredChecks: asArray(report.ignored_checks).length
    },
    violations: bounded,
    violationsTruncated: all.length > bounded.length
  };
}

function summarizeErc(value: unknown) {
  const report = asRecord(value);
  const sheets = asArray(report.sheets).map(sheet => asRecord(sheet));
  const violations: unknown[] = [];
  const sheetSummary = sheets.slice(0, 128).map(sheet => {
    const entries = asArray(sheet.violations);
    violations.push(...entries);
    return {
      path: typeof sheet.path === 'string' ? sheet.path : undefined,
      uuidPath: typeof sheet.uuid_path === 'string' ? sheet.uuid_path : undefined,
      violations: entries.length
    };
  });
  const bounded = violations.slice(0, MAX_VIOLATIONS).map(boundedViolation);
  return {
    schema: typeof report.$schema === 'string' ? report.$schema : undefined,
    source: typeof report.source === 'string' ? path.basename(report.source) : undefined,
    kicadVersion: typeof report.kicad_version === 'string' ? report.kicad_version : undefined,
    coordinateUnits: typeof report.coordinate_units === 'string' ? report.coordinate_units : undefined,
    counts: {
      sheets: sheets.length,
      violations: violations.length,
      excluded: violations.filter(item => asRecord(item).excluded === true).length,
      bySeverity: severitySummary(violations),
      active: {
        violations: activeItems(violations).length,
        bySeverity: severitySummary(activeItems(violations))
      }
    },
    sheets: sheetSummary,
    violations: bounded,
    violationsTruncated: violations.length > bounded.length
  };
}

async function discoverKicadPythonProvider(): Promise<string | undefined> {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const candidate = path.join(process.env.LOCALAPPDATA, 'RemoteWorkstationMCP', 'providers', 'kicad-python', 'venv', 'Scripts', 'python.exe');
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Fall through to normal executable discovery.
    }
  }
  return (await resolveFirstExecutable(['python3', 'python', 'python.exe']))?.path;
}

function parseBoundedJsonResult(result: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }, label: string): JsonRecord {
  if (result.timedOut) throw new Error(label + ' timed out.');
  let parsed: JsonRecord = {};
  try {
    parsed = asRecord(JSON.parse(result.stdout.trim() || '{}'));
  } catch {
    throw new Error(label + ' returned invalid JSON: ' + (result.stderr || result.stdout).slice(-1024));
  }
  if (result.exitCode !== 0 || parsed.state === 'error') {
    throw new Error(typeof parsed.error === 'string' ? parsed.error : label + ' failed.');
  }
  return parsed;
}

async function readJsonBounded(file: string): Promise<unknown> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('KiCad report output is not a regular file.');
  if (stat.size > MAX_REPORT_BYTES) throw new Error(`KiCad report exceeds the ${MAX_REPORT_BYTES}-byte diagnostics limit.`);
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}

function safeOutputDirectory(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 1024) throw new Error('KiCad output directory must contain 1..1024 characters.');
  if (path.isAbsolute(normalized)) throw new Error('KiCad output directory must remain project-relative.');
  const segments = normalized.split(/[\\/]+/);
  if (segments.includes('..') || segments.includes('.git')) {
    throw new Error('KiCad output directory must not escape the project or target .git.');
  }
  const result = path.normalize(normalized);
  if (result === '.' || result === '') throw new Error('KiCad output directory must not be the project root.');
  return result;
}

function safeOutputFileName(value: string, extension: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) throw new Error('KiCad output file name must contain 1..128 characters.');
  if (path.basename(normalized) !== normalized || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) {
    throw new Error('KiCad output file name must be a plain portable file name.');
  }
  if (path.extname(normalized).toLowerCase() !== extension.toLowerCase()) {
    throw new Error(`KiCad output file must use ${extension}.`);
  }
  return normalized;
}

function boundedTheme(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('KiCad schematic theme must contain 1..128 printable characters.');
  }
  return normalized;
}

export type KicadVisualExportRequest =
  | { kind: 'schematic_svg'; schematic: string; outputDir: string; blackAndWhite?: boolean; excludeDrawingSheet?: boolean; pages?: number[]; theme?: string }
  | { kind: 'schematic_pdf'; schematic: string; outputDir: string; fileName?: string; blackAndWhite?: boolean; excludeDrawingSheet?: boolean; pages?: number[]; theme?: string }
  | { kind: 'pcb_3d_render'; board: string; outputDir: string; fileName?: string; format?: 'png' | 'jpeg'; width?: number; height?: number; side?: 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back'; background?: 'default' | 'transparent' | 'opaque'; quality?: 'basic' | 'high'; perspective?: boolean; floor?: boolean; useBoardStackupColors?: boolean; zoom?: number }
  | { kind: 'pcb_step'; board: string; outputDir: string; fileName?: string; noDnp?: boolean; boardOnly?: boolean; substituteModels?: boolean; includeTracks?: boolean; includePads?: boolean; includeZones?: boolean; includeInnerCopper?: boolean; includeSilkscreen?: boolean; includeSoldermask?: boolean; fuseShapes?: boolean };

function insideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function prepareNewOutputDirectory(projectRoot: string, relativeOutput: string): Promise<string> {
  let current = projectRoot;
  const segments = relativeOutput.split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const candidate = path.join(current, segments[index]!);
    const final = index === segments.length - 1;
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) throw new Error('KiCad fabrication output path must not traverse symbolic links.');
      if (final) throw new Error('KiCad fabrication output directory already exists; choose a new destination.');
      if (!stat.isDirectory()) throw new Error('KiCad fabrication output parent must be a directory.');
      const real = await fs.realpath(candidate);
      if (!insideRoot(projectRoot, real)) throw new Error('KiCad fabrication output path escapes the project.');
      current = real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fs.mkdir(candidate);
      current = candidate;
    }
  }
  return current;
}

async function sha256File(file: string): Promise<{ sha256: string; size: number }> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('KiCad fabrication output must be a regular file.');
  if (stat.size > 64 * 1024 * 1024) throw new Error('KiCad fabrication output exceeds the per-file 64 MiB limit.');
  const data = await fs.readFile(file);
  return { sha256: createHash('sha256').update(data).digest('hex'), size: stat.size };
}

async function fabricationManifest(root: string) {
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('KiCad fabrication output must not contain symbolic links.');
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= 512) throw new Error('KiCad fabrication output exceeds the 512-file manifest limit.');
      const digest = await sha256File(absolute);
      files.push({
        path: path.relative(root, absolute).split(path.sep).join('/'),
        size: digest.size,
        sha256: digest.sha256
      });
    }
  };
  await walk(root);
  const totalBytes = files.reduce((sum, item) => sum + item.size, 0);
  if (totalBytes > 256 * 1024 * 1024) throw new Error('KiCad fabrication output exceeds the 256 MiB bundle limit.');
  return { schemaVersion: 1 as const, fileCount: files.length, totalBytes, files };
}

async function discoverKicadCli(): Promise<{ path: string; source: 'owner-override' | 'path' | 'known-install' }> {
  const override = process.env.RWMCP_KICAD_CLI?.trim();
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('RWMCP_KICAD_CLI must be an absolute path.');
    const resolved = await resolveExecutable(override);
    if (!resolved) throw new Error(`Configured KiCad CLI was not found: ${override}`);
    return { path: resolved, source: 'owner-override' };
  }
  const direct = await resolveFirstExecutable(['kicad-cli', 'kicad-cli.exe']);
  if (direct) return { path: direct.path, source: 'path' };
  if (os.platform() === 'win32') {
    const roots = [
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'KiCad') : undefined,
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'KiCad') : undefined
    ].filter((item): item is string => Boolean(item));
    for (const root of roots) {
      let versions: string[] = [];
      try {
        versions = (await fs.readdir(root, { withFileTypes: true }))
          .filter(entry => entry.isDirectory())
          .map(entry => entry.name)
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      } catch {
        continue;
      }
      for (const version of versions) {
        const candidate = path.join(root, version, 'bin', 'kicad-cli.exe');
        try {
          await fs.access(candidate);
          return { path: candidate, source: 'known-install' };
        } catch {
          // Continue searching known installations.
        }
      }
    }
  }
  throw new Error('KiCad CLI is unavailable. Install KiCad or configure RWMCP_KICAD_CLI.');
}

export class KicadAdapter {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly paths: PathGuard,
    private readonly runner: EngineeringCommandRunner,
    private readonly resources?: EngineeringResourceManager
  ) {}

  private async commandSupported(cliPath: string, cwd: string, args: string[]): Promise<boolean> {
    const result = await this.runner.run(cliPath, [...args, '--help'], cwd, 10_000);
    return !result.timedOut && result.exitCode === 0;
  }

  private async runJsonReport(
    workspace: string,
    projectPath: string,
    args: string[],
    inputFile: string,
    reportName: string,
    timeoutMs = 120_000
  ): Promise<{ command: { program: string; args: string[] }; report: unknown }> {
    this.policy.assertEngineeringExecute();
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const input = await resolveExistingProjectPath(this.paths, workspace, projectPath, inputFile, 'KiCad input file');
    const cli = await discoverKicadCli();
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-'));
    const report = path.join(temp, reportName);
    const commandArgs = [...args, '--output', report, input];
    try {
      const result = await this.runner.run(cli.path, commandArgs, cwd, timeoutMs);
      if (result.exitCode !== 0 || result.timedOut) {
        throw new Error(`KiCad CLI failed: ${result.stderr || result.stdout || `exit=${result.exitCode}`}`);
      }
      return {
        command: { program: cli.path, args: commandArgs.map(arg => arg === report ? '<temp-report>' : arg === input ? inputFile : arg) },
        report: await readJsonBounded(report)
      };
    } finally {
      await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async ipcPrepare(workspace: string, projectPath = '.') {
    this.policy.assertEngineeringExecute();
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    if (process.platform !== 'win32') {
      throw new Error('KICAD_IPC_PREPARE_UNSUPPORTED: KiCad IPC preparation is currently Windows-only.');
    }

    const cli = await discoverKicadCli();
    const versionResult = await this.runner.run(cli.path, ['version'], cwd, 10_000);
    if (versionResult.exitCode !== 0 || versionResult.timedOut) {
      throw new Error('KiCad version probe failed before IPC preparation.');
    }
    const versionText = (versionResult.stdout.trim() || versionResult.stderr.trim()).slice(0, 160);
    const major = Number(versionText.match(/(\d+)(?:\.\d+)?/)?.[1] ?? 0);
    if (!Number.isInteger(major) || major < 9) {
      throw new Error('KICAD_IPC_PREPARE_UNSUPPORTED: KiCad 9 or newer is required.');
    }

    const powershell = await resolveFirstExecutable(['powershell.exe', 'powershell']);
    if (!powershell) throw new Error('KICAD_IPC_PREPARE_UNAVAILABLE: PowerShell was not found.');
    const script = fileURLToPath(new URL('../../../scripts/kicad_ipc_prepare.ps1', import.meta.url));
    const execute = async () => {
      const result = await this.runner.run(
        powershell.path,
        ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-KiCadMajor', String(major)],
        cwd,
        15_000
      );
      return {
        provider: 'kicad-ipc',
        cliVersion: versionText,
        ...parseBoundedJsonResult(result, 'KiCad IPC preparation')
      };
    };
    return this.resources
      ? await this.resources.withLease('kicad-ipc-config:' + major, 'orchestrating', execute)
      : await execute();
  }

  async ipcStatus(workspace: string, projectPath = '.') {
    this.policy.assertEngineeringEnabled();
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const cli = await discoverKicadCli();
    const cliVersionResult = await this.runner.run(cli.path, ['version'], cwd, 10_000);
    if (cliVersionResult.exitCode !== 0 || cliVersionResult.timedOut) {
      throw new Error(`KiCad version probe failed: ${cliVersionResult.stderr || cliVersionResult.stdout}`);
    }
    const cliVersion = (cliVersionResult.stdout.trim() || cliVersionResult.stderr.trim()).slice(0, 160);
    const major = Number(cliVersion.match(/(\d+)(?:\.\d+)?/)?.[1] ?? 0);
    const pythonPath = await discoverKicadPythonProvider();
    if (!pythonPath) {
      return {
        provider: 'kicad-ipc',
        cliVersion,
        supportedByKiCad: major >= 9,
        guiRequired: major >= 9 && major <= 10,
        headlessApiSupported: major >= 11,
        pythonAvailable: false,
        kicadPythonAvailable: false,
        connected: false,
        reason: 'Python runtime was not found; official kicad-python (kipy) cannot be probed.'
      };
    }
    const script = fileURLToPath(new URL('../../../scripts/kicad_ipc_probe.py', import.meta.url));
    const probe = await this.runner.run(pythonPath, [script], cwd, 5_000);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = asRecord(JSON.parse(probe.stdout.trim() || '{}'));
    } catch {
      parsed = { reason: (probe.stderr || probe.stdout || 'Invalid IPC probe output').slice(0, 1024) };
    }
    return {
      provider: 'kicad-ipc',
      cliVersion,
      supportedByKiCad: major >= 9,
      guiRequired: major >= 9 && major <= 10,
      headlessApiSupported: major >= 11,
      pythonAvailable: true,
      pythonExecutable: pythonPath,
      probeExitCode: probe.exitCode,
      probeTimedOut: probe.timedOut,
      packageAvailable: parsed.packageAvailable === true,
      ...(typeof parsed.packageVersion === 'string' ? { packageVersion: parsed.packageVersion } : {}),
      connected: parsed.connected === true,
      socketConfigured: parsed.socketConfigured === true,
      tokenConfigured: parsed.tokenConfigured === true,
      ...(typeof parsed.kicadVersion === 'string' ? { ipcKiCadVersion: parsed.kicadVersion } : {}),
      ...(typeof parsed.boardOpen === 'boolean' ? { boardOpen: parsed.boardOpen } : {}),
      ...(typeof parsed.boardName === 'string' && parsed.boardName ? { boardName: parsed.boardName } : {}),
      ...(typeof parsed.reason === 'string' && parsed.reason ? { reason: parsed.reason } : {})
    };
  }

  async ipcBoardInspect(workspace: string, projectPath: string, board: string, maxItems = 500) {
    this.policy.assertEngineeringExecute();
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const boardPath = await resolveExistingProjectPath(this.paths, workspace, projectPath, board, 'KiCad live IPC board');
    const pythonPath = await discoverKicadPythonProvider();
    if (!pythonPath) throw new Error('KICAD_IPC_PROVIDER_UNAVAILABLE: Python provider was not found.');
    const script = fileURLToPath(new URL('../../../scripts/kicad_ipc_live.py', import.meta.url));
    const result = await this.runner.run(
      pythonPath,
      [script, '--action', 'inspect', '--board-path', boardPath, '--max-items', String(Math.max(1, Math.min(maxItems, 2000)))],
      cwd,
      8_000
    );
    const parsed = parseBoundedJsonResult(result, 'KiCad IPC board inspection');
    const footprints = Array.isArray(parsed.footprints) ? parsed.footprints.slice(0, 2000) : [];
    return {
      provider: 'kicad-ipc',
      board,
      boardPath: typeof parsed.boardPath === 'string' ? parsed.boardPath : boardPath,
      boardSha256: typeof parsed.boardSha256 === 'string' ? parsed.boardSha256 : undefined,
      footprintCount: typeof parsed.footprintCount === 'number' ? parsed.footprintCount : footprints.length,
      footprints,
      truncated: parsed.truncated === true
    };
  }

  async ipcFootprintMove(
    workspace: string,
    projectPath: string,
    board: string,
    expectedBoardSha256: string,
    selector: { uuid?: string; reference?: string },
    xMm: number,
    yMm: number,
    rotationDeg?: number
  ) {
    this.policy.assertEngineeringExecute();
    this.policy.assertWrite(workspace);
    if (!/^[0-9a-f]{64}$/i.test(expectedBoardSha256)) throw new Error('KiCad live IPC expectedBoardSha256 must be a SHA-256 digest.');
    if (!selector.uuid && !selector.reference) throw new Error('KiCad live IPC footprint move requires uuid or reference.');
    for (const value of [xMm, yMm, rotationDeg].filter((item): item is number => item !== undefined)) {
      if (!Number.isFinite(value) || Math.abs(value) > 100000) throw new Error('KiCad live IPC placement value is out of range.');
    }
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const boardPath = await resolveExistingProjectPath(this.paths, workspace, projectPath, board, 'KiCad live IPC board');
    const pythonPath = await discoverKicadPythonProvider();
    if (!pythonPath) throw new Error('KICAD_IPC_PROVIDER_UNAVAILABLE: Python provider was not found.');
    const cli = await discoverKicadCli();
    const script = fileURLToPath(new URL('../../../scripts/kicad_ipc_live.py', import.meta.url));
    const args = [
      script,
      '--action', 'move',
      '--board-path', boardPath,
      '--kicad-cli', cli.path,
      '--expected-sha', expectedBoardSha256,
      ...(selector.uuid ? ['--uuid', selector.uuid] : []),
      ...(selector.reference ? ['--reference', selector.reference] : []),
      '--x-mm', String(xMm),
      '--y-mm', String(yMm),
      ...(rotationDeg !== undefined ? ['--rotation-deg', String(rotationDeg)] : [])
    ];
    const execute = async () => {
      const result = await this.runner.run(pythonPath, args, cwd, 45_000);
      return parseBoundedJsonResult(result, 'KiCad IPC footprint move');
    };
    return this.resources
      ? await this.resources.withLease('kicad-ipc-board:' + boardPath, 'orchestrating', execute)
      : await execute();
  }

  async ipcFootprintUpdate(
    workspace: string,
    projectPath: string,
    board: string,
    expectedBoardSha256: string,
    selector: { uuid?: string; reference?: string },
    update: {
      value?: string;
      locked?: boolean;
      excludeFromBom?: boolean;
      excludeFromPosFiles?: boolean;
      doNotPopulate?: boolean;
      notInSchematic?: boolean;
    }
  ) {
    this.policy.assertEngineeringExecute();
    this.policy.assertWrite(workspace);
    if (!/^[0-9a-f]{64}$/i.test(expectedBoardSha256)) throw new Error('KiCad live IPC expectedBoardSha256 must be a SHA-256 digest.');
    if (!selector.uuid && !selector.reference) throw new Error('KiCad live IPC footprint update requires uuid or reference.');
    if (Object.keys(update).length < 1) throw new Error('KiCad live IPC footprint update requires at least one field.');
    if (update.value !== undefined && (update.value.length > 512 || /[\u0000-\u001f\u007f]/.test(update.value))) {
      throw new Error('KiCad live IPC footprint value is invalid.');
    }
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const boardPath = await resolveExistingProjectPath(this.paths, workspace, projectPath, board, 'KiCad live IPC board');
    const pythonPath = await discoverKicadPythonProvider();
    if (!pythonPath) throw new Error('KICAD_IPC_PROVIDER_UNAVAILABLE: Python provider was not found.');
    const cli = await discoverKicadCli();
    const script = fileURLToPath(new URL('../../../scripts/kicad_ipc_live.py', import.meta.url));
    const args = [
      script,
      '--action', 'update',
      '--board-path', boardPath,
      '--kicad-cli', cli.path,
      '--expected-sha', expectedBoardSha256,
      ...(selector.uuid ? ['--uuid', selector.uuid] : []),
      ...(selector.reference ? ['--reference', selector.reference] : []),
      '--update-b64', Buffer.from(JSON.stringify(update), 'utf8').toString('base64')
    ];
    const execute = async () => {
      const result = await this.runner.run(pythonPath, args, cwd, 45_000);
      return parseBoundedJsonResult(result, 'KiCad IPC footprint update');
    };
    return this.resources
      ? await this.resources.withLease('kicad-ipc-board:' + boardPath, 'orchestrating', execute)
      : await execute();
  }

  async ipcBatchPlace(
    workspace: string,
    projectPath: string,
    board: string,
    expectedBoardSha256: string,
    placements: Array<{ uuid?: string; reference?: string; xMm: number; yMm: number; rotationDeg?: number }>
  ) {
    this.policy.assertEngineeringExecute();
    this.policy.assertWrite(workspace);
    if (!/^[0-9a-f]{64}$/i.test(expectedBoardSha256)) throw new Error('KiCad live IPC expectedBoardSha256 must be a SHA-256 digest.');
    if (placements.length < 1 || placements.length > 32) throw new Error('KiCad live IPC batch placement requires 1..32 items.');
    for (const placement of placements) {
      if (!placement.uuid && !placement.reference) throw new Error('Every KiCad live IPC batch placement item requires uuid or reference.');
      for (const value of [placement.xMm, placement.yMm, placement.rotationDeg].filter((item): item is number => item !== undefined)) {
        if (!Number.isFinite(value) || Math.abs(value) > 100000) throw new Error('KiCad live IPC batch placement value is out of range.');
      }
    }
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const boardPath = await resolveExistingProjectPath(this.paths, workspace, projectPath, board, 'KiCad live IPC board');
    const pythonPath = await discoverKicadPythonProvider();
    if (!pythonPath) throw new Error('KICAD_IPC_PROVIDER_UNAVAILABLE: Python provider was not found.');
    const cli = await discoverKicadCli();
    const script = fileURLToPath(new URL('../../../scripts/kicad_ipc_live.py', import.meta.url));
    const args = [
      script,
      '--action', 'batch-place',
      '--board-path', boardPath,
      '--kicad-cli', cli.path,
      '--expected-sha', expectedBoardSha256,
      '--placements-b64', Buffer.from(JSON.stringify(placements), 'utf8').toString('base64')
    ];
    const execute = async () => {
      const result = await this.runner.run(pythonPath, args, cwd, 60_000);
      return parseBoundedJsonResult(result, 'KiCad IPC batch placement');
    };
    return this.resources
      ? await this.resources.withLease('kicad-ipc-board:' + boardPath, 'orchestrating', execute)
      : await execute();
  }

  async ipcRoutingInspect(workspace: string, projectPath: string, board: string, maxItems = 1000) {
    this.policy.assertEngineeringExecute();
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const boardPath = await resolveExistingProjectPath(this.paths, workspace, projectPath, board, 'KiCad live IPC board');
    const pythonPath = await discoverKicadPythonProvider();
    if (!pythonPath) throw new Error('KICAD_IPC_PROVIDER_UNAVAILABLE: Python provider was not found.');
    const script = fileURLToPath(new URL('../../../scripts/kicad_ipc_routing.py', import.meta.url));
    const result = await this.runner.run(
      pythonPath,
      [script, '--action', 'inspect', '--board-path', boardPath, '--max-items', String(Math.max(1, Math.min(maxItems, 2000)))],
      cwd,
      10_000
    );
    return parseBoundedJsonResult(result, 'KiCad IPC routing inspection');
  }

  async ipcTrackAdd(
    workspace: string,
    projectPath: string,
    board: string,
    expectedBoardSha256: string,
    payload: {
      netName: string;
      layerName: string;
      start: { xMm: number; yMm: number };
      end: { xMm: number; yMm: number };
      widthMm: number;
      locked?: boolean;
    }
  ) {
    return await this.ipcRoutingMutation(workspace, projectPath, board, expectedBoardSha256, 'track-add', payload, 'KiCad IPC track add');
  }

  async ipcTrackUpdate(
    workspace: string,
    projectPath: string,
    board: string,
    expectedBoardSha256: string,
    payload: {
      uuid: string;
      netName?: string;
      layerName?: string;
      start?: { xMm: number; yMm: number };
      end?: { xMm: number; yMm: number };
      widthMm?: number;
      locked?: boolean;
    }
  ) {
    return await this.ipcRoutingMutation(workspace, projectPath, board, expectedBoardSha256, 'track-update', payload, 'KiCad IPC track update');
  }

  async ipcViaAdd(
    workspace: string,
    projectPath: string,
    board: string,
    expectedBoardSha256: string,
    payload: {
      netName: string;
      position: { xMm: number; yMm: number };
      diameterMm: number;
      drillMm: number;
      locked?: boolean;
    }
  ) {
    return await this.ipcRoutingMutation(workspace, projectPath, board, expectedBoardSha256, 'via-add', payload, 'KiCad IPC via add');
  }

  async ipcViaUpdate(
    workspace: string,
    projectPath: string,
    board: string,
    expectedBoardSha256: string,
    payload: {
      uuid: string;
      netName?: string;
      position?: { xMm: number; yMm: number };
      diameterMm?: number;
      drillMm?: number;
      locked?: boolean;
    }
  ) {
    return await this.ipcRoutingMutation(workspace, projectPath, board, expectedBoardSha256, 'via-update', payload, 'KiCad IPC via update');
  }

  private async ipcRoutingMutation(
    workspace: string,
    projectPath: string,
    board: string,
    expectedBoardSha256: string,
    action: 'track-add' | 'track-update' | 'via-add' | 'via-update',
    payload: Record<string, unknown>,
    label: string
  ) {
    this.policy.assertEngineeringExecute();
    this.policy.assertWrite(workspace);
    if (!/^[0-9a-f]{64}$/i.test(expectedBoardSha256)) throw new Error('KiCad live IPC expectedBoardSha256 must be a SHA-256 digest.');
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const boardPath = await resolveExistingProjectPath(this.paths, workspace, projectPath, board, 'KiCad live IPC board');
    const pythonPath = await discoverKicadPythonProvider();
    if (!pythonPath) throw new Error('KICAD_IPC_PROVIDER_UNAVAILABLE: Python provider was not found.');
    const cli = await discoverKicadCli();
    const script = fileURLToPath(new URL('../../../scripts/kicad_ipc_routing.py', import.meta.url));
    const args = [
      script,
      '--action', action,
      '--board-path', boardPath,
      '--kicad-cli', cli.path,
      '--expected-sha', expectedBoardSha256,
      '--payload-b64', Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    ];
    const execute = async () => {
      const result = await this.runner.run(pythonPath, args, cwd, 60_000);
      return parseBoundedJsonResult(result, label);
    };
    return this.resources
      ? await this.resources.withLease('kicad-ipc-board:' + boardPath, 'orchestrating', execute)
      : await execute();
  }

  async version(workspace: string, projectPath = '.') {
    this.policy.assertEngineeringEnabled();
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const cli = await discoverKicadCli();
    const result = await this.runner.run(cli.path, ['version'], cwd, 10_000);
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`KiCad version probe failed: ${result.stderr || result.stdout}`);
    const [boardStats, bomExport, schematicSvg, schematicPdf, schematicNetlist, pcb3dRender, stepExport] = await Promise.all([
      this.commandSupported(cli.path, cwd, ['pcb', 'export', 'stats']),
      this.commandSupported(cli.path, cwd, ['sch', 'export', 'bom']),
      this.commandSupported(cli.path, cwd, ['sch', 'export', 'svg']),
      this.commandSupported(cli.path, cwd, ['sch', 'export', 'pdf']),
      this.commandSupported(cli.path, cwd, ['sch', 'export', 'netlist']),
      this.commandSupported(cli.path, cwd, ['pcb', 'render']),
      this.commandSupported(cli.path, cwd, ['pcb', 'export', 'step'])
    ]);
    return {
      version: result.stdout.trim() || result.stderr.trim(),
      executable: cli.path,
      executableSource: cli.source,
      capabilities: {
        boardStats,
        bomExport,
        schematicSvg,
        schematicPdf,
        schematicNetlist,
        pcb3dRender,
        stepExport,
        drcJson: true,
        ercJson: true
      }
    };
  }

  async libraryLookup(
    workspace: string,
    projectPath: string,
    request:
      | { mode: 'search'; query: string; kind: 'symbol' | 'footprint' | 'both'; limit: number }
      | { mode: 'symbol'; symbolId: string }
      | { mode: 'footprint'; footprintId: string }
      | { mode: 'component'; symbolId: string; footprintId?: string }
  ) {
    this.policy.assertEngineeringEnabled();
    await this.paths.resolveExisting(workspace, projectPath);
    const cli = await discoverKicadCli();
    const paths = defaultKicadLibraryPaths(cli.path);
    if (request.mode === 'search') {
      const [symbols, footprints] = await Promise.all([
        request.kind === 'footprint' ? Promise.resolve([]) : searchKicadSymbols(paths, request.query, request.limit),
        request.kind === 'symbol' ? Promise.resolve([]) : searchKicadFootprints(paths, request.query, request.limit)
      ]);
      return {
        provider: { executable: cli.path, source: cli.source, shareRoot: paths.shareRoot },
        query: request.query,
        kind: request.kind,
        symbols,
        footprints
      };
    }
    if (request.mode === 'symbol') {
      const symbol = await resolveKicadSymbol(paths, request.symbolId);
      return { provider: { executable: cli.path, source: cli.source, shareRoot: paths.shareRoot }, symbol };
    }
    if (request.mode === 'footprint') {
      const footprint = await resolveKicadFootprint(paths, request.footprintId);
      return {
        provider: { executable: cli.path, source: cli.source, shareRoot: paths.shareRoot },
        footprint: { ...footprint, source: undefined }
      };
    }
    const symbol = await resolveKicadSymbol(paths, request.symbolId);
    const selectedFootprintId = request.footprintId ?? symbol.footprint;
    if (!selectedFootprintId) {
      return {
        provider: { executable: cli.path, source: cli.source, shareRoot: paths.shareRoot },
        symbol,
        footprint: undefined,
        compatibility: undefined,
        warning: 'The symbol has no default footprint and no footprintId was supplied.'
      };
    }
    const footprint = await resolveKicadFootprint(paths, selectedFootprintId);
    return {
      provider: { executable: cli.path, source: cli.source, shareRoot: paths.shareRoot },
      symbol,
      footprint: { ...footprint, source: undefined },
      compatibility: footprintMatchesFilters(footprint.id, symbol.footprintFilters)
    };
  }

  async schematicSynthesize(
    workspace: string,
    projectPath: string,
    request: {
      outputDir: string;
      projectName: string;
      title?: string;
      revision?: string;
      company?: string;
      components: Array<{
        reference: string;
        symbolId: string;
        value?: string;
        footprintId?: string;
        xMm?: number;
        yMm?: number;
        rotationDeg?: 0 | 90 | 180 | 270;
        unit?: number;
        inBom?: boolean;
        onBoard?: boolean;
        dnp?: boolean;
      }>;
      nets: KicadSchematicNetSpec[];
      markUnusedNoConnect?: boolean;
      allowUnconnectedPowerPins?: boolean;
      allowFootprintFilterMismatch?: boolean;
      runErc?: boolean;
      requireErcClean?: boolean;
    }
  ) {
    this.policy.assertEngineeringExecute();
    this.policy.assertWrite(workspace);
    const projectRoot = await this.paths.resolveExisting(workspace, projectPath);
    const outputDir = safeOutputDirectory(request.outputDir);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(request.projectName)) {
      throw new Error('KiCad synthesized projectName must be a portable 1..64 character name.');
    }
    if (request.components.length < 1 || request.components.length > 128) throw new Error('KiCad schematic synthesis requires 1..128 components.');
    if (request.nets.length > 512) throw new Error('KiCad schematic synthesis supports at most 512 nets.');

    const cli = await discoverKicadCli();
    const libraryPaths = defaultKicadLibraryPaths(cli.path);
    const resolvedComponents = [];
    for (const component of request.components) {
      const symbol = await resolveKicadSymbol(libraryPaths, component.symbolId);
      const footprintId = component.footprintId ?? symbol.footprint;
      if (component.onBoard !== false && !footprintId) {
        throw new Error(`On-board component ${component.reference} requires an explicit/default footprint.`);
      }
      if (footprintId) {
        const footprint = await resolveKicadFootprint(libraryPaths, footprintId);
        const compatible = footprintMatchesFilters(footprint.id, symbol.footprintFilters);
        if (compatible === false && request.allowFootprintFilterMismatch !== true) {
          throw new Error(`Footprint ${footprint.id} does not match filters for ${symbol.id}: ${symbol.footprintFilters.join(', ') || '<none>'}.`);
        }
      }
      resolvedComponents.push({
        reference: component.reference,
        symbol,
        ...(component.value !== undefined ? { value: component.value } : {}),
        ...(footprintId ? { footprintId } : {}),
        ...(component.xMm !== undefined ? { xMm: component.xMm } : {}),
        ...(component.yMm !== undefined ? { yMm: component.yMm } : {}),
        ...(component.rotationDeg !== undefined ? { rotationDeg: component.rotationDeg } : {}),
        ...(component.unit !== undefined ? { unit: component.unit } : {}),
        ...(component.inBom !== undefined ? { inBom: component.inBom } : {}),
        ...(component.onBoard !== undefined ? { onBoard: component.onBoard } : {}),
        ...(component.dnp !== undefined ? { dnp: component.dnp } : {})
      });
    }

    const synthesisOptions: KicadSchematicSynthesisOptions = {
      ...(request.title ? { title: request.title } : {}),
      ...(request.revision ? { revision: request.revision } : {}),
      ...(request.company ? { company: request.company } : {}),
      markUnusedNoConnect: request.markUnusedNoConnect !== false,
      allowUnconnectedPowerPins: request.allowUnconnectedPowerPins === true
    };
    const generated = synthesizeKicadSchematic(resolvedComponents, request.nets, synthesisOptions);
    const output = await prepareNewOutputDirectory(projectRoot, outputDir);
    const projectFile = path.join(output, request.projectName + '.kicad_pro');
    const schematicFile = path.join(output, request.projectName + '.kicad_sch');
    const relativeProject = path.relative(projectRoot, projectFile).split(path.sep).join('/');
    const relativeSchematic = path.relative(projectRoot, schematicFile).split(path.sep).join('/');
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-synth-'));
    try {
      const templateRaw = await fs.readFile(libraryPaths.blankProjectTemplate, 'utf8');
      const template = JSON.parse(templateRaw) as Record<string, unknown>;
      const meta = asRecord(template.meta);
      template.meta = { ...meta, filename: request.projectName + '.kicad_pro', version: typeof meta.version === 'number' ? meta.version : 1 };
      await fs.writeFile(projectFile, JSON.stringify(template, null, 2) + '\n', 'utf8');
      await fs.writeFile(schematicFile, generated.source, 'utf8');

      const netlistOutput = path.join(temp, 'roundtrip.net');
      const netlistArgs = ['sch', 'export', 'netlist', '--format', 'kicadsexpr', '--output', netlistOutput, schematicFile];
      const netlistResult = await this.runner.run(cli.path, netlistArgs, projectRoot, 120_000);
      if (netlistResult.exitCode !== 0 || netlistResult.timedOut) {
        throw new Error(`KiCad synthesized schematic netlist round-trip failed: ${netlistResult.stderr || netlistResult.stdout || `exit=${netlistResult.exitCode}`}`);
      }
      const netlistStat = await fs.stat(netlistOutput);
      if (!netlistStat.isFile() || netlistStat.size > 16 * 1024 * 1024) throw new Error('KiCad synthesized netlist is missing or exceeds 16 MiB.');
      const actualNets = parseKicadSexprNetlist(await fs.readFile(netlistOutput, 'utf8'));
      const verification = verifyKicadSchematicNetlist(request.nets, actualNets);
      if (!verification.valid) {
        throw new Error(`KiCad synthesized netlist does not match requested connectivity: ${JSON.stringify(verification.missingEndpoints.slice(0, 16))}`);
      }

      const runErc = request.runErc !== false;
      const erc = runErc ? await this.erc(workspace, projectPath, relativeSchematic) : undefined;
      const ercErrors = Number(erc?.report.counts.active.bySeverity.error ?? 0);
      if (request.requireErcClean !== false && runErc && ercErrors > 0) {
        throw new Error(`KiCad synthesized schematic ERC has ${ercErrors} active error(s); output rejected.`);
      }

      const designManifest = {
        schemaVersion: 1,
        projectName: request.projectName,
        projectFile: path.basename(projectFile),
        schematicFile: path.basename(schematicFile),
        rootUuid: generated.rootUuid,
        components: generated.components.map(component => {
          const requested = request.components.find(item => item.reference === component.reference);
          return {
            reference: component.reference,
            symbolId: component.symbolId,
            symbolUuid: component.symbolUuid,
            unit: component.unit,
            value: component.value,
            ...(component.footprintId ? { footprintId: component.footprintId } : {}),
            inBom: requested?.inBom !== false,
            onBoard: requested?.onBoard !== false,
            dnp: requested?.dnp === true
          };
        }),
        nets: generated.nets
      };
      const designManifestText = JSON.stringify(designManifest, null, 2) + '\n';
      const designManifestFile = path.join(output, request.projectName + '.rwmcp-design.json');
      await fs.writeFile(designManifestFile, designManifestText, 'utf8');
      const relativeDesignManifest = path.relative(projectRoot, designManifestFile).split(path.sep).join('/');
      const designManifestSha256 = sha256Text(designManifestText);

      const manifest = await fabricationManifest(output);
      return {
        outputDir: outputDir.split(path.sep).join('/'),
        projectFile: relativeProject,
        schematicFile: relativeSchematic,
        designManifestFile: relativeDesignManifest,
        designManifestSha256,
        generated: {
          rootUuid: generated.rootUuid,
          componentCount: generated.components.length,
          netCount: generated.nets.length,
          unusedPinCount: generated.unusedPins.length,
          components: generated.components,
          nets: generated.nets
        },
        roundTrip: {
          valid: true,
          actualNetCount: actualNets.length,
          expectedNetCount: request.nets.length,
          command: { program: cli.path, args: netlistArgs.map(arg => arg === netlistOutput ? '<temp-roundtrip.net>' : arg === schematicFile ? relativeSchematic : arg) }
        },
        ercRun: runErc,
        ...(erc ? { erc } : {}),
        manifest
      };
    } catch (error) {
      await fs.rm(output, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async semanticPlacementPlan(
    workspace: string,
    projectPath: string,
    request: {
      designManifest: string;
      expectedDesignManifestSha256: string;
      widthMm: number;
      heightMm: number;
      originXmm?: number;
      originYmm?: number;
      gridMm?: number;
      minSpacingMm?: number;
      edgeInsetMm?: number;
      hints?: KicadPlacementHint[];
    }
  ) {
    this.policy.assertEngineeringEnabled();
    const manifestPath = await resolveExistingProjectPath(this.paths, workspace, projectPath, request.designManifest, 'KiCad semantic-placement design manifest');
    if (!manifestPath.endsWith('.rwmcp-design.json')) throw new Error('KiCad semantic placement requires a .rwmcp-design.json manifest.');
    const stat = await fs.stat(manifestPath);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('KiCad design manifest is missing or exceeds 4 MiB.');
    const text = await fs.readFile(manifestPath, 'utf8');
    const actual = sha256Text(text);
    if (actual.toLowerCase() !== request.expectedDesignManifestSha256.toLowerCase()) {
      throw new Error(`KiCad design manifest SHA mismatch: expected ${request.expectedDesignManifestSha256}, actual ${actual}.`);
    }
    const manifest = JSON.parse(text) as unknown;
    const plan = planKicadSemanticPlacement(manifest, {
      widthMm: request.widthMm,
      heightMm: request.heightMm,
      ...(request.originXmm !== undefined ? { originXmm: request.originXmm } : {}),
      ...(request.originYmm !== undefined ? { originYmm: request.originYmm } : {}),
      ...(request.gridMm !== undefined ? { gridMm: request.gridMm } : {}),
      ...(request.minSpacingMm !== undefined ? { minSpacingMm: request.minSpacingMm } : {}),
      ...(request.edgeInsetMm !== undefined ? { edgeInsetMm: request.edgeInsetMm } : {}),
      ...(request.hints ? { hints: request.hints } : {})
    });
    return { designManifest: request.designManifest, designManifestSha256: actual, plan };
  }

  async boardSynthesize(
    workspace: string,
    projectPath: string,
    request: {
      designManifest: string;
      expectedDesignManifestSha256: string;
      widthMm: number;
      heightMm: number;
      copperLayers?: number;
      thicknessMm?: number;
      originXmm?: number;
      originYmm?: number;
      placements?: Array<{ reference: string; xMm: number; yMm: number; rotationDeg?: number; side?: 'front' | 'back'; locked?: boolean }>;
      minimums?: {
        clearanceMm?: number;
        trackWidthMm?: number;
        viaDiameterMm?: number;
        viaDrillMm?: number;
        viaAnnularWidthMm?: number;
        copperEdgeClearanceMm?: number;
      };
      defaultRouting?: {
        trackWidthMm?: number;
        viaDiameterMm?: number;
        viaDrillMm?: number;
        diffPairWidthMm?: number;
        diffPairGapMm?: number;
      };
      netClasses?: Array<{
        name: string;
        nets: string[];
        clearanceMm?: number;
        trackWidthMm?: number;
        viaDiameterMm?: number;
        viaDrillMm?: number;
        diffPairWidthMm?: number;
        diffPairGapMm?: number;
      }>;
      runDrc?: boolean;
      requireNoViolations?: boolean;
    }
  ) {
    this.policy.assertEngineeringExecute();
    this.policy.assertWrite(workspace);
    const projectRoot = await this.paths.resolveExisting(workspace, projectPath);
    const manifestPath = await resolveExistingProjectPath(this.paths, workspace, projectPath, request.designManifest, 'KiCad design manifest');
    if (!manifestPath.endsWith('.rwmcp-design.json')) throw new Error('KiCad board synthesis requires a .rwmcp-design.json manifest.');
    const manifestStat = await fs.stat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.size > 4 * 1024 * 1024) throw new Error('KiCad design manifest is missing or exceeds 4 MiB.');
    const originalManifestText = await fs.readFile(manifestPath, 'utf8');
    const actualManifestSha = sha256Text(originalManifestText);
    if (actualManifestSha.toLowerCase() !== request.expectedDesignManifestSha256.toLowerCase()) {
      throw new Error(`KiCad design manifest SHA mismatch: expected ${request.expectedDesignManifestSha256}, actual ${actualManifestSha}.`);
    }
    const manifest = asRecord(JSON.parse(originalManifestText));
    if (manifest.schemaVersion !== 1 || typeof manifest.projectName !== 'string') throw new Error('Unsupported KiCad design manifest schema.');
    const projectName = manifest.projectName;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(projectName)) throw new Error('KiCad design manifest projectName is invalid.');
    const designDir = path.dirname(manifestPath);
    if (!insideRoot(projectRoot, designDir)) throw new Error('KiCad design manifest directory escapes the project.');
    const projectFile = path.join(designDir, typeof manifest.projectFile === 'string' ? manifest.projectFile : projectName + '.kicad_pro');
    const schematicFile = path.join(designDir, typeof manifest.schematicFile === 'string' ? manifest.schematicFile : projectName + '.kicad_sch');
    const boardFile = path.join(designDir, projectName + '.kicad_pcb');
    try { await fs.lstat(boardFile); throw new Error('KiCad synthesized board already exists; board synthesis is fail-if-exists.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const originalProjectText = await fs.readFile(projectFile, 'utf8');
    await fs.access(schematicFile);

    const cli = await discoverKicadCli();
    const libraryPaths = defaultKicadLibraryPaths(cli.path);
    const placements = new Map((request.placements ?? []).map(item => [item.reference, item]));
    const rawComponents = asArray(manifest.components).map(asRecord);
    const rawNets = asArray(manifest.nets).map(asRecord);
    const nets: KicadSchematicNetSpec[] = rawNets.map(net => ({
      name: typeof net.name === 'string' ? net.name : '',
      endpoints: asArray(net.endpoints).map(endpoint => {
        const entry = asRecord(endpoint);
        return {
          reference: typeof entry.reference === 'string' ? entry.reference : '',
          pinNumber: typeof entry.pinNumber === 'string' ? entry.pinNumber : '',
          ...(typeof entry.expectedPinName === 'string' ? { expectedPinName: entry.expectedPinName } : {})
        };
      })
    }));
    if (nets.some(net => !net.name || net.endpoints.some(endpoint => !endpoint.reference || !endpoint.pinNumber))) throw new Error('KiCad design manifest contains invalid net data.');

    const boardComponents = [];
    for (const entry of rawComponents) {
      if (entry.onBoard === false) continue;
      const reference = typeof entry.reference === 'string' ? entry.reference : '';
      const symbolId = typeof entry.symbolId === 'string' ? entry.symbolId : '';
      const symbolUuid = typeof entry.symbolUuid === 'string' ? entry.symbolUuid : '';
      const footprintId = typeof entry.footprintId === 'string' ? entry.footprintId : '';
      const value = typeof entry.value === 'string' ? entry.value : '';
      if (!reference || !symbolId || !symbolUuid || !footprintId) throw new Error(`KiCad design manifest component is incomplete: ${reference || '<unknown>'}.`);
      const [symbol, footprint] = await Promise.all([resolveKicadSymbol(libraryPaths, symbolId), resolveKicadFootprint(libraryPaths, footprintId)]);
      const compatible = footprintMatchesFilters(footprint.id, symbol.footprintFilters);
      if (compatible === false) throw new Error(`Manifest footprint ${footprint.id} no longer matches installed symbol filters for ${symbol.id}.`);
      const placement = placements.get(reference);
      boardComponents.push({
        reference, value: value || symbol.name, symbol, footprint, symbolUuid,
        ...(placement ? { xMm: placement.xMm, yMm: placement.yMm, rotationDeg: placement.rotationDeg ?? 0, side: placement.side ?? 'front', locked: placement.locked ?? false } : {})
      });
    }
    if (!boardComponents.length) throw new Error('KiCad board synthesis has no on-board components.');

    const generated = synthesizeKicadBoard(boardComponents, nets, {
      projectName, widthMm: request.widthMm, heightMm: request.heightMm,
      copperLayers: request.copperLayers ?? 2, thicknessMm: request.thicknessMm ?? 1.6,
      originXmm: request.originXmm ?? 20, originYmm: request.originYmm ?? 20
    });

    const minimums = {
      clearanceMm: request.minimums?.clearanceMm ?? 0.2,
      trackWidthMm: request.minimums?.trackWidthMm ?? 0.15,
      viaDiameterMm: request.minimums?.viaDiameterMm ?? 0.5,
      viaDrillMm: request.minimums?.viaDrillMm ?? 0.25,
      viaAnnularWidthMm: request.minimums?.viaAnnularWidthMm ?? 0.1,
      copperEdgeClearanceMm: request.minimums?.copperEdgeClearanceMm ?? 0.3
    };
    const defaultRouting = {
      trackWidthMm: request.defaultRouting?.trackWidthMm ?? 0.25,
      viaDiameterMm: request.defaultRouting?.viaDiameterMm ?? 0.6,
      viaDrillMm: request.defaultRouting?.viaDrillMm ?? 0.3,
      diffPairWidthMm: request.defaultRouting?.diffPairWidthMm ?? 0.2,
      diffPairGapMm: request.defaultRouting?.diffPairGapMm ?? 0.25
    };
    if (defaultRouting.trackWidthMm < minimums.trackWidthMm || defaultRouting.viaDiameterMm < minimums.viaDiameterMm || defaultRouting.viaDrillMm < minimums.viaDrillMm) {
      throw new Error('KiCad default routing geometry must not be below configured hard minimums.');
    }

    const projectJson = asRecord(JSON.parse(originalProjectText));
    const boardSettings = asRecord(projectJson.board);
    const designSettings = asRecord(boardSettings.design_settings);
    const oldRules = asRecord(designSettings.rules);
    designSettings.rules = {
      ...oldRules,
      min_clearance: minimums.clearanceMm,
      min_copper_edge_clearance: minimums.copperEdgeClearanceMm,
      min_track_width: minimums.trackWidthMm,
      min_via_diameter: minimums.viaDiameterMm,
      min_through_hole_diameter: minimums.viaDrillMm,
      min_via_annular_width: minimums.viaAnnularWidthMm,
      min_hole_clearance: 0.2, min_hole_to_hole: 0.25,
      min_microvia_diameter: 0.3, min_microvia_drill: 0.1,
      use_height_for_length_calcs: true
    };
    const classes = [{
      name: 'Default', priority: 2147483647, clearance: minimums.clearanceMm,
      track_width: defaultRouting.trackWidthMm, via_diameter: defaultRouting.viaDiameterMm, via_drill: defaultRouting.viaDrillMm,
      microvia_diameter: 0.3, microvia_drill: 0.1, diff_pair_width: defaultRouting.diffPairWidthMm, diff_pair_gap: defaultRouting.diffPairGapMm, diff_pair_via_gap: defaultRouting.diffPairGapMm
    }];
    const assignments: Record<string, string[]> = {};
    for (const [index, item] of (request.netClasses ?? []).entries()) {
      if (!item.name || item.name === 'Default') throw new Error('Custom KiCad net class names must be non-empty and must not be Default.');
      const cls = {
        name: item.name, priority: index + 1, clearance: item.clearanceMm ?? minimums.clearanceMm,
        track_width: item.trackWidthMm ?? defaultRouting.trackWidthMm, via_diameter: item.viaDiameterMm ?? defaultRouting.viaDiameterMm, via_drill: item.viaDrillMm ?? defaultRouting.viaDrillMm,
        microvia_diameter: 0.3, microvia_drill: 0.1, diff_pair_width: item.diffPairWidthMm ?? defaultRouting.diffPairWidthMm, diff_pair_gap: item.diffPairGapMm ?? defaultRouting.diffPairGapMm, diff_pair_via_gap: item.diffPairGapMm ?? defaultRouting.diffPairGapMm
      };
      if (cls.track_width < minimums.trackWidthMm || cls.via_diameter < minimums.viaDiameterMm || cls.via_drill < minimums.viaDrillMm) throw new Error(`Net class ${item.name} geometry is below hard minimums.`);
      classes.push(cls);
      for (const net of item.nets) {
        if (!nets.some(candidate => candidate.name === net)) throw new Error(`Net class ${item.name} references unknown net ${net}.`);
        assignments[canonicalKicadBoardNetName(net)] = [item.name];
      }
    }
    designSettings.track_widths = [0, ...[...new Set(classes.map(item => item.track_width))].sort((a, b) => a - b)];
    designSettings.via_dimensions = [{ diameter: 0, drill: 0 }, ...classes.map(item => ({ diameter: item.via_diameter, drill: item.via_drill }))];
    designSettings.diff_pair_dimensions = [{ width: 0, gap: 0, via_gap: 0 }, ...classes.map(item => ({ width: item.diff_pair_width, gap: item.diff_pair_gap, via_gap: item.diff_pair_via_gap }))];
    boardSettings.design_settings = designSettings;
    projectJson.board = boardSettings;
    projectJson.net_settings = { ...asRecord(projectJson.net_settings), classes, netclass_assignments: assignments, meta: { version: 3 } };
    const updatedProjectText = JSON.stringify(projectJson, null, 2) + '\n';

    const relativeBoard = path.relative(projectRoot, boardFile).split(path.sep).join('/');
    const relativeProject = path.relative(projectRoot, projectFile).split(path.sep).join('/');
    const relativeSchematic = path.relative(projectRoot, schematicFile).split(path.sep).join('/');
    try {
      await fs.writeFile(boardFile, generated.source, { encoding: 'utf8', flag: 'wx' });
      await atomicReplace(projectFile, updatedProjectText);
      const stats = await this.boardStats(workspace, projectPath, relativeBoard);
      const runDrc = request.runDrc !== false;
      const drc = runDrc ? await this.drc(workspace, projectPath, relativeBoard, true) : undefined;
      const violations = Number(drc?.report.counts.active.violations ?? 0);
      const parity = Number(drc?.report.counts.active.schematicParity ?? 0);
      if (request.requireNoViolations !== false && runDrc && (violations > 0 || parity > 0)) {
        throw new Error(`KiCad synthesized board DRC rejected: active violations=${violations}, schematicParity=${parity}.`);
      }
      const updatedManifest = {
        ...manifest,
        board: {
          file: path.basename(boardFile), sha256: sha256Text(generated.source),
          widthMm: request.widthMm, heightMm: request.heightMm, copperLayers: request.copperLayers ?? 2, thicknessMm: request.thicknessMm ?? 1.6,
          components: generated.components, nets: generated.nets
        }
      };
      const updatedManifestText = JSON.stringify(updatedManifest, null, 2) + '\n';
      await atomicReplace(manifestPath, updatedManifestText);
      const updatedManifestSha256 = sha256Text(updatedManifestText);
      return {
        projectFile: relativeProject, schematicFile: relativeSchematic, boardFile: relativeBoard,
        designManifest: request.designManifest, designManifestSha256: updatedManifestSha256,
        boardSha256: sha256Text(generated.source),
        generated: { componentCount: generated.components.length, netCount: generated.nets.length, components: generated.components, nets: generated.nets },
        stats, drcRun: runDrc, ...(drc ? { drc } : {})
      };
    } catch (error) {
      await fs.rm(boardFile, { force: true }).catch(() => undefined);
      await atomicReplace(projectFile, originalProjectText).catch(() => undefined);
      await atomicReplace(manifestPath, originalManifestText).catch(() => undefined);
      throw error;
    }
  }

  async boardStats(workspace: string, projectPath: string, board: string) {
    this.policy.assertEngineeringExecute();
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const cli = await discoverKicadCli();
    if (!await this.commandSupported(cli.path, cwd, ['pcb', 'export', 'stats'])) {
      throw new Error('KICAD_CAPABILITY_UNAVAILABLE: this KiCad CLI does not provide `pcb export stats`; use DRC/ERC/BOM diagnostics or a KiCad version that provides board statistics.');
    }
    const result = await this.runJsonReport(workspace, projectPath, ['pcb', 'export', 'stats', '--format', 'json'], board, 'board-stats.json');
    return { board, ...result };
  }

  async drc(workspace: string, projectPath: string, board: string, schematicParity = false) {
    const result = await this.runJsonReport(
      workspace,
      projectPath,
      ['pcb', 'drc', '--format', 'json', '--severity-all', ...(schematicParity ? ['--schematic-parity'] : [])],
      board,
      'drc.json'
    );
    return { board, command: result.command, report: summarizeDrc(result.report) };
  }

  async erc(workspace: string, projectPath: string, schematic: string) {
    const result = await this.runJsonReport(workspace, projectPath, ['sch', 'erc', '--format', 'json', '--severity-all'], schematic, 'erc.json');
    return { schematic, command: result.command, report: summarizeErc(result.report) };
  }

  async bomReport(workspace: string, projectPath: string, schematic: string, maxRows = 500) {
    this.policy.assertEngineeringExecute();
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 5000) throw new Error('KiCad BOM maxRows must be in range 1..5000.');
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const input = await resolveExistingProjectPath(this.paths, workspace, projectPath, schematic, 'KiCad schematic file');
    if (path.extname(input).toLowerCase() !== '.kicad_sch') throw new Error('KiCad BOM report requires a .kicad_sch schematic file.');
    const cli = await discoverKicadCli();
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-bom-'));
    const output = path.join(temp, 'bom.csv');
    const args = [
      'sch', 'export', 'bom',
      '--fields', 'Reference,Value,Footprint,QUANTITY,DNP',
      '--labels', 'Refs,Value,Footprint,Qty,DNP',
      '--output', output,
      input
    ];
    try {
      const result = await this.runner.run(cli.path, args, cwd, 120_000);
      if (result.exitCode !== 0 || result.timedOut) throw new Error(`KiCad BOM export failed: ${result.stderr || result.stdout || `exit=${result.exitCode}`}`);
      const stat = await fs.stat(output);
      if (!stat.isFile()) throw new Error('KiCad BOM output is not a regular file.');
      if (stat.size > 4 * 1024 * 1024) throw new Error('KiCad BOM output exceeds the 4 MiB limit.');
      const report = parseKicadBomCsv(await fs.readFile(output, 'utf8'), maxRows);
      return {
        schematic,
        command: {
          program: cli.path,
          args: args.map(arg => arg === output ? '<temp-bom.csv>' : arg === input ? schematic : arg)
        },
        report
      };
    } finally {
      await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async diagnostics(workspace: string, projectPath: string, files: KicadProjectFiles) {
    this.policy.assertEngineeringExecute();
    const provider = await this.version(workspace, projectPath);
    const boardStats = files.board && provider.capabilities.boardStats
      ? await this.boardStats(workspace, projectPath, files.board)
      : undefined;
    return {
      provider,
      files,
      ...(boardStats ? { boardStats } : {}),
      ...(!provider.capabilities.boardStats && files.board
        ? { warnings: ['KiCad board statistics are unavailable in the detected CLI; diagnostics continue without stats.'] }
        : {})
    };
  }

  async validate(workspace: string, projectPath: string, files: KicadProjectFiles) {
    this.policy.assertEngineeringExecute();
    if (!files.board && !files.schematic) throw new Error('KiCad validation requires a .kicad_pcb or .kicad_sch file.');
    const [drc, erc] = await Promise.all([
      files.board ? this.drc(workspace, projectPath, files.board, Boolean(files.schematic)) : Promise.resolve(undefined),
      files.schematic ? this.erc(workspace, projectPath, files.schematic) : Promise.resolve(undefined)
    ]);
    return { files, ...(drc ? { drc } : {}), ...(erc ? { erc } : {}) };
  }

  async designReview(
    workspace: string,
    projectPath: string,
    files: { schematic?: string; board?: string },
    options: KicadDesignReviewOptions & { runRuleChecks?: boolean } = {}
  ) {
    this.policy.assertEngineeringEnabled();
    if (!files.schematic && !files.board) throw new Error('KiCad design review requires schematic and/or board.');
    const readSource = async (relative: string, extension: '.kicad_sch' | '.kicad_pcb', label: string) => {
      const input = await resolveExistingProjectPath(this.paths, workspace, projectPath, relative, label);
      if (path.extname(input).toLowerCase() !== extension) throw new Error(`${label} must use ${extension}.`);
      const stat = await fs.stat(input);
      if (!stat.isFile()) throw new Error(`${label} is not a regular file.`);
      if (stat.size > 128 * 1024 * 1024) throw new Error(`${label} exceeds the 128 MiB constraints-review limit.`);
      return await fs.readFile(input, 'utf8');
    };
    const [schematicSource, boardSource] = await Promise.all([
      files.schematic ? readSource(files.schematic, '.kicad_sch', 'KiCad design-review schematic') : Promise.resolve(undefined),
      files.board ? readSource(files.board, '.kicad_pcb', 'KiCad design-review board') : Promise.resolve(undefined)
    ]);
    const analysis = analyzeKicadDesign(
      { ...(schematicSource ? { schematic: schematicSource } : {}), ...(boardSource ? { board: boardSource } : {}) },
      options
    );
    if (options.runRuleChecks === false) return { files, analysis, ruleChecksRun: false };

    const validation = await this.validate(workspace, projectPath, { ...files, jobsets: [] });
    const recommendations = [...analysis.recommendations];
    const drcErrors = Number(validation.drc?.report.counts.active.bySeverity.error ?? 0);
    const drcUnconnected = Number(validation.drc?.report.counts.active.unconnected ?? 0);
    const drcParity = Number(validation.drc?.report.counts.active.schematicParity ?? 0);
    const ercErrors = Number(validation.erc?.report.counts.active.bySeverity.error ?? 0);
    if (drcErrors + drcUnconnected + drcParity > 0) {
      recommendations.unshift({
        category: 'routing' as const,
        priority: 'high' as const,
        code: 'active-drc-findings',
        message: `Resolve active DRC findings before treating layout optimization as accepted: errors=${drcErrors}, unconnected=${drcUnconnected}, schematicParity=${drcParity}.`,
        count: drcErrors + drcUnconnected + drcParity,
        nextTools: ['kicad_drc', 'kicad_ipc_routing_inspect']
      });
    }
    if (ercErrors > 0) {
      recommendations.unshift({
        category: 'schematic' as const,
        priority: 'high' as const,
        code: 'active-erc-findings',
        message: `Resolve active ERC errors before PCB optimization: errors=${ercErrors}.`,
        count: ercErrors,
        nextTools: ['kicad_erc', 'kicad_edit']
      });
    }
    return { files, analysis: { ...analysis, recommendations }, validation, ruleChecksRun: true };
  }

  async layoutOptimizePlan(
    workspace: string,
    projectPath: string,
    board: string,
    schematic: string | undefined,
    options: KicadLayoutOptimizationOptions & { runRuleChecks?: boolean } = {}
  ) {
    this.policy.assertEngineeringExecute();
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const boardPath = await resolveExistingProjectPath(this.paths, workspace, projectPath, board, 'KiCad layout-optimization board');
    if (path.extname(boardPath).toLowerCase() !== '.kicad_pcb') throw new Error('KiCad layout optimization requires a .kicad_pcb board file.');
    const boardStat = await fs.stat(boardPath);
    if (!boardStat.isFile()) throw new Error('KiCad layout-optimization board is not a regular file.');
    if (boardStat.size > 32 * 1024 * 1024) throw new Error('KiCad layout-optimization board exceeds the 32 MiB limit.');
    const boardSource = await fs.readFile(boardPath, 'utf8');

    let schematicNetlist: string | undefined;
    let netlistCommand: { program: string; args: string[] } | undefined;
    if (schematic) {
      const schematicPath = await resolveExistingProjectPath(this.paths, workspace, projectPath, schematic, 'KiCad layout-optimization schematic');
      if (path.extname(schematicPath).toLowerCase() !== '.kicad_sch') throw new Error('KiCad layout optimization schematic must use .kicad_sch.');
      const cli = await discoverKicadCli();
      if (!await this.commandSupported(cli.path, cwd, ['sch', 'export', 'netlist'])) {
        throw new Error('KICAD_CAPABILITY_UNAVAILABLE: this KiCad CLI does not provide `sch export netlist`.');
      }
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-layout-netlist-'));
      const output = path.join(temp, 'schematic.net');
      const args = ['sch', 'export', 'netlist', '--format', 'kicadsexpr', '--output', output, schematicPath];
      try {
        const result = await this.runner.run(cli.path, args, cwd, 120_000);
        if (result.exitCode !== 0 || result.timedOut) {
          throw new Error(`KiCad schematic netlist export failed: ${result.stderr || result.stdout || `exit=${result.exitCode}`}`);
        }
        const stat = await fs.stat(output);
        if (!stat.isFile()) throw new Error('KiCad schematic netlist export did not produce a regular file.');
        if (stat.size > 32 * 1024 * 1024) throw new Error('KiCad schematic netlist exceeds the 32 MiB optimization limit.');
        schematicNetlist = await fs.readFile(output, 'utf8');
        netlistCommand = {
          program: cli.path,
          args: args.map(arg => arg === output ? '<temp-schematic.net>' : arg === schematicPath ? schematic : arg)
        };
      } finally {
        await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    const analysis = analyzeKicadLayoutOptimization(
      { board: boardSource, ...(schematicNetlist ? { schematicNetlist } : {}) },
      options
    );
    const runRuleChecks = options.runRuleChecks !== false;
    const validation = runRuleChecks
      ? await this.validate(workspace, projectPath, { board, ...(schematic ? { schematic } : {}), jobsets: [] })
      : undefined;
    return {
      files: { board, ...(schematic ? { schematic } : {}) },
      ...(netlistCommand ? { netlistCommand } : {}),
      analysis,
      ruleChecksRun: runRuleChecks,
      ...(validation ? { validation } : {})
    };
  }

  async constraintsReview(
    workspace: string,
    projectPath: string,
    files: { projectFile: string; board: string; customRules?: string },
    options: KicadConstraintsReviewOptions & { runDrc?: boolean } = {}
  ) {
    this.policy.assertEngineeringExecute();
    const readBounded = async (relative: string, extension: string, label: string) => {
      const resolved = await resolveExistingProjectPath(this.paths, workspace, projectPath, relative, label);
      if (path.extname(resolved).toLowerCase() !== extension) throw new Error(`${label} must use ${extension}.`);
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) throw new Error(`${label} is not a regular file.`);
      if (stat.size > 32 * 1024 * 1024) throw new Error(`${label} exceeds the 32 MiB review limit.`);
      return await fs.readFile(resolved, 'utf8');
    };

    const [projectSource, boardSource, customRulesSource] = await Promise.all([
      readBounded(files.projectFile, '.kicad_pro', 'KiCad constraints-review project'),
      readBounded(files.board, '.kicad_pcb', 'KiCad constraints-review board'),
      files.customRules
        ? readBounded(files.customRules, '.kicad_dru', 'KiCad constraints-review custom rules')
        : Promise.resolve(undefined)
    ]);

    const analysis = analyzeKicadConstraints(
      { project: projectSource, board: boardSource, ...(customRulesSource ? { customRules: customRulesSource } : {}) },
      options
    );
    const runDrc = options.runDrc !== false;
    const drc = runDrc ? await this.drc(workspace, projectPath, files.board) : undefined;
    return {
      files,
      analysis,
      drcRun: runDrc,
      ...(drc ? { drc } : {})
    };
  }

  async visualExport(workspace: string, projectPath: string, request: KicadVisualExportRequest) {
    this.policy.assertEngineeringExecute();
    this.policy.assertWrite(workspace);
    const projectRoot = await this.paths.resolveExisting(workspace, projectPath);
    const cli = await discoverKicadCli();
    const relativeOutput = safeOutputDirectory(request.outputDir);

    const pagesArgs = (pages: number[] | undefined) => {
      if (!pages?.length) return [] as string[];
      if (pages.length > 32 || pages.some(page => !Number.isInteger(page) || page < 1 || page > 9999)) {
        throw new Error('KiCad schematic export pages must contain 1..32 page numbers in range 1..9999.');
      }
      return ['--pages', [...new Set(pages)].join(',')];
    };

    let inputRelative: string;
    let supportArgs: string[];
    let buildArgs: (output: string) => { args: string[]; primaryName?: string };

    if (request.kind === 'schematic_svg' || request.kind === 'schematic_pdf') {
      inputRelative = request.schematic;
      supportArgs = ['sch', 'export', request.kind === 'schematic_svg' ? 'svg' : 'pdf'];
      const input = await resolveExistingProjectPath(this.paths, workspace, projectPath, request.schematic, 'KiCad schematic visual export');
      if (path.extname(input).toLowerCase() !== '.kicad_sch') throw new Error('KiCad schematic visual export requires a .kicad_sch file.');
      const theme = boundedTheme(request.theme);
      buildArgs = output => {
        if (request.kind === 'schematic_svg') {
          return {
            args: ['sch', 'export', 'svg', '--output', output, ...(request.blackAndWhite ? ['--black-and-white'] : []), ...(request.excludeDrawingSheet ? ['--exclude-drawing-sheet'] : []), ...(theme ? ['--theme', theme] : []), ...pagesArgs(request.pages), input]
          };
        }
        const fileName = safeOutputFileName(request.fileName ?? 'schematic.pdf', '.pdf');
        const outputFile = path.join(output, fileName);
        return {
          primaryName: fileName,
          args: ['sch', 'export', 'pdf', '--output', outputFile, ...(request.blackAndWhite ? ['--black-and-white'] : []), ...(request.excludeDrawingSheet ? ['--exclude-drawing-sheet'] : []), ...(theme ? ['--theme', theme] : []), ...pagesArgs(request.pages), input]
        };
      };
    } else {
      inputRelative = request.board;
      supportArgs = request.kind === 'pcb_3d_render' ? ['pcb', 'render'] : ['pcb', 'export', 'step'];
      const input = await resolveExistingProjectPath(this.paths, workspace, projectPath, request.board, 'KiCad PCB visual export');
      if (path.extname(input).toLowerCase() !== '.kicad_pcb') throw new Error('KiCad PCB visual export requires a .kicad_pcb file.');
      if (request.kind === 'pcb_3d_render') {
        const format = request.format ?? 'png';
        const extension = format === 'png' ? '.png' : '.jpeg';
        const fileName = safeOutputFileName(request.fileName ?? `board-3d${extension}`, extension);
        const width = request.width ?? 1600;
        const height = request.height ?? 900;
        const zoom = request.zoom ?? 1;
        if (!Number.isInteger(width) || width < 320 || width > 4096 || !Number.isInteger(height) || height < 240 || height > 4096) {
          throw new Error('KiCad 3D render dimensions must be integer width 320..4096 and height 240..4096.');
        }
        if (!Number.isFinite(zoom) || zoom < 0.1 || zoom > 10) throw new Error('KiCad 3D render zoom must be in range 0.1..10.');
        buildArgs = output => {
          const outputFile = path.join(output, fileName);
          return {
            primaryName: fileName,
            args: ['pcb', 'render', '--output', outputFile, '--width', String(width), '--height', String(height), '--side', request.side ?? 'top', '--background', request.background ?? 'default', '--quality', request.quality ?? 'high', '--zoom', String(zoom), ...(request.perspective ? ['--perspective'] : []), ...(request.floor ? ['--floor'] : []), ...(request.useBoardStackupColors ? ['--use-board-stackup-colors'] : []), input]
          };
        };
      } else {
        const fileName = safeOutputFileName(request.fileName ?? 'board.step', '.step');
        buildArgs = output => {
          const outputFile = path.join(output, fileName);
          return {
            primaryName: fileName,
            args: ['pcb', 'export', 'step', '--output', outputFile, ...(request.noDnp ? ['--no-dnp'] : []), ...(request.boardOnly ? ['--board-only'] : []), ...(request.substituteModels ? ['--subst-models'] : []), ...(request.includeTracks ? ['--include-tracks'] : []), ...(request.includePads ? ['--include-pads'] : []), ...(request.includeZones ? ['--include-zones'] : []), ...(request.includeInnerCopper ? ['--include-inner-copper'] : []), ...(request.includeSilkscreen ? ['--include-silkscreen'] : []), ...(request.includeSoldermask ? ['--include-soldermask'] : []), ...(request.fuseShapes ? ['--fuse-shapes'] : []), input]
          };
        };
      }
    }

    if (!await this.commandSupported(cli.path, projectRoot, supportArgs)) {
      throw new Error(`KICAD_CAPABILITY_UNAVAILABLE: this KiCad CLI does not provide ${supportArgs.join(' ')}.`);
    }

    const output = await prepareNewOutputDirectory(projectRoot, relativeOutput);
    const built = buildArgs(output);
    try {
      const result = await this.runner.run(cli.path, built.args, projectRoot, 180_000);
      if (result.exitCode !== 0 || result.timedOut) {
        throw new Error(`KiCad ${request.kind} export failed: ${result.stderr || result.stdout || `exit=${result.exitCode}`}`);
      }
      const manifest = await fabricationManifest(output);
      if (manifest.fileCount < 1) throw new Error('KiCad visual export produced no files.');
      const primaryArtifact = built.primaryName
        ? manifest.files.find(item => item.path === built.primaryName)
        : undefined;
      return {
        kind: request.kind,
        input: inputRelative,
        outputDir: relativeOutput.split(path.sep).join('/'),
        ...(primaryArtifact ? { primaryArtifact } : {}),
        manifest,
        command: {
          program: cli.path,
          args: built.args.map(arg => arg.startsWith(output) ? path.relative(projectRoot, arg).split(path.sep).join('/') : arg)
        }
      };
    } catch (error) {
      await fs.rm(output, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async inspectEditable(workspace: string, projectPath: string, file: string, maxItems = 500) {
    this.policy.assertEngineeringEnabled();
    const input = await resolveExistingProjectPath(this.paths, workspace, projectPath, file, 'KiCad edit file');
    const stat = await fs.stat(input);
    if (!stat.isFile()) throw new Error('KiCad edit target is not a regular file.');
    if (stat.size > 32 * 1024 * 1024) throw new Error('KiCad edit target exceeds the 32 MiB limit.');
    const source = await fs.readFile(input, 'utf8');
    return {
      file,
      size: stat.size,
      ...inspectKicadDocument(source, path.extname(input), maxItems)
    };
  }

  async transactionalEdit(
    workspace: string,
    projectPath: string,
    file: string,
    expectedSha256: string,
    operations: KicadEditOperation[]
  ) {
    this.policy.assertEngineeringExecute();
    this.policy.assertWrite(workspace);
    if (!/^[0-9a-f]{64}$/i.test(expectedSha256)) throw new Error('KiCad expectedSha256 must be a SHA-256 hex digest.');

    const projectRoot = await this.paths.resolveExisting(workspace, projectPath);
    const input = await resolveExistingProjectPath(this.paths, workspace, projectPath, file, 'KiCad edit file');
    const extension = path.extname(input).toLowerCase();
    if (!['.kicad_sch', '.kicad_pcb'].includes(extension)) {
      throw new Error('KiCad edit supports only .kicad_sch and .kicad_pcb files.');
    }

    const execute = async () => {
      const original = await fs.readFile(input, 'utf8');
      const originalSha256 = sha256Text(original);
      if (originalSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
        throw new Error('KICAD_EDIT_CONFLICT: expected SHA-256 ' + expectedSha256 + ', observed ' + originalSha256 + '.');
      }

      const baseline = extension === '.kicad_sch'
        ? await this.erc(workspace, projectPath, file)
        : await this.drc(workspace, projectPath, file);

      const patched = patchKicadDocument(original, operations, extension);
      const transactionId = randomUUID();
      const working = path.join(path.dirname(input), '.rwmcp-edit-' + transactionId + '-' + path.basename(input));
      await fs.writeFile(working, patched.text, 'utf8');
      const workingRelative = path.relative(projectRoot, working);

      try {
        const validation = extension === '.kicad_sch'
          ? await this.erc(workspace, projectPath, workingRelative)
          : await this.drc(workspace, projectPath, workingRelative);

        const baselineActiveErrors = Number(baseline.report.counts.active.bySeverity.error ?? 0);
        const postActiveErrors = Number(validation.report.counts.active.bySeverity.error ?? 0);
        let baselineUnconnected = 0;
        let postUnconnected = 0;
        let baselineParity = 0;
        let postParity = 0;
        if (extension === '.kicad_pcb') {
          const baselineDrc = baseline as Awaited<ReturnType<KicadAdapter['drc']>>;
          const postDrc = validation as Awaited<ReturnType<KicadAdapter['drc']>>;
          baselineUnconnected = Number(baselineDrc.report.counts.active.unconnected ?? 0);
          postUnconnected = Number(postDrc.report.counts.active.unconnected ?? 0);
          baselineParity = Number(baselineDrc.report.counts.active.schematicParity ?? 0);
          postParity = Number(postDrc.report.counts.active.schematicParity ?? 0);
        }

        if (postActiveErrors > baselineActiveErrors || postUnconnected > baselineUnconnected || postParity > baselineParity) {
          throw new Error(
            'KICAD_EDIT_ACCEPTANCE_FAILED: active errors ' + baselineActiveErrors + '->' + postActiveErrors +
            ', unconnected ' + baselineUnconnected + '->' + postUnconnected +
            ', schematicParity ' + baselineParity + '->' + postParity + '.'
          );
        }

        const currentOriginal = await fs.readFile(input, 'utf8');
        const currentSha256 = sha256Text(currentOriginal);
        if (currentSha256 !== originalSha256) {
          throw new Error('KICAD_EDIT_CONFLICT: source changed during edit; expected ' + originalSha256 + ', observed ' + currentSha256 + '.');
        }

        const backup = await createKicadBackup(input);
        await atomicReplace(input, patched.text);
        const committed = await fs.readFile(input, 'utf8');
        const committedSha256 = sha256Text(committed);
        return {
          transactionId,
          state: 'committed' as const,
          file,
          extension,
          originalSha256,
          committedSha256,
          backupPath: path.relative(projectRoot, backup).split(path.sep).join('/'),
          operations: patched.results,
          acceptance: {
            baseline: {
              activeErrors: baselineActiveErrors,
              unconnected: baselineUnconnected,
              schematicParity: baselineParity
            },
            post: {
              activeErrors: postActiveErrors,
              unconnected: postUnconnected,
              schematicParity: postParity
            },
            passed: true
          }
        };
      } finally {
        await fs.rm(working, { force: true }).catch(() => undefined);
      }
    };

    return this.resources
      ? await this.resources.withLease('kicad-file:' + input, 'orchestrating', execute)
      : await execute();
  }

  async fabricationExport(
    workspace: string,
    projectPath: string,
    files: KicadProjectFiles,
    outputDir: string
  ) {
    this.policy.assertEngineeringExecute();
    this.policy.assertWrite(workspace);
    if (!files.board) throw new Error('KiCad fabrication export requires a .kicad_pcb board file.');

    const validation = await this.validate(workspace, projectPath, files);
    const drcErrors = Number(validation.drc?.report.counts.active.bySeverity.error ?? 0);
    const ercErrors = Number(validation.erc?.report.counts.active.bySeverity.error ?? 0);
    const unconnected = Number(validation.drc?.report.counts.active.unconnected ?? 0);
    const schematicParity = Number(validation.drc?.report.counts.active.schematicParity ?? 0);
    if (drcErrors + ercErrors + unconnected + schematicParity > 0) {
      throw new Error(
        `KiCad fabrication export blocked by active validation findings: DRC errors=${drcErrors}, ERC errors=${ercErrors}, unconnected=${unconnected}, schematicParity=${schematicParity}.`
      );
    }

    const projectRoot = await this.paths.resolveExisting(workspace, projectPath);
    const relativeOutput = safeOutputDirectory(outputDir);
    const output = await prepareNewOutputDirectory(projectRoot, relativeOutput);

    const cli = await discoverKicadCli();
    const board = await resolveExistingProjectPath(this.paths, workspace, projectPath, files.board, 'KiCad board file');
    const schematic = files.schematic
      ? await resolveExistingProjectPath(this.paths, workspace, projectPath, files.schematic, 'KiCad schematic file')
      : undefined;
    const gerbers = path.join(output, 'gerbers');
    const drill = path.join(output, 'drill');
    const bom = path.join(output, 'bom.csv');

    await fs.mkdir(gerbers, { recursive: true });
    await fs.mkdir(drill, { recursive: true });

    const commands: Array<{ id: string; args: string[] }> = [
      { id: 'gerbers', args: ['pcb', 'export', 'gerbers', '--output', gerbers, board] },
      { id: 'drill', args: ['pcb', 'export', 'drill', '--output', drill, board] },
      ...(schematic ? [{ id: 'bom', args: ['sch', 'export', 'bom', '--output', bom, schematic] }] : [])
    ];

    try {
      for (const command of commands) {
        const result = await this.runner.run(cli.path, command.args, projectRoot, 180_000);
        if (result.exitCode !== 0 || result.timedOut) {
          throw new Error(`KiCad ${command.id} export failed: ${result.stderr || result.stdout || `exit=${result.exitCode}`}`);
        }
      }
      const manifest = await fabricationManifest(output);
      const manifestPath = path.join(output, 'manifest.json');
      await fs.writeFile(manifestPath, `${JSON.stringify({
        ...manifest,
        generatedAt: new Date().toISOString(),
        source: {
          board: files.board,
          ...(files.schematic ? { schematic: files.schematic } : {})
        },
        validation: { drcErrors, ercErrors }
      }, null, 2)}\n`, 'utf8');
      return {
        outputDir: relativeOutput.split(path.sep).join('/'),
        manifestPath: path.relative(projectRoot, manifestPath).split(path.sep).join('/'),
        manifest,
        validation,
        commands: commands.map(command => ({
          id: command.id,
          args: command.args.map(arg =>
            arg === board ? files.board! :
            arg === schematic ? files.schematic! :
            arg === gerbers ? path.join(relativeOutput, 'gerbers').split(path.sep).join('/') :
            arg === drill ? path.join(relativeOutput, 'drill').split(path.sep).join('/') :
            arg === bom ? path.join(relativeOutput, 'bom.csv').split(path.sep).join('/') :
            arg
          )
        }))
      };
    } catch (error) {
      await fs.rm(output, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
}
