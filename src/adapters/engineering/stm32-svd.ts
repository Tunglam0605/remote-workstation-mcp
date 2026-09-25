import fs from 'node:fs/promises';
import path from 'node:path';
import { DOMParser, type Element as XmlElement, type Node as XmlNode } from '@xmldom/xmldom';
import type {
  Stm32SvdArray,
  Stm32SvdField,
  Stm32SvdInspection,
  Stm32SvdPeripheral,
  Stm32SvdRegister
} from '../../engineering/types.js';
import { PathGuard } from '../../security/path-guard.js';

const MAX_SVD_BYTES = 16 * 1024 * 1024;
const MAX_PERIPHERALS = 256;
const MAX_REGISTERS_TOTAL = 8192;
const MAX_REGISTERS_PER_PERIPHERAL = 1024;
const MAX_FIELDS_PER_REGISTER = 128;
const MAX_FIELDS_TOTAL = 32768;

function directChildren(node: XmlNode, tag: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (let i = 0; i < node.childNodes.length; i += 1) {
    const child = node.childNodes.item(i);
    if (child?.nodeType === 1 && (child as XmlElement).tagName === tag) out.push(child as XmlElement);
  }
  return out;
}

function directChild(node: XmlNode, tag: string): XmlElement | undefined {
  return directChildren(node, tag)[0];
}

function text(node: XmlNode, tag: string): string | undefined {
  const value = directChild(node, tag)?.textContent?.trim();
  return value ? value : undefined;
}

