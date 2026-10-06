import { createHash } from 'node:crypto';

const MAX_TEXT_BYTES = 128 * 1024 * 1024;
const MAX_BLOCKS = 250_000;

type JsonObject = Record<string, unknown>;

type NetClass = {
  name: string;
  priority: number;
  clearance?: number;
  trackWidth?: number;
  viaDiameter?: number;
  viaDrill?: number;
  microviaDiameter?: number;
  microviaDrill?: number;
  diffPairWidth?: number;
  diffPairGap?: number;
  diffPairViaGap?: number;
  tuningProfile?: string;
};

type RouteNet = {
  id: number;
  name: string;
  segmentCount: number;
  arcCount: number;
  viaCount: number;
  trackLengthMm: number;
  widths: Set<number>;
  layers: Set<string>;
  vias: Array<{ type: 'through' | 'blind' | 'micro'; sizeMm: number; drillMm: number; layers: string[] }>;
};

export interface KicadConstraintsReviewOptions {
  maxDetails?: number;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function blockEnd(text: string, start: number): number {
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
      if (depth < 0) break;
    }
  }
  throw new Error('Malformed KiCad S-expression: unbalanced parentheses.');
}

function blocks(text: string, token: string, limit = MAX_BLOCKS): string[] {
  const result: string[] = [];
  const marker = '(' + token;
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(marker, cursor);
    if (start < 0) break;
    const next = text[start + marker.length] ?? '';
    if (next && !/\s|"/.test(next)) {
      cursor = start + marker.length;
      continue;
    }
    const end = blockEnd(text, start);
    result.push(text.slice(start, end));
    if (result.length > limit) throw new Error(`KiCad constraint review exceeds the ${limit}-block limit for ${token}.`);
    cursor = end;
  }
  return result;
}

function* iterateBlocks(text: string, token: string, limit = MAX_BLOCKS): Generator<string> {
  const marker = '(' + token;
  let cursor = 0;
  let count = 0;
  while (cursor < text.length) {
    const start = text.indexOf(marker, cursor);
    if (start < 0) break;
    const next = text[start + marker.length] ?? '';
    if (next && !/\s|"/.test(next)) {
      cursor = start + marker.length;
      continue;
    }
    const end = blockEnd(text, start);
    count += 1;
    if (count > limit) throw new Error(`KiCad constraint review exceeds the ${limit}-block limit for ${token}.`);
    yield text.slice(start, end);
    cursor = end;
  }
}

function numberToken(block: string, token: string): number | undefined {
  const escaped = token.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp('\\(' + escaped + '\\s+(-?\\d+(?:\\.\\d+)?)\\)', 'i'));
  return match?.[1] !== undefined ? Number(match[1]) : undefined;
}

