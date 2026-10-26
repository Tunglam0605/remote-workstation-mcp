import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectRoutingTurns, type RoutingSegmentEvidence } from '../src/adapters/engineering/kicad-route-quality.js';

const edge = (netName: string, x1: number, y1: number, x2: number, y2: number, netId=1): RoutingSegmentEvidence =>
  ({ netId, netName, layer: 'F.Cu', start:{x:x1,y:y1},end:{x:x2,y:y2} });

test('Route quality detects 90-degree elbows but does not flag straight collinear joints', () => {
  const result=inspectRoutingTurns([edge('SIG',0,0,10,0),edge('SIG',10,0,10,10),edge('SIG',10,10,20,10)],[]);
  assert.equal(result.rightAngleCount,2);
  assert.equal(result.reversalCount,0);
  assert.equal(result.eligibleJunctions,2);
  assert.equal(result.topCandidates[0]?.netName,'SIG');
  const straight=inspectRoutingTurns([edge('LINE',0,0,10,0),edge('LINE',10,0,20,0)],[]);
  assert.equal(straight.rightAngleCount,0);
  assert.equal(straight.topCandidates.length,0);
});

test('45-degree geometry is recorded separately from 90-degree quality review',()=>{
  const result=inspectRoutingTurns([edge('SIG',0,0,10,0),edge('SIG',10,0,20,10)],[]);
  assert.equal(result.diagonalTurnCount,1);
  assert.equal(result.rightAngleCount,0);
  assert.equal(result.topCandidates.length,0);
});

test('Near reversals are review candidates but not physical DRC findings',()=>{
  const result=inspectRoutingTurns([edge('DETOUR',0,0,10,0),edge('DETOUR',10,0,1,1)],[]);
  assert.equal(result.reversalCount,1);
  assert.equal(result.topCandidates[0]?.reversalCount,1);
});

test('Junctions at via locations are excluded because layer transitions require extra context',()=>{
  const a=[edge('NET',0,0,10,0),edge('NET',10,0,10,10)];
  const via=[{netId:1,layers:['F.Cu','B.Cu'],at:{x:10,y:0}}];
  const result=inspectRoutingTurns(a,via);
  assert.equal(result.rightAngleCount,0);
  assert.equal(result.excludedViaJunctions,1);
});

test('Branches and unrelated nets/layers do not create bogus two-edge elbows',()=>{
  const branches=[edge('PWR',0,0,10,0),edge('PWR',10,0,20,0),edge('PWR',10,0,10,10)];
  const mixed=[edge('NET_B',10,0,10,10,2)];
  const r=inspectRoutingTurns([...branches,...mixed],[]);
  assert.equal(r.branchNodeCount,1);
  assert.equal(r.eligibleJunctions,0);
  assert.equal(r.rightAngleCount,0);
});

test('Candidate sorting is deterministic across multiple nets',()=>{
  const a=[edge('B',0,0,10,0,2),edge('B',10,0,10,10,2),edge('A',0,20,10,20,1),edge('A',10,20,10,30,1)];
  const r=inspectRoutingTurns(a,[],5);
  assert.deepEqual(r.topCandidates.map(n=>n.netName),['A','B']);
});

test('Route junction diagnostics emit exact PCB coordinates and bounded 45-degree chamfer preview', () => {
  const a = [
    { ...edge('/D12',0,0,10,0), widthMm:0.3 },
    { ...edge('/D12',10,0,10,10), widthMm:0.3 }
  ];
  const r = inspectRoutingTurns(a,[]);
  assert.equal(r.topJunctions.length,1);
  const j=r.topJunctions[0]!;
  assert.equal(j.kind,'right-angle');
  assert.deepEqual(j.at,{x:10,y:0});
  assert.equal(j.layer,'F.Cu');
  assert.deepEqual(j.segmentIndices,[0,1]);
  assert.deepEqual(j.chamferPreview?.from,{x:9,y:0});
  assert.deepEqual(j.chamferPreview?.to,{x:10,y:1});
  assert.equal(j.chamferPreview?.estimatedLengthSavingMm,0.5858);
  assert.match(r.methodology,/DRC are not checked/);
});

test('Collinear fragments report precise review points while unequal widths cannot preview chamfers', () => {
  const a = [
    { ...edge('LINE',0,0,10,0), widthMm:0.3 },
    { ...edge('LINE',10,0,20,0), widthMm:0.3 },
    { ...edge('DIFF',0,20,10,20,2), widthMm:0.3 },
    { ...edge('DIFF',10,20,10,30,2), widthMm:0.6 }
  ];
  const r=inspectRoutingTurns(a,[]);
  assert.equal(r.collinearJoinCount,1);
  assert.deepEqual(r.topCollinearJoins[0]?.at,{x:10,y:0});
  assert.equal(r.topJunctions[0]?.kind,'right-angle');
  assert.equal(r.topJunctions[0]?.chamferPreview,undefined);
});

test('Preview candidates exclude corners at vias, branches and arbitrary short stubs', () => {
  const vias=[{netId:1,layers:['F.Cu','B.Cu'],at:{x:1,y:0}}];
  const a=[
    { ...edge('A',0,0,1,0),widthMm:0.3 },
    { ...edge('A',1,0,1,1),widthMm:0.3 },
    { ...edge('B',0,10,0.1,10,2),widthMm:0.3 },
    { ...edge('B',0.1,10,0.1,10.1,2),widthMm:0.3 }
  ];
  const r=inspectRoutingTurns(a,vias);
  assert.equal(r.topJunctions.length,1);
  assert.equal(r.topJunctions[0]?.netName,'B');
  assert.equal(r.topJunctions[0]?.chamferPreview,undefined);
});

test('Ranked junction evidence is bounded and deterministic',()=>{
  const a=[
    { ...edge('Z',0,0,10,0,1),widthMm:0.3 },
    { ...edge('Z',10,0,10,10,1),widthMm:0.3 },
    { ...edge('A',0,20,10,20,2),widthMm:0.3 },
    { ...edge('A',10,20,10,30,2),widthMm:0.3 }
  ];
  const r=inspectRoutingTurns(a,[],1);
  assert.equal(r.rightAngleCount,2);
  assert.equal(r.topJunctions.length,1);
  assert.equal(r.topJunctions[0]?.netName,'A');
});
