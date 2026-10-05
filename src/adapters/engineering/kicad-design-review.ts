import { createHash } from 'node:crypto';

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_BLOCKS = 200_000;

type Point = { x: number; y: number };

type SchematicSymbol = {
  reference?: string;
  value?: string;
  footprint?: string;
  inBom?: boolean;
  onBoard?: boolean;
};

type BoardFootprint = {
  reference?: string;
  value?: string;
  libraryLink?: string;
  layer?: string;
  at?: { x: number; y: number; rotation?: number };
  locked: boolean;
  boardOnly: boolean;
  modelPaths: string[];
};

type RoutedNet = {
  id: number;
  name: string;
  segmentCount: number;
  arcCount: number;
  viaCount: number;
  trackLengthMm: number;
  layers: Set<string>;
  widths: Set<number>;
  shortSegments: number;
};

export interface KicadDesignReviewOptions {
  maxDetails?: number;
  shortSegmentMm?: number;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function unquote(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
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
    if (result.length > limit) throw new Error(`KiCad design review exceeds the ${limit}-block limit for ${token}.`);
    cursor = end;
  }
  return result;
}

function quotedProperty(block: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp('\\(property\\s+"' + escaped + '"\\s+"((?:\\\\.|[^"\\\\])*)"', 'i'));
  return match?.[1] !== undefined ? unquote(match[1]) : undefined;
}

function firstQuotedArg(block: string, token: string): string | undefined {
  const escaped = token.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp('^\\(' + escaped + '\\s+"((?:\\\\.|[^"\\\\])*)"', 'i'));
  return match?.[1] !== undefined ? unquote(match[1]) : undefined;
}

function firstBooleanToken(block: string, token: string): boolean | undefined {
  const escaped = token.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp('\\(' + escaped + '\\s+(yes|no)\\)', 'i'));
  return match?.[1] ? match[1].toLowerCase() === 'yes' : undefined;
}

function firstNumberToken(block: string, token: string): number | undefined {
  const escaped = token.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp('\\(' + escaped + '\\s+(-?\\d+(?:\\.\\d+)?)\\)', 'i'));
  return match?.[1] !== undefined ? Number(match[1]) : undefined;
}

function pointToken(block: string, token: string): Point | undefined {
  const escaped = token.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp('\\(' + escaped + '\\s+(-?\\d+(?:\\.\\d+)?)\\s+(-?\\d+(?:\\.\\d+)?)', 'i'));
  if (!match?.[1] || !match[2]) return undefined;
  return { x: Number(match[1]), y: Number(match[2]) };
}

function firstAt(block: string): { x: number; y: number; rotation?: number } | undefined {
  const match = block.match(/\(at\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+(-?\d+(?:\.\d+)?))?\)/);
  if (!match?.[1] || !match[2]) return undefined;
  return {
    x: Number(match[1]),
    y: Number(match[2]),
    ...(match[3] !== undefined ? { rotation: Number(match[3]) } : {})
  };
}

function layerName(block: string): string | undefined {
  return block.match(/\(layer\s+"([^"]+)"\)/i)?.[1];
}

function attributes(block: string): Set<string> {
  const match = block.match(/\(attr(?:\s+([^()\r\n]*))?\)/i);
  return new Set((match?.[1] ?? '').trim().split(/\s+/).filter(Boolean));
}

function parseSchematic(source: string): SchematicSymbol[] {
  return blocks(source, 'symbol', 20_000)
    .filter(block => block.includes('(instances'))
    .map(block => ({
      reference: quotedProperty(block, 'Reference') ?? block.match(/\(reference\s+"([^"]+)"\)/i)?.[1],
      value: quotedProperty(block, 'Value'),
      footprint: quotedProperty(block, 'Footprint'),
      inBom: firstBooleanToken(block, 'in_bom'),
      onBoard: firstBooleanToken(block, 'on_board')
    }))
    .filter(item => item.reference || item.value);
}

