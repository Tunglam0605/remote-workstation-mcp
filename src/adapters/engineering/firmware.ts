import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineeringCommandResult, FirmwareArtifact, FirmwareFlashPlan, FirmwareProjectInfo, FirmwareProjectTarget, FirmwareProviderStatus, KeilBuildSummary } from '../../engineering/types.js';
import { PolicyEngine } from '../../policy.js';
import { parseBuildDiagnostics } from '../build-diagnostics.js';
import { PathGuard } from '../../security/path-guard.js';
import { FirmwareArtifactFinder } from './artifact-finder.js';
import { EngineeringCommandRunner } from './command-runner.js';
import { readEspIdfBuildMetadata } from './esp-idf-metadata.js';
import { resolveExecutable, resolveFirstExecutable } from './executable-resolver.js';
import { HardwareDiscoveryAdapter } from './hardware-discovery.js';
import { validateOpenOcdTargetConfig, validateProbeSerial } from './openocd-policy.js';
import { classifyOpenOcdResult, openOcdAdapterSpeedArgs, openOcdSearchPathArgs, resolveOpenOcdExecutable, validateAdapterSpeedKhz } from './openocd-provider.js';
import { FirmwareProjectInspector, stm32OpenOcdTargetConfig } from './project-inspector.js';
import { resolveExistingProjectPath } from './project-path.js';
import { EngineeringResourceManager } from './resource-manager.js';
import { validateSerialPortPath } from './serial-port-policy.js';

function safeTclValue(value: string, label: string): string {
  if (/[{}\r\n]/.test(value)) throw new Error(`${label} contains characters unsafe for OpenOCD Tcl.`);
  return value;
}

function normalizedOpenOcdPath(value: string): string {
  return safeTclValue(value.replaceAll('\\', '/'), 'Artifact path');
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

async function discoverEspIdfRoot(): Promise<string | undefined> {
  const configured = process.env.RWMCP_ESP_IDF_PATH || process.env.IDF_PATH;
  if (configured && await exists(path.join(configured, 'tools', 'idf.py'))) return path.resolve(configured);
  const candidates: string[] = [];
  if (os.platform() === 'win32') {
    const base = process.env.RWMCP_ESPRESSIF_HOME || 'C:\\Espressif';
    try {
      for (const entry of await fs.readdir(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const root = path.join(base, entry.name, 'esp-idf');
        if (await exists(path.join(root, 'tools', 'idf.py'))) candidates.push(root);
      }
    } catch { /* optional installation */ }
  } else {
    const home = os.homedir();
    candidates.push(path.join(home, 'esp', 'esp-idf'), path.join(home, 'esp-idf'), '/opt/esp/esp-idf');
  }
  const valid: string[] = [];
  for (const candidate of candidates) if (await exists(path.join(candidate, 'tools', 'idf.py'))) valid.push(candidate);
  return valid.sort().at(-1);
}

function helperPath(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../scripts', name);
}

interface CommandSpec { program: string; args: string[]; }

async function espIdfCommand(args: string[]): Promise<CommandSpec> {
  const direct = await resolveExecutable('idf.py');
  if (direct) {
    if (direct.toLowerCase().endsWith('.py')) {
      const python = await resolveFirstExecutable(['python', 'python3']);
      if (!python) throw new Error('idf.py was found but Python is unavailable.');
      return { program: python.path, args: [direct, ...args] };
    }
    return { program: direct, args };
  }
  const root = await discoverEspIdfRoot();
  if (!root) throw new Error('ESP-IDF was not found. Configure RWMCP_ESP_IDF_PATH or install/export ESP-IDF.');
  if (os.platform() === 'win32') {
    const powershell = await resolveFirstExecutable(['powershell.exe', 'pwsh.exe']);
    if (!powershell) throw new Error('PowerShell is required to activate an installed ESP-IDF environment on Windows.');
    return {
      program: powershell.path,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath('esp-idf-run.ps1'), '-IdfPath', root, '-ArgsJson', JSON.stringify(args)]
    };
  }
  const bash = await resolveFirstExecutable(['bash']);
  if (!bash) throw new Error('bash is required to activate an installed ESP-IDF environment on Linux.');
  return { program: bash.path, args: [helperPath('esp-idf-run.sh'), root, ...args] };
}

async function discoverKeilUv4(): Promise<{ path: string; source: 'owner-override' | 'path' | 'known-install' } | undefined> {
  if (os.platform() !== 'win32') return undefined;
  const override = process.env.RWMCP_KEIL_UVISION_EXECUTABLE?.trim();
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('RWMCP_KEIL_UVISION_EXECUTABLE must be an absolute path.');
    const resolved = await resolveExecutable(override);
    if (!resolved) throw new Error(`Configured Keil uVision executable was not found: ${override}`);
    return { path: resolved, source: 'owner-override' };
  }
  const direct = await resolveFirstExecutable(['UV4.exe', 'UV4']);
  if (direct) return { path: direct.path, source: 'path' };
  const candidates = [
    'C:\\Keil_v5\\UV4\\UV4.exe',
    'C:\\Keil\\UV4\\UV4.exe',
    'C:\\Program Files\\Keil_v5\\UV4\\UV4.exe',
    'C:\\Program Files (x86)\\Keil_v5\\UV4\\UV4.exe'
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return { path: candidate, source: 'known-install' };
  }
  return undefined;
}

