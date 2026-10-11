/**
 * Read-only KiCad electrical/design review acceptance gate.
 * Clean ERC/DRC NEVER implies mechanical/connector/fabrication approval.
 */
type Obj = Record<string, unknown>;
function record(value: unknown, label: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('KiCad acceptance evidence is missing ' + label + '.');
  }
  return value as Obj;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error('KiCad acceptance evidence is missing ' + label + '.');
  return value;
}
function quantity(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('KiCad acceptance evidence has invalid ' + label + '.');
  }
  return value;
}
function issue(errors: string[], condition: boolean, label: string): void {
  if (condition) errors.push(label);
}
export interface KicadDesignAcceptance {
  phase: 'electrical-and-design-review';
  electricallyAccepted: boolean;
  manufacturingAccepted: false;
  requiresPhysicalReview: true;
  source: { schematicSha256: string; boardSha256: string };
  metrics: {
    ercErrors: number; ercWarnings: number; drcErrors: number; drcWarnings: number;
    unconnected: number; schematicParity: number; ignoredChecks: number;
    netsRouted: number; trackSegments: number; vias: number; missing3dModels: number;
  };
  blockers: string[];
  reviewHolds: string[];
  decision: 'ELECTRICAL_PASS_PHYSICAL_HOLD' | 'ELECTRICAL_BLOCKED';
}
export function evaluateKicadDesignAcceptance(raw: unknown): KicadDesignAcceptance {
  const review = record(raw, 'design review');
  const analysis = record(review.analysis, 'analysis');
  const sources = record(analysis.sources, 'source fingerprints');
  const schem = record(sources.schematic, 'schematic fingerprint');
  const board = record(sources.board, 'PCB fingerprint');
  const sha = /^[0-9a-f]{64}$/i;
  if (typeof schem.sha256 !== 'string' || !sha.test(schem.sha256) ||
      typeof board.sha256 !== 'string' || !sha.test(board.sha256)) {
    throw new Error('KiCad acceptance requires valid source SHA-256 fingerprints for both schematic and PCB.');
  }
  // Parse-only review must never masquerade as official ERC/DRC acceptance.
  const validation = record(review.validation, 'official KiCad rule checks');
  const ercCounts = record(record(record(validation.erc, 'ERC').report, 'ERC report').counts, 'ERC counts');
  const drcCounts = record(record(record(validation.drc, 'DRC').report, 'DRC report').counts, 'DRC counts');
  const ercActive = record(ercCounts.active, 'active ERC counts');
  const drcActive = record(drcCounts.active, 'active DRC counts');
  const ercSeverity = record(ercActive.bySeverity, 'ERC severity');
  const drcSeverity = record(drcActive.bySeverity, 'DRC severity');
  const ercErrors = quantity(ercSeverity.error ?? 0, 'ERC errors');
  const ercWarnings = quantity(ercSeverity.warning ?? 0, 'ERC warnings');
  const drcErrors = quantity(drcSeverity.error ?? 0, 'DRC errors');
  const drcWarnings = quantity(drcSeverity.warning ?? 0, 'DRC warnings');
  const unconnected = quantity(drcActive.unconnected, 'unconnected copper');
  const schematicParity = quantity(drcActive.schematicParity, 'schematic parity');
  const ignoredChecks = quantity(drcCounts.ignoredChecks ?? 0, 'ignored DRC checks');
  const routing = record(analysis.routing, 'routed copper analysis');
  const netsRouted = quantity(routing.netCount, 'routed nets');
  const trackSegments = quantity(routing.segmentCount, 'copper segments');
  const vias = quantity(routing.viaCount, 'vias');
  const consistency = record(analysis.consistency, 'schematic-to-PCB consistency');
  const schematic = record(analysis.schematic, 'schematic symbol inventory');
  const models = record(analysis.models3d, '3D footprint models');
  const missing3dModels = quantity(models.footprintWithoutModelCount, 'missing 3D models');
  const blockers: string[] = [];
  issue(blockers, ercErrors > 0, 'ERC errors: ' + ercErrors);
  issue(blockers, ercWarnings > 0, 'ERC warnings: ' + ercWarnings);
  issue(blockers, drcErrors > 0, 'DRC errors: ' + drcErrors);
  issue(blockers, drcWarnings > 0, 'DRC warnings: ' + drcWarnings);
  issue(blockers, unconnected > 0, 'Unconnected: ' + unconnected);
  issue(blockers, schematicParity > 0, 'Schematic parity: ' + schematicParity);
  for (const key of [
    'missingOnBoard', 'boardOnlyDeclared', 'unexpectedOnBoard',
    'valueMismatches', 'footprintMismatches',
    'duplicateSchematicReferences', 'duplicateBoardReferences'
  ]) {
    const count = array(consistency[key], key).length;
    issue(blockers, count > 0, key + ': ' + count);
  }
  for (const key of ['missingFootprintAssignments', 'duplicateReferences']) {
    const count = array(schematic[key], key).length;
    issue(blockers, count > 0, key + ': ' + count);
  }
  // An empty copper graph is not proof of a routed PCB.
  issue(blockers, netsRouted === 0 || trackSegments === 0, 'No routed copper evidence on the PCB.');
  const reviewHolds = [
    'Connector polarity, harness clearance, power loading, stack height, mounting and enclosure fit require independent physical sign-off.',
    '3D model declarations do not demonstrate physical assembly or STEP clearance.'
  ];
  if (missing3dModels) reviewHolds.push(missing3dModels + ' footprint(s) have no declared 3D model.');
  if (ignoredChecks) reviewHolds.push(ignoredChecks + ' KiCad DRC checks are ignored; review exclusions before manufacture.');
  return {
    phase: 'electrical-and-design-review',
    electricallyAccepted: blockers.length === 0,
    manufacturingAccepted: false,
    requiresPhysicalReview: true,
    source: { schematicSha256: schem.sha256.toLowerCase(), boardSha256: board.sha256.toLowerCase() },
    metrics: { ercErrors, ercWarnings, drcErrors, drcWarnings, unconnected, schematicParity, ignoredChecks,
      netsRouted, trackSegments, vias, missing3dModels },
    blockers, reviewHolds,
    decision: blockers.length ? 'ELECTRICAL_BLOCKED' : 'ELECTRICAL_PASS_PHYSICAL_HOLD'
  };
}
