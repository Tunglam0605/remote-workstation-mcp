import { createHash } from 'node:crypto';

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_BLOCKS = 200_000;

type Point = { x: number; y: number };

type BoardPad = {
  number: string;
  netId?: number;
  netName?: string;
  position: Point;
  layers: string[];
};

type BoardFootprint = {
  reference?: string;
  position: Point;
  rotationDeg: number;
  locked: boolean;
  pads: BoardPad[];
};

type RouteEvidence = {
  trackLengthMm: number;
  segmentCount: number;
  arcCount: number;
  viaCount: number;
  layers: Set<string>;
};

export interface KicadLayoutOptimizationOptions {
  maxDetails?: number;
  maxPlacementNetPads?: number;
  maxSuggestedStepMm?: number;
  placementGridMm?: number;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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
    if (result.length > limit) throw new Error(`KiCad layout optimization exceeds the ${limit}-block limit for ${token}.`);
    cursor = end;
  }
  return result;
}

function unquote(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
}

function quotedProperty(block: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp('\\(property\\s+"' + escaped + '"\\s+"((?:\\\\.|[^"\\\\])*)"', 'i'));
  return match?.[1] !== undefined ? unquote(match[1]) : undefined;
}

function quotedToken(block: string, token: string): string | undefined {
  const escaped = token.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp('\\(' + escaped + '\\s+"((?:\\\\.|[^"\\\\])*)"', 'i'));
  return match?.[1] !== undefined ? unquote(match[1]) : undefined;
}

function numberToken(block: string, token: string): number | undefined {
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

function atToken(block: string): { x: number; y: number; rotationDeg: number } | undefined {
  const match = block.match(/\(at\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+(-?\d+(?:\.\d+)?))?\)/);
  if (!match?.[1] || !match[2]) return undefined;
  return { x: Number(match[1]), y: Number(match[2]), rotationDeg: Number(match[3] ?? 0) };
}

function firstQuotedArg(block: string, token: string): string | undefined {
  const escaped = token.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp('^\\(' + escaped + '\\s+"((?:\\\\.|[^"\\\\])*)"', 'i'));
  return match?.[1] !== undefined ? unquote(match[1]) : undefined;
}

function rotate(point: Point, degrees: number): Point {
  const radians = degrees * Math.PI / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return { x: point.x * c - point.y * s, y: point.x * s + point.y * c };
}

function boardNetNames(source: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const match of source.matchAll(/\(net\s+(\d+)\s+"((?:\\.|[^"\\])*)"\)/g)) {
    if (!match[1] || match[2] === undefined) continue;
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id < 0) continue;
    if (!names.has(id)) names.set(id, unquote(match[2]));
  }
  return names;
}

function padNet(block: string): { id?: number; name?: string } {
  const match = block.match(/\(net\s+(\d+)\s+"((?:\\.|[^"\\])*)"\)/);
  if (!match?.[1]) return {};
  return { id: Number(match[1]), ...(match[2] !== undefined ? { name: unquote(match[2]) } : {}) };
}

function padLayers(block: string): string[] {
  const match = block.match(/\(layers\s+([^\r\n()]+)\)/);
  if (!match?.[1]) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map(item => item[1]!).slice(0, 32);
}

