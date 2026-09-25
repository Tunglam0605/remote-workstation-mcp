import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { KicadProjectFiles } from '../../engineering/types.js';
import { PolicyEngine } from '../../policy.js';
import { PathGuard } from '../../security/path-guard.js';
import { EngineeringCommandRunner } from './command-runner.js';
import { resolveExecutable, resolveFirstExecutable } from './executable-resolver.js';
import { resolveExistingProjectPath } from './project-path.js';
import { parseKicadBomCsv } from './kicad-bom.js';

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
    private readonly runner: EngineeringCommandRunner
  ) {}

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

  async version(workspace: string, projectPath = '.') {
    this.policy.assertEngineeringEnabled();
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const cli = await discoverKicadCli();
    const result = await this.runner.run(cli.path, ['version'], cwd, 10_000);
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`KiCad version probe failed: ${result.stderr || result.stdout}`);
    return { version: result.stdout.trim() || result.stderr.trim(), executable: cli.path, executableSource: cli.source };
  }

  async boardStats(workspace: string, projectPath: string, board: string) {
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
    const boardStats = files.board ? await this.boardStats(workspace, projectPath, files.board) : undefined;
    return { provider, files, ...(boardStats ? { boardStats } : {}) };
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
