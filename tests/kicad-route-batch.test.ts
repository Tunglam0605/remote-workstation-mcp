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

test('KiCad 10 pcbnew named-net-only files accept typed route batch without inventing numeric IDs', () => {
  const modern=BOARD.replace(/^\s*\(net\s+\d+\s+"[^"]*"\)\s*$/gm,'')
    .replace('  (embedded_fonts no)', [
      '  (footprint "Test:Connector" (layer "F.Cu") (at 10 10)',
      '    (property "Reference" "J1")',
      '    (pad "1" thru_hole circle (at 0 0) (size 1.5 1.5) (drill 0.8)',
      '      (layers "*.Cu" "*.Mask") (net "/SIG")))',
      '  (embedded_fonts no)'
    ].join('\n'));
  const ctx=inspectKicadRoutingContext(modern);
  assert.equal(ctx.nets.get('/SIG'),-1);
  const applied=applyKicadRouteBatch(modern,[
    {kind:'segment',netName:'/SIG',layer:'F.Cu',start:{x:10,y:10},end:{x:20,y:10},widthMm:0.25},
    {kind:'via',netName:'/SIG',position:{x:20,y:10},diameterMm:0.6,drillMm:0.3}
  ]);
  assert.equal(applied.summary.segments,1);
  assert.equal(applied.summary.vias,1);
  assert.match(applied.source,/\(segment[\s\S]*?\(net "\/SIG"\)/);
  assert.match(applied.source,/\(via[\s\S]*?\(net "\/SIG"\)/);
  assert.doesNotMatch(applied.source,/\(net -1\)/);
  assert.throws(
    () => applyKicadRouteBatch(modern,[{kind:'segment',netName:'/MISSING',layer:'F.Cu',start:{x:10,y:10},end:{x:20,y:10},widthMm:0.25}]),
    /unknown net/
  );
});

test('KiCad 10 layer numbers and CRLF indentation correctly expose both F.Cu and B.Cu', () => {
  const board=BOARD.replace('(31 "B.Cu" signal)', '(2 "B.Cu" signal)')
    .replaceAll('\n','\r\n')
    .replace('(net 1 "/SIG")','(net 1 "/SIG")');
  const context=inspectKicadRoutingContext(board);
  assert.deepEqual([...context.copperLayers].sort(), ['B.Cu','F.Cu','In1.Cu']);
  const applied=applyKicadRouteBatch(board,[
    {kind:'segment',netName:'/SIG',layer:'B.Cu',start:{x:12,y:10},end:{x:20,y:10},widthMm:0.25},
    {kind:'via',netName:'/SIG',position:{x:20,y:10},diameterMm:0.6,drillMm:0.3,layers:['F.Cu','B.Cu']}
  ]);
  assert.equal(applied.summary.vias,1);
  assert.equal(applied.summary.segments,1);
});