function parseBoardFootprints(source: string): BoardFootprint[] {
  const result: BoardFootprint[] = [];
  for (const footprintBlock of blocks(source, 'footprint', 20_000)) {
    const at = atToken(footprintBlock);
    if (!at) continue;
    const reference = quotedProperty(footprintBlock, 'Reference');
    const pads: BoardPad[] = [];
    for (const padBlock of blocks(footprintBlock, 'pad', 4096)) {
      const number = firstQuotedArg(padBlock, 'pad');
      if (number === undefined) continue;
      const local = atToken(padBlock) ?? { x: 0, y: 0, rotationDeg: 0 };
      const rotated = rotate({ x: local.x, y: local.y }, at.rotationDeg);
      const net = padNet(padBlock);
      pads.push({
        number,
        ...(net.id !== undefined ? { netId: net.id } : {}),
        ...(net.name !== undefined ? { netName: net.name } : {}),
        position: { x: at.x + rotated.x, y: at.y + rotated.y },
        layers: padLayers(padBlock)
      });
      if (pads.length > 4096) throw new Error('KiCad footprint exceeds the 4096-pad optimization bound.');
    }
    result.push({
      reference,
      position: { x: at.x, y: at.y },
      rotationDeg: at.rotationDeg,
      locked: /\(locked\b/.test(footprintBlock),
      pads
    });
  }
  return result;
}

function arcLength(start: Point, mid: Point, end: Point): number {
  const ax = start.x; const ay = start.y;
  const bx = mid.x; const by = mid.y;
  const cx = end.x; const cy = end.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) {
    return Math.hypot(bx - ax, by - ay) + Math.hypot(cx - bx, cy - by);
  }
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
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
  const ccw = normalize(a1 - a0);
  const midSweep = normalize(am - a0);
  const sweep = midSweep <= ccw + 1e-9 ? ccw : Math.PI * 2 - ccw;
  return radius * sweep;
}

function routeEvidenceForNet(map: Map<number, RouteEvidence>, id: number): RouteEvidence {
  let value = map.get(id);
  if (!value) {
    value = { trackLengthMm: 0, segmentCount: 0, arcCount: 0, viaCount: 0, layers: new Set<string>() };
    map.set(id, value);
  }
  return value;
}

function parseRouteEvidence(source: string): Map<number, RouteEvidence> {
  const map = new Map<number, RouteEvidence>();
  for (const block of blocks(source, 'segment')) {
    const net = numberToken(block, 'net');
    const start = pointToken(block, 'start');
    const end = pointToken(block, 'end');
    const layer = block.match(/\(layer\s+"([^"]+)"\)/)?.[1];
    if (net === undefined || !start || !end || !layer?.endsWith('.Cu')) continue;
    const evidence = routeEvidenceForNet(map, net);
    evidence.segmentCount += 1;
    evidence.trackLengthMm += Math.hypot(end.x - start.x, end.y - start.y);
    evidence.layers.add(layer);
  }
  for (const block of blocks(source, 'arc')) {
    const net = numberToken(block, 'net');
    const start = pointToken(block, 'start');
    const mid = pointToken(block, 'mid');
    const end = pointToken(block, 'end');
    const layer = block.match(/\(layer\s+"([^"]+)"\)/)?.[1];
    if (net === undefined || !start || !mid || !end || !layer?.endsWith('.Cu')) continue;
    const evidence = routeEvidenceForNet(map, net);
    evidence.arcCount += 1;
    evidence.trackLengthMm += arcLength(start, mid, end);
    evidence.layers.add(layer);
  }
  for (const block of blocks(source, 'via')) {
    const net = numberToken(block, 'net');
    if (net === undefined) continue;
    const evidence = routeEvidenceForNet(map, net);
    evidence.viaCount += 1;
    for (const match of block.matchAll(/"((?:F|B|In\d+)\.Cu)"/g)) {
      if (match[1]) evidence.layers.add(match[1]);
    }
  }
  return map;
}

function euclideanMstLength(points: Point[]): number {
  if (points.length < 2) return 0;
  if (points.length > 1024) throw new Error('KiCad net exceeds the 1024-pad MST optimization bound.');
  const used = new Array(points.length).fill(false);
  const best = new Array(points.length).fill(Number.POSITIVE_INFINITY);
  best[0] = 0;
  let total = 0;
  for (let step = 0; step < points.length; step += 1) {
    let next = -1;
    for (let index = 0; index < points.length; index += 1) {
      if (!used[index] && (next < 0 || best[index]! < best[next]!)) next = index;
    }
    if (next < 0) break;
    used[next] = true;
    total += best[next]!;
    for (let index = 0; index < points.length; index += 1) {
      if (used[index]) continue;
      const distance = Math.hypot(points[index]!.x - points[next]!.x, points[index]!.y - points[next]!.y);
      if (distance < best[index]!) best[index] = distance;
    }
  }
  return total;
}

function hpwl(points: Point[]): number {
  if (points.length < 2) return 0;
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  return (Math.max(...xs) - Math.min(...xs)) + (Math.max(...ys) - Math.min(...ys));
}

