import { randomUUID } from 'node:crypto';
import type { KicadResolvedSymbol } from './kicad-library.js';

export interface KicadSchematicComponentSpec {
  reference: string;
  symbol: KicadResolvedSymbol;
  value?: string;
  footprintId?: string;
  xMm?: number;
  yMm?: number;
  rotationDeg?: 0 | 90 | 180 | 270;
  unit?: number;
  inBom?: boolean;
  onBoard?: boolean;
  dnp?: boolean;
}

export interface KicadSchematicNetEndpoint {
  reference: string;
  pinNumber: string;
  expectedPinName?: string;
}

export interface KicadSchematicNetSpec {
  name: string;
  endpoints: KicadSchematicNetEndpoint[];
}

export interface KicadSchematicSynthesisOptions {
  title?: string;
  revision?: string;
  company?: string;
  paper?: 'A4' | 'A3' | 'A2' | 'A1' | 'A0';
  markUnusedNoConnect?: boolean;
  allowUnconnectedPowerPins?: boolean;
}

export interface KicadSchematicSynthesisResult {
  rootUuid: string;
  source: string;
  components: Array<{
    reference: string;
    symbolId: string;
    symbolUuid: string;
    unit: number;
    value: string;
    footprintId?: string;
    position: { xMm: number; yMm: number; rotationDeg: number };
    pins: Array<{ number: string; name: string; uuid: string; connectedNet?: string }>;
  }>;
  nets: Array<{ name: string; endpoints: KicadSchematicNetEndpoint[] }>;
  unusedPins: Array<{ reference: string; pinNumber: string; pinName: string }>;
}

function quote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n\t]/g, ' ');
}

function fmt(value: number): string {
  const normalized = Math.abs(value) < 1e-9 ? 0 : Number(value.toFixed(4));
  return String(normalized);
}

function rotatePoint(x: number, y: number, rotationDeg: number): { x: number; y: number } {
  const normalized = ((rotationDeg % 360) + 360) % 360;
  if (normalized === 0) return { x, y };
  if (normalized === 90) return { x: -y, y: x };
  if (normalized === 180) return { x: -x, y: -y };
  if (normalized === 270) return { x: y, y: -x };
  throw new Error('Schematic component rotation must be 0/90/180/270 degrees.');
}

function transformPin(x: number, y: number, cx: number, cy: number, rotation: number) {
  // KiCad library symbol coordinates are Cartesian (positive Y up) while
  // schematic sheet coordinates are screen-like (positive Y down).
  const pageLocal = { x, y: -y };
  const rotated = rotatePoint(pageLocal.x, pageLocal.y, rotation);
  return { x: cx + rotated.x, y: cy + rotated.y };
}

function effectBlock(hidden = false): string {
  return `(effects (font (size 1.27 1.27))${hidden ? ' (hide yes)' : ''})`;
}

function propertyBlock(name: string, value: string, x: number, y: number, hidden = false): string {
  return `\t\t(property "${quote(name)}" "${quote(value)}"\n\t\t\t(at ${fmt(x)} ${fmt(y)} 0)\n\t\t\t${effectBlock(hidden)}\n\t\t)`;
}

function labelBlock(name: string, x: number, y: number): string {
  return `\t(label "${quote(name)}"\n\t\t(at ${fmt(x)} ${fmt(y)} 0)\n\t\t${effectBlock(false)}\n\t\t(uuid "${randomUUID()}")\n\t)`;
}

function noConnectBlock(x: number, y: number): string {
  return `\t(no_connect\n\t\t(at ${fmt(x)} ${fmt(y)})\n\t\t(uuid "${randomUUID()}")\n\t)`;
}

function titleBlock(options: KicadSchematicSynthesisOptions): string | undefined {
  const values = [
    options.title ? `\t\t(title "${quote(options.title)}")` : undefined,
    options.revision ? `\t\t(rev "${quote(options.revision)}")` : undefined,
    options.company ? `\t\t(company "${quote(options.company)}")` : undefined
  ].filter((value): value is string => Boolean(value));
  return values.length ? `\t(title_block\n${values.join('\n')}\n\t)` : undefined;
}

function autoPosition(index: number): { x: number; y: number } {
  const columns = 3;
  return { x: 70 + (index % columns) * 65, y: 55 + Math.floor(index / columns) * 65 };
}

