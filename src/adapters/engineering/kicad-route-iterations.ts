import { applyKicadRouteBatch } from './kicad-route-batch.js';
import { planKicadRoutes, type KicadRoutePlanOptions } from './kicad-route-plan.js';
import type { KicadExperimentDrc } from './kicad-autoexperiment.js';

export interface IterativeRoutePolicy {
  maxRounds?: number;
  maxNetsPerRound?: number;
  autoSelectUnconnected?: boolean;
  includePowerNets?: boolean;
}
export interface IterativeRouteAttempt {
  round: number;
  status: 'accepted' | 'rejected' | 'no-route' | 'failed-validation';
  attemptedNetNames: string[];
  operationCount: number;
  addedStraightTrackLengthMm: number;
  addedViaCount: number;
  beforeUnconnected: number;
  afterUnconnected?: number;
  activeViolations?: number;
  reasons: string[];
}
export interface IterativeRouteInput {
  board: string;
  baseline: KicadExperimentDrc;
  routing: KicadRoutePlanOptions;
  policy?: IterativeRoutePolicy;
  validate: (board: string, round: number) => Promise<KicadExperimentDrc>;
}
/** Return verified official DRC unconnected net names (no inference from raw PCB names). */
export function listUnconnectedNetsFromKiCadReport(report: {
  violations: Array<{ type?: string; description?: string; items?: Array<{ description?: string }> }>;
}): string[] {
  const found = new Set<string>();
  for (const finding of report.violations ?? []) {
    if (finding.type !== 'unconnected_items') continue;
    // Two DRC item descriptions must agree on the same named net.
    const names = (finding.items ?? []).map(item => item.description?.match(/\[([^\]\r\n]{1,128})\]/)?.[1]).filter((x): x is string => Boolean(x));
    if (names.length < 2 || new Set(names).size !== 1) continue;
    found.add(names[0]!);
  }
  return [...found].sort((a,b) => a.localeCompare(b));
}
export function isProtectedPowerNet(name: string): boolean {
  const normalized = name.replace(/^\//, '').toUpperCase();
  return /(^|[_./-])(GND|PGND|AGND|VCC|VDD|VIN|VBUS|VBAT|BUCK|EFUSE|POWER|RTN|IOREF|3V3|5V|12V|24V|SW_?2596|SW)([_./-]|$)/.test(normalized) ||
    /^(?:[+-]?\d+(?:\.\d+)?V\d*|\d+V\d*|5V|3V3|VIN|GND|VCC|VDD)/.test(normalized);
}
export function chooseKiCadRouteTargets(available: string[] | undefined, routing: KicadRoutePlanOptions,
  policy: IterativeRoutePolicy, attempted: Set<string>): string[] {
  const max = policy.maxNetsPerRound ?? 6;
  if (!Number.isInteger(max) || max < 1 || max > 24) throw new Error('maxNetsPerRound must be 1..24.');
  const explicitlySelected = routing.selectedNets;
  const availableSet = available ? new Set(available) : undefined;
  const pool = explicitlySelected?.length ? explicitlySelected : (policy.autoSelectUnconnected ? available ?? [] : []);
  const skipped = new Set(routing.skipNets ?? []);
  const safe = pool.filter(name => {
    if (!/^[^\x00-\x1f]{1,128}$/.test(name) || attempted.has(name) || skipped.has(name)) return false;
    if (availableSet && !availableSet.has(name)) return false;
    // Even explicitly requested power nets need opt-in to route automatically.
    if (policy.includePowerNets !== true && isProtectedPowerNet(name)) return false;
    return true;
  });
  return [...new Set(safe)].sort((a,b) => a.localeCompare(b)).slice(0,max);
}
function assess(before: KicadExperimentDrc, after: KicadExperimentDrc): string[] {
  const problems: string[] = [];
  if (after.violations > before.violations) problems.push('drc-violations-regression');
  if (after.unconnected > before.unconnected) problems.push('unconnected-regression');
  if (after.schematicParity > before.schematicParity) problems.push('schematic-parity-regression');
  // 'errors' includes DRC unconnected items, so allow a decrease only.
  if (after.errors > before.errors) problems.push('drc-errors-regression');
  if (after.unconnected >= before.unconnected) problems.push('no-official-connectivity-improvement');
  for (const v of [after.violations,after.unconnected,after.schematicParity,after.errors]) {
    if (!Number.isSafeInteger(v) || v < 0) problems.push('invalid-official-drc-count');
  }
  return problems;
}

export async function runKicadIterativeRouteTrials(input: IterativeRouteInput) {
  const policy = input.policy ?? {};
  const maxRounds = policy.maxRounds ?? 1;
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 4) throw new Error('maxRounds must be 1..4.');
  if (policy.autoSelectUnconnected && !input.baseline.unconnectedNetNames?.length && !input.routing.selectedNets?.length) {
    throw new Error('Auto-selection needs real KiCad DRC unconnected net names.');
  }
  let currentSource = input.board;
  let currentDrc = input.baseline;
  let roundCount = 0;
  let totalOperations = 0;
  let addedStraightTrackLengthMm = 0;
  let addedViaCount = 0;
  const attempts: IterativeRouteAttempt[] = [];
  const attempted = new Set<string>();
  let complete = false;
  let totalSkipped = 0;
  for (let round = 1; round <= maxRounds; round++) {
    const routing = { ...input.routing };
    let names: string[] = [];
    if (policy.autoSelectUnconnected) {
      names = chooseKiCadRouteTargets(currentDrc.unconnectedNetNames, routing, policy, attempted);
      if (!names.length) break;
      routing.selectedNets = names;
    } else if (routing.selectedNets?.length) {
      names = [...routing.selectedNets];
    } else if (round > 1) {
      // Never run an unconstrained global A* search repeatedly.
      break;
    }
    for (const net of names) attempted.add(net);
    roundCount++;
    const budget = Math.min(64, routing.maxOperations ?? 32);
    const plan = planKicadRoutes(currentSource, { ...routing, maxOperations: budget });
    totalSkipped += plan.nets.skippedCount;
    complete = plan.complete;
    if (!plan.operationCount) {
      attempts.push({ round, status:'no-route', attemptedNetNames:names, operationCount:0,
        addedStraightTrackLengthMm:0, addedViaCount:0,beforeUnconnected:currentDrc.unconnected,
        reasons: plan.skipped.filter(x=>!['not-selected','explicitly-skipped','already-connected'].includes(x.reason)).map(x=>x.reason).slice(0,6) });
      continue;
    }
    const patched = applyKicadRouteBatch(currentSource, plan.operations);
    let measured: KicadExperimentDrc;
    try {
      measured = await input.validate(patched.source, round);
    } catch (err) {
      attempts.push({ round, status:'failed-validation', attemptedNetNames:names,
        operationCount: plan.operationCount,addedStraightTrackLengthMm:patched.summary.totalStraightLengthMm,
        addedViaCount:patched.summary.vias,beforeUnconnected:currentDrc.unconnected,
        reasons: ['validation-failed:'+(err instanceof Error?err.message.slice(0,160):'unknown')] });
      continue;
    }
    const reasons = assess(currentDrc, measured);
    const accepted = reasons.length === 0;
    attempts.push({ round, status:accepted?'accepted':'rejected',attemptedNetNames:names,
      operationCount:plan.operationCount,addedStraightTrackLengthMm:patched.summary.totalStraightLengthMm,
      addedViaCount:patched.summary.vias,beforeUnconnected:currentDrc.unconnected,
      afterUnconnected:measured.unconnected,activeViolations:measured.violations,reasons });
    if (accepted) {
      currentSource = patched.source;
      currentDrc = measured;
      totalOperations += plan.operationCount;
      addedStraightTrackLengthMm += patched.summary.totalStraightLengthMm;
      addedViaCount += patched.summary.vias;
      if (currentDrc.unconnected === 0) break;
    }
  }
  return { board:currentSource, drc:currentDrc, roundsAttempted:roundCount, attempts,
    totalOperations, addedStraightTrackLengthMm:Number(addedStraightTrackLengthMm.toFixed(4)),
    addedViaCount, routeComplete:complete, routingSkippedCount:totalSkipped,
    improved:currentDrc.unconnected < input.baseline.unconnected };
}
