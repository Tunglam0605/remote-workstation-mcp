import assert from 'node:assert/strict';
import test from 'node:test';
import { reanchorMovedPadCopperEndpoints } from '../src/adapters/engineering/kicad-placement-copper-repair.js';
import { buildKicadMechanicalPlacementPreview } from '../src/adapters/engineering/kicad-mechanical-preview.js';
import { runKicadCopyExperiments } from '../src/adapters/engineering/kicad-autoexperiment.js';
import { analyzeKicadLayoutOptimization } from '../src/adapters/engineering/kicad-layout-optimization.js';

const PCB=`(kicad_pcb
  (version 20241229) (generator "test")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (gr_rect (start 0 0) (end 50 40) (layer "Edge.Cuts"))
  (net 1 "/SIG") (net 2 "/GND")
  (footprint "Test:J1" (layer "F.Cu") (at 10 10)
    (property "Reference" "J1")
    (fp_rect (start -1 -1) (end 1 1) (layer "F.CrtYd"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "/SIG")))
  (footprint "Test:J2" (layer "F.Cu") (at 30 13)
    (property "Reference" "J2")
    (fp_rect (start -1 -1) (end 1 1) (layer "F.CrtYd"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "/SIG")))
  (segment (start 10 10) (end 30 13) (width 0.25) (layer "F.Cu") (net "/SIG"))
  (embedded_fonts no)
)`;
const move={reference:'J2',from:{x:30,y:13},to:{x:30,y:10}};
const placement={alignmentGroups:[{id:'align',references:['J1','J2'],anchorReference:'J1',
  axis:'row' as const}],fixedReferences:['J1'],maxSuggestedStepMm:3,placementGridMm:0.5,
  maxHpwlRegressionMm:10};