function parseBoardFootprints(source: string): BoardFootprint[] {
  return blocks(source, 'footprint', 20_000).map(block => {
    const flags = attributes(block);
    const modelPaths = blocks(block, 'model', 128)
      .map(model => firstQuotedArg(model, 'model'))
      .filter((value): value is string => Boolean(value))
      .slice(0, 128);
    return {
      reference: quotedProperty(block, 'Reference'),
      value: quotedProperty(block, 'Value'),
      libraryLink: firstQuotedArg(block, 'footprint'),
      layer: layerName(block),
      at: firstAt(block),
      locked: /\(locked\b/.test(block) || flags.has('locked'),
      boardOnly: flags.has('board_only'),
      modelPaths
    };
  });
}

function duplicateValues(values: Array<string | undefined>): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function netNames(source: string): Map<number, string> {
  const result = new Map<number, string>();
  for (const match of source.matchAll(/\(net\s+(\d+)\s+"((?:\\.|[^"\\])*)"\)/g)) {
    if (!match[1] || match[2] === undefined) continue;
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id < 0) continue;
    if (!result.has(id)) result.set(id, unquote(match[2]));
  }
  return result;
}

function arcLength(start: Point, mid: Point, end: Point): number {
  const ax = start.x;
  const ay = start.y;
  const bx = mid.x;
  const by = mid.y;
  const cx = end.x;
  const cy = end.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) {
    return Math.hypot(bx - ax, by - ay) + Math.hypot(cx - bx, cy - by);
  }
  const ux = (
    (ax * ax + ay * ay) * (by - cy) +
    (bx * bx + by * by) * (cy - ay) +
    (cx * cx + cy * cy) * (ay - by)
  ) / d;
  const uy = (
    (ax * ax + ay * ay) * (cx - bx) +
    (bx * bx + by * by) * (ax - cx) +
    (cx * cx + cy * cy) * (bx - ax)
  ) / d;
  const radius = Math.hypot(ax - ux, ay - uy);
  const angle = (point: Point) => Math.atan2(point.y - uy, point.x - ux);
  const normalize = (value: number) => {
    let out = value % (Math.PI * 2);
    if (out < 0) out += Math.PI * 2;
    return out;
  };
  const a0 = normalize(angle(start));
  const am = normalize(angle(mid));
  const a1 = normalize(angle(end));
  const ccwSweep = normalize(a1 - a0);
  const midSweep = normalize(am - a0);
  const sweep = midSweep <= ccwSweep + 1e-9 ? ccwSweep : Math.PI * 2 - ccwSweep;
  return radius * sweep;
}

function routeNet(
  nets: Map<number, RoutedNet>,
  id: number,
  names: Map<number, string>
): RoutedNet {
  let item = nets.get(id);
  if (!item) {
    item = {
      id,
      name: names.get(id) ?? `#${id}`,
      segmentCount: 0,
      arcCount: 0,
      viaCount: 0,
      trackLengthMm: 0,
      layers: new Set<string>(),
      widths: new Set<number>(),
      shortSegments: 0
    };
    nets.set(id, item);
  }
  return item;
}

function segmentAngleBucket(start: Point, end: Point): 'orthogonal' | 'diagonal45' | 'other' {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let angle = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI) % 180;
  if (angle > 90) angle = 180 - angle;
  const near = (target: number) => Math.abs(angle - target) <= 0.5;
  if (near(0) || near(90)) return 'orthogonal';
  if (near(45)) return 'diagonal45';
  return 'other';
}