export function synthesizeKicadSchematic(
  componentSpecs: KicadSchematicComponentSpec[],
  netSpecs: KicadSchematicNetSpec[],
  options: KicadSchematicSynthesisOptions = {}
): KicadSchematicSynthesisResult {
  if (componentSpecs.length < 1 || componentSpecs.length > 128) throw new Error('Schematic synthesis requires 1..128 components.');
  if (netSpecs.length > 512) throw new Error('Schematic synthesis supports at most 512 nets.');

  const references = new Set<string>();
  for (const component of componentSpecs) {
    if (!/^[A-Za-z][A-Za-z0-9._+-]{0,31}$/.test(component.reference)) throw new Error(`Invalid schematic reference: ${component.reference}.`);
    if (references.has(component.reference)) throw new Error(`Duplicate schematic reference: ${component.reference}.`);
    references.add(component.reference);
  }

  const endpointNet = new Map<string, string>();
  const componentByRef = new Map(componentSpecs.map(component => [component.reference, component]));
  for (const net of netSpecs) {
    if (!net.name.trim() || net.name.length > 128) throw new Error('Schematic net names must contain 1..128 characters.');
    if (net.endpoints.length < 1 || net.endpoints.length > 128) throw new Error(`Net ${net.name} requires 1..128 endpoints.`);
    for (const endpoint of net.endpoints) {
      const component = componentByRef.get(endpoint.reference);
      if (!component) throw new Error(`Net ${net.name} references unknown component ${endpoint.reference}.`);
      const unit = component.unit ?? 1;
      const pin = component.symbol.pins.find(item => (item.unit === unit || item.unit === 0) && item.number === endpoint.pinNumber);
      if (!pin) throw new Error(`Net ${net.name} references missing pin ${endpoint.reference}.${endpoint.pinNumber} (unit ${unit}).`);
      if (endpoint.expectedPinName && endpoint.expectedPinName !== pin.name) {
        throw new Error(`Pin-name guard failed for ${endpoint.reference}.${endpoint.pinNumber}: expected ${endpoint.expectedPinName}, library reports ${pin.name}.`);
      }
      const key = `${endpoint.reference}\u0000${endpoint.pinNumber}`;
      if (endpointNet.has(key)) throw new Error(`Pin ${endpoint.reference}.${endpoint.pinNumber} is assigned to multiple nets.`);
      endpointNet.set(key, net.name);
    }
  }

  if (!options.allowUnconnectedPowerPins) {
    const missing: string[] = [];
    for (const component of componentSpecs) {
      const unit = component.unit ?? 1;
      for (const pin of component.symbol.pins.filter(item => (item.unit === unit || item.unit === 0) && item.electricalType === 'power_in')) {
        if (!endpointNet.has(`${component.reference}\u0000${pin.number}`)) missing.push(`${component.reference}.${pin.number}(${pin.name})`);
      }
    }
    if (missing.length) throw new Error(`Unconnected power-input pins are not allowed: ${missing.slice(0, 32).join(', ')}${missing.length > 32 ? ' ...' : ''}`);
  }

  const rootUuid = randomUUID();
  const definitions = new Map<string, string>();
  const componentManifest: KicadSchematicSynthesisResult['components'] = [];
  const labels: string[] = [];
  const noConnects: string[] = [];
  const unusedPins: KicadSchematicSynthesisResult['unusedPins'] = [];
  const instances: string[] = [];

  for (const [index, component] of componentSpecs.entries()) {
    definitions.set(component.symbol.id, component.symbol.embeddedDefinition);
    const auto = autoPosition(index);
    const cx = component.xMm ?? auto.x;
    const cy = component.yMm ?? auto.y;
    const rotation = component.rotationDeg ?? 0;
    const unit = component.unit ?? 1;
    const symbolUuid = randomUUID();
    const value = component.value ?? component.symbol.name;
    const footprintId = component.footprintId ?? component.symbol.footprint;
    const pinManifest: Array<{ number: string; name: string; uuid: string; connectedNet?: string }> = [];

    const pins = component.symbol.pins.filter(pin => pin.unit === unit || pin.unit === 0);
    if (!pins.length) throw new Error(`Symbol ${component.symbol.id} has no pins for unit ${unit}.`);
    const pinBlocks: string[] = [];
    for (const pin of pins) {
      const pinUuid = randomUUID();
      const net = endpointNet.get(`${component.reference}\u0000${pin.number}`);
      pinBlocks.push(`\t\t(pin "${quote(pin.number)}" (uuid "${pinUuid}"))`);
      pinManifest.push({ number: pin.number, name: pin.name, uuid: pinUuid, ...(net ? { connectedNet: net } : {}) });
      const point = transformPin(pin.xMm, pin.yMm, cx, cy, rotation);
      if (net) labels.push(labelBlock(net, point.x, point.y));
      else {
        unusedPins.push({ reference: component.reference, pinNumber: pin.number, pinName: pin.name });
        if (options.markUnusedNoConnect !== false) noConnects.push(noConnectBlock(point.x, point.y));
      }
    }

    const symbolLines = [
      '\t(symbol',
      `\t\t(lib_id "${quote(component.symbol.id)}")`,
      `\t\t(at ${fmt(cx)} ${fmt(cy)} ${rotation})`,
      `\t\t(unit ${unit})`,
      '\t\t(exclude_from_sim no)',
      `\t\t(in_bom ${component.inBom === false ? 'no' : 'yes'})`,
      `\t\t(on_board ${component.onBoard === false ? 'no' : 'yes'})`,
      `\t\t(dnp ${component.dnp === true ? 'yes' : 'no'})`,
      '\t\t(fields_autoplaced yes)',
      `\t\t(uuid "${symbolUuid}")`,
      propertyBlock('Reference', component.reference, cx, cy - 3.81),
      propertyBlock('Value', value, cx, cy - 1.27),
      propertyBlock('Footprint', footprintId ?? '', cx, cy, true),
      propertyBlock('Datasheet', component.symbol.properties.Datasheet ?? '~', cx, cy, true),
      propertyBlock('Description', component.symbol.description ?? '', cx, cy, true),
      ...pinBlocks,
      '\t\t(instances',
      '\t\t\t(project ""',
      `\t\t\t\t(path "/${rootUuid}" (reference "${quote(component.reference)}") (unit ${unit}))`,
      '\t\t\t)',
      '\t\t)',
      '\t)'
    ];
    instances.push(symbolLines.join('\n'));
    componentManifest.push({
      reference: component.reference,
      symbolId: component.symbol.id,
      symbolUuid,
      unit,
      value,
      ...(footprintId ? { footprintId } : {}),
      position: { xMm: cx, yMm: cy, rotationDeg: rotation },
      pins: pinManifest
    });
  }

  const title = titleBlock(options);
  const source = [
    '(kicad_sch',
    '\t(version 20250114)',
    '\t(generator "rwmcp")',
    '\t(generator_version "0.68")',
    `\t(uuid "${rootUuid}")`,
    `\t(paper "${options.paper ?? 'A4'}")`,
    ...(title ? [title] : []),
    '\t(lib_symbols',
    ...[...definitions.values()].map(definition => definition.split('\n').map(line => '\t\t' + line).join('\n')),
    '\t)',
    ...labels,
    ...noConnects,
    ...instances,
    '\t(sheet_instances',
    '\t\t(path "/" (page "1"))',
    '\t)',
    '\t(embedded_fonts no)',
    ')',
    ''
  ].join('\n');

  return {
    rootUuid,
    source,
    components: componentManifest,
    nets: netSpecs.map(net => ({ name: net.name, endpoints: [...net.endpoints] })),
    unusedPins
  };
}

