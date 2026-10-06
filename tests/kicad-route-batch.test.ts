import assert from 'node:assert/strict';
import test from 'node:test';
import { applyKicadRouteBatch, inspectKicadRoutingContext } from '../src/adapters/engineering/kicad-route-batch.js';

const BOARD=`(kicad_pcb
  (version 20250101)
  (generator pcbnew)
  (general (thickness 1.6))
  (layers
    (0 "F.Cu" signal)
    (2 "In1.Cu" power)
    (31 "B.Cu" signal)
    (36 "B.SilkS" user "b.silkscreen")
    (37 "F.SilkS" user "f.silkscreen")
    (44 "Edge.Cuts" user)
  )
  (setup)
  (net 0 "")
  (net 1 "/SIG")
  (net 2 "/GND")
  (embedded_fonts no)
)`;

test('route batch detects nets/copper layers and emits typed segments/vias',()=>{
  const ctx=inspectKicadRoutingContext(BOARD);
  assert.equal(ctx.nets.get('/SIG'),1);
  assert.deepEqual([...ctx.copperLayers].sort(),['B.Cu','F.Cu','In1.Cu']);
  const out=applyKicadRouteBatch(BOARD,[
    {kind:'segment',netName:'/SIG',layer:'F.Cu',start:{x:10,y:10},end:{x:20,y:10},widthMm:0.25},
    {kind:'via',netName:'/SIG',position:{x:20,y:10},diameterMm:0.6,drillMm:0.3,layers:['F.Cu','B.Cu']}
  ]);
  assert.equal(out.summary.segments,1);
  assert.equal(out.summary.vias,1);
  assert.equal(out.summary.totalStraightLengthMm,10);
  assert.match(out.source,/\(segment[\s\S]*\(net 1\)/);
  assert.match(out.source,/\(via[\s\S]*\(layers "F\.Cu" "B\.Cu"\)[\s\S]*\(net 1\)/);
  assert.equal((out.source.match(/\(embedded_fonts no\)/g)??[]).length,1);
});

test('route batch rejects unknown nets, non-copper layers and invalid vias',()=>{
  assert.throws(()=>applyKicadRouteBatch(BOARD,[{kind:'segment',netName:'/BAD',layer:'F.Cu',start:{x:0,y:0},end:{x:1,y:0},widthMm:0.25}]),/unknown net/);
  assert.throws(()=>applyKicadRouteBatch(BOARD,[{kind:'segment',netName:'/SIG',layer:'F.SilkS',start:{x:0,y:0},end:{x:1,y:0},widthMm:0.25}]),/non-copper/);
  assert.throws(()=>applyKicadRouteBatch(BOARD,[{kind:'via',netName:'/SIG',position:{x:1,y:1},diameterMm:0.3,drillMm:0.3}]),/drillMm/);
});
