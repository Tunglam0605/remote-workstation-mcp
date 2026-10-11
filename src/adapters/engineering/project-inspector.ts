import fs from 'node:fs/promises';
import path from 'node:path';
import type { FirmwareFramework, FirmwareProjectInfo, FirmwareProjectTarget, KicadProjectFiles } from '../../engineering/types.js';
import { PathGuard } from '../../security/path-guard.js';

const MAX_KEIL_PROJECT_BYTES = 8 * 1024 * 1024;
const MAX_KEIL_PROJECTS = 32;
const MAX_KEIL_TARGETS = 128;

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

async function firstBySuffix(root: string, suffix: string): Promise<string | undefined> {
  const entries = (await fs.readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(suffix))
    .sort((a, b) => a.name.localeCompare(b.name));
  const match = entries[0];
  return match ? path.join(root, match.name) : undefined;
}

async function discoverKicadProject(root: string): Promise<KicadProjectFiles | undefined> {
  // A project must be selected as a coherent *same-basename* KiCad source set.
  // An alphabetical first-match mixes temporary .pro files with unrelated .sch/.pcb.
  const entries = (await fs.readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
  type SourceGroup = {
    name: string;
    project?: string;
    schematic?: string;
    board?: string;
  };
  const groups = new Map<string, SourceGroup>();
  for (const name of entries) {
    const suffix = /\.(kicad_pro|kicad_sch|kicad_pcb)$/i.exec(name)?.[1]?.toLowerCase();
    if (!suffix) continue;
    const stem = name.slice(0, name.length - suffix.length - 1);
    const key = stem.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = { name: stem };
      groups.set(key, group);
    }
    if (suffix === 'kicad_pro') group.project = name;
    else if (suffix === 'kicad_sch') group.schematic = name;
    else group.board = name;
  }
  const jobsets = entries.filter(name => name.toLowerCase().endsWith('.kicad_jobset')).slice(0, 16);
  if (groups.size === 0) return jobsets.length ? { jobsets } : undefined;

  // Favor the most complete, cross-linked sources. A .sch/.pcb pair outranks
  // a stray .pro, even when the stray project sorts first alphabetically.
  const scored = [...groups.values()].map(group => ({
    group,
    score: Number(Boolean(group.project)) + Number(Boolean(group.schematic)) +
      Number(Boolean(group.board)) + (group.schematic && group.board ? 1 : 0)
  }));
  const bestScore = Math.max(...scored.map(item => item.score));
  const best = scored.filter(item => item.score === bestScore);
  const directoryName = path.basename(root).toLowerCase();
  const preferred = best.find(item => item.group.name.toLowerCase() === directoryName);
  if (best.length > 1 && !preferred) {
    const candidates = best.map(item => item.group.name).slice(0, 12).join(', ');
    throw new Error(
      `Ambiguous KiCad project in ${path.basename(root)}: ${candidates}. ` +
      'Select the intended subproject/workspace explicitly; source sets must not be mixed.'
    );
  }
  const selected = (preferred ?? best[0])!.group;
  return {
    ...(selected.project ? { project: selected.project } : {}),
    ...(selected.schematic ? { schematic: selected.schematic } : {}),
    ...(selected.board ? { board: selected.board } : {}),
    jobsets
  };
}

function parseStm32Ioc(text: string): { target?: string; board?: string } {
  const target = text.match(/^Mcu\.Name=(.+)$/m)?.[1]?.trim()
    ?? text.match(/^Mcu\.Family=(.+)$/m)?.[1]?.trim();
  const board = text.match(/^Board=(.+)$/m)?.[1]?.trim();
  return { target, board };
}

function parseEspTarget(text: string): string | undefined {
  return text.match(/^CONFIG_IDF_TARGET="?([^"\r\n]+)"?/m)?.[1]?.trim();
}

