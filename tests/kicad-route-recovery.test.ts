import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverKicadRejectedRouteBatch } from '../src/adapters/engineering/kicad-route-recovery.js';
import { runKicadIterativeRouteTrials } from '../src/adapters/engineering/kicad-route-iterations.js';

const PCB = `(kicad_pcb
  (version 20241229)
  (generator "rwmcp-test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "")
  (net 1 "/SIG")
  (net 2 "/AUX")
  (footprint "Test:A" (layer "F.Cu") (at 6 10)
    (property "Reference" "J1")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "/SIG")))
  (footprint "Test:B" (layer "F.Cu") (at 32 10)
    (property "Reference" "J2")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "/SIG")))
  (footprint "Test:C" (layer "F.Cu") (at 6 30)
    (property "Reference" "J3")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 2 "/AUX")))
  (footprint "Test:D" (layer "F.Cu") (at 32 30)
    (property "Reference" "J4")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 2 "/AUX")))
  (gr_rect (start 0 0) (end 40 40) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))
  (embedded_fonts no))`;
const baseline = {
  violations:0,unconnected:2,schematicParity:0,errors:2,unconnectedNetNames:['/AUX','/SIG']
};
function routed(board: string, netId: number) {
  return new RegExp('\\(segment[\\s\\S]*?\\(net ' + netId + '\\)').test(board);
}
function simulatedDrc(board: string) {
  const sig = routed(board,1);
  const aux = routed(board,2);
  // The /AUX trace fails a rule independent of otherwise sound /SIG.
  const violations = aux ? 1 : 0;
  const unconnected = 2-Number(sig)-Number(aux);
  return {violations,unconnected,errors:unconnected,schematicParity:0,
    unconnectedNetNames:[...(aux?[]:['/AUX']),...(sig?[]:['/SIG'])]};
}

test('recovery isolates one invalid net, keeps the other only after official-DRC validation', async () => {
  const seen: string[] = [];
  const result = await recoverKicadRejectedRouteBatch({
    source:PCB, before:baseline,failedNetNames:['/AUX','/SIG'],
    routing:{gridMm:0.5,maxOperations:24},maxChecks:4,
    validate:async (pcb,id)=>{seen.push(id);return simulatedDrc(pcb);}
  });
  assert.equal(result.improved,true);
  assert.equal(result.drc.unconnected,1);
  assert.equal(result.drc.violations,0);
  assert.equal(routed(result.board,1),true);
  assert.equal(routed(result.board,2),false);
  assert.deepEqual(result.traces.map(t=>t.status),['rejected','accepted']);
  assert.ok(result.traces[0]?.reasons.includes('drc-violations-regression'));
  assert.equal(result.operationCount>0,true);
  assert.equal(result.drcChecks,2);
  assert.deepEqual(seen,['isolate-01','isolate-02']);
  assert.equal(result.manufacturingApproved,false);
  assert.equal(PCB.includes('(segment'),false);
});

test('recovery refuses over-budget validation and never adopts unverified traces', async () => {
  let checks=0;
  const result=await recoverKicadRejectedRouteBatch({
    source:PCB,before:baseline,failedNetNames:['/AUX','/SIG'],
    routing:{gridMm:0.5,maxOperations:24},maxChecks:1,
    validate:async board=>{checks++;return simulatedDrc(board);}
  });
  assert.equal(checks,1);
  assert.equal(result.improved,false);
  assert.equal(result.board,PCB);
  assert.equal(result.operationCount,0);
  assert.equal(result.traces.some(t=>t.status==='blocked-budget'),true);
  await assert.rejects(() => recoverKicadRejectedRouteBatch({
    source:PCB,before:baseline,failedNetNames:['/AUX','/SIG'],
    routing:{},maxChecks:9,validate:async()=>baseline
  }),/maxChecks must be 1..8/);
});

test('integrated round rejects aggregate, recovers the safe subset and does not alter source', async () => {
  const result=await runKicadIterativeRouteTrials({
    board:PCB,baseline,routing:{gridMm:0.5,maxOperations:48},
    policy:{maxRounds:1,maxNetsPerRound:2,autoSelectUnconnected:true,
      recoverRejectedBatches:true,maxRecoveryChecks:4},
    validate:async (board,_round,_id)=>simulatedDrc(board)
  });
  assert.equal(result.improved,true);
  assert.equal(result.drc.unconnected,1);
  assert.equal(result.drc.violations,0);
  assert.equal(result.attempts[0]?.status,'rejected');
  assert.equal(result.attempts[1]?.phase,'recovery');
  assert.deepEqual(result.attempts.slice(1).map(t=>t.status),['rejected','accepted']);
  assert.ok(result.totalOperations>0);
  assert.equal(routed(result.board,1),true);
  assert.equal(routed(result.board,2),false);
});

test('if no separated net passes the official DRC, never claim an accepted board', async () => {
  const result=await runKicadIterativeRouteTrials({
    board:PCB,baseline,routing:{maxOperations:32},
    policy:{maxRounds:1,maxNetsPerRound:2,autoSelectUnconnected:true,
      recoverRejectedBatches:true,maxRecoveryChecks:4},
    validate:async () => ({...baseline,violations:2,unconnected:1,errors:1})
  });
  assert.equal(result.improved,false);
  assert.equal(result.board,PCB);
  assert.equal(result.totalOperations,0);
  assert.ok(result.attempts.every(t=>t.status!=='accepted'));
});
