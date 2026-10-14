/**
 * Build a placement-only PCB preview from source authority.
 *
 * This module NEVER writes KiCad files. The host adapter creates a new copy,
 * stages local libraries, and runs independent KiCad DRC / optional parity.
 * Unlike routing autoexperiments, unconnected copper need not improve when
 * moving parts: copper must instead not regress, and the result is for review.
 */
import { analyzeKicadLayoutOptimization, type KicadLayoutOptimizationOptions } from './kicad-layout-optimization.js';
import { patchKicadDocument } from './kicad-edit.js';
import { reanchorMovedPadCopperEndpoints } from './kicad-placement-copper-repair.js';
export interface MechanicalPreviewRequest {
  scenarioId: 'scenario-1' | 'scenario-2' | 'scenario-3';
  placement: KicadLayoutOptimizationOptions;
  repairAttachedTracks?: boolean;
}
export function buildKicadMechanicalPlacementPreview(board: string, request: MechanicalPreviewRequest) {
  if (!request.placement.alignmentGroups?.length) throw Error('Placement preview requires explicit alignmentGroups.');
  const result = analyzeKicadLayoutOptimization({ board }, { ...request.placement, rankScenarios: true });
  if (result.boardMechanicalOutline.status !== 'verified-contour') {
    throw Error('Placement preview requires a single verified native KiCad Edge.Cuts contour.');
  }
  const item = result.rankedPlacement?.rankedScenarios.find(x => x.id === request.scenarioId);
  if (!item) throw Error('Unknown KiCad placement preview scenario.');
  if (item.status !== 'review-only') {
    throw Error('KiCad placement preview scenario is blocked or requires HPWL tradeoff review.');
  }
  if (!item.proposals.length || item.proposals.some(p => p.blockers.length)) {
    throw Error('KiCad placement preview requires one or more unblocked placement moves.');
  }
  const moved = new Set<string>();
  const edits = item.proposals.map(p => {
    const ref = p.reference.toUpperCase();
    if (moved.has(ref)) throw Error('Duplicate placement preview reference: ' + ref);
    moved.add(ref);
    if (Math.hypot(p.to.x-p.from.x,p.to.y-p.from.y)<1e-8) throw Error('Empty movement is not a placement preview.');
    return { kind:'pcb_footprint_move' as const, reference:p.reference, x:p.to.x, y:p.to.y };
  });
  const repairs=request.repairAttachedTracks
    ? reanchorMovedPadCopperEndpoints(board,item.proposals.map(p=>({
      reference:p.reference,from:p.from,to:p.to
    })),3)
    : undefined;
  if (repairs?.holdReasons.length) {
    throw Error('Copper endpoint repair needs manual review: '+repairs.holdReasons.join('; ').slice(0,300));
  }
  const modified=patchKicadDocument(repairs?.source ?? board,edits,'.kicad_pcb').text;
  return {
    modifiedBoard:modified,
    selectedScenarioId:item.id,
    score:item.score,
    proposedMoves:item.proposals.map(p=>({reference:p.reference,from:p.from,to:p.to})),
    ...(repairs ? { copperRepair: {
      adjustedSegments: repairs.adjustedSegments,
      adjustedPadCount: repairs.adjustedPadCount,
      changedNets: repairs.changedNets,
      holdReasons: repairs.holdReasons,
      requiresOfficialDrc: true
    }} : {}),
    geometricEvidence:{
      hpwlBeforeMm:item.metrics.hpwlBeforeMm,
      hpwlAfterMm:item.metrics.hpwlProxyAfterMm,
      hpwlGainMm:item.metrics.hpwlProxyGainMm,
      translationMm:item.metrics.totalMovementMm
    },
    mechanicalEvidence:{
      status:result.boardMechanicalOutline.status,
      bounds:result.boardMechanicalOutline.bounds,
      areaMm2:result.boardMechanicalOutline.areaMm2,
      nativeArcCount:result.boardMechanicalOutline.arcCount,
      minEdgeClearanceMm:request.placement.minEdgeClearanceMm??0
    },
    warning:'Preview only. Neither accepted DRC nor verified 2D courtyard means mating, hot-loop, 3D or manufacturing approval.'
  };
}