function decodeXmlText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function xmlTag(block: string, tag: string): string | undefined {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return decodeXmlText(new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`, 'i').exec(block)?.[1]);
}

function safeProjectId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'keil-target';
}

function normalizeKeilRelative(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) return undefined;
  return normalized;
}

function parseKeilTargets(projectFile: string, text: string): FirmwareProjectTarget[] {
  const targets: FirmwareProjectTarget[] = [];
  const blocks = [...text.matchAll(/<Target>([\s\S]*?)<\/Target>/gi)];
  for (const match of blocks.slice(0, MAX_KEIL_TARGETS)) {
    const block = match[1] ?? '';
    const targetName = xmlTag(block, 'TargetName');
    if (!targetName) continue;
    const device = xmlTag(block, 'Device');
    const outputDirectory = normalizeKeilRelative(xmlTag(block, 'OutputDirectory'));
    const outputName = xmlTag(block, 'OutputName');
    const createHexFile = xmlTag(block, 'CreateHexFile') === '1';
    const expectedArtifact = outputDirectory && outputName
      ? path.posix.join(outputDirectory, `${outputName}.axf`)
      : undefined;
    targets.push({
      id: safeProjectId(`${path.parse(projectFile).name}-${targetName}`),
      projectFile,
      targetName,
      ...(device ? { device } : {}),
      ...(outputDirectory ? { outputDirectory } : {}),
      ...(outputName ? { outputName } : {}),
      ...(expectedArtifact ? { expectedArtifact } : {}),
      ...(createHexFile ? { createHexFile: true } : {})
    });
  }
  return targets;
}

async function discoverKeilProjects(root: string): Promise<{ markers: string[]; targets: FirmwareProjectTarget[] }> {
  const entries = (await fs.readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.uvprojx'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_KEIL_PROJECTS);
  const markers: string[] = [];
  const targets: FirmwareProjectTarget[] = [];
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_KEIL_PROJECT_BYTES) continue;
      const text = await fs.readFile(file, 'utf8');
      markers.push(entry.name);
      targets.push(...parseKeilTargets(entry.name, text));
    } catch {
      // Optional IDE metadata must not break generic project inspection.
    }
  }
  return { markers, targets: targets.slice(0, MAX_KEIL_TARGETS) };
}

export class FirmwareProjectInspector {
  constructor(private readonly paths: PathGuard) {}

  async inspect(workspace: string, projectPath = '.'): Promise<FirmwareProjectInfo> {
    const root = await this.paths.resolveExisting(workspace, projectPath);
    const markers: string[] = [];
    let family: FirmwareProjectInfo['family'] = 'unknown';
    let framework: FirmwareFramework = 'unknown';
    let target: string | undefined;
    let board: string | undefined;
    let buildSystem: string | undefined;
    let targets: FirmwareProjectTarget[] | undefined;

    const cmake = path.join(root, 'CMakeLists.txt');
    const sdkconfig = path.join(root, 'sdkconfig');
    const idfYml = path.join(root, 'idf_component.yml');
    const platformioIni = path.join(root, 'platformio.ini');
    const makefile = path.join(root, 'Makefile');
    const packageXml = path.join(root, 'package.xml');
    const dockerfile = path.join(root, 'Dockerfile');
    const compose = path.join(root, 'docker-compose.yml');
    const composeYaml = path.join(root, 'compose.yaml');
    const ioc = await firstBySuffix(root, '.ioc');
    const kicad = await discoverKicadProject(root);

    if (await exists(cmake)) {
      markers.push('CMakeLists.txt');
      buildSystem = 'cmake';
      framework = 'cmake';
      const text = await fs.readFile(cmake, 'utf8').catch(() => '');
      if (/IDF_PATH|project\.cmake|idf_component_register/i.test(text)) {
        family = 'esp32';
        framework = 'esp-idf';
      }
    }
    if (await exists(sdkconfig)) {
      markers.push('sdkconfig');
      const text = await fs.readFile(sdkconfig, 'utf8').catch(() => '');
      target = parseEspTarget(text) ?? target;
      family = 'esp32';
      framework = 'esp-idf';
      buildSystem = 'idf.py';
    }
    if (await exists(idfYml)) {
      markers.push('idf_component.yml');
      if (family === 'unknown') {
        family = 'esp32';
        framework = 'esp-idf';
        buildSystem = 'idf.py';
      }
    }
    if (await exists(platformioIni)) {
      markers.push('platformio.ini');
      const text = await fs.readFile(platformioIni, 'utf8').catch(() => '');
      framework = 'platformio';
      buildSystem = 'platformio';
      board = text.match(/^\s*board\s*=\s*([^;#\r\n]+)/mi)?.[1]?.trim() ?? board;
      family = /^\s*platform\s*=\s*espressif32\b/mi.test(text) ? 'esp32' : (family === 'unknown' ? 'generic-embedded' : family);
    }
    if (ioc) {
      markers.push(path.basename(ioc));
      const text = await fs.readFile(ioc, 'utf8').catch(() => '');
      const parsed = parseStm32Ioc(text);
      target = parsed.target ?? target;
      board = parsed.board;
      family = 'stm32';
      framework = 'stm32-cube';
      buildSystem ??= (await exists(cmake)) ? 'cmake' : (await exists(makefile)) ? 'make' : undefined;
    }
    if (await exists(makefile)) {
      markers.push('Makefile');
      buildSystem ??= 'make';
      if (family === 'unknown') {
        family = 'generic-embedded';
        framework = 'make';
      }
    }

    const keil = await discoverKeilProjects(root);
    if (keil.targets.length > 0) {
      markers.push(...keil.markers.filter(item => !markers.includes(item)));
      targets = keil.targets;
      family = 'stm32';
      framework = 'keil-mdk';
      buildSystem = 'keil';
      const devices = [...new Set(keil.targets.map(item => item.device).filter((item): item is string => Boolean(item)))];
      if (devices.length === 1) target = devices[0];
      else if (devices.length > 1) target = undefined;
    }

    if (kicad) {
      for (const marker of [kicad.project, kicad.schematic, kicad.board, ...kicad.jobsets]) {
        if (marker && !markers.includes(marker)) markers.push(marker);
      }
    }

    const ros2 = await exists(packageXml);
    if (ros2) markers.push('package.xml');
    const docker = await exists(dockerfile) || await exists(compose) || await exists(composeYaml);
    if (docker) markers.push('docker');

    return {
      workspace,
      projectPath,
      family,
      framework,
      target,
      board,
      buildSystem,
      ...(targets?.length ? { targets } : {}),
      markers,
      ros2,
      docker,
      ...(kicad ? { kicad } : {})
    };
  }
}

export function stm32OpenOcdTargetConfig(target?: string): string | undefined {
  const upper = (target ?? '').toUpperCase();
  if (/STM32F0/.test(upper)) return 'target/stm32f0x.cfg';
  if (/STM32F1/.test(upper)) return 'target/stm32f1x.cfg';
  if (/STM32F2/.test(upper)) return 'target/stm32f2x.cfg';
  if (/STM32F3/.test(upper)) return 'target/stm32f3x.cfg';
  if (/STM32F4/.test(upper)) return 'target/stm32f4x.cfg';
  if (/STM32F7/.test(upper)) return 'target/stm32f7x.cfg';
  if (/STM32H7/.test(upper)) return 'target/stm32h7x.cfg';
  if (/STM32G0/.test(upper)) return 'target/stm32g0x.cfg';
  if (/STM32G4/.test(upper)) return 'target/stm32g4x.cfg';
  if (/STM32L0/.test(upper)) return 'target/stm32l0.cfg';
  if (/STM32L1/.test(upper)) return 'target/stm32l1.cfg';
  if (/STM32L4/.test(upper)) return 'target/stm32l4x.cfg';
  if (/STM32U5/.test(upper)) return 'target/stm32u5x.cfg';
  if (/STM32WB/.test(upper)) return 'target/stm32wbx.cfg';
  return undefined;
}