function parseSchematicNetlist(source: string) {
  const nets: Array<{ name: string; code?: number; nodes: Array<{ reference: string; pin: string }> }> = [];
  const netSections = blocks(source, 'nets', 8);
  const container = netSections[0] ?? source;
  for (const netBlock of blocks(container, 'net', 50_000)) {
    const name = quotedToken(netBlock, 'name') ?? '';
    const codeRaw = quotedToken(netBlock, 'code');
    const nodes: Array<{ reference: string; pin: string }> = [];
    for (const nodeBlock of blocks(netBlock, 'node', 10_000)) {
      const reference = quotedToken(nodeBlock, 'ref');
      const pin = quotedToken(nodeBlock, 'pin');
      if (reference && pin !== undefined) nodes.push({ reference, pin });
    }
    if (name || nodes.length) {
      nets.push({ name, ...(codeRaw && /^\d+$/.test(codeRaw) ? { code: Number(codeRaw) } : {}), nodes });
    }
  }
  return nets;
}

function snap(value: number, grid: number): number {
  return Math.round(value / grid) * grid;
}

function boundedStep(vector: Point, maxStep: number, grid: number): Point {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 1e-9) return { x: 0, y: 0 };
  const scale = Math.min(1, maxStep / length);
  return {
    x: snap(vector.x * scale, grid),
    y: snap(vector.y * scale, grid)
  };
}