function validateKeilTargetName(value: string | undefined): string {
  const target = value?.trim();
  if (!target || target.length > 160 || /[\0\r\n]/.test(target)) {
    throw new Error('Keil build requires a keilTarget of 1..160 characters without control characters.');
  }
  return target;
}

async function readBoundedText(file: string, maxBytes: number): Promise<string> {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      const length = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

function keilToolchain(text: string): KeilBuildSummary['toolchain'] {
  const compiler = /Using Compiler\s+['"]?([^'"\r\n,]+)['"]?[^\r\n]*/i.exec(text);
  const version = compiler?.[1]?.match(/V?([0-9]+(?:\.[0-9]+){1,3})/i)?.[1];
  const lower = text.toLowerCase();
  const family = lower.includes('armclang')
    ? 'armclang'
    : lower.includes('armcc') || /using compiler[^\r\n]*v5\./i.test(text)
      ? 'armcc'
      : 'unknown';
  return {
    family,
    ...(version ? { version } : {})
  };
}

function keilLicense(text: string): KeilBuildSummary['license'] {
  const lines = text.split(/\r?\n/).filter(line => /licen[sc]e|flexnet|checkout/i.test(line));
  const failure = lines.find(line => /fail|error|denied|expired|unlicensed|not available|cannot|could not/i.test(line));
  if (failure) {
    return {
      status: 'error',
      message: failure.trim().slice(0, 512)
    };
  }
  const success = lines.find(line => /checkout.*success|license.*valid|licensed/i.test(line));
  if (success) {
    return {
      status: 'ok',
      message: success.trim().slice(0, 512)
    };
  }
  return { status: 'unknown' };
}

async function keilArtifactSummary(
  cwd: string,
  target: FirmwareProjectTarget
): Promise<KeilBuildSummary['artifact']> {
  const expectedPath = target.expectedArtifact;
  const expectedHexPath = target.createHexFile && target.outputDirectory && target.outputName
    ? path.posix.join(target.outputDirectory, `${target.outputName}.hex`)
    : undefined;
  if (!expectedPath) {
    return {
      ...(expectedHexPath ? { expectedHexPath } : {}),
      exists: false
    };
  }
  const absolute = path.resolve(cwd, expectedPath.replaceAll('/', path.sep));
  try {
    const stat = await fs.stat(absolute);
    return {
      expectedPath,
      ...(expectedHexPath ? { expectedHexPath } : {}),
      exists: stat.isFile(),
      ...(stat.isFile() ? { size: stat.size, mtime: stat.mtime.toISOString() } : {})
    };
  } catch {
    return {
      expectedPath,
      ...(expectedHexPath ? { expectedHexPath } : {}),
      exists: false
    };
  }
}

async function summarizeKeilBuild(
  text: string,
  resolved: { path: string; source: 'owner-override' | 'path' | 'known-install' },
  target: FirmwareProjectTarget,
  cwd: string
): Promise<KeilBuildSummary> {
  const parsed = parseBuildDiagnostics(text, 80);
  const summary = /([0-9]+)\s+Error\(s\)\s*,\s*([0-9]+)\s+Warning\(s\)/i.exec(text);
  const diagnosticErrors = parsed.diagnostics.filter(item => item.severity === 'fatal' || item.severity === 'error').length;
  const diagnosticWarnings = parsed.diagnostics.filter(item => item.severity === 'warning').length;
  const diagnosticNotes = parsed.diagnostics.filter(item => item.severity === 'note').length;
  return {
    target: {
      projectFile: target.projectFile,
      targetName: target.targetName,
      ...(target.device ? { device: target.device } : {}),
      ...(target.outputDirectory ? { outputDirectory: target.outputDirectory } : {}),
      ...(target.outputName ? { outputName: target.outputName } : {}),
      ...(target.expectedArtifact ? { expectedArtifact: target.expectedArtifact } : {}),
      ...(target.createHexFile ? { createHexFile: true } : {})
    },
    toolchain: keilToolchain(text),
    provider: {
      executable: resolved.path,
      executableSource: resolved.source
    },
    license: keilLicense(text),
    counts: {
      errors: summary?.[1] ? Number(summary[1]) : diagnosticErrors,
      warnings: summary?.[2] ? Number(summary[2]) : diagnosticWarnings,
      notes: diagnosticNotes
    },
    diagnostics: parsed.diagnostics.map(item => ({
      ...(item.file ? { file: item.file } : {}),
      ...(item.line !== undefined ? { line: item.line } : {}),
      ...(item.column !== undefined ? { column: item.column } : {}),
      severity: item.severity,
      ...(item.code ? { code: item.code } : {}),
      message: item.message
    })),
    diagnosticsTruncated: parsed.truncated,
    artifact: await keilArtifactSummary(cwd, target)
  };
}
export class FirmwareAdapter {
  readonly inspector: FirmwareProjectInspector;
  readonly artifacts: FirmwareArtifactFinder;

  constructor(
    private readonly policy: PolicyEngine,
    private readonly paths: PathGuard,
    private readonly runner: EngineeringCommandRunner,
    private readonly resources: EngineeringResourceManager,
    private readonly hardware: HardwareDiscoveryAdapter
  ) {
    this.inspector = new FirmwareProjectInspector(paths);
    this.artifacts = new FirmwareArtifactFinder(paths);
  }

  private async selectProbe(requestedSerial?: string): Promise<{ probeSerial?: string; resourceId: string }> {
    validateProbeSerial(requestedSerial);
    const probes = (await this.hardware.list()).filter(item => item.kind === 'debug-probe' && item.capabilities.includes('swd'));
    if (requestedSerial) {
      if (probes.length > 0 && !probes.some(item => item.serialNumber === requestedSerial)) {
        throw new Error(`Requested probeSerial '${requestedSerial}' is not among the discovered ST-Link probes.`);
      }
      return { probeSerial: requestedSerial, resourceId: `debug-probe:${requestedSerial}` };
    }
    if (probes.length > 1) {
      throw new Error(`Multiple debug probes are present (${probes.length}); probeSerial is required.`);
    }
    const probe = probes[0];
    return {
      probeSerial: probe?.serialNumber,
      resourceId: probe?.serialNumber ? `debug-probe:${probe.serialNumber}` : (probe?.id ?? 'debug-probe:auto')
    };
  }

  inspect(workspace: string, projectPath = '.'): Promise<FirmwareProjectInfo> {
    this.policy.assertEngineeringEnabled();
    return this.inspector.inspect(workspace, projectPath);
  }

  listArtifacts(workspace: string, projectPath = '.'): Promise<FirmwareArtifact[]> {
    this.policy.assertEngineeringEnabled();
    return this.artifacts.find(workspace, projectPath);
  }

  async providerStatus(provider: 'openocd' | 'keil' = 'openocd'): Promise<FirmwareProviderStatus> {
    this.policy.assertEngineeringEnabled();
    if (provider === 'keil') {
      const resolved = await discoverKeilUv4();
      const base = {
        provider: 'keil' as const,
        capabilities: ['uvprojx', 'multi-target', 'batch-build', 'build-log'],
        intentionallyUnavailable: ['arbitrary-command-line', 'interactive-ide-control', 'flash-download', 'debugger-automation']
      };
      if (!resolved) {
        return {
          ...base,
          available: false,
          diagnostic: {
            code: 'provider-unavailable', ok: false, retryable: false,
            message: 'Keil µVision (UV4.exe) is unavailable.',
            hint: 'Install Keil MDK or set owner-controlled RWMCP_KEIL_UVISION_EXECUTABLE to an absolute UV4.exe path.'
          }
        };
      }
      return {
        ...base,
        available: true,
        executable: resolved.path,
        executableSource: resolved.source,
        licenseStatus: 'unknown',
        licenseMessage: 'Keil license validity is established from bounded build output, not inferred from executable presence.',
        diagnostic: { code: 'ok', ok: true, retryable: false, message: 'Keil µVision batch build provider is available.' }
      };
    }

    const resolved = await resolveOpenOcdExecutable();
    const base = {
      provider: 'openocd' as const,
      capabilities: ['swd', 'st-link', 'flash', 'verify', 'reset', 'gdb-server'],
      intentionallyUnavailable: ['arbitrary-tcl', 'mass-erase', 'option-bytes', 'readout-protection-change', 'memory-write']
    };
    if (!resolved) return { ...base, available: false, diagnostic: { code: 'provider-unavailable', ok: false, retryable: false, message: 'OpenOCD is not configured, available on PATH, or discoverable from STM32CubeIDE.', hint: 'Install STM32CubeIDE/OpenOCD or set owner-controlled RWMCP_OPENOCD_EXECUTABLE (and optionally RWMCP_OPENOCD_SCRIPTS) to absolute paths.' } };
    const result = await this.runner.run(resolved.path, ['--version'], process.cwd(), 5000);
    const text = `${result.stdout}\n${result.stderr}`.trim();
    const match = /Open On-Chip Debugger\s+([^\s]+)/i.exec(text);
    return {
      ...base,
      available: result.exitCode === 0 && !result.timedOut,
      executable: resolved.path,
      executableSource: resolved.source,
      ...(resolved.scriptsPath ? { scriptSearchPath: resolved.scriptsPath } : {}),
      ...(match?.[1] ? { version: match[1] } : {}),
      diagnostic: classifyOpenOcdResult(result)
    };
  }
  async espIdfDiagnostics(workspace: string, projectPath = '.', buildDir = 'build') {
    this.policy.assertEngineeringExecute();
    const project = await this.inspect(workspace, projectPath);
    if (project.framework !== 'esp-idf' && project.family !== 'esp32') {
      throw new Error('espidf.diagnostics requires a detected ESP-IDF/ESP32 project.');
    }
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const versionCommand = await espIdfCommand(['--version']);
    const targetsCommand = await espIdfCommand(['--list-targets']);
    const [versionResult, targetsResult, artifacts, devices, buildMetadata] = await Promise.all([
      this.runner.run(versionCommand.program, versionCommand.args, cwd, 10_000),
      this.runner.run(targetsCommand.program, targetsCommand.args, cwd, 15_000),
      this.listArtifacts(workspace, projectPath),
      this.hardware.list(),
      readEspIdfBuildMetadata(cwd, buildDir)
    ]);
    if (versionResult.exitCode !== 0 || versionResult.timedOut) {
      throw new Error(`ESP-IDF version probe failed: ${versionResult.stderr || versionResult.stdout || `exit=${versionResult.exitCode}`}`);
    }
    const supportedTargets = targetsResult.exitCode === 0 && !targetsResult.timedOut
      ? targetsResult.stdout.split(/\r?\n/).map(item => item.trim()).filter(item => /^[a-z0-9_-]+$/.test(item)).slice(0, 64)
      : [];
    const warnings = [
      ...buildMetadata.warnings,
      ...(targetsResult.exitCode === 0 && !targetsResult.timedOut
        ? []
        : [`ESP-IDF target discovery failed: ${targetsResult.stderr || targetsResult.stdout || `exit=${targetsResult.exitCode}`}`])
    ];
    return {
      provider: 'esp-idf' as const,
      version: versionResult.stdout.trim() || versionResult.stderr.trim(),
      supportedTargets,
      project,
      buildMetadata,
      artifacts,
      serialPorts: devices
        .filter(item => item.kind === 'serial')
        .map(item => ({ id: item.id, path: item.path, name: item.name, serialNumber: item.serialNumber, provider: item.provider })),
      warnings
    };
  }

  async espIdfSizeAnalysis(workspace: string, projectPath = '.') {
    this.policy.assertEngineeringExecute();
    const project = await this.inspect(workspace, projectPath);
    if (project.framework !== 'esp-idf' && project.family !== 'esp32') {
      throw new Error('espidf.size_analysis requires a detected ESP-IDF/ESP32 project.');
    }
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const outputs: Record<'summary' | 'components' | 'files', unknown> = {
      summary: {},
      components: {},
      files: {}
    };
    const formats: Record<'summary' | 'components' | 'files', 'json2' | 'json'> = {
      summary: 'json', components: 'json', files: 'json'
    };
    const commands = [
      ['summary', 'size'],
      ['components', 'size-components'],
      ['files', 'size-files']
    ] as const;
    for (const [key, verb] of commands) {
      let accepted: { stdout: string; format: 'json2' | 'json' } | undefined;
      const failures: string[] = [];
      for (const format of ['json2', 'json'] as const) {
        const command = await espIdfCommand([verb, '--format', format]);
        const result = await this.runner.run(command.program, command.args, cwd, 120_000);
        if (result.exitCode !== 0 || result.timedOut) {
          failures.push(`${format}: ${result.stderr || result.stdout || `exit=${result.exitCode}`}`);
          continue;
        }
        try {
          JSON.parse(result.stdout.trim());
          accepted = { stdout: result.stdout, format };
          break;
        } catch {
          failures.push(`${format}: invalid structured output`);
        }
      }
      if (!accepted) {
        throw new Error(`ESP-IDF ${verb} failed structured-output compatibility probes: ${failures.join(' | ')}`);
      }
      outputs[key] = JSON.parse(accepted.stdout.trim()) as unknown;
      formats[key] = accepted.format;
    }
    return { provider: 'esp-idf' as const, project, formats, ...outputs };
  }

  async build(
    workspace: string,
    projectPath = '.',
    provider: 'auto' | 'esp-idf' | 'cmake' | 'make' | 'keil' = 'auto',
    buildDir = 'build',
    keilProject?: string,
    keilTarget?: string
  ): Promise<{ project: FirmwareProjectInfo; provider: string; result: EngineeringCommandResult; keil?: KeilBuildSummary }> {
    this.policy.assertEngineeringExecute();
    const project = await this.inspect(workspace, projectPath);
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const selected = provider === 'auto'
      ? project.framework === 'esp-idf' ? 'esp-idf' : project.buildSystem === 'keil' ? 'keil' : project.buildSystem === 'make' ? 'make' : 'cmake'
      : provider;

    if (selected === 'keil') {
      if (os.platform() !== 'win32') throw new Error('Keil µVision batch build is supported on Windows only.');
      const resolved = await discoverKeilUv4();
      if (!resolved) throw new Error('Keil µVision (UV4.exe) is unavailable.');
      const target = validateKeilTargetName(keilTarget);
      const projectFile = keilProject?.trim();
      if (!projectFile) throw new Error('Keil build requires keilProject in the project profile or workflow parameters.');
      const declared = project.targets?.find(item =>
        item.projectFile.toLowerCase() === projectFile.toLowerCase() && item.targetName === target
      );
      if (project.targets?.length && !declared) {
        throw new Error(`Keil target '${target}' in '${projectFile}' was not found in inspected .uvprojx metadata.`);
      }
      const projectAbsolute = await resolveExistingProjectPath(this.paths, workspace, projectPath, projectFile, 'keilProject');
      const buildResourceId = `project-variant:keil:${workspace}:${projectPath}:${projectFile}:${target}`;
      return this.resources.withLease(buildResourceId, 'building', async () => {
        const logPath = path.join(os.tmpdir(), `rwmcp-keil-${process.pid}-${Date.now()}.log`);
        let result: EngineeringCommandResult;
        try {
          // Compatibility baseline: µVision 5.31 accepts -j0/-b/-t/-o but returns a non-build exit code when the newer -sg flag is forced.
          result = await this.runner.run(resolved.path, ['-j0', '-b', projectAbsolute, `-t${target}`, `-o${logPath}`], cwd);
          const log = await readBoundedText(logPath, this.policy.config.process.maxOutputBytes);
          if (log) result = { ...result, stdout: [result.stdout, log].filter(Boolean).join('\n').slice(-this.policy.config.process.maxOutputBytes) };
        } finally {
          await fs.rm(logPath, { force: true }).catch(() => undefined);
        }
        const targetMetadata: FirmwareProjectTarget = declared ?? {
          id: 'keil-target',
          projectFile,
          targetName: target
        };
        const keil = await summarizeKeilBuild(`${result.stdout}\n${result.stderr}`, resolved, targetMetadata, cwd);
        return { project, provider: selected, result, keil };
      });
    }

    let command: CommandSpec;
    if (selected === 'esp-idf') {
      command = await espIdfCommand(['build']);
    } else if (selected === 'cmake') {
      const cmake = await resolveFirstExecutable(['cmake']);
      if (!cmake) throw new Error('CMake is unavailable.');
      const buildAbsolute = await resolveExistingProjectPath(this.paths, workspace, projectPath, buildDir, 'buildDir');
      command = { program: cmake.path, args: ['--build', buildAbsolute] };
    } else {
      const make = await resolveFirstExecutable(os.platform() === 'win32' ? ['mingw32-make', 'make'] : ['make', 'gmake']);
      if (!make) throw new Error('Make is unavailable.');
      command = { program: make.path, args: [] };
    }
    const result = await this.runner.run(command.program, command.args, cwd);
    return { project, provider: selected, result };
  }
  async flashPlan(options: {
    workspace: string;
    projectPath?: string;
    artifact?: string;
    provider?: 'auto' | 'openocd' | 'esp-idf';
    port?: string;
    probeSerial?: string;
    targetConfig?: string;
    adapterSpeedKhz?: number;
  }): Promise<FirmwareFlashPlan> {
    this.policy.assertEngineeringEnabled();
    const projectPath = options.projectPath ?? '.';
    const project = await this.inspect(options.workspace, projectPath);
    const selected = options.provider === 'auto' || !options.provider
      ? project.framework === 'esp-idf' ? 'esp-idf' : 'openocd'
      : options.provider;
    const cwd = await this.paths.resolveExisting(options.workspace, projectPath);

    if (selected === 'esp-idf') {
      if (!options.port) throw new Error('ESP-IDF flash requires an explicit serial port; automatic first-port flashing is intentionally disabled.');
      const port = validateSerialPortPath(options.port);
      const command = await espIdfCommand(['-p', port, 'flash']);
      return {
        provider: 'esp-idf', family: project.family, target: project.target, port,
        program: command.program, args: command.args, resourceId: `serial:${port}`, destructive: true,
        notes: ['idf.py flash rebuilds changed outputs automatically.', 'The serial port is explicit to prevent flashing the wrong board.']
      };
    }

    let artifactRelative = options.artifact;
    if (!artifactRelative) {
      const candidates = (await this.listArtifacts(options.workspace, projectPath)).filter(item => ['elf', 'axf', 'hex'].includes(item.kind));
      if (candidates.length !== 1) {
        throw new Error(`OpenOCD flash requires an explicit artifact when discovery finds ${candidates.length} ELF/AXF/HEX candidates.`);
      }
      artifactRelative = candidates[0]!.path;
    }
    const artifactAbsolute = await resolveExistingProjectPath(this.paths, options.workspace, projectPath, artifactRelative, 'artifact');
    const targetConfigRaw = options.targetConfig ?? stm32OpenOcdTargetConfig(project.target);
    if (!targetConfigRaw) throw new Error(`Unable to map target '${project.target ?? 'unknown'}' to an OpenOCD target config; provide targetConfig explicitly.`);
    const targetConfig = validateOpenOcdTargetConfig(targetConfigRaw);
    const openocd = await resolveOpenOcdExecutable();
    if (!openocd) throw new Error('OpenOCD is unavailable. Install/configure OpenOCD before flashing.');
    const selectedProbe = await this.selectProbe(options.probeSerial);
    const probeSerial = selectedProbe.probeSerial;
    const adapterSpeedKhz = validateAdapterSpeedKhz(options.adapterSpeedKhz);
    const tclArtifact = normalizedOpenOcdPath(artifactAbsolute);
    const args = [
      ...openOcdSearchPathArgs(openocd),
      '-f', 'interface/stlink.cfg', '-c', 'transport select swd', '-f', targetConfig,
      ...(probeSerial ? ['-c', `adapter serial ${probeSerial}`] : []),
      ...openOcdAdapterSpeedArgs(adapterSpeedKhz),
      '-c', 'init', '-c', 'reset halt', '-c', `program {${tclArtifact}} verify`, '-c', 'reset run', '-c', 'shutdown'
    ];
    return {
      provider: 'openocd', family: project.family, target: project.target, artifact: artifactAbsolute,
      probeSerial, targetConfig, ...(adapterSpeedKhz !== undefined ? { adapterSpeedKhz } : {}), program: openocd.path,
      ...(openocd.scriptsPath ? { scriptSearchPath: openocd.scriptsPath } : {}), args,
      resourceId: selectedProbe.resourceId, destructive: true,
      notes: ['OpenOCD is bound to an explicit ST-Link/SWD target transaction.', 'No mass erase, Option Byte, readout-protection, or arbitrary TCL surface is exposed.']
    };
  }

  async stm32DeploymentPreflight(options: { probeSerial?: string; monitorPort?: string; adapterSpeedKhz?: number } = {}) {
    this.policy.assertEngineeringEnabled();
    validateProbeSerial(options.probeSerial);
    const monitorPort = options.monitorPort ? validateSerialPortPath(options.monitorPort) : undefined;
    const [provider, devices] = await Promise.all([
      this.providerStatus('openocd'),
      this.hardware.list()
    ]);
    const probes = devices.filter(item => item.kind === 'debug-probe' && item.capabilities.includes('swd'));
    const serialPorts = devices.filter(item => item.kind === 'serial' && item.path);
    const blockers: string[] = [];
    let selectedProbe = undefined as (typeof probes)[number] | undefined;

    if (!provider.available) blockers.push(provider.diagnostic?.message ?? 'OpenOCD provider is unavailable.');
    if (options.probeSerial) {
      selectedProbe = probes.find(item => item.serialNumber === options.probeSerial);
      if (!selectedProbe) blockers.push(`Requested ST-Link '${options.probeSerial}' is not currently discovered.`);
    } else if (probes.length === 0) {
      blockers.push('No ST-Link/SWD debug probe is currently discovered.');
    } else if (probes.length > 1) {
      blockers.push(`Multiple ST-Link/SWD probes are present (${probes.length}); configure probeSerial or pass parameters.probeSerial.`);
    } else {
      selectedProbe = probes[0];
    }

    let probeAccess = undefined as undefined | {
      resourceId: string;
      probeSerial?: string;
      adapterSpeedKhz: number;
      targetVoltage?: number;
      diagnostic: ReturnType<typeof classifyOpenOcdResult>;
      result: EngineeringCommandResult;
    };

    if (provider.available && selectedProbe && blockers.length === 0) {
      const openocd = await resolveOpenOcdExecutable();
      if (!openocd) {
        blockers.push('OpenOCD became unavailable during probe preflight.');
      } else {
        const adapterSpeedKhz = validateAdapterSpeedKhz(options.adapterSpeedKhz) ?? 1000;
        const resourceId = selectedProbe.serialNumber ? `debug-probe:${selectedProbe.serialNumber}` : selectedProbe.id;
        const args = [
          '-d3',
          ...openOcdSearchPathArgs(openocd),
          '-f', 'interface/stlink.cfg',
          '-c', 'transport select swd',
          ...(selectedProbe.serialNumber ? ['-c', `adapter serial ${selectedProbe.serialNumber}`] : []),
          ...openOcdAdapterSpeedArgs(adapterSpeedKhz),
          '-c', 'init',
          '-c', 'shutdown'
        ];
        const result = await this.resources.withLease(
          resourceId,
          'reading',
          () => this.runner.run(openocd.path, args, process.cwd(), 10_000)
        );
        const diagnostic = classifyOpenOcdResult(result);
        const voltageMatch = /Target voltage:\s*([0-9]+(?:\.[0-9]+)?)/i.exec(`${result.stdout}\n${result.stderr}`);
        const targetVoltage = voltageMatch?.[1] ? Number(voltageMatch[1]) : undefined;
        probeAccess = {
          resourceId,
          ...(selectedProbe.serialNumber ? { probeSerial: selectedProbe.serialNumber } : {}),
          adapterSpeedKhz,
          ...(Number.isFinite(targetVoltage) ? { targetVoltage } : {}),
          diagnostic,
          result
        };
        if (!diagnostic.ok) blockers.push(diagnostic.message);
      }
    }

    let selectedSerialPort = undefined as (typeof serialPorts)[number] | undefined;
    if (monitorPort) {
      const normalized = os.platform() === 'win32' ? monitorPort.toLowerCase() : monitorPort;
      selectedSerialPort = serialPorts.find(item => {
        const candidate = item.path ?? '';
        return (os.platform() === 'win32' ? candidate.toLowerCase() : candidate) === normalized;
      });
      if (!selectedSerialPort) blockers.push(`Configured serial monitor port '${monitorPort}' is not currently discovered.`);
    }

    return {
      ready: blockers.length === 0,
      provider,
      selectedProbe,
      selectedSerialPort,
      probeAccess,
      discovered: {
        probes: probes.map(item => ({ id: item.id, name: item.name, serialNumber: item.serialNumber, provider: item.provider })),
        serialPorts: serialPorts.map(item => ({ id: item.id, path: item.path, name: item.name, provider: item.provider }))
      },
      blockers
    };
  }

  async deployVerifyReset(options: Omit<Parameters<FirmwareAdapter['flashPlan']>[0], 'provider' | 'port'>): Promise<{
    plan: FirmwareFlashPlan;
    result: EngineeringCommandResult;
    diagnostic: ReturnType<typeof classifyOpenOcdResult>;
    stages: readonly ['flash', 'verify', 'reset'];
  }> {
    this.policy.assertHardwareMutation();
    const plan = await this.flashPlan({ ...options, provider: 'openocd' });
    if (plan.provider !== 'openocd' || !plan.artifact || !plan.targetConfig) {
      throw new Error('STM32 deploy transaction requires a resolved OpenOCD artifact and targetConfig.');
    }
    const args = [
      ...(plan.scriptSearchPath ? ['-s', plan.scriptSearchPath] : []),
      '-f', 'interface/stlink.cfg', '-c', 'transport select swd', '-f', plan.targetConfig,
      ...(plan.probeSerial ? ['-c', `adapter serial ${plan.probeSerial}`] : []),
      ...openOcdAdapterSpeedArgs(plan.adapterSpeedKhz),
      '-c', 'init',
      '-c', 'reset halt',
      '-c', `program {${normalizedOpenOcdPath(plan.artifact)}} verify`,
      '-c', `verify_image {${normalizedOpenOcdPath(plan.artifact)}}`,
      '-c', 'reset run',
      '-c', 'shutdown'
    ];
    const transactionPlan: FirmwareFlashPlan = {
      ...plan,
      args,
      notes: [
        ...plan.notes,
        'Flash, independent verify and reset execute inside one ST-Link lease and one OpenOCD process.'
      ]
    };
    const cwd = await this.paths.resolveExisting(options.workspace, options.projectPath ?? '.');
    const result = await this.resources.withLease(
      transactionPlan.resourceId,
      'flashing',
      () => this.runner.run(transactionPlan.program, transactionPlan.args, cwd)
    );
    return {
      plan: transactionPlan,
      result,
      diagnostic: classifyOpenOcdResult(result),
      stages: ['flash', 'verify', 'reset'] as const
    };
  }
  async flash(options: Parameters<FirmwareAdapter['flashPlan']>[0]): Promise<{ plan: FirmwareFlashPlan; result: EngineeringCommandResult; diagnostic?: ReturnType<typeof classifyOpenOcdResult> }> {
    this.policy.assertHardwareMutation();
    const plan = await this.flashPlan(options);
    const cwd = await this.paths.resolveExisting(options.workspace, options.projectPath ?? '.');
    const result = await this.resources.withLease(plan.resourceId, 'flashing', () => this.runner.run(plan.program, plan.args, cwd));
    return { plan, result, ...(plan.provider === 'openocd' ? { diagnostic: classifyOpenOcdResult(result) } : {}) };
  }

  async verify(options: Omit<Parameters<FirmwareAdapter['flashPlan']>[0], 'provider'> & { targetConfig?: string }): Promise<{ provider: 'openocd'; result: EngineeringCommandResult; diagnostic: ReturnType<typeof classifyOpenOcdResult> }> {
    this.policy.assertHardwareMutation();
    const projectPath = options.projectPath ?? '.';
    const project = await this.inspect(options.workspace, projectPath);
    if (!options.artifact) throw new Error('firmware_verify requires an explicit ELF/AXF/HEX artifact.');
    const artifactAbsolute = await resolveExistingProjectPath(this.paths, options.workspace, projectPath, options.artifact, 'artifact');
    const targetConfigRaw = options.targetConfig ?? stm32OpenOcdTargetConfig(project.target);
    if (!targetConfigRaw) throw new Error('Unable to determine OpenOCD target config.');
    const targetConfig = validateOpenOcdTargetConfig(targetConfigRaw);
    const openocd = await resolveOpenOcdExecutable();
    if (!openocd) throw new Error('OpenOCD is unavailable.');
    const selectedProbe = await this.selectProbe(options.probeSerial);
    const resourceId = selectedProbe.resourceId;
    const adapterSpeedKhz = validateAdapterSpeedKhz(options.adapterSpeedKhz);
    const args = [...openOcdSearchPathArgs(openocd), '-f', 'interface/stlink.cfg', '-c', 'transport select swd', '-f', targetConfig,
      ...(selectedProbe.probeSerial ? ['-c', `adapter serial ${selectedProbe.probeSerial}`] : []),
      ...openOcdAdapterSpeedArgs(adapterSpeedKhz),
      '-c', 'init', '-c', 'reset halt', '-c', `verify_image {${normalizedOpenOcdPath(artifactAbsolute)}}`, '-c', 'reset run', '-c', 'shutdown'];
    const cwd = await this.paths.resolveExisting(options.workspace, projectPath);
    const result = await this.resources.withLease(resourceId, 'reading', () => this.runner.run(openocd.path, args, cwd));
    return { provider: 'openocd', result, diagnostic: classifyOpenOcdResult(result) };
  }

  async reset(options: { workspace: string; projectPath?: string; probeSerial?: string; targetConfig?: string; adapterSpeedKhz?: number }): Promise<EngineeringCommandResult & { diagnostic: ReturnType<typeof classifyOpenOcdResult> }> {
    this.policy.assertHardwareMutation();
    const projectPath = options.projectPath ?? '.';
    const project = await this.inspect(options.workspace, projectPath);
    const targetConfigRaw = options.targetConfig ?? stm32OpenOcdTargetConfig(project.target);
    if (!targetConfigRaw) throw new Error('Unable to determine OpenOCD target config.');
    const targetConfig = validateOpenOcdTargetConfig(targetConfigRaw);
    const openocd = await resolveOpenOcdExecutable();
    if (!openocd) throw new Error('OpenOCD is unavailable.');
    const selectedProbe = await this.selectProbe(options.probeSerial);
    const adapterSpeedKhz = validateAdapterSpeedKhz(options.adapterSpeedKhz);
    const args = [...openOcdSearchPathArgs(openocd), '-f', 'interface/stlink.cfg', '-c', 'transport select swd', '-f', targetConfig,
      ...(selectedProbe.probeSerial ? ['-c', `adapter serial ${selectedProbe.probeSerial}`] : []),
      ...openOcdAdapterSpeedArgs(adapterSpeedKhz),
      '-c', 'init', '-c', 'reset run', '-c', 'shutdown'];
    const cwd = await this.paths.resolveExisting(options.workspace, projectPath);
    const result = await this.resources.withLease(selectedProbe.resourceId, 'resetting', () => this.runner.run(openocd.path, args, cwd));
    return { ...result, diagnostic: classifyOpenOcdResult(result) };
  }
}