function integerText(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/_/g, '').trim();
  const match = /^(?:0x([0-9a-f]+)|#([0-9a-f]+)|(\d+))$/i.exec(normalized);
  if (!match) return undefined;
  const radix = match[1] || match[2] ? 16 : 10;
  const raw = match[1] ?? match[2] ?? match[3]!;
  const parsed = Number.parseInt(raw, radix);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function boolText(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  if (/^(?:1|true)$/i.test(value)) return true;
  if (/^(?:0|false)$/i.test(value)) return false;
  return undefined;
}

function boundedDescription(value: string | undefined, limit = 2048): string | undefined {
  return value ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : undefined;
}

function parseArray(node: XmlElement): Stm32SvdArray | undefined {
  const count = integerText(text(node, 'dim'));
  const increment = integerText(text(node, 'dimIncrement'));
  if (count === undefined || increment === undefined || count < 1 || count > 4096) return undefined;
  const rawIndex = text(node, 'dimIndex');
  let indexes: string[] | undefined;
  if (rawIndex) {
    const items = rawIndex.split(',').map(item => item.trim()).filter(Boolean).slice(0, count);
    if (items.length) indexes = items;
  }
  return { count, increment, ...(indexes ? { indexes } : {}) };
}

function parseBitLocation(field: XmlElement): { bitOffset: number; bitWidth: number } | undefined {
  const bitOffset = integerText(text(field, 'bitOffset'));
  const bitWidth = integerText(text(field, 'bitWidth'));
  if (bitOffset !== undefined && bitWidth !== undefined && bitWidth > 0 && bitWidth <= 64) {
    return { bitOffset, bitWidth };
  }
  const lsb = integerText(text(field, 'lsb'));
  const msb = integerText(text(field, 'msb'));
  if (lsb !== undefined && msb !== undefined && msb >= lsb && msb - lsb + 1 <= 64) {
    return { bitOffset: lsb, bitWidth: msb - lsb + 1 };
  }
  const range = text(field, 'bitRange');
  const match = range ? /^\[(\d+):(\d+)\]$/.exec(range) : undefined;
  if (match) {
    const high = Number(match[1]);
    const low = Number(match[2]);
    if (Number.isInteger(high) && Number.isInteger(low) && high >= low && high - low + 1 <= 64) {
      return { bitOffset: low, bitWidth: high - low + 1 };
    }
  }
  return undefined;
}

function parseFields(register: XmlElement, warnings: string[]): { fields: Stm32SvdField[]; truncated: boolean; total: number } {
  const fieldsContainer = directChild(register, 'fields');
  if (!fieldsContainer) return { fields: [], truncated: false, total: 0 };
  const rawFields = directChildren(fieldsContainer, 'field');
  const fields: Stm32SvdField[] = [];
  for (const field of rawFields.slice(0, MAX_FIELDS_PER_REGISTER)) {
    const name = text(field, 'name');
    const location = parseBitLocation(field);
    if (!name || !location) {
      warnings.push('Skipped SVD field with missing name or unsupported bit location.');
      continue;
    }
    const description = boundedDescription(text(field, 'description'));
    const access = text(field, 'access');
    fields.push({
      name: name.slice(0, 256),
      ...(description ? { description } : {}),
      ...location,
      ...(access ? { access: access.slice(0, 64) } : {})
    });
  }
  return { fields, truncated: rawFields.length > MAX_FIELDS_PER_REGISTER, total: rawFields.length };
}

function registerFromElement(
  register: XmlElement,
  baseAddress: number,
  clusterOffset: number,
  clusterPath: string | undefined,
  inheritedSize: number | undefined,
  inheritedAccess: string | undefined,
  warnings: string[]
): { register?: Stm32SvdRegister; fieldTotal: number } {
  const name = text(register, 'name');
  const ownOffset = integerText(text(register, 'addressOffset'));
  if (!name || ownOffset === undefined) {
    warnings.push('Skipped SVD register with missing name or addressOffset.');
    return { fieldTotal: 0 };
  }
  const offset = clusterOffset + ownOffset;
  const description = boundedDescription(text(register, 'description'));
  const sizeBits = integerText(text(register, 'size')) ?? inheritedSize;
  const access = text(register, 'access') ?? inheritedAccess;
  const resetValue = integerText(text(register, 'resetValue'));
  const derivedFrom = register.getAttribute('derivedFrom')?.trim() || undefined;
  const array = parseArray(register);
  const parsedFields = parseFields(register, warnings);
  return {
    register: {
      name: name.slice(0, 256),
      ...(description ? { description } : {}),
      addressOffset: offset,
      absoluteAddress: baseAddress + offset,
      ...(sizeBits !== undefined ? { sizeBits } : {}),
      ...(access ? { access: access.slice(0, 64) } : {}),
      ...(resetValue !== undefined ? { resetValue } : {}),
      ...(derivedFrom ? { derivedFrom: derivedFrom.slice(0, 256) } : {}),
      ...(clusterPath ? { clusterPath } : {}),
      ...(array ? { array } : {}),
      fields: parsedFields.fields,
      fieldsTruncated: parsedFields.truncated
    },
    fieldTotal: parsedFields.total
  };
}

function parseRegisterTree(
  container: XmlElement,
  baseAddress: number,
  baseOffset: number,
  clusterPath: string | undefined,
  inheritedSize: number | undefined,
  inheritedAccess: string | undefined,
  warnings: string[],
  remaining: number
): { registers: Stm32SvdRegister[]; fieldTotal: number; truncated: boolean } {
  const registers: Stm32SvdRegister[] = [];
  let fieldTotal = 0;
  let truncated = false;
  for (let i = 0; i < container.childNodes.length; i += 1) {
    if (registers.length >= remaining) { truncated = true; break; }
    const node = container.childNodes.item(i);
    if (!node || node.nodeType !== 1) continue;
    const element = node as XmlElement;
    if (element.tagName === 'register') {
      const parsed = registerFromElement(element, baseAddress, baseOffset, clusterPath, inheritedSize, inheritedAccess, warnings);
      if (parsed.register) registers.push(parsed.register);
      fieldTotal += parsed.fieldTotal;
    } else if (element.tagName === 'cluster') {
      const clusterName = text(element, 'name') ?? 'cluster';
      const offset = integerText(text(element, 'addressOffset'));
      if (offset === undefined) {
        warnings.push(`Skipped SVD cluster '${clusterName}' without addressOffset.`);
        continue;
      }
      const childPath = clusterPath ? `${clusterPath}.${clusterName}` : clusterName;
      const nested = parseRegisterTree(
        element,
        baseAddress,
        baseOffset + offset,
        childPath.slice(0, 512),
        integerText(text(element, 'size')) ?? inheritedSize,
        text(element, 'access') ?? inheritedAccess,
        warnings,
        remaining - registers.length
      );
      registers.push(...nested.registers);
      fieldTotal += nested.fieldTotal;
      truncated ||= nested.truncated;
    }
  }
  return { registers, fieldTotal, truncated };
}

function parsePeripheral(element: XmlElement, warnings: string[]): { peripheral?: Stm32SvdPeripheral; fieldTotal: number } {
  const name = text(element, 'name');
  const baseAddress = integerText(text(element, 'baseAddress'));
  if (!name || baseAddress === undefined) {
    warnings.push('Skipped SVD peripheral with missing name or baseAddress.');
    return { fieldTotal: 0 };
  }
  const description = boundedDescription(text(element, 'description'));
  const groupName = text(element, 'groupName');
  const derivedFrom = element.getAttribute('derivedFrom')?.trim() || undefined;
  const registersContainer = directChild(element, 'registers');
  const sizeBits = integerText(text(element, 'size'));
  const access = text(element, 'access');
  const parsed = registersContainer
    ? parseRegisterTree(registersContainer, baseAddress, 0, undefined, sizeBits, access, warnings, MAX_REGISTERS_PER_PERIPHERAL)
    : { registers: [], fieldTotal: 0, truncated: false };
  return {
    peripheral: {
      name: name.slice(0, 256),
      ...(description ? { description } : {}),
      ...(groupName ? { groupName: groupName.slice(0, 256) } : {}),
      baseAddress,
      ...(derivedFrom ? { derivedFrom: derivedFrom.slice(0, 256) } : {}),
      registers: parsed.registers,
      registersTruncated: parsed.truncated
    },
    fieldTotal: parsed.fieldTotal
  };
}

function cpuInfo(device: XmlElement): Stm32SvdInspection['device']['cpu'] | undefined {
  const cpu = directChild(device, 'cpu');
  if (!cpu) return undefined;
  const name = text(cpu, 'name');
  const revision = text(cpu, 'revision');
  const endian = text(cpu, 'endian');
  const mpuPresent = boolText(text(cpu, 'mpuPresent'));
  const fpuPresent = boolText(text(cpu, 'fpuPresent'));
  const nvicPrioBits = integerText(text(cpu, 'nvicPrioBits'));
  if (!name && !revision && !endian && mpuPresent === undefined && fpuPresent === undefined && nvicPrioBits === undefined) return undefined;
  return {
    ...(name ? { name: name.slice(0, 128) } : {}),
    ...(revision ? { revision: revision.slice(0, 128) } : {}),
    ...(endian ? { endian: endian.slice(0, 64) } : {}),
    ...(mpuPresent !== undefined ? { mpuPresent } : {}),
    ...(fpuPresent !== undefined ? { fpuPresent } : {}),
    ...(nvicPrioBits !== undefined ? { nvicPrioBits } : {})
  };
}

export function parseStm32SvdText(file: string, size: number, xml: string): Stm32SvdInspection {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('SVD_XML_UNSAFE: DTD/entity declarations are not permitted.');
  const warnings: string[] = [];
  const document = new DOMParser({
    onError: (level, message) => {
      if (level === 'fatalError') throw new Error(`SVD_XML_INVALID: ${String(message).slice(0, 256)}`);
      warnings.push(`XML ${level}: ${String(message).slice(0, 256)}`);
    }
  }).parseFromString(xml, 'application/xml');
  const device = document.documentElement;
  if (!device || device.tagName !== 'device') throw new Error('SVD_XML_INVALID: root <device> element is required.');

  const peripheralsContainer = directChild(device, 'peripherals');
  const rawPeripherals = peripheralsContainer ? directChildren(peripheralsContainer, 'peripheral') : [];
  const peripherals: Stm32SvdPeripheral[] = [];
  let fieldTotal = 0;
  let registerTotal = 0;
  let truncated = rawPeripherals.length > MAX_PERIPHERALS;
  for (const item of rawPeripherals.slice(0, MAX_PERIPHERALS)) {
    if (registerTotal >= MAX_REGISTERS_TOTAL || fieldTotal >= MAX_FIELDS_TOTAL) { truncated = true; break; }
    const parsed = parsePeripheral(item, warnings);
    if (!parsed.peripheral) continue;
    const allowedRegisters = Math.max(0, MAX_REGISTERS_TOTAL - registerTotal);
    if (parsed.peripheral.registers.length > allowedRegisters) {
      parsed.peripheral.registers = parsed.peripheral.registers.slice(0, allowedRegisters);
      parsed.peripheral.registersTruncated = true;
      truncated = true;
    }
    registerTotal += parsed.peripheral.registers.length;
    fieldTotal += Math.min(parsed.fieldTotal, Math.max(0, MAX_FIELDS_TOTAL - fieldTotal));
    if (parsed.fieldTotal > MAX_FIELDS_TOTAL - fieldTotal) truncated = true;
    peripherals.push(parsed.peripheral);
  }

  const name = text(device, 'name');
  const version = text(device, 'version');
  const description = boundedDescription(text(device, 'description'));
  const addressUnitBits = integerText(text(device, 'addressUnitBits'));
  const width = integerText(text(device, 'width'));
  return {
    file,
    size,
    device: {
      ...(name ? { name: name.slice(0, 256) } : {}),
      ...(version ? { version: version.slice(0, 128) } : {}),
      ...(description ? { description } : {}),
      ...(addressUnitBits !== undefined ? { addressUnitBits } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(cpuInfo(device) ? { cpu: cpuInfo(device) } : {})
    },
    peripherals,
    counts: {
      peripherals: peripherals.length,
      registers: registerTotal,
      fields: peripherals.reduce((sum, peripheral) => sum + peripheral.registers.reduce((inner, register) => inner + register.fields.length, 0), 0)
    },
    truncated,
    warnings: warnings.slice(0, 128)
  };
}

export class Stm32SvdAdapter {
  constructor(private readonly paths: PathGuard) {}

  async inspect(workspace: string, projectPath = '.', svdFile: string): Promise<Stm32SvdInspection> {
    const relative = svdFile.trim();
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]+/).includes('..') || !relative.toLowerCase().endsWith('.svd')) {
      throw new Error('svdFile must be a project-relative .svd path.');
    }
    const resolved = await this.paths.resolveExisting(workspace, path.join(projectPath, relative));
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error('Selected .svd path is not a regular file.');
    if (stat.size > MAX_SVD_BYTES) throw new Error(`CMSIS-SVD file exceeds the ${MAX_SVD_BYTES} byte inspection limit.`);
    const xml = await fs.readFile(resolved, 'utf8');
    return parseStm32SvdText(relative.replace(/\\/g, '/'), stat.size, xml);
  }
}