export function analyzeKicadLayoutOptimization(
  input: { board: string; schematicNetlist?: string },
  options: KicadLayoutOptimizationOptions = {}
) {
  if (Buffer.byteLength(input.board, 'utf8') > MAX_SOURCE_BYTES) throw new Error('KiCad board exceeds the 32 MiB optimization limit.');
  if (input.schematicNetlist && Buffer.byteLength(input.schematicNetlist, 'utf8') > MAX_SOURCE_BYTES) {
    throw new Error('KiCad schematic netlist exceeds the 32 MiB optimization limit.');
  }
  const maxDetails = Math.max(1, Math.min(100, options.maxDetails ?? 25));
  const maxPlacementNetPads = Math.max(2, Math.min(128, options.maxPlacementNetPads ?? 24));
  const maxSuggestedStepMm = options.maxSuggestedStepMm ?? 5;
  const placementGridMm = options.placementGridMm ?? 0.5;
  if (!Number.isFinite(maxSuggestedStepMm) || maxSuggestedStepMm <= 0 || maxSuggestedStepMm > 50) {
    throw new Error('maxSuggestedStepMm must be in range >0..50 mm.');
  }
  if (!Number.isFinite(placementGridMm) || placementGridMm <= 0 || placementGridMm > 10) {
    throw new Error('placementGridMm must be in range >0..10 mm.');
  }

  const netNames = boardNetNames(input.board);
  const footprints = parseBoardFootprints(input.board);
  const routes = parseRouteEvidence(input.board);
  const netPads = new Map<number, Array<{ reference?: string; pad: BoardPad }>>();
  for (const footprint of footprints) {
    for (const pad of footprint.pads) {
      if (pad.netId === undefined || pad.netId === 0) continue;
      const list = netPads.get(pad.netId) ?? [];
      list.push({ reference: footprint.reference, pad });
      netPads.set(pad.netId, list);
    }
  }

  const perNet = [...netPads.entries()].map(([id, endpoints]) => {
    const points = endpoints.map(item => item.pad.position);
    const route = routes.get(id);
    const mst = euclideanMstLength(points);
    const length = route?.trackLengthMm ?? 0;
    const uniqueFootprints = new Set(endpoints.map(item => item.reference).filter((value): value is string => Boolean(value)));
    return {
      id,
      name: netNames.get(id) ?? endpoints.find(item => item.pad.netName)?.pad.netName ?? `#${id}`,
      padCount: endpoints.length,
      footprintCount: uniqueFootprints.size,
      hpwlMm: Number(hpwl(points).toFixed(4)),
      euclideanMstMm: Number(mst.toFixed(4)),
      explicitTrackLengthMm: Number(length.toFixed(4)),
      segmentCount: route?.segmentCount ?? 0,
      arcCount: route?.arcCount ?? 0,
      viaCount: route?.viaCount ?? 0,
      copperLayers: [...(route?.layers ?? new Set<string>())].sort(),
      ...(mst > 1e-6 && length > 0 ? { trackToMstRatio: Number((length / mst).toFixed(4)) } : {}),
      noExplicitTrackOrVia: (route?.segmentCount ?? 0) + (route?.arcCount ?? 0) + (route?.viaCount ?? 0) === 0
    };
  });

  const topDetourNets = perNet
    .filter(item => item.trackToMstRatio !== undefined)
    .sort((a, b) => (b.trackToMstRatio ?? 0) - (a.trackToMstRatio ?? 0) || b.explicitTrackLengthMm - a.explicitTrackLengthMm)
    .slice(0, maxDetails);
  const topViaNets = [...perNet]
    .filter(item => item.viaCount > 0)
    .sort((a, b) => b.viaCount - a.viaCount || b.explicitTrackLengthMm - a.explicitTrackLengthMm)
    .slice(0, maxDetails);
  const noExplicitCopper = perNet
    .filter(item => item.noExplicitTrackOrVia && item.padCount > 1)
    .sort((a, b) => b.padCount - a.padCount || a.name.localeCompare(b.name))
    .slice(0, maxDetails);

  const footprintByReference = new Map(footprints.filter(item => item.reference).map(item => [item.reference!, item]));
  const pairWeights = new Map<string, { a: string; b: string; sharedNets: Set<string>; weight: number }>();
  const placementVectors = new Map<string, { x: number; y: number; weight: number; incidentNets: Set<string>; ignoredHighFanout: number }>();

  for (const [id, endpoints] of netPads) {
    const name = netNames.get(id) ?? endpoints.find(item => item.pad.netName)?.pad.netName ?? `#${id}`;
    const refs = [...new Set(endpoints.map(item => item.reference).filter((value): value is string => Boolean(value)))];
    if (endpoints.length > maxPlacementNetPads) {
      for (const ref of refs) {
        const current = placementVectors.get(ref) ?? { x: 0, y: 0, weight: 0, incidentNets: new Set<string>(), ignoredHighFanout: 0 };
        current.ignoredHighFanout += 1;
        placementVectors.set(ref, current);
      }
      continue;
    }
    for (let left = 0; left < refs.length; left += 1) {
      for (let right = left + 1; right < refs.length; right += 1) {
        const a = refs[left]!;
        const b = refs[right]!;
        const key = a.localeCompare(b) <= 0 ? `${a}\u0000${b}` : `${b}\u0000${a}`;
        const current = pairWeights.get(key) ?? { a: a.localeCompare(b) <= 0 ? a : b, b: a.localeCompare(b) <= 0 ? b : a, sharedNets: new Set<string>(), weight: 0 };
        current.sharedNets.add(name);
        current.weight += 1 / Math.max(1, refs.length - 1);
        pairWeights.set(key, current);
      }
    }

    for (const ref of refs) {
      const footprint = footprintByReference.get(ref);
      if (!footprint || footprint.locked) continue;
      const otherPads = endpoints.filter(item => item.reference !== ref);
      if (otherPads.length === 0) continue;
      const centroid = {
        x: otherPads.reduce((sum, item) => sum + item.pad.position.x, 0) / otherPads.length,
        y: otherPads.reduce((sum, item) => sum + item.pad.position.y, 0) / otherPads.length
      };
      const weight = 1 / Math.sqrt(Math.max(1, endpoints.length - 1));
      const current = placementVectors.get(ref) ?? { x: 0, y: 0, weight: 0, incidentNets: new Set<string>(), ignoredHighFanout: 0 };
      current.x += (centroid.x - footprint.position.x) * weight;
      current.y += (centroid.y - footprint.position.y) * weight;
      current.weight += weight;
      current.incidentNets.add(name);
      placementVectors.set(ref, current);
    }
  }

  const placementCandidates = [...placementVectors.entries()]
    .map(([reference, vector]) => {
      const footprint = footprintByReference.get(reference);
      const pull = vector.weight > 0 ? { x: vector.x / vector.weight, y: vector.y / vector.weight } : { x: 0, y: 0 };
      const step = boundedStep(pull, maxSuggestedStepMm, placementGridMm);
      return {
        reference,
        locked: footprint?.locked ?? false,
        incidentNetCount: vector.incidentNets.size,
        ignoredHighFanoutNetCount: vector.ignoredHighFanout,
        pullVectorMm: { x: Number(pull.x.toFixed(4)), y: Number(pull.y.toFixed(4)) },
        pullDistanceMm: Number(Math.hypot(pull.x, pull.y).toFixed(4)),
        suggestedTranslationMm: { x: Number(step.x.toFixed(4)), y: Number(step.y.toFixed(4)) },
        ...(footprint ? {
          currentPositionMm: footprint.position,
          suggestedPositionMm: {
            x: Number((footprint.position.x + step.x).toFixed(4)),
            y: Number((footprint.position.y + step.y).toFixed(4))
          }
        } : {})
      };
    })
    .filter(item => !item.locked && item.pullDistanceMm > placementGridMm / 2)
    .sort((a, b) => b.pullDistanceMm - a.pullDistanceMm || b.incidentNetCount - a.incidentNetCount)
    .slice(0, maxDetails);

  const affinityPairs = [...pairWeights.values()]
    .map(item => ({
      a: item.a,
      b: item.b,
      sharedNetCount: item.sharedNets.size,
      sharedNets: [...item.sharedNets].sort().slice(0, 16),
      weight: Number(item.weight.toFixed(4)),
      ...(footprintByReference.get(item.a) && footprintByReference.get(item.b) ? {
        currentDistanceMm: Number(Math.hypot(
          footprintByReference.get(item.a)!.position.x - footprintByReference.get(item.b)!.position.x,
          footprintByReference.get(item.a)!.position.y - footprintByReference.get(item.b)!.position.y
        ).toFixed(4))
      } : {})
    }))
    .sort((a, b) => b.weight - a.weight || b.sharedNetCount - a.sharedNetCount || a.a.localeCompare(b.a))
    .slice(0, maxDetails);

  let schematicConnectivity: undefined | {
    netCount: number;
    nodeCount: number;
    comparedPins: number;
    matchingPins: number;
    missingBoardPins: Array<{ reference: string; pin: string; schematicNet: string }>;
    netMismatches: Array<{ reference: string; pin: string; schematicNet: string; boardNet: string }>;
  };

  if (input.schematicNetlist) {
    const schematicNets = parseSchematicNetlist(input.schematicNetlist);
    const boardPinMap = new Map<string, string>();
    for (const footprint of footprints) {
      if (!footprint.reference) continue;
      for (const pad of footprint.pads) {
        if (!pad.netName || !pad.number) continue;
        boardPinMap.set(`${footprint.reference}\u0000${pad.number}`, pad.netName);
      }
    }
    const missingBoardPins: Array<{ reference: string; pin: string; schematicNet: string }> = [];
    const netMismatches: Array<{ reference: string; pin: string; schematicNet: string; boardNet: string }> = [];
    let comparedPins = 0;
    let matchingPins = 0;
    for (const net of schematicNets) {
      for (const node of net.nodes) {
        comparedPins += 1;
        const boardNet = boardPinMap.get(`${node.reference}\u0000${node.pin}`);
        if (boardNet === undefined) {
          if (missingBoardPins.length < maxDetails) missingBoardPins.push({ reference: node.reference, pin: node.pin, schematicNet: net.name });
        } else if (boardNet !== net.name) {
          if (netMismatches.length < maxDetails) netMismatches.push({ reference: node.reference, pin: node.pin, schematicNet: net.name, boardNet });
        } else {
          matchingPins += 1;
        }
      }
    }
    schematicConnectivity = {
      netCount: schematicNets.length,
      nodeCount: schematicNets.reduce((sum, net) => sum + net.nodes.length, 0),
      comparedPins,
      matchingPins,
      missingBoardPins,
      netMismatches
    };
  }

  const recommendations: Array<{
    priority: 'high' | 'medium' | 'review';
    code: string;
    message: string;
    count?: number;
    nextTools: string[];
  }> = [];

  if (schematicConnectivity?.netMismatches.length) recommendations.push({
    priority: 'high',
    code: 'schematic-pcb-net-mismatch',
    message: 'Reference/pin connectivity differs between the KiCad schematic netlist and PCB pad net assignments.',
    count: schematicConnectivity.netMismatches.length,
    nextTools: ['kicad_validate', 'kicad_design_review']
  });
  if (schematicConnectivity?.missingBoardPins.length) recommendations.push({
    priority: 'high',
    code: 'schematic-pin-missing-on-board',
    message: 'Some schematic netlist nodes have no matching PCB reference/pad number.',
    count: schematicConnectivity.missingBoardPins.length,
    nextTools: ['kicad_validate', 'kicad_design_review']
  });
  if (topDetourNets.some(item => (item.trackToMstRatio ?? 0) >= 1.5)) recommendations.push({
    priority: 'review',
    code: 'route-detour-candidates',
    message: 'Review nets whose explicit routed copper is substantially longer than the Euclidean pad MST proxy. Zones, tuning and topology constraints can make this intentional.',
    count: topDetourNets.filter(item => (item.trackToMstRatio ?? 0) >= 1.5).length,
    nextTools: ['kicad_ipc_routing_inspect', 'kicad_ipc_track_update']
  });
  if (topViaNets.length) recommendations.push({
    priority: 'review',
    code: 'via-layer-transition-candidates',
    message: 'Review the highest-via nets for avoidable layer transitions before changing geometry.',
    count: topViaNets.length,
    nextTools: ['kicad_ipc_routing_inspect', 'kicad_ipc_via_update', 'kicad_ipc_track_update']
  });
  if (placementCandidates.length) recommendations.push({
    priority: 'review',
    code: 'net-weighted-placement-candidates',
    message: 'Net-weighted pull vectors identify footprints that may reduce connection span if moved. Suggested translations are geometry-only candidates and require collision/mechanical review plus DRC.',
    count: placementCandidates.length,
    nextTools: ['kicad_ipc_board_inspect', 'kicad_ipc_batch_place', 'kicad_design_review']
  });
  if (noExplicitCopper.length) recommendations.push({
    priority: 'medium',
    code: 'nets-without-explicit-copper',
    message: 'Some multi-pad nets have no explicit tracks/arcs/vias. This is evidence only because copper zones may provide connectivity.',
    count: noExplicitCopper.length,
    nextTools: ['kicad_drc', 'kicad_ipc_routing_inspect']
  });

  return {
    schemaVersion: 1,
    sources: {
      board: { sha256: sha256Text(input.board), bytes: Buffer.byteLength(input.board, 'utf8') },
      ...(input.schematicNetlist ? { schematicNetlist: { sha256: sha256Text(input.schematicNetlist), bytes: Buffer.byteLength(input.schematicNetlist, 'utf8') } } : {})
    },
    options: { maxDetails, maxPlacementNetPads, maxSuggestedStepMm, placementGridMm },
    boardConnectivity: {
      footprintCount: footprints.length,
      padCount: footprints.reduce((sum, footprint) => sum + footprint.pads.length, 0),
      connectedPadCount: footprints.reduce((sum, footprint) => sum + footprint.pads.filter(pad => pad.netId !== undefined && pad.netId !== 0).length, 0),
      netCount: perNet.length
    },
    routingEfficiency: {
      comparedNetCount: perNet.filter(item => item.trackToMstRatio !== undefined).length,
      topDetourNets,
      topViaNets,
      noExplicitCopper
    },
    placementOptimization: {
      method: 'net-weighted-centroid-pull',
      geometryOnly: true,
      highFanoutThresholdPads: maxPlacementNetPads,
      maxSuggestedStepMm,
      gridMm: placementGridMm,
      candidates: placementCandidates,
      affinityPairs
    },
    ...(schematicConnectivity ? { schematicConnectivity } : {}),
    recommendations
  };
}
