import fs from 'node:fs/promises';
import path from 'node:path';
import type { Stm32IocInspection, Stm32IocPeripheral, Stm32IocPin } from '../../engineering/types.js';
import { PathGuard } from '../../security/path-guard.js';

const MAX_IOC_BYTES = 4 * 1024 * 1024;
const MAX_PINS = 256;
const MAX_PERIPHERALS = 128;
const MAX_PARAMETERS_PER_PERIPHERAL = 32;
const MAX_CLOCKS = 64;

function parseKeyValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.startsWith('#')) continue;
    const index = raw.indexOf('=');
    if (index <= 0) continue;
    const key = raw.slice(0, index).trim();
    const value = raw.slice(index + 1).trim();
    if (!key) continue;
    values.set(key, value);
  }
  return values;
}

function optional(values: Map<string, string>, key: string): string | undefined {
  const value = values.get(key)?.trim();
  return value ? value : undefined;
}

function integer(values: Map<string, string>, key: string): number | undefined {
  const value = optional(values, key);
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isPhysicalPin(pin: string): boolean {
  return /^(?:P[A-K]\d{1,2}(?:\b|[- ])|NRST(?:\b|$)|BOOT\d?(?:\b|$))/i.test(pin);
}

function parsePins(values: Map<string, string>): Stm32IocPin[] {
  const declared: string[] = [];
  for (const [key, value] of values) {
    if (/^Mcu\.Pin\d+$/i.test(key) && value) declared.push(value);
  }
  return [...new Set(declared)]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_PINS)
    .map(pin => {
      const signal = optional(values, `${pin}.Signal`);
      const label = optional(values, `${pin}.GPIO_Label`);
      const mode = optional(values, `${pin}.Mode`);
      const pull = optional(values, `${pin}.GPIO_PuPd`);
      const speed = optional(values, `${pin}.GPIO_Speed`);
      const locked = optional(values, `${pin}.Locked`);
      return {
        pin,
        kind: isPhysicalPin(pin) ? 'physical' : 'virtual',
        ...(signal ? { signal } : {}),
        ...(label ? { label } : {}),
        ...(mode ? { mode } : {}),
        ...(pull ? { pull } : {}),
        ...(speed ? { speed } : {}),
        ...(locked ? { locked: /^true$/i.test(locked) } : {})
      };
    });
}

function parsePeripherals(values: Map<string, string>): Stm32IocPeripheral[] {
  const instances: string[] = [];
  for (const [key, value] of values) {
    if (/^Mcu\.IP\d+$/i.test(key) && value) instances.push(value);
  }
  return [...new Set(instances)]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_PERIPHERALS)
    .map(instance => {
      const parameterNames = (optional(values, `${instance}.IPParameters`) ?? '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
      const bounded = parameterNames.slice(0, MAX_PARAMETERS_PER_PERIPHERAL);
      const parameters: Record<string, string> = {};
      for (const parameter of bounded) {
        const value = optional(values, `${instance}.${parameter}`);
        if (value !== undefined) parameters[parameter] = value;
      }
      return {
        instance,
        parameterCount: parameterNames.length,
        parameters,
        parametersTruncated: parameterNames.length > bounded.length
      };
    });
}

function parseClocks(values: Map<string, string>): Stm32IocInspection['clocks'] {
  const frequencies: Array<[string, number]> = [];
  for (const [key, raw] of values) {
    if (!/^RCC\./i.test(key) || !/freq/i.test(key)) continue;
    if (!/^\d+(?:\.\d+)?$/.test(raw)) continue;
    const number = Number(raw);
    if (!Number.isFinite(number) || number < 0) continue;
    frequencies.push([key.slice(4), number]);
  }
  frequencies.sort(([a], [b]) => a.localeCompare(b));
  const bounded = frequencies.slice(0, MAX_CLOCKS);
  return {
    frequenciesHz: Object.fromEntries(bounded),
    frequenciesTruncated: frequencies.length > bounded.length
  };
}

