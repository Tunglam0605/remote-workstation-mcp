import assert from 'node:assert/strict';
import test from 'node:test';
import { buildKicadMechanicalPlacementPreview } from '../src/adapters/engineering/kicad-mechanical-preview.js';
import { runKicadCopyExperiments } from '../src/adapters/engineering/kicad-autoexperiment.js';
import { analyzeKicadLayoutOptimization } from '../src/adapters/engineering/kicad-layout-optimization.js';

const BOARD=`(kicad_pcb (version 20241229) (generator "test")
  (net 1 "/SIG")
  (gr_rect (start 0 0) (end 60 40) (layer "Edge.Cuts"))
  (footprint "Test:Header" (layer "F.Cu") (at 10 10)
    (property "Reference" "J1")
    (fp_rect (start -1 -1) (end 1 1) (layer "F.CrtYd"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "/SIG")))
  (footprint "Test:Header" (layer "F.Cu") (at 30 14)
    (property "Reference" "J2")
    (fp_rect (start -1 -1) (end 1 1) (layer "F.CrtYd"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "/SIG"))))`;
const placement={
  alignmentGroups:[{id:'JST',axis:'row' as const,anchorReference:'J1',references:['J1','J2']}],
  fixedReferences:['J1'],maxSuggestedStepMm:5,placementGridMm:0.5,minEdgeClearanceMm:1,
  maxHpwlRegressionMm:5
};

test('converts a safe constrained preview scenario into a real separate KiCad source PCB',()=>{
  const before=BOARD;
  const proposed=buildKicadMechanicalPlacementPreview(before,{scenarioId:'scenario-3',placement});
  assert.equal(proposed.mechanicalEvidence.status,'verified-contour');
  assert.deepEqual(proposed.proposedMoves.map(x=>x.reference),['J2']);
  assert.ok(proposed.modifiedBoard.includes('(at 30 10)'));
  assert.ok(proposed.modifiedBoard.includes('(at 10 10)'));
  assert.ok(BOARD.includes('(at 30 14)'));
  assert.equal(proposed.geometricEvidence.hpwlGainMm>0,true);
});
test('requires authoritative native Edge.Cuts and never writes unverified geometry',()=>{
  assert.throws(()=>buildKicadMechanicalPlacementPreview(BOARD.replace('(gr_rect (start 0 0) (end 60 40) (layer "Edge.Cuts"))',''),{
    scenarioId:'scenario-3',placement
  }),/verified native KiCad Edge.Cuts/);
});
test('copy-only mechanical preview may keep unconnected count unchanged but never worsen DRC',async()=>{
  const ranked=analyzeKicadLayoutOptimization({board:BOARD},{...placement,rankScenarios:true});
  const scenarios=ranked.rankedPlacement!.rankedScenarios.map(x=>({
    id:x.id,status:x.status,score:x.score,
    proposals:x.proposals.map(p=>({reference:p.reference,from:p.from,to:p.to}))
  }));
  const baseline={violations:0,unconnected:1,schematicParity:0,errors:1};
  const result=await runKicadCopyExperiments(BOARD,{
    scenarios,routing:{},baseline,previewPlacementOnly:true,placementOptions:placement,
    validate:async(_id,source)=>{
      assert.ok(source.includes('(kicad_pcb'));
      return baseline;
    }
  });
  assert.ok(result.selectedCandidateId);
  const selected=result.candidates.find(c=>c.id===result.selectedCandidateId);
  assert.equal(selected?.status,'candidate-accepted');
  assert.equal(selected?.previewOnly,true);
  assert.equal(selected?.candidateDrc?.unconnected,1);
  assert.equal(selected?.operationCount,0);
  assert.equal(result.manufacturingApproved,false);
  assert.equal(BOARD.includes('(at 30 14)'),true);
});
test('preview DRC or parity regressions reject layout even if courtyard/outline are legal',async()=>{
  const ranked=analyzeKicadLayoutOptimization({board:BOARD},{...placement,rankScenarios:true});
  const scenarios=ranked.rankedPlacement!.rankedScenarios.map(x=>({
    id:x.id,status:x.status,score:x.score,
    proposals:x.proposals.map(p=>({reference:p.reference,from:p.from,to:p.to}))
  }));
  const base={violations:0,unconnected:1,schematicParity:0,errors:1};
  const report=await runKicadCopyExperiments(BOARD,{scenarios,routing:{},
    baseline:base,previewPlacementOnly:true,placementOptions:placement,
    validate:async()=>({...base,violations:1})
  });
  assert.equal(report.selectedCandidateId,null);
  assert.ok(report.candidates.every(x=>x.status==='candidate-rejected'));
});