function parseRouting(source: string, shortSegmentMm: number) {
  const names = netNames(source);
  const nets = new Map<number, RoutedNet>();
  let segmentCount = 0;
  let arcCount = 0;
  let viaCount = 0;
  let totalTrackLengthMm = 0;
  let shortSegments = 0;
  const angleBuckets = { orthogonal: 0, diagonal45: 0, other: 0 };

  for (const block of blocks(source, 'segment')) {
    const start = pointToken(block, 'start');
    const end = pointToken(block, 'end');
    const netId = firstNumberToken(block, 'net');
    const layer = layerName(block);
    const width = firstNumberToken(block, 'width');
    if (!start || !end || netId === undefined || !layer?.endsWith('.Cu')) continue;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const item = routeNet(nets, netId, names);
    item.segmentCount += 1;
    item.trackLengthMm += length;
    item.layers.add(layer);
    if (width !== undefined) item.widths.add(width);
    if (length <= shortSegmentMm) { item.shortSegments += 1; shortSegments += 1; }
    angleBuckets[segmentAngleBucket(start, end)] += 1;
    segmentCount += 1;
    totalTrackLengthMm += length;
  }

  for (const block of blocks(source, 'arc')) {
    const start = pointToken(block, 'start');
    const mid = pointToken(block, 'mid');
    const end = pointToken(block, 'end');
    const netId = firstNumberToken(block, 'net');
    const layer = layerName(block);
    const width = firstNumberToken(block, 'width');
    if (!start || !mid || !end || netId === undefined || !layer?.endsWith('.Cu')) continue;
    const length = arcLength(start, mid, end);
    const item = routeNet(nets, netId, names);
    item.arcCount += 1;
    item.trackLengthMm += length;
    item.layers.add(layer);
    if (width !== undefined) item.widths.add(width);
    arcCount += 1;
    totalTrackLengthMm += length;
  }

  for (const block of blocks(source, 'via')) {
    const netId = firstNumberToken(block, 'net');
    if (netId === undefined) continue;
    const item = routeNet(nets, netId, names);
    item.viaCount += 1;
    for (const layer of block.matchAll(/"((?:F|B|In\d+)\.Cu)"/g)) {
      if (layer[1]) item.layers.add(layer[1]);
    }
    viaCount += 1;
  }

  return {
    names,
    nets,
    segmentCount,
    arcCount,
    viaCount,
    totalTrackLengthMm,
    shortSegments,
    angleBuckets
  };
}

function edgeBounds(source: string) {
  const points: Point[] = [];
  for (const token of ['gr_line', 'gr_rect', 'gr_arc', 'gr_circle', 'gr_poly', 'gr_curve']) {
    for (const block of blocks(source, token, 20_000)) {
      if (!/\(layer\s+"Edge\.Cuts"\)/i.test(block)) continue;
      for (const match of block.matchAll(/\((?:start|end|mid|center|xy)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)) {
        if (match[1] && match[2]) points.push({ x: Number(match[1]), y: Number(match[2]) });
      }
    }
  }
  if (points.length === 0) return undefined;
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    approximate: true,
    pointCount: points.length,
    minX,
    minY,
    maxX,
    maxY,
    widthMm: maxX - minX,
    heightMm: maxY - minY,
    areaMm2: Math.max(0, maxX - minX) * Math.max(0, maxY - minY)
  };
}

