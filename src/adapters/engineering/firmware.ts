import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineeringCommandResult, FirmwareArtifact, FirmwareFlashPlan, FirmwareProjectInfo } from '../../engineering/types.js';
import { PolicyEngine } from '../../policy.js';
import { PathGuard } from '../../security/path-guard.js';
import { FirmwareArtifactFinder } from './artifact-finder.js';
import { EngineeringCommandRunner } from './command-runner.js';
import { resolveExecutable, resolveFirstExecutable } from './executable-resolver.js';
import { HardwareDiscoveryAdapter } from './hardware-discovery.js';
import { validateOpenOcdTargetConfig, validateProbeSerial } from './openocd-policy.js';
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
      resourceId: `debug-probe:${probe?.serialNumber ?? probe?.id ?? 'auto'}`
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

  async build(workspace: string, projectPath = '.', provider: 'auto' | 'esp-idf' | 'cmake' | 'make' = 'auto', buildDir = 'build'): Promise<{ project: FirmwareProjectInfo; provider: string; result: EngineeringCommandResult }> {
    this.policy.assertEngineeringExecute();
    const project = await this.inspect(workspace, projectPath);
    const cwd = await this.paths.resolveExisting(workspace, projectPath);
    const selected = provider === 'auto'
      ? project.framework === 'esp-idf' ? 'esp-idf' : project.buildSystem === 'make' ? 'make' : 'cmake'
      : provider;
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
    const openocd = await resolveFirstExecutable(['openocd']);
    if (!openocd) throw new Error('OpenOCD is unavailable. Install/configure OpenOCD before flashing.');
    const selectedProbe = await this.selectProbe(options.probeSerial);
    const probeSerial = selectedProbe.probeSerial;
    const tclArtifact = normalizedOpenOcdPath(artifactAbsolute);
    const args = [
      '-f', 'interface/stlink.cfg', '-c', 'transport select swd', '-f', targetConfig,
      ...(probeSerial ? ['-c', `adapter serial ${probeSerial}`] : []),
      '-c', 'init', '-c', 'reset halt', '-c', `program {${tclArtifact}} verify`, '-c', 'reset run', '-c', 'shutdown'
    ];
    return {
      provider: 'openocd', family: project.family, target: project.target, artifact: artifactAbsolute,
      probeSerial, program: openocd.path, args,
      resourceId: selectedProbe.resourceId, destructive: true,
      notes: ['OpenOCD is bound to an explicit ST-Link/SWD target transaction.', 'No mass erase, Option Byte, readout-protection, or arbitrary TCL surface is exposed.']
    };
  }

  async flash(options: Parameters<FirmwareAdapter['flashPlan']>[0]): Promise<{ plan: FirmwareFlashPlan; result: EngineeringCommandResult }> {
    this.policy.assertHardwareMutation();
    const plan = await this.flashPlan(options);
    const cwd = await this.paths.resolveExisting(options.workspace, options.projectPath ?? '.');
    const result = await this.resources.withLease(plan.resourceId, 'flashing', () => this.runner.run(plan.program, plan.args, cwd));
    return { plan, result };
  }

  async verify(options: Omit<Parameters<FirmwareAdapter['flashPlan']>[0], 'provider'> & { targetConfig?: string }): Promise<{ provider: 'openocd'; result: EngineeringCommandResult }> {
    this.policy.assertHardwareMutation();
    const projectPath = options.projectPath ?? '.';
    const project = await this.inspect(options.workspace, projectPath);
    if (!options.artifact) throw new Error('firmware_verify requires an explicit ELF/AXF/HEX artifact.');
    const artifactAbsolute = await resolveExistingProjectPath(this.paths, options.workspace, projectPath, options.artifact, 'artifact');
    const targetConfigRaw = options.targetConfig ?? stm32OpenOcdTargetConfig(project.target);
    if (!targetConfigRaw) throw new Error('Unable to determine OpenOCD target config.');
    const targetConfig = validateOpenOcdTargetConfig(targetConfigRaw);
    const openocd = await resolveFirstExecutable(['openocd']);
    if (!openocd) throw new Error('OpenOCD is unavailable.');
    const selectedProbe = await this.selectProbe(options.probeSerial);
    const resourceId = selectedProbe.resourceId;
    const args = ['-f', 'interface/stlink.cfg', '-c', 'transport select swd', '-f', targetConfig,
      ...(selectedProbe.probeSerial ? ['-c', `adapter serial ${selectedProbe.probeSerial}`] : []),
      '-c', 'init', '-c', 'reset halt', '-c', `verify_image {${normalizedOpenOcdPath(artifactAbsolute)}}`, '-c', 'reset run', '-c', 'shutdown'];
    const cwd = await this.paths.resolveExisting(options.workspace, projectPath);
    const result = await this.resources.withLease(resourceId, 'reading', () => this.runner.run(openocd.path, args, cwd));
    return { provider: 'openocd', result };
  }

  async reset(options: { workspace: string; projectPath?: string; probeSerial?: string; targetConfig?: string }): Promise<EngineeringCommandResult> {
    this.policy.assertHardwareMutation();
    const projectPath = options.projectPath ?? '.';
    const project = await this.inspect(options.workspace, projectPath);
    const targetConfigRaw = options.targetConfig ?? stm32OpenOcdTargetConfig(project.target);
    if (!targetConfigRaw) throw new Error('Unable to determine OpenOCD target config.');
    const targetConfig = validateOpenOcdTargetConfig(targetConfigRaw);
    const openocd = await resolveFirstExecutable(['openocd']);
    if (!openocd) throw new Error('OpenOCD is unavailable.');
    const selectedProbe = await this.selectProbe(options.probeSerial);
    const args = ['-f', 'interface/stlink.cfg', '-c', 'transport select swd', '-f', targetConfig,
      ...(selectedProbe.probeSerial ? ['-c', `adapter serial ${selectedProbe.probeSerial}`] : []),
      '-c', 'init', '-c', 'reset run', '-c', 'shutdown'];
    const cwd = await this.paths.resolveExisting(options.workspace, projectPath);
    return this.resources.withLease(selectedProbe.resourceId, 'resetting', () => this.runner.run(openocd.path, args, cwd));
  }
}