export function parseStm32IocText(file: string, size: number, text: string): Stm32IocInspection {
  const values = parseKeyValues(text);
  const pins = parsePins(values);
  const peripherals = parsePeripherals(values);
  const declaredPins = integer(values, 'Mcu.PinsNb');
  const declaredPeripherals = integer(values, 'Mcu.IPNb');
  const warnings: string[] = [];

  if (!optional(values, 'Mcu.Name') && !optional(values, 'Mcu.Family')) {
    warnings.push('IOC metadata does not declare Mcu.Name or Mcu.Family.');
  }
  if (declaredPins !== undefined && declaredPins !== pins.length) {
    warnings.push(`Mcu.PinsNb declares ${declaredPins} pins but ${pins.length} unique Mcu.Pin entries were parsed.`);
  }
  if (declaredPeripherals !== undefined && declaredPeripherals !== peripherals.length) {
    warnings.push(`Mcu.IPNb declares ${declaredPeripherals} peripherals but ${peripherals.length} unique Mcu.IP entries were parsed.`);
  }

  const formatVersion = optional(values, 'File.Version');
  const mcuName = optional(values, 'Mcu.Name');
  const mcuFamily = optional(values, 'Mcu.Family');
  const mcuPackage = optional(values, 'Mcu.Package');
  const partNumber = optional(values, 'Mcu.CPN');
  const board = optional(values, 'Board');
  const projectName = optional(values, 'ProjectManager.ProjectName');
  const toolchain = optional(values, 'ProjectManager.ToolChain');
  const targetToolchain = optional(values, 'ProjectManager.TargetToolchain');
  const firmwarePackage = optional(values, 'ProjectManager.FirmwarePackage');

  return {
    file,
    size,
    ...(formatVersion ? { formatVersion } : {}),
    mcu: {
      ...(mcuName ? { name: mcuName } : {}),
      ...(mcuFamily ? { family: mcuFamily } : {}),
      ...(mcuPackage ? { package: mcuPackage } : {}),
      ...(partNumber ? { partNumber } : {})
    },
    ...(board ? { board } : {}),
    project: {
      ...(projectName ? { name: projectName } : {}),
      ...(toolchain ? { toolchain } : {}),
      ...(targetToolchain ? { targetToolchain } : {}),
      ...(firmwarePackage ? { firmwarePackage } : {})
    },
    clocks: parseClocks(values),
    pins,
    peripherals,
    counts: {
      ...(declaredPins !== undefined ? { declaredPins } : {}),
      parsedPins: pins.length,
      ...(declaredPeripherals !== undefined ? { declaredPeripherals } : {}),
      parsedPeripherals: peripherals.length
    },
    warnings
  };
}

export class Stm32IocAdapter {
  constructor(private readonly paths: PathGuard) {}

  async inspect(workspace: string, projectPath = '.', iocFile?: string): Promise<Stm32IocInspection> {
    const root = await this.paths.resolveExisting(workspace, projectPath);
    const entries = (await fs.readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.ioc'))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b));

    if (entries.length === 0) throw new Error('No STM32 CubeMX .ioc file was found at the project root.');
    if (iocFile && (path.basename(iocFile) !== iocFile || !iocFile.toLowerCase().endsWith('.ioc'))) {
      throw new Error('iocFile must be a project-root .ioc basename.');
    }
    if (!iocFile && entries.length > 1) {
      throw new Error(`Multiple STM32 CubeMX .ioc files were found (${entries.join(', ')}); iocFile is required.`);
    }
    if (iocFile && !entries.includes(iocFile)) {
      throw new Error(`Requested iocFile '${iocFile}' was not found at the project root.`);
    }

    const selected = iocFile ?? entries[0]!;
    const relative = projectPath === '.' ? selected : path.join(projectPath, selected);
    const file = await this.paths.resolveExisting(workspace, relative);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('Selected .ioc path is not a regular file.');
    if (stat.size > MAX_IOC_BYTES) {
      throw new Error(`STM32 CubeMX .ioc file exceeds the ${MAX_IOC_BYTES} byte inspection limit.`);
    }
    const text = await fs.readFile(file, 'utf8');
    return parseStm32IocText(selected, stat.size, text);
  }
}