function quotedToken(block: string, token: string): string | undefined {
  const escaped = token.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp('\\(' + escaped + '\\s+"((?:\\\\.|[^"\\\\])*)"', 'i'));
  return match?.[1]?.replace(/\\(["\\])/g, '$1');
}

function firstQuotedArg(block: string, token: string): string | undefined {
  const escaped = token.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp('^\\(' + escaped + '\\s+"((?:\\\\.|[^"\\\\])*)"', 'i'));
  return match?.[1]?.replace(/\\(["\\])/g, '$1');
}

function pointToken(block: string, token: string): { x: number; y: number } | undefined {
  const escaped = token.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp('\\(' + escaped + '\\s+(-?\\d+(?:\\.\\d+)?)\\s+(-?\\d+(?:\\.\\d+)?)', 'i'));
  if (!match?.[1] || !match[2]) return undefined;
  return { x: Number(match[1]), y: Number(match[2]) };
}

function layerName(block: string): string | undefined {
  return block.match(/\(layer\s+"([^"]+)"\)/i)?.[1];
}

function boardNetNames(source: string): Map<number, string> {
  const result = new Map<number, string>();
  for (const match of source.matchAll(/\(net\s+(\d+)\s+"((?:\\.|[^"\\])*)"\)/g)) {
    if (!match[1] || match[2] === undefined) continue;
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id < 0) continue;
    if (!result.has(id)) result.set(id, match[2].replace(/\\(["\\])/g, '$1'));
  }
  return result;
}

function arcLength(start: { x: number; y: number }, mid: { x: number; y: number }, end: { x: number; y: number }): number {
  const d = 2 * (start.x * (mid.y - end.y) + mid.x * (end.y - start.y) + end.x * (start.y - mid.y));
  if (Math.abs(d) < 1e-9) {
    return Math.hypot(mid.x - start.x, mid.y - start.y) + Math.hypot(end.x - mid.x, end.y - mid.y);
  }
  const ux = (
    (start.x ** 2 + start.y ** 2) * (mid.y - end.y) +
    (mid.x ** 2 + mid.y ** 2) * (end.y - start.y) +
    (end.x ** 2 + end.y ** 2) * (start.y - mid.y)
  ) / d;
  const uy = (
    (start.x ** 2 + start.y ** 2) * (end.x - mid.x) +
    (mid.x ** 2 + mid.y ** 2) * (start.x - end.x) +
    (end.x ** 2 + end.y ** 2) * (mid.x - start.x)
  ) / d;
  const radius = Math.hypot(start.x - ux, start.y - uy);
  const normalize = (value: number) => {
    let out = value % (Math.PI * 2);
    if (out < 0) out += Math.PI * 2;
    return out;
  };
  const angle = (point: { x: number; y: number }) => Math.atan2(point.y - uy, point.x - ux);
  const a0 = normalize(angle(start));
  const am = normalize(angle(mid));
  const a1 = normalize(angle(end));
  const ccw = normalize(a1 - a0);
  const midSweep = normalize(am - a0);
  const sweep = midSweep <= ccw + 1e-9 ? ccw : Math.PI * 2 - ccw;
  return radius * sweep;
}

function routeFor(map: Map<number, RouteNet>, id: number, names: Map<number, string>): RouteNet {
  let route = map.get(id);
  if (!route) {
    route = {
      id,
      name: names.get(id) ?? `#${id}`,
      segmentCount: 0,
      arcCount: 0,
      viaCount: 0,
      trackLengthMm: 0,
      widths: new Set<number>(),
      layers: new Set<string>(),
      vias: []
    };
    map.set(id, route);
  }
  return route;
}

function parseRoutes(source: string) {
  const names = boardNetNames(source);
  const routes = new Map<number, RouteNet>();
  const tracks: Array<{ netId: number; netName: string; widthMm: number; layer: string; kind: 'segment' | 'arc' }> = [];
  for (const block of iterateBlocks(source, 'segment')) {
    const netId = numberToken(block, 'net');
    const width = numberToken(block, 'width');
    const layer = layerName(block);
    const start = pointToken(block, 'start');
    const end = pointToken(block, 'end');
    if (netId === undefined || width === undefined || !layer?.endsWith('.Cu') || !start || !end) continue;
    const route = routeFor(routes, netId, names);
    route.segmentCount += 1;
    route.trackLengthMm += Math.hypot(end.x - start.x, end.y - start.y);
    route.widths.add(width);
    route.layers.add(layer);
    tracks.push({ netId, netName: route.name, widthMm: width, layer, kind: 'segment' });
  }
  for (const block of iterateBlocks(source, 'arc')) {
    const netId = numberToken(block, 'net');
    const width = numberToken(block, 'width');
    const layer = layerName(block);
    const start = pointToken(block, 'start');
    const mid = pointToken(block, 'mid');
    const end = pointToken(block, 'end');
    if (netId === undefined || width === undefined || !layer?.endsWith('.Cu') || !start || !mid || !end) continue;
    const route = routeFor(routes, netId, names);
    route.arcCount += 1;
    route.trackLengthMm += arcLength(start, mid, end);
    route.widths.add(width);
    route.layers.add(layer);
    tracks.push({ netId, netName: route.name, widthMm: width, layer, kind: 'arc' });
  }
  for (const block of iterateBlocks(source, 'via')) {
    const netId = numberToken(block, 'net');
    const size = numberToken(block, 'size');
    const drill = numberToken(block, 'drill');
    if (netId === undefined || size === undefined || drill === undefined) continue;
    const route = routeFor(routes, netId, names);
    const type: 'through' | 'blind' | 'micro' = /^\(via\s+micro\b/.test(block)
      ? 'micro'
      : /^\(via\s+blind\b/.test(block)
        ? 'blind'
        : 'through';
    const layerBlock = block.match(/\(layers\s+([^\r\n()]+)\)/)?.[1] ?? '';
    const layers = [...layerBlock.matchAll(/"([^"]+)"/g)].map(match => match[1]!).slice(0, 32);
    route.viaCount += 1;
    route.vias.push({ type, sizeMm: size, drillMm: drill, layers });
    for (const layer of layers) route.layers.add(layer);
  }
  return { names, routes, tracks };
}

function parseNetClasses(project: JsonObject): {
  classes: NetClass[];
  assignments: Record<string, string[]>;
  patternCount: number;
} {
  const netSettings = isObject(project.net_settings) ? project.net_settings : {};
  const rawClasses = Array.isArray(netSettings.classes) ? netSettings.classes : [];
  const classes: NetClass[] = [];
  for (const raw of rawClasses) {
    if (!isObject(raw) || !asString(raw.name)) continue;
    const name = asString(raw.name)!;
    classes.push({
      name,
      priority: asNumber(raw.priority) ?? Number.MAX_SAFE_INTEGER,
      ...(asNumber(raw.clearance) !== undefined ? { clearance: asNumber(raw.clearance) } : {}),
      ...(asNumber(raw.track_width) !== undefined ? { trackWidth: asNumber(raw.track_width) } : {}),
      ...(asNumber(raw.via_diameter) !== undefined ? { viaDiameter: asNumber(raw.via_diameter) } : {}),
      ...(asNumber(raw.via_drill) !== undefined ? { viaDrill: asNumber(raw.via_drill) } : {}),
      ...(asNumber(raw.microvia_diameter) !== undefined ? { microviaDiameter: asNumber(raw.microvia_diameter) } : {}),
      ...(asNumber(raw.microvia_drill) !== undefined ? { microviaDrill: asNumber(raw.microvia_drill) } : {}),
      ...(asNumber(raw.diff_pair_width) !== undefined ? { diffPairWidth: asNumber(raw.diff_pair_width) } : {}),
      ...(asNumber(raw.diff_pair_gap) !== undefined ? { diffPairGap: asNumber(raw.diff_pair_gap) } : {}),
      ...(asNumber(raw.diff_pair_via_gap) !== undefined ? { diffPairViaGap: asNumber(raw.diff_pair_via_gap) } : {}),
      ...(asString(raw.tuning_profile) ? { tuningProfile: asString(raw.tuning_profile) } : {})
    });
  }
  const assignments: Record<string, string[]> = {};
  const rawAssignments = isObject(netSettings.netclass_assignments) ? netSettings.netclass_assignments : {};
  for (const [net, value] of Object.entries(rawAssignments)) {
    if (!Array.isArray(value)) continue;
    const names = value.filter((item): item is string => typeof item === 'string').slice(0, 32);
    if (names.length) assignments[net] = names;
  }
  const patterns = Array.isArray(netSettings.netclass_patterns) ? netSettings.netclass_patterns.length : 0;
  return { classes, assignments, patternCount: patterns };
}

function designSettings(project: JsonObject) {
  const board = isObject(project.board) ? project.board : {};
  const settings = isObject(board.design_settings) ? board.design_settings : {};
  const rules = isObject(settings.rules) ? settings.rules : {};
  const severities = isObject(settings.rule_severities) ? settings.rule_severities : {};
  return {
    minimums: {
      minClearanceMm: asNumber(rules.min_clearance),
      minCopperEdgeClearanceMm: asNumber(rules.min_copper_edge_clearance),
      minHoleClearanceMm: asNumber(rules.min_hole_clearance),
      minHoleToHoleMm: asNumber(rules.min_hole_to_hole),
      minMicroviaDiameterMm: asNumber(rules.min_microvia_diameter),
      minMicroviaDrillMm: asNumber(rules.min_microvia_drill),
      minTrackWidthMm: asNumber(rules.min_track_width),
      minViaAnnularWidthMm: asNumber(rules.min_via_annular_width),
      minViaDiameterMm: asNumber(rules.min_via_diameter),
      minThroughHoleDiameterMm: asNumber(rules.min_through_hole_diameter),
      minTextHeightMm: asNumber(rules.min_text_height),
      minTextThicknessMm: asNumber(rules.min_text_thickness)
    },
    useHeightForLengthCalcs: rules.use_height_for_length_calcs === true,
    trackWidthPresetsMm: Array.isArray(settings.track_widths)
      ? settings.track_widths.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      : [],
    viaDimensionPresets: Array.isArray(settings.via_dimensions)
      ? settings.via_dimensions.filter(isObject).map(value => ({ diameter: asNumber(value.diameter), drill: asNumber(value.drill) }))
      : [],
    diffPairDimensionPresets: Array.isArray(settings.diff_pair_dimensions)
      ? settings.diff_pair_dimensions.filter(isObject).map(value => ({
        width: asNumber(value.width),
        gap: asNumber(value.gap),
        viaGap: asNumber(value.via_gap)
      }))
      : [],
    severities: Object.fromEntries(Object.entries(severities).filter(([, value]) => typeof value === 'string')) as Record<string, string>
  };
}

function parseStackup(boardSource: string) {
  const general = blocks(boardSource, 'general', 4)[0];
  const setup = blocks(boardSource, 'setup', 4)[0];
  const stackup = setup ? blocks(setup, 'stackup', 4)[0] : undefined;
  const boardThickness = general ? numberToken(general, 'thickness') : undefined;
  if (!stackup) {
    return {
      declared: false,
      boardThicknessMm: boardThickness,
      copperLayerCount: 0,
      dielectricLayerCount: 0,
      layers: [],
      totalDeclaredThicknessMm: 0,
      missingDielectricMaterialCount: 0,
      missingDielectricEpsilonRCount: 0,
      missingDielectricLossTangentCount: 0
    };
  }
  const layers = blocks(stackup, 'layer', 128).map(block => {
    const name = firstQuotedArg(block, 'layer') ?? block.match(/^\(layer\s+([^\s()]+)/)?.[1] ?? '<unknown>';
    const type = quotedToken(block, 'type');
    const parts = block.split(/\baddsublayer\b/);
    const base = parts[0] ?? block;
    const thickness = numberToken(base, 'thickness');
    const material = quotedToken(base, 'material');
    const epsilonR = numberToken(base, 'epsilon_r');
    const lossTangent = numberToken(base, 'loss_tangent');
    const sublayers = parts.slice(1).map(part => ({
      thicknessMm: numberToken(part, 'thickness'),
      material: quotedToken(part, 'material'),
      epsilonR: numberToken(part, 'epsilon_r'),
      lossTangent: numberToken(part, 'loss_tangent')
    }));
    const isCopper = name.endsWith('.Cu') || type?.toLowerCase() === 'copper';
    const isDielectric = name.toLowerCase().startsWith('dielectric') || ['core', 'prepreg'].includes((type ?? '').toLowerCase());
    return {
      name,
      type,
      thicknessMm: thickness,
      material,
      epsilonR,
      lossTangent,
      sublayers,
      isCopper,
      isDielectric
    };
  });
  const dielectricLayers = layers.filter(layer => layer.isDielectric);
  const dielectricSlices = dielectricLayers.flatMap(layer => [
    { material: layer.material, epsilonR: layer.epsilonR, lossTangent: layer.lossTangent },
    ...layer.sublayers
  ]);
  const totalDeclaredThicknessMm = layers.reduce((sum, layer) =>
    sum + (layer.thicknessMm ?? 0) + layer.sublayers.reduce((sub, slice) => sub + (slice.thicknessMm ?? 0), 0), 0);
  return {
    declared: true,
    boardThicknessMm: boardThickness,
    copperFinish: quotedToken(stackup, 'copper_finish'),
    dielectricConstraints: stackup.match(/\(dielectric_constraints\s+(yes|no)\)/)?.[1] ?? undefined,
    copperLayerCount: layers.filter(layer => layer.isCopper).length,
    dielectricLayerCount: dielectricLayers.length,
    dielectricSliceCount: dielectricSlices.length,
    layers,
    totalDeclaredThicknessMm: Number(totalDeclaredThicknessMm.toFixed(4)),
    thicknessDeltaMm: boardThickness !== undefined ? Number(Math.abs(boardThickness - totalDeclaredThicknessMm).toFixed(4)) : undefined,
    missingDielectricMaterialCount: dielectricSlices.filter(layer => !layer.material).length,
    missingDielectricEpsilonRCount: dielectricSlices.filter(layer => layer.epsilonR === undefined).length,
    missingDielectricLossTangentCount: dielectricSlices.filter(layer => layer.lossTangent === undefined).length
  };
}

function parseZones(boardSource: string, maxDetails: number) {
  const byLayer: Record<string, number> = {};
  const byNet: Record<string, number> = {};
  const examples: Array<{
    netId?: number;
    netName?: string;
    layers: string[];
    minThicknessMm?: number;
    thermalGapMm?: number;
    thermalBridgeWidthMm?: number;
  }> = [];
  let count = 0;
  for (const fullBlock of iterateBlocks(boardSource, 'zone', 20_000)) {
    count += 1;
    const polygonIndex = fullBlock.indexOf('(polygon');
    const filledIndex = fullBlock.indexOf('(filled_polygon');
    const cutoffCandidates = [polygonIndex, filledIndex].filter(index => index >= 0);
    const cutoff = cutoffCandidates.length ? Math.min(...cutoffCandidates) : fullBlock.length;
    const block = fullBlock.slice(0, cutoff);
    const netId = numberToken(block, 'net');
    const netName = quotedToken(block, 'net_name');
    const singleLayer = layerName(block);
    const layerList = block.match(/\(layers\s+([^\r\n()]+)\)/)?.[1];
    const layers = singleLayer
      ? [singleLayer]
      : layerList
        ? [...layerList.matchAll(/"([^"]+)"/g)].map(match => match[1]!).slice(0, 32)
        : [];
    const minThickness = numberToken(block, 'min_thickness');
    const fill = blocks(block, 'fill', 4)[0];
    const zone = {
      ...(netId !== undefined ? { netId } : {}),
      ...(netName !== undefined ? { netName } : {}),
      layers,
      ...(minThickness !== undefined ? { minThicknessMm: minThickness } : {}),
      ...(fill && numberToken(fill, 'thermal_gap') !== undefined ? { thermalGapMm: numberToken(fill, 'thermal_gap') } : {}),
      ...(fill && numberToken(fill, 'thermal_bridge_width') !== undefined ? { thermalBridgeWidthMm: numberToken(fill, 'thermal_bridge_width') } : {})
    };
    for (const layer of layers) byLayer[layer] = (byLayer[layer] ?? 0) + 1;
    const key = netName ?? (netId !== undefined ? `#${netId}` : '<unknown>');
    byNet[key] = (byNet[key] ?? 0) + 1;
    if (examples.length < maxDetails) examples.push(zone);
  }
  return { count, byLayer, byNet, examples };
}

function topLevelRuleBlocks(source: string): string[] {
  const rules: string[] = [];
  let cursor = 0;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  while (cursor < source.length) {
    const ch = source[cursor]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      cursor += 1;
      continue;
    }
    if (ch === '"') { quoted = true; cursor += 1; continue; }
    if (ch === '#') {
      const newline = source.indexOf('\n', cursor);
      cursor = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (ch === '(') {
      if (depth === 0 && source.startsWith('(rule', cursor)) {
        const end = blockEnd(source, cursor);
        rules.push(source.slice(cursor, end));
        if (rules.length > 10_000) throw new Error('KiCad custom rules exceed the 10000-rule review limit.');
        cursor = end;
        continue;
      }
      depth += 1;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
    }
    cursor += 1;
  }
  return rules;
}

function parseSimpleMeasurement(raw: string): number | undefined {
  const match = raw.trim().match(/^(-?\d+(?:\.\d+)?)\s*(mm|mil|in)?$/i);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  const unit = (match[2] ?? 'mm').toLowerCase();
  if (unit === 'mil') return value * 0.0254;
  if (unit === 'in') return value * 25.4;
  return value;
}

function parseCustomRules(source: string | undefined, maxDetails: number) {
  if (!source) return { present: false, version: undefined, ruleCount: 0, constraintTypeCounts: {}, rules: [] };
  const version = Number(source.match(/\(version\s+(\d+)\)/)?.[1] ?? NaN);
  const parsed = topLevelRuleBlocks(source).map((block, index) => {
    const nameMatch = block.match(/^\(rule\s+(?:"((?:\\.|[^"\\])*)"|([^\s()]+))/);
    const name = (nameMatch?.[1] ?? nameMatch?.[2] ?? `rule-${index + 1}`).replace(/\\(["\\])/g, '$1');
    const severity = block.match(/\(severity\s+([^\s()]+)\)/)?.[1];
    const layer = block.match(/\(layer\s+([^\s()]+|"[^"]+")\)/)?.[1]?.replace(/^"|"$/g, '');
    const condition = quotedToken(block, 'condition');
    const constraints = blocks(block, 'constraint', 128).map(constraint => {
      const type = constraint.match(/^\(constraint\s+([^\s()]+)/)?.[1] ?? '<unknown>';
      const values: Record<string, { raw: string; simpleMm?: number }> = {};
      for (const key of ['min', 'opt', 'max']) {
        const match = constraint.match(new RegExp('\\(' + key + '\\s+([^()]+?)\\)'));
        if (!match?.[1]) continue;
        const raw = match[1].trim();
        const simpleMm = parseSimpleMeasurement(raw);
        values[key] = { raw, ...(simpleMm !== undefined ? { simpleMm } : {}) };
      }
      return { type, values };
    });
    return { name, severity, layer, condition, constraints };
  });
  const counts: Record<string, number> = {};
  for (const rule of parsed) {
    for (const constraint of rule.constraints) counts[constraint.type] = (counts[constraint.type] ?? 0) + 1;
  }
  return {
    present: true,
    version: Number.isFinite(version) ? version : undefined,
    evaluation: 'catalog-only; KiCad DRC remains authoritative for custom-rule matching and violations',
    ruleCount: parsed.length,
    constraintTypeCounts: counts,
    rules: parsed.slice(0, maxDetails)
  };
}

function detectDifferentialPairs(names: Iterable<string>) {
  const all = new Set(names);
  const pairs: Array<{ base: string; positive: string; negative: string }> = [];
  const seen = new Set<string>();
  for (const name of all) {
    let base: string | undefined;
    let positive: string | undefined;
    let negative: string | undefined;
    if (name.endsWith('+')) {
      base = name.slice(0, -1); positive = name; negative = base + '-';
    } else if (name.endsWith('_P')) {
      base = name.slice(0, -1); positive = name; negative = base + 'N';
    }
    if (!base || !positive || !negative || !all.has(negative)) continue;
    const key = positive + '\u0000' + negative;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ base, positive, negative });
  }
  return pairs;
}

function classByName(classes: NetClass[]): Map<string, NetClass> {
  return new Map(classes.map(item => [item.name, item]));
}

function effectiveNetClassProperty(
  net: string,
  assignments: Record<string, string[]>,
  classes: NetClass[],
  property: keyof Omit<NetClass, 'name' | 'priority'>
): { value?: number | string; sourceClass?: string; assignmentSource: 'direct' | 'default' | 'pattern-unresolved' } {
  const byName = classByName(classes);
  const explicit = assignments[net] ?? [];
  const candidates = explicit
    .map(name => byName.get(name))
    .filter((item): item is NetClass => Boolean(item))
    .sort((a, b) => a.priority - b.priority);
  for (const item of candidates) {
    const value = item[property];
    if (value !== undefined) return { value, sourceClass: item.name, assignmentSource: 'direct' };
  }
  const fallback = byName.get('Default');
  const fallbackValue = fallback?.[property];
  return {
    ...(fallbackValue !== undefined ? { value: fallbackValue, sourceClass: 'Default' } : {}),
    assignmentSource: explicit.length ? 'direct' : 'default'
  };
}

export function analyzeKicadConstraints(
  input: { project: string; board: string; customRules?: string },
  options: KicadConstraintsReviewOptions = {}
) {
  for (const [name, source] of Object.entries(input)) {
    if (source && Buffer.byteLength(source, 'utf8') > MAX_TEXT_BYTES) {
      throw new Error(`KiCad ${name} source exceeds the 128 MiB constraints-review limit.`);
    }
  }
  const maxDetails = Math.max(1, Math.min(100, options.maxDetails ?? 25));
  let project: JsonObject;
  try {
    const parsed: unknown = JSON.parse(input.project);
    if (!isObject(parsed)) throw new Error('project root is not an object');
    project = parsed;
  } catch (error) {
    throw new Error(`KiCad project settings are not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const settings = designSettings(project);
  const netSettings = parseNetClasses(project);
  const routeData = parseRoutes(input.board);
  const stackup = parseStackup(input.board);
  const zones = parseZones(input.board, maxDetails);
  const customRules = parseCustomRules(input.customRules, maxDetails);

  const hardMinimumFindings = {
    trackWidthBelowMinimum: [] as Array<{ net: string; widthMm: number; minimumMm: number; layer: string }>,
    viaDiameterBelowMinimum: [] as Array<{ net: string; type: string; sizeMm: number; minimumMm: number }>,
    viaDrillBelowMinimum: [] as Array<{ net: string; type: string; drillMm: number; minimumMm: number }>,
    viaAnnularWidthBelowMinimum: [] as Array<{ net: string; type: string; annularWidthMm: number; minimumMm: number }>
  };
  const minTrack = settings.minimums.minTrackWidthMm;
  if (minTrack !== undefined) {
    for (const track of routeData.tracks) {
      if (track.widthMm + 1e-9 < minTrack && hardMinimumFindings.trackWidthBelowMinimum.length < maxDetails) {
        hardMinimumFindings.trackWidthBelowMinimum.push({ net: track.netName, widthMm: track.widthMm, minimumMm: minTrack, layer: track.layer });
      }
    }
  }
  for (const route of routeData.routes.values()) {
    for (const via of route.vias) {
      const minDiameter = via.type === 'micro'
        ? settings.minimums.minMicroviaDiameterMm
        : settings.minimums.minViaDiameterMm;
      const minDrill = via.type === 'micro'
        ? settings.minimums.minMicroviaDrillMm
        : settings.minimums.minThroughHoleDiameterMm;
      if (minDiameter !== undefined && via.sizeMm + 1e-9 < minDiameter && hardMinimumFindings.viaDiameterBelowMinimum.length < maxDetails) {
        hardMinimumFindings.viaDiameterBelowMinimum.push({ net: route.name, type: via.type, sizeMm: via.sizeMm, minimumMm: minDiameter });
      }
      if (minDrill !== undefined && via.drillMm + 1e-9 < minDrill && hardMinimumFindings.viaDrillBelowMinimum.length < maxDetails) {
        hardMinimumFindings.viaDrillBelowMinimum.push({ net: route.name, type: via.type, drillMm: via.drillMm, minimumMm: minDrill });
      }
      const annularWidth = Math.max(0, (via.sizeMm - via.drillMm) / 2);
      const minAnnular = settings.minimums.minViaAnnularWidthMm;
      if (minAnnular !== undefined && annularWidth + 1e-9 < minAnnular && hardMinimumFindings.viaAnnularWidthBelowMinimum.length < maxDetails) {
        hardMinimumFindings.viaAnnularWidthBelowMinimum.push({
          net: route.name,
          type: via.type,
          annularWidthMm: Number(annularWidth.toFixed(4)),
          minimumMm: minAnnular
        });
      }
    }
  }

  const classDefaultDeviation = [...routeData.routes.values()].map(route => {
    const widthDefault = effectiveNetClassProperty(route.name, netSettings.assignments, netSettings.classes, 'trackWidth');
    const viaDiameterDefault = effectiveNetClassProperty(route.name, netSettings.assignments, netSettings.classes, 'viaDiameter');
    const viaDrillDefault = effectiveNetClassProperty(route.name, netSettings.assignments, netSettings.classes, 'viaDrill');
    const widths = [...route.widths].sort((a, b) => a - b);
    const viaDiameters = [...new Set(route.vias.map(via => via.sizeMm))].sort((a, b) => a - b);
    const viaDrills = [...new Set(route.vias.map(via => via.drillMm))].sort((a, b) => a - b);
    const widthValue = typeof widthDefault.value === 'number' ? widthDefault.value : undefined;
    const viaDiameterValue = typeof viaDiameterDefault.value === 'number' ? viaDiameterDefault.value : undefined;
    const viaDrillValue = typeof viaDrillDefault.value === 'number' ? viaDrillDefault.value : undefined;
    return {
      net: route.name,
      assignedClasses: netSettings.assignments[route.name] ?? [],
      trackWidthsMm: widths,
      viaDiametersMm: viaDiameters,
      viaDrillsMm: viaDrills,
      configuredDefaults: {
        trackWidthMm: widthValue,
        trackWidthSourceClass: widthDefault.sourceClass,
        viaDiameterMm: viaDiameterValue,
        viaDiameterSourceClass: viaDiameterDefault.sourceClass,
        viaDrillMm: viaDrillValue,
        viaDrillSourceClass: viaDrillDefault.sourceClass
      },
      differsFromConfiguredDefaults: {
        trackWidth: widthValue !== undefined && widths.some(width => Math.abs(width - widthValue) > 1e-6),
        viaDiameter: viaDiameterValue !== undefined && viaDiameters.some(value => Math.abs(value - viaDiameterValue) > 1e-6),
        viaDrill: viaDrillValue !== undefined && viaDrills.some(value => Math.abs(value - viaDrillValue) > 1e-6)
      }
    };
  }).filter(item =>
    item.differsFromConfiguredDefaults.trackWidth ||
    item.differsFromConfiguredDefaults.viaDiameter ||
    item.differsFromConfiguredDefaults.viaDrill
  ).slice(0, maxDetails);

  const pairs = detectDifferentialPairs(routeData.names.values()).map(pair => {
    const positive = [...routeData.routes.values()].find(route => route.name === pair.positive);
    const negative = [...routeData.routes.values()].find(route => route.name === pair.negative);
    const positiveLength = positive?.trackLengthMm ?? 0;
    const negativeLength = negative?.trackLengthMm ?? 0;
    const widthDefault = effectiveNetClassProperty(pair.positive, netSettings.assignments, netSettings.classes, 'diffPairWidth');
    const gapDefault = effectiveNetClassProperty(pair.positive, netSettings.assignments, netSettings.classes, 'diffPairGap');
    return {
      ...pair,
      positiveLengthMm: Number(positiveLength.toFixed(4)),
      negativeLengthMm: Number(negativeLength.toFixed(4)),
      explicitLengthSkewMm: Number(Math.abs(positiveLength - negativeLength).toFixed(4)),
      positiveViaCount: positive?.viaCount ?? 0,
      negativeViaCount: negative?.viaCount ?? 0,
      positiveWidthsMm: [...(positive?.widths ?? new Set<number>())].sort((a, b) => a - b),
      negativeWidthsMm: [...(negative?.widths ?? new Set<number>())].sort((a, b) => a - b),
      positiveClasses: netSettings.assignments[pair.positive] ?? [],
      negativeClasses: netSettings.assignments[pair.negative] ?? [],
      configuredDiffPairDefaults: {
        widthMm: typeof widthDefault.value === 'number' ? widthDefault.value : undefined,
        gapMm: typeof gapDefault.value === 'number' ? gapDefault.value : undefined,
        sourceClass: widthDefault.sourceClass ?? gapDefault.sourceClass
      }
    };
  }).sort((a, b) => b.explicitLengthSkewMm - a.explicitLengthSkewMm).slice(0, maxDetails);

  const ignoredSeverities = Object.entries(settings.severities)
    .filter(([, severity]) => severity === 'ignore')
    .map(([rule]) => rule)
    .sort();

  const recommendations: Array<{
    priority: 'high' | 'medium' | 'review';
    code: string;
    message: string;
    count?: number;
    nextTools: string[];
  }> = [];
  const hardCount = Object.values(hardMinimumFindings).reduce((sum, list) => sum + list.length, 0);
  if (hardCount) recommendations.push({
    priority: 'high',
    code: 'configured-hard-minimum-breach-evidence',
    message: 'Explicit routing geometry appears below one or more Board Setup hard minimums. KiCad DRC remains authoritative and should be run before edits.',
    count: hardCount,
    nextTools: ['kicad_drc', 'kicad_ipc_routing_inspect']
  });
  if (!stackup.declared) recommendations.push({
    priority: 'review',
    code: 'stackup-not-declared',
    message: 'No physical stackup is declared in the PCB setup. Mechanical thickness and high-speed length/impedance evidence will be less trustworthy.',
    nextTools: ['kicad_visual_export', 'kicad_drc']
  });
  if (stackup.declared && stackup.dielectricLayerCount > 0 &&
      (stackup.missingDielectricMaterialCount || stackup.missingDielectricEpsilonRCount || stackup.missingDielectricLossTangentCount)) {
    recommendations.push({
      priority: 'review',
      code: 'incomplete-dielectric-stackup',
      message: 'One or more dielectric stackup entries are missing material, epsilon_r or loss tangent metadata needed for stronger high-speed/manufacturing review.',
      count: Math.max(stackup.missingDielectricMaterialCount, stackup.missingDielectricEpsilonRCount, stackup.missingDielectricLossTangentCount),
      nextTools: ['kicad_constraints_review']
    });
  }
  if (stackup.thicknessDeltaMm !== undefined && stackup.thicknessDeltaMm > 0.05) recommendations.push({
    priority: 'medium',
    code: 'stackup-thickness-mismatch',
    message: 'Sum of declared stackup layer thickness differs materially from board general thickness; review mechanical/fabrication settings.',
    nextTools: ['kicad_visual_export', 'kicad_constraints_review']
  });
  if (classDefaultDeviation.length) recommendations.push({
    priority: 'review',
    code: 'routing-differs-from-netclass-defaults',
    message: 'Some explicit track/via geometry differs from configured net-class defaults. This is not a violation by itself; custom rules or intentional overrides may apply.',
    count: classDefaultDeviation.length,
    nextTools: ['kicad_drc', 'kicad_ipc_routing_inspect']
  });
  if (customRules.present) recommendations.push({
    priority: 'review',
    code: 'custom-rules-present',
    message: 'Custom .kicad_dru rules are cataloged but not re-evaluated by RWMCP; KiCad DRC is authoritative for rule matching, order and violations.',
    count: customRules.ruleCount,
    nextTools: ['kicad_drc']
  });
  if (ignoredSeverities.some(rule => ['clearance', 'shorting_items', 'track_width', 'diff_pair_gap_out_of_range', 'skew_out_of_range'].includes(rule))) {
    recommendations.push({
      priority: 'medium',
      code: 'critical-drc-severity-ignored',
      message: 'One or more critical routing/high-speed DRC severities are configured as ignored; review the project rule policy.',
      count: ignoredSeverities.filter(rule => ['clearance', 'shorting_items', 'track_width', 'diff_pair_gap_out_of_range', 'skew_out_of_range'].includes(rule)).length,
      nextTools: ['kicad_drc', 'kicad_constraints_review']
    });
  }

  return {
    schemaVersion: 1,
    sources: {
      project: { sha256: sha256Text(input.project), bytes: Buffer.byteLength(input.project, 'utf8') },
      board: { sha256: sha256Text(input.board), bytes: Buffer.byteLength(input.board, 'utf8') },
      ...(input.customRules ? { customRules: { sha256: sha256Text(input.customRules), bytes: Buffer.byteLength(input.customRules, 'utf8') } } : {})
    },
    projectRules: {
      minimums: settings.minimums,
      useHeightForLengthCalcs: settings.useHeightForLengthCalcs,
      trackWidthPresetsMm: settings.trackWidthPresetsMm,
      viaDimensionPresets: settings.viaDimensionPresets,
      diffPairDimensionPresets: settings.diffPairDimensionPresets,
      ignoredDrcSeverities: ignoredSeverities
    },
    netClasses: {
      classes: [...netSettings.classes].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name)),
      directAssignmentCount: Object.keys(netSettings.assignments).length,
      patternCount: netSettings.patternCount,
      note: 'Net-class values are routing defaults/optimal values unless a hard minimum or custom DRC rule says otherwise.'
    },
    board: {
      stackup,
      zones,
      routeNetCount: routeData.routes.size,
      segmentOrArcCount: routeData.tracks.length,
      viaCount: [...routeData.routes.values()].reduce((sum, route) => sum + route.viaCount, 0)
    },
    customRules,
    complianceEvidence: {
      hardMinimumFindings,
      netClassDefaultDeviations: classDefaultDeviation
    },
    differentialPairs: {
      detectedPairCount: pairs.length,
      pairs,
      note: 'Length skew and configured pair defaults are evidence only; KiCad DRC/custom rules remain authoritative for pair-width/gap/skew compliance.'
    },
    recommendations
  };
}