function sexprBlockEnd(text: string, start: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error('Malformed KiCad netlist S-expression.');
}

function immediateSexprBlocks(text: string, token: string): string[] {
  const result: string[] = [];
  const marker = '(' + token;
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(marker, cursor);
    if (start < 0) break;
    const next = text[start + marker.length] ?? '';
    if (next && !/\s|"/.test(next)) { cursor = start + marker.length; continue; }
    const end = sexprBlockEnd(text, start);
    result.push(text.slice(start, end));
    cursor = end;
  }
  return result;
}

function sexprQuoted(block: string, token: string): string | undefined {
  const escaped = token.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp('\\(' + escaped + '\\s+"((?:\\\\.|[^"\\\\])*)"', 'i'));
  return match?.[1]?.replace(/\\(["\\])/g, '$1');
}

export function parseKicadSexprNetlist(source: string) {
  const netsContainer = immediateSexprBlocks(source, 'nets')[0];
  if (!netsContainer) return [] as Array<{ name: string; nodes: Array<{ reference: string; pin: string }> }>;
  const nets: Array<{ name: string; nodes: Array<{ reference: string; pin: string }> }> = [];
  for (const block of immediateSexprBlocks(netsContainer, 'net')) {
    const rawName = sexprQuoted(block, 'name') ?? '';
    const name = rawName.startsWith('/') ? rawName.slice(1) : rawName;
    const nodes = immediateSexprBlocks(block, 'node').map(node => ({
      reference: sexprQuoted(node, 'ref') ?? '',
      pin: sexprQuoted(node, 'pin') ?? ''
    })).filter(node => node.reference && node.pin);
    nets.push({ name, nodes });
  }
  return nets;
}

export function verifyKicadSchematicNetlist(
  expected: KicadSchematicNetSpec[],
  actual: Array<{ name: string; nodes: Array<{ reference: string; pin: string }> }>
) {
  const actualMap = new Map(actual.map(net => [net.name, new Set(net.nodes.map(node => node.reference + '\u0000' + node.pin))]));
  const missing: Array<{ net: string; reference: string; pin: string }> = [];
  for (const net of expected) {
    const nodes = actualMap.get(net.name);
    for (const endpoint of net.endpoints) {
      const key = endpoint.reference + '\u0000' + endpoint.pinNumber;
      if (!nodes?.has(key)) missing.push({ net: net.name, reference: endpoint.reference, pin: endpoint.pinNumber });
    }
  }
  return {
    valid: missing.length === 0,
    expectedNetCount: expected.length,
    actualNetCount: actual.length,
    missingEndpoints: missing
  };
}