test('repairs only the exact same-net track endpoint, never the original source',()=>{
  const r=reanchorMovedPadCopperEndpoints(PCB,[move]);
  assert.equal(r.adjustedSegments,1);
  assert.equal(r.adjustedPadCount,1);
  assert.deepEqual(r.changedNets,['/SIG']);
  assert.deepEqual(r.holdReasons,[]);
  assert.match(r.source,/\(segment \(start 10 10\) \(end 30 10\)/);
  assert.match(PCB,/\(segment \(start 10 10\) \(end 30 13\)/);
  assert.equal(r.requiresOfficialDrc,true);
});

test('fails closed for old footprint origin mismatch and excessive moves',()=>{
  assert.throws(()=>reanchorMovedPadCopperEndpoints(PCB,[{...move,from:{x:30,y:12.9}}]),/origin changed/);
  assert.throws(()=>reanchorMovedPadCopperEndpoints(PCB,[{...move,to:{x:50,y:10}}]),/bounded distance/);
});

test('blocks power-net and locked copper from automatic repair',()=>{
  const gnd=PCB.replaceAll('"/SIG"','"/GND"');
  const r=reanchorMovedPadCopperEndpoints(gnd,[move]);
  assert.ok(r.holdReasons.some(x=>x.includes('power-net-protected')));
  assert.equal(r.source,gnd);
  assert.equal(r.adjustedSegments,0);
  const locked=PCB.replace('(segment (start','(segment locked (start');
  const q=reanchorMovedPadCopperEndpoints(locked,[move]);
  assert.ok(q.holdReasons.some(x=>x.includes('locked-track')));
  assert.equal(q.source,locked);
});

test('rejects ambiguous copper junction and via at pad origin without any partial edit',()=>{
  const branch=PCB.replace('(embedded_fonts no)',
    '(segment (start 30 13) (end 35 15) (width 0.25) (layer "F.Cu") (net "/SIG")) (embedded_fonts no)');
  const b=reanchorMovedPadCopperEndpoints(branch,[move]);
  assert.ok(b.holdReasons.some(x=>x.includes('ambiguous-track-junction')));
  assert.equal(b.source,branch);
  const via=PCB.replace('(embedded_fonts no)',
    '(via (at 30 13) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "/SIG")) (embedded_fonts no)');
  const v=reanchorMovedPadCopperEndpoints(via,[move]);
  assert.ok(v.holdReasons.some(x=>x.includes('via-at-pad-origin')));
  assert.equal(v.source,via);
});
test('copy-only mechanical preview reanchors routed signal, but always requires KiCad DRC',()=>{
  const preview=buildKicadMechanicalPlacementPreview(PCB,{
    scenarioId:'scenario-3',placement,repairAttachedTracks:true
  });
  assert.equal(preview.copperRepair?.adjustedSegments,1);
  assert.match(preview.modifiedBoard,/\(segment \(start 10 10\) \(end 30 10\)/);
  assert.match(preview.modifiedBoard,/\(at 30 10\)/);
  assert.equal(PCB.includes('(at 30 13)'),true);
});
test('acceptance of copper repair is gated by authoritative DRC, not optimizer scoring',async()=>{
  const ranked=analyzeKicadLayoutOptimization({board:PCB},{...placement,rankScenarios:true});
  const scenarios=ranked.rankedPlacement!.rankedScenarios.map(x=>({
    id:x.id,status:x.status,score:x.score,
    proposals:x.proposals.map(p=>({reference:p.reference,from:p.from,to:p.to}))
  }));
  const base={violations:0,unconnected:0,schematicParity:0,errors:0};
  const rejected=await runKicadCopyExperiments(PCB,{
    scenarios,routing:{},baseline:base,previewPlacementOnly:true,repairAttachedTracks:true,placementOptions:placement,
    validate:async()=>({...base,violations:1,errors:1})
  });
  assert.equal(rejected.selectedCandidateId,null);
  assert.equal(rejected.candidates.some(x=>x.status==='candidate-accepted'),false);
  const accepted=await runKicadCopyExperiments(PCB,{
    scenarios,routing:{},baseline:base,previewPlacementOnly:true,repairAttachedTracks:true,placementOptions:placement,
    validate:async(_id,source)=>{
      assert.match(source,/\(segment \(start 10 10\) \(end 30 10\)/);
      return base;
    }
  });
  assert.ok(accepted.selectedCandidateId);
  assert.equal(accepted.candidates.some(x=>x.copperRepair?.adjustedSegments===1),true);
  assert.equal(accepted.manufacturingApproved,false);
});

test('zone fill requires separate refill; never silently adjust copper beside zones',()=>{
  const zoned=PCB.replace('(embedded_fonts no)',
    '(zone (net "/GND") (layer "F.Cu") (hatch edge 0.5)) (embedded_fonts no)');
  assert.throws(()=>reanchorMovedPadCopperEndpoints(zoned,[move]),/zone-refill support/);
  assert.equal(PCB.includes('(zone '),false);
});
test('does not modify tracks passing through a moved pad without an exact same-net endpoint',()=>{
  const withCross=PCB.replace(
    '(segment (start 10 10) (end 30 13) (width 0.25) (layer "F.Cu") (net "/SIG"))',
    '(segment (start 20 13) (end 40 13) (width 0.25) (layer "F.Cu") (net "/SIG"))'
  );
  const r=reanchorMovedPadCopperEndpoints(withCross,[move]);
  assert.equal(r.adjustedSegments,0);
  assert.ok(r.holdReasons.some(x=>x.includes('copper-touch-without-same-net-track-end')));
  assert.equal(r.source,withCross);
});
test('refuses a foreign net track crossing an old pad origin',()=>{
  const shorted=PCB.replace(
    '(segment (start 10 10) (end 30 13) (width 0.25) (layer "F.Cu") (net "/SIG"))',
    '(segment (start 20 13) (end 40 13) (width 0.25) (layer "F.Cu") (net "/GND"))'
  );
  const r=reanchorMovedPadCopperEndpoints(shorted,[move]);
  assert.equal(r.adjustedSegments,0);
  assert.ok(r.holdReasons.some(x=>x.includes('copper-touch-without-same-net-track-end')));
});
