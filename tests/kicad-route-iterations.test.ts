import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseKiCadRouteTargets, isProtectedPowerNet, listUnconnectedNetsFromKiCadReport, runKicadIterativeRouteTrials
} from '../src/adapters/engineering/kicad-route-iterations.js';

const BOARD=`(kicad_pcb
(version 20241229) (generator "test") (general (thickness 1.6))
(layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
(setup (pad_to_mask_clearance 0))
(net 0 "") (net 1 "/SIG") (net 2 "/AUX")
(footprint "Test:R" (layer "F.Cu") (at 10 10)
 (property "Reference" "R1")
 (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "/SIG")))
(footprint "Test:R" (layer "F.Cu") (at 30 10)
 (property "Reference" "R2")
 (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "/SIG")))
(footprint "Test:R" (layer "F.Cu") (at 10 30)
 (property "Reference" "R3")
 (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 2 "/AUX")))
(footprint "Test:R" (layer "F.Cu") (at 30 30)
 (property "Reference" "R4")
 (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 2 "/AUX")))
(gr_rect (start 0 0) (end 40 40) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))
(embedded_fonts no))`;

test('KiCad DRC item descriptions identify unconnected nets only with agreeing pad labels',()=>{
  const nets=listUnconnectedNetsFromKiCadReport({violations:[
    {type:'unconnected_items',items:[{description:'Pad 1 [/AUX] of R1'},{description:'PTH pad 3 [/AUX] of J1'}]},
    {type:'unconnected_items',items:[{description:'Pad 1 [/SIG] of R2'},{description:'Pad 1 [/SIG] of R4'}]},
    {type:'unconnected_items',items:[{description:'Pad 2 [/SIG] of R3'},{description:'Pad 1 [/AUX] of R3'}]},
    {type:'lib_footprint_issues',items:[{description:'Pad 1 [/FAKE]'},{description:'Pad 2 [/FAKE]'}]}
  ]});
  assert.deepEqual(nets,['/AUX','/SIG']);
});
test('high-current and return nets require explicit opt-in in auto-selection',()=>{
  assert.equal(isProtectedPowerNet('/GND'),true);
  assert.equal(isProtectedPowerNet('/EFUSE_RTN'),true);
  assert.equal(isProtectedPowerNet('/VIN_PROTECTED'),true);
  assert.equal(isProtectedPowerNet('/BUCK_5V'),true);
  assert.equal(isProtectedPowerNet('/3V3'),true);
  assert.equal(isProtectedPowerNet('/IOREF'),true);
  assert.equal(isProtectedPowerNet('/USB_5V'),true);
  assert.equal(isProtectedPowerNet('/D38'),false);
  assert.equal(isProtectedPowerNet('/A8'),false);
  const options={selectedNets:['/GND','/EFUSE_RTN','/A8','/D2']};
  assert.deepEqual(chooseKiCadRouteTargets(['/GND','/A8','/EFUSE_RTN','/D2'],options,{
    autoSelectUnconnected:true,maxNetsPerRound:5
  },new Set()),['/A8','/D2']);
  assert.deepEqual(chooseKiCadRouteTargets(['/GND','/A8'],options,{
    autoSelectUnconnected:true,includePowerNets:true
  },new Set()),['/A8','/GND']);
});
test('two official DRC-backed rounds route different nets, preserving all previously accepted copper',async()=>{
  const baseline={violations:0,unconnected:2,schematicParity:0,errors:2,unconnectedNetNames:['/SIG','/AUX']};
  const result=await runKicadIterativeRouteTrials({
    board:BOARD,baseline,routing:{maxOperations:16},
    policy:{maxRounds:3,maxNetsPerRound:1,autoSelectUnconnected:true},
    validate:async (board)=>{
      const aux=board.includes('(segment') && /\(net 2\)/.test(board.slice(board.indexOf('(segment')));
      const sig=board.includes('(segment') && /\(net 1\)/.test(board.slice(board.indexOf('(segment')));
      const unconnected=2-Number(aux)-Number(sig);
      return {violations:0,unconnected,schematicParity:0,errors:unconnected,
        unconnectedNetNames:['/SIG','/AUX'].filter(name=>name==='/SIG'?!sig:!aux)};
    }
  });
  assert.equal(result.improved,true);
  assert.equal(result.drc.unconnected,0);
  assert.equal(result.roundsAttempted,2);
  assert.deepEqual(result.attempts.map(x=>x.status),['accepted','accepted']);
  assert.ok(result.totalOperations>=2);
  assert.equal(BOARD.includes('(segment'),false);
});
test('a DRC regression rolls back the failing round while next iteration uses untouched routing',async()=>{
  const baseline={violations:0,unconnected:2,schematicParity:0,errors:2,unconnectedNetNames:['/SIG','/AUX']};
  const seen:string[]=[];
  const result=await runKicadIterativeRouteTrials({
    board:BOARD,baseline,routing:{maxOperations:16},
    policy:{maxRounds:2,maxNetsPerRound:1,autoSelectUnconnected:true},
    validate:async (board,round)=>{
      seen.push(board);
      if(round===1)return {...baseline,violations:1,unconnected:1,errors:1};
      const aux=board.includes('(segment') && /\(net 2\)/.test(board.slice(board.indexOf('(segment')));
      const sig=board.includes('(segment') && /\(net 1\)/.test(board.slice(board.indexOf('(segment')));
      assert.equal(aux,false,'first rejected route must never persist to next round');
      assert.equal(sig,true);
      return {...baseline,violations:0,unconnected:1,errors:1,unconnectedNetNames:['/AUX']};
    }
  });
  assert.deepEqual(result.attempts.map(x=>x.status),['rejected','accepted']);
  assert.equal(result.drc.unconnected,1);
  assert.equal(result.totalOperations,result.attempts[1]?.operationCount);
  assert.equal(BOARD.includes('(segment'),false);
  assert.equal(seen.length,2);
});
test('route budget and failed DRC labels fail closed',async()=>{
  await assert.rejects(()=>runKicadIterativeRouteTrials({
    board:BOARD,baseline:{violations:0,unconnected:2,schematicParity:0,errors:2},
    routing:{},policy:{maxRounds:2,autoSelectUnconnected:true},
    validate:async()=>({violations:0,unconnected:0,schematicParity:0,errors:0})
  }),/real KiCad DRC unconnected net names/);
});
