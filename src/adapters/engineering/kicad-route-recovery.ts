/**
 * Deterministic bounded diagnostic recovery for failed multi-net PCB route batches.
 *
 * All board changes are in-memory. A new subset becomes the next authority
 * only after the caller validates it using official KiCad DRC on a copy.
 * Neither a failed batch nor an unverified candidate is ever committed.
 */
import { applyKicadRouteBatch } from './kicad-route-batch.js';
import { planKicadRoutes, type KicadRoutePlanOptions } from './kicad-route-plan.js';
import type { KicadExperimentDrc } from './kicad-autoexperiment.js';

export interface KiCadRouteRecoveryTrace {
  trialId: string;
  netNames: string[];
  depth: number;
  status: 'accepted' | 'rejected' | 'no-route' | 'failed-validation' | 'blocked-budget';
  beforeUnconnected: number;
  afterUnconnected?: number;
  drcViolations?: number;
  operationCount: number;
  addedStraightTrackLengthMm: number;
  addedViaCount: number;
  reasons: string[];
}

export interface KicadRouteRecoveryInput {
  source: string;
  before: KicadExperimentDrc;
  failedNetNames: string[];
  routing: KicadRoutePlanOptions;
  maxChecks: number;
  validate: (source: string, trialId: string) => Promise<KicadExperimentDrc>;
}

function drcGate(before: KicadExperimentDrc, next: KicadExperimentDrc): string[] {
  const reasons: string[] = [];
  for (const v of [next.violations, next.errors, next.schematicParity, next.unconnected]) {
    if (!Number.isSafeInteger(v) || v < 0) return ['invalid-drc-result'];
  }
  if (next.violations > before.violations) reasons.push('drc-violations-regression');
  if (next.errors > before.errors) reasons.push('drc-errors-regression');
  if (next.schematicParity > before.schematicParity) reasons.push('schematic-parity-regression');
  if (next.unconnected >= before.unconnected) reasons.push('no-connectivity-improvement');
  return reasons;
}

export async function recoverKicadRejectedRouteBatch(input: KicadRouteRecoveryInput) {
  if (!Number.isInteger(input.maxChecks) || input.maxChecks < 1 || input.maxChecks > 8)
    throw new Error('KiCad recovery maxChecks must be 1..8.');
  const names = [...new Set(input.failedNetNames)];
  if (names.length < 2 || names.length > 24 || names.some(x => !/^[^\u0000-\u001f]{1,128}$/.test(x)))
    throw new Error('KiCad recovery requires 2..24 distinct named nets.');
  let board = input.source;
  let drc = input.before;
  let checks = 0;
  let visited = 0;
  let operationCount = 0;
  let addedStraightTrackLengthMm = 0;
  let addedViaCount = 0;
  const traces: KiCadRouteRecoveryTrace[] = [];
  const split = async (group: string[], depth: number): Promise<void> => {
    if (!group.length || drc.unconnected === 0) return;
    // Limit planning and validation, including groups that yield zero routes.
    visited++;
    if (visited > input.maxChecks * 3 || checks >= input.maxChecks) {
      traces.push({
        trialId: 'budget-' + visited,
        netNames: group, depth, status: 'blocked-budget',
        beforeUnconnected: drc.unconnected, operationCount: 0,
        addedStraightTrackLengthMm: 0, addedViaCount: 0,
        reasons: ['bounded-recovery-budget-exhausted']
      });
      return;
    }
    const trialId = 'isolate-' + String(visited).padStart(2, '0');
    const beforeUnconnected = drc.unconnected;
    let reasons: string[] = [];
    let status: KiCadRouteRecoveryTrace['status'] = 'no-route';
    let afterUnconnected: number | undefined;
    let drcViolations: number | undefined;
    let trialOperations = 0, trialCopper = 0, trialVias = 0;
    try {
      const plan = planKicadRoutes(board, {
        ...input.routing, selectedNets: group,
        maxOperations: Math.min(64, input.routing.maxOperations ?? 32)
      });
      trialOperations = plan.operationCount;
      if (!plan.operationCount) {
        reasons = plan.skipped
          .filter(item => group.includes(item.netName) && item.reason !== 'not-selected')
          .map(item => item.netName + ':' + item.reason).slice(0, 8);
      } else {
        const modified = applyKicadRouteBatch(board, plan.operations);
        trialCopper = modified.summary.totalStraightLengthMm;
        trialVias = modified.summary.vias;
        checks++;
        const measured = await input.validate(modified.source, trialId);
        afterUnconnected = measured.unconnected;
        drcViolations = measured.violations;
        reasons = drcGate(drc, measured);
        status = reasons.length === 0 ? 'accepted' : 'rejected';
        if (status === 'accepted') {
          board = modified.source;
          drc = measured;
          operationCount += trialOperations;
          addedStraightTrackLengthMm += trialCopper;
          addedViaCount += trialVias;
        }
      }
    } catch (error) {
      status = 'failed-validation';
      reasons = ['recovery-error:' + (error instanceof Error ? error.message.slice(0, 180) : 'unknown')];
    }
    traces.push({
      trialId, netNames: group, depth, status, beforeUnconnected,
      ...(afterUnconnected === undefined ? {} : { afterUnconnected }),
      ...(drcViolations === undefined ? {} : { drcViolations }),
      operationCount: trialOperations, addedStraightTrackLengthMm: trialCopper,
      addedViaCount: trialVias, reasons
    });
    // After any non-improving multi-net trial, retry smaller subsets.
    if (status !== 'accepted' && group.length > 1 && checks < input.maxChecks) {
      const midpoint = Math.floor(group.length / 2);
      await split(group.slice(0, midpoint), depth + 1);
      await split(group.slice(midpoint), depth + 1);
    }
  };
  const middle = Math.floor(names.length / 2);
  await split(names.slice(0, middle), 1);
  await split(names.slice(middle), 1);
  return {
    board,
    drc,
    improved: drc.unconnected < input.before.unconnected,
    traces,
    drcChecks: checks,
    operationCount,
    addedStraightTrackLengthMm: Number(addedStraightTrackLengthMm.toFixed(4)),
    addedViaCount,
    manufacturingApproved: false as const
  };
}