function placementMetrics(footprints: BoardFootprint[], outline: ReturnType<typeof edgeBounds>, maxDetails: number) {
  const positioned = footprints.filter(item => item.at !== undefined) as Array<BoardFootprint & { at: NonNullable<BoardFootprint['at']> }>;
  if (positioned.length === 0) {
    return {
      positionedFootprints: 0,
      lockedFootprints: footprints.filter(item => item.locked).length,
      layerCounts: {},
      originBounds: undefined,
      centroid: undefined,
      farthestFromCentroid: [],
      outsideEdgeBoundsApprox: []
    };
  }
  const xs = positioned.map(item => item.at.x);
  const ys = positioned.map(item => item.at.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const centroid = {
    x: xs.reduce((sum, value) => sum + value, 0) / xs.length,
    y: ys.reduce((sum, value) => sum + value, 0) / ys.length
  };
  const farthest = positioned
    .map(item => ({
      reference: item.reference,
      x: item.at.x,
      y: item.at.y,
      distanceFromCentroidMm: Math.hypot(item.at.x - centroid.x, item.at.y - centroid.y),
      locked: item.locked
    }))
    .sort((a, b) => b.distanceFromCentroidMm - a.distanceFromCentroidMm)
    .slice(0, maxDetails);
  const outside = outline
    ? positioned
      .filter(item => item.at.x < outline.minX || item.at.x > outline.maxX || item.at.y < outline.minY || item.at.y > outline.maxY)
      .slice(0, maxDetails)
      .map(item => ({ reference: item.reference, x: item.at.x, y: item.at.y }))
    : [];
  const layerCounts: Record<string, number> = {};
  for (const item of footprints) {
    const layer = item.layer ?? 'unknown';
    layerCounts[layer] = (layerCounts[layer] ?? 0) + 1;
  }
  const spreadArea = Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
  return {
    positionedFootprints: positioned.length,
    lockedFootprints: footprints.filter(item => item.locked).length,
    layerCounts,
    originBounds: {
      minX,
      minY,
      maxX,
      maxY,
      widthMm: maxX - minX,
      heightMm: maxY - minY,
      areaMm2: spreadArea
    },
    centroid,
    ...(outline && outline.areaMm2 > 0 ? { originSpreadAreaRatioApprox: spreadArea / outline.areaMm2 } : {}),
    farthestFromCentroid: farthest,
    outsideEdgeBoundsApprox: outside
  };
}

function classifyModelPath(value: string): 'variable' | 'absolute' | 'relative' {
  if (/^\$\{|^\$\(/.test(value)) return 'variable';
  if (/^[A-Za-z]:[\\/]/.test(value) || /^[\\/]/.test(value)) return 'absolute';
  return 'relative';
}

function normalizeFootprint(value: string | undefined): string {
  return (value ?? '').trim();
}

function normalizeValue(value: string | undefined): string {
  return (value ?? '').trim();
}

export function analyzeKicadDesign(
  input: { schematic?: string; board?: string },
  options: KicadDesignReviewOptions = {}
) {
  if (!input.schematic && !input.board) throw new Error('KiCad design review requires schematic and/or board source.');
  for (const [name, source] of Object.entries(input)) {
    if (source && Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
      throw new Error(`KiCad ${name} source exceeds the 32 MiB review limit.`);
    }
  }
  const maxDetails = Math.max(1, Math.min(100, options.maxDetails ?? 25));
  const shortSegmentMm = options.shortSegmentMm ?? 0.25;
  if (!Number.isFinite(shortSegmentMm) || shortSegmentMm < 0 || shortSegmentMm > 10) {
    throw new Error('KiCad design review shortSegmentMm must be in range 0..10 mm.');
  }

  const symbols = input.schematic ? parseSchematic(input.schematic) : [];
  const footprints = input.board ? parseBoardFootprints(input.board) : [];
  const outline = input.board ? edgeBounds(input.board) : undefined;
  const routing = input.board ? parseRouting(input.board, shortSegmentMm) : undefined;

  const schematicRefs = new Map(symbols.filter(item => item.reference).map(item => [item.reference!, item]));
  const boardRefs = new Map(footprints.filter(item => item.reference).map(item => [item.reference!, item]));
  const schematicEligible = symbols.filter(item => item.onBoard !== false && item.reference);

  const missingFootprintAssignments = schematicEligible
    .filter(item => !normalizeFootprint(item.footprint))
    .map(item => item.reference!)
    .slice(0, maxDetails);
  const missingOnBoard = schematicEligible
    .filter(item => item.reference && !boardRefs.has(item.reference))
    .map(item => item.reference!)
    .slice(0, maxDetails);
  const boardOnlyDeclared = footprints
    .filter(item => item.boardOnly && item.reference && !schematicRefs.has(item.reference))
    .map(item => item.reference!)
    .slice(0, maxDetails);
  const unexpectedOnBoard = footprints
    .filter(item => !item.boardOnly && item.reference && !schematicRefs.has(item.reference))
    .map(item => item.reference!)
    .slice(0, maxDetails);
  const valueMismatches: Array<{ reference: string; schematic: string; board: string }> = [];
  const footprintMismatches: Array<{ reference: string; schematic: string; board: string }> = [];
  for (const [reference, symbol] of schematicRefs) {
    const footprint = boardRefs.get(reference);
    if (!footprint) continue;
    const schematicValue = normalizeValue(symbol.value);
    const boardValue = normalizeValue(footprint.value);
    if (schematicValue && boardValue && schematicValue !== boardValue) {
      valueMismatches.push({ reference, schematic: schematicValue, board: boardValue });
    }
    const schematicFootprint = normalizeFootprint(symbol.footprint);
    const boardFootprint = normalizeFootprint(footprint.libraryLink);
    if (schematicFootprint && boardFootprint && schematicFootprint !== boardFootprint) {
      footprintMismatches.push({ reference, schematic: schematicFootprint, board: boardFootprint });
    }
  }

  const allModels = footprints.flatMap(item => item.modelPaths.map(modelPath => ({
    reference: item.reference,
    path: modelPath,
    kind: classifyModelPath(modelPath)
  })));
  const modelPathKinds = { variable: 0, relative: 0, absolute: 0 };
  for (const model of allModels) modelPathKinds[model.kind] += 1;
  const footprintsWithoutModels = footprints
    .filter(item => item.modelPaths.length === 0)
    .map(item => item.reference ?? item.libraryLink ?? '<unknown>')
    .slice(0, maxDetails);
  const absoluteModelPaths = allModels.filter(item => item.kind === 'absolute').slice(0, maxDetails);

  const placement = placementMetrics(footprints, outline, maxDetails);

  const perNet = routing
    ? [...routing.nets.values()].map(item => ({
      id: item.id,
      name: item.name,
      segmentCount: item.segmentCount,
      arcCount: item.arcCount,
      viaCount: item.viaCount,
      trackLengthMm: Number(item.trackLengthMm.toFixed(4)),
      layers: [...item.layers].sort(),
      widthsMm: [...item.widths].sort((a, b) => a - b),
      shortSegments: item.shortSegments
    }))
    : [];
  const topLongestNets = [...perNet]
    .sort((a, b) => b.trackLengthMm - a.trackLengthMm || a.name.localeCompare(b.name))
    .slice(0, maxDetails);
  const topViaNets = [...perNet]
    .filter(item => item.viaCount > 0)
    .sort((a, b) => b.viaCount - a.viaCount || b.trackLengthMm - a.trackLengthMm)
    .slice(0, maxDetails);
  const multipleWidthNets = perNet
    .filter(item => item.widthsMm.length > 1)
    .sort((a, b) => b.widthsMm.length - a.widthsMm.length || a.name.localeCompare(b.name))
    .slice(0, maxDetails);

  const recommendations: Array<{
    category: 'schematic' | 'consistency' | 'placement' | 'routing' | '3d';
    priority: 'high' | 'medium' | 'review';
    code: string;
    message: string;
    count?: number;
    nextTools?: string[];
  }> = [];
  const addRecommendation = (
    category: typeof recommendations[number]['category'],
    priority: typeof recommendations[number]['priority'],
    code: string,
    message: string,
    count?: number,
    nextTools?: string[]
  ) => recommendations.push({ category, priority, code, message, ...(count !== undefined ? { count } : {}), ...(nextTools ? { nextTools } : {}) });

  if (missingFootprintAssignments.length) addRecommendation(
    'schematic', 'high', 'missing-footprint-assignment',
    'Assign footprints in the schematic before placement optimization or fabrication.',
    missingFootprintAssignments.length, ['kicad_edit', 'kicad_design_review']
  );
  if (missingOnBoard.length) addRecommendation(
    'consistency', 'high', 'schematic-symbol-missing-on-board',
    'Schematic symbols marked for the board are missing from the PCB; synchronize schematic and PCB before routing.',
    missingOnBoard.length, ['kicad_validate', 'kicad_design_review']
  );
  if (unexpectedOnBoard.length) addRecommendation(
    'consistency', 'medium', 'unexpected-board-footprint',
    'PCB footprints are not represented in the schematic and are not declared board-only; review schematic parity.',
    unexpectedOnBoard.length, ['kicad_validate', 'kicad_ipc_footprint_update']
  );
  if (valueMismatches.length) addRecommendation(
    'consistency', 'medium', 'value-mismatch',
    'Reference-matched schematic and PCB values differ.',
    valueMismatches.length, ['kicad_edit', 'kicad_ipc_footprint_update']
  );
  if (footprintMismatches.length) addRecommendation(
    'consistency', 'high', 'footprint-mismatch',
    'Reference-matched schematic footprint assignments differ from PCB library links.',
    footprintMismatches.length, ['kicad_edit', 'kicad_validate']
  );
  if (placement.outsideEdgeBoundsApprox.length) addRecommendation(
    'placement', 'high', 'footprint-origin-outside-edge-bounds',
    'Some footprint origins are outside the approximate Edge.Cuts bounding box; inspect placement before fabrication.',
    placement.outsideEdgeBoundsApprox.length, ['kicad_ipc_board_inspect', 'kicad_ipc_batch_place']
  );
  if (footprintsWithoutModels.length) addRecommendation(
    '3d', 'medium', 'missing-3d-model',
    'Some PCB footprints declare no 3D model; complete model coverage before mechanical review.',
    footprintsWithoutModels.length, ['kicad_visual_export']
  );
  if (absoluteModelPaths.length) addRecommendation(
    '3d', 'review', 'absolute-3d-model-path',
    'Absolute 3D model paths reduce project portability; prefer KiCad variables or project-relative model paths where practical.',
    absoluteModelPaths.length, ['kicad_visual_export']
  );
  if (routing && routing.shortSegments > 0) addRecommendation(
    'routing', 'review', 'short-track-segments',
    `Review track segments at or below the configured ${shortSegmentMm} mm threshold; they may be intentional but can indicate routing cleanup opportunities.`,
    routing.shortSegments, ['kicad_ipc_routing_inspect', 'kicad_ipc_track_update']
  );
  if (topViaNets.length) addRecommendation(
    'routing', 'review', 'via-heavy-net-ranking',
    'Review the highest-via nets first when optimizing layer transitions and route complexity; ranking is evidence-only, not a DRC violation.',
    topViaNets.length, ['kicad_ipc_routing_inspect', 'kicad_ipc_via_update', 'kicad_ipc_track_update']
  );
  if (topLongestNets.length) addRecommendation(
    'routing', 'review', 'longest-routed-net-ranking',
    'Review the longest routed nets first when looking for detours or placement-driven route reductions; length alone is not an error.',
    topLongestNets.length, ['kicad_ipc_routing_inspect', 'kicad_ipc_batch_place', 'kicad_ipc_track_update']
  );

  return {
    schemaVersion: 1,
    options: { maxDetails, shortSegmentMm },
    sources: {
      ...(input.schematic ? { schematic: { sha256: sha256Text(input.schematic), bytes: Buffer.byteLength(input.schematic, 'utf8') } } : {}),
      ...(input.board ? { board: { sha256: sha256Text(input.board), bytes: Buffer.byteLength(input.board, 'utf8') } } : {})
    },
    schematic: input.schematic ? {
      symbolCount: symbols.length,
      inBomCount: symbols.filter(item => item.inBom !== false).length,
      onBoardCount: symbols.filter(item => item.onBoard !== false).length,
      footprintAssignedCount: symbols.filter(item => Boolean(normalizeFootprint(item.footprint))).length,
      duplicateReferences: duplicateValues(symbols.map(item => item.reference)).slice(0, maxDetails),
      missingFootprintAssignments
    } : undefined,
    consistency: input.schematic && input.board ? {
      missingOnBoard,
      boardOnlyDeclared,
      unexpectedOnBoard,
      valueMismatches: valueMismatches.slice(0, maxDetails),
      footprintMismatches: footprintMismatches.slice(0, maxDetails),
      duplicateSchematicReferences: duplicateValues(symbols.map(item => item.reference)).slice(0, maxDetails),
      duplicateBoardReferences: duplicateValues(footprints.map(item => item.reference)).slice(0, maxDetails)
    } : undefined,
    placement: input.board ? {
      footprintCount: footprints.length,
      outline,
      ...placement
    } : undefined,
    routing: routing ? {
      netCount: perNet.length,
      segmentCount: routing.segmentCount,
      arcCount: routing.arcCount,
      viaCount: routing.viaCount,
      totalTrackLengthMm: Number(routing.totalTrackLengthMm.toFixed(4)),
      shortSegmentThresholdMm: shortSegmentMm,
      shortSegmentCount: routing.shortSegments,
      straightSegmentAngles: routing.angleBuckets,
      topLongestNets,
      topViaNets,
      multipleWidthNets
    } : undefined,
    models3d: input.board ? {
      footprintCount: footprints.length,
      footprintWithModelCount: footprints.filter(item => item.modelPaths.length > 0).length,
      footprintWithoutModelCount: footprints.filter(item => item.modelPaths.length === 0).length,
      declaredModelCount: allModels.length,
      pathKinds: modelPathKinds,
      footprintsWithoutModels,
      absoluteModelPaths
    } : undefined,
    recommendations
  };
}
