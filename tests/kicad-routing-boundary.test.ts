import assert from 'node:assert/strict';
import test from 'node:test';
import { buildKicadRoutingBoundary } from '../src/adapters/engineering/kicad-routing-boundary.js';
import { planKicadRoutes } from '../src/adapters/engineering/kicad-route-plan.js';
export const ROUND = `(kicad_pcb (version 20241229) (generator "test")
(layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
(setup (pad_to_mask_clearance 0))
(net 0 "") (net 1 "/SIG")
(footprint "Test:A" (layer "F.Cu") (at 7 7)
 (property "Reference" "J1")
 (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "/SIG")))
(footprint "Test:B" (layer "F.Cu") (at 33 23)
 (property "Reference" "J2")
 (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "/SIG")))
(gr_line (start 6 0) (end 34 0) (layer "Edge.Cuts"))
(gr_arc (start 34 0) (mid 38.242640687 1.757359313) (end 40 6) (layer "Edge.Cuts"))
(gr_line (start 40 6) (end 40 24) (layer "Edge.Cuts"))
(gr_arc (start 40 24) (mid 38.242640687 28.242640687) (end 34 30) (layer "Edge.Cuts"))
(gr_line (start 34 30) (end 6 30) (layer "Edge.Cuts"))
(gr_arc (start 6 30) (mid 1.757359313 28.242640687) (end 0 24) (layer "Edge.Cuts"))
(gr_line (start 0 24) (end 0 6) (layer "Edge.Cuts"))
(gr_arc (start 0 6) (mid 1.757359313 1.757359313) (end 6 0) (layer "Edge.Cuts"))
(embedded_fonts no))`;
test('routing geometry knows exact rounded corners rather than only the bounding box',()=>{
 const b=buildKicadRoutingBoundary(ROUND);
 assert.equal(b.outline.status,'verified-contour');
 assert.equal(b.outline.arcCount,4);
 assert.equal(b.pointAllowed({x:1,y:1},0.15),false,'inside box, outside actual copper board');
 assert.equal(b.pointAllowed({x:7,y:7},0.15),true);
 assert.equal(b.segmentAllowed({x:1,y:1},{x:7,y:7},0.15),false);
 assert.equal(b.segmentAllowed({x:7,y:7},{x:30,y:7},0.15),true);
});
test('bounded two-layer A* checks every new track and via against native Edge.Cuts clearance',()=>{
 const b=buildKicadRoutingBoundary(ROUND);
 const plan=planKicadRoutes(ROUND,{gridMm:0.5,edgeInsetMm:0.25,
   defaultWidthMm:0.25,maxOperations:32,selectedNets:['/SIG']});
 assert.equal(plan.board.nativeOutlineStatus,'verified-contour');
 assert.equal(plan.board.nativeOutlineArcCount,4);
 assert.ok(plan.operationCount>0);
 for(const op of plan.operations){
   if(op.kind==='segment')assert.equal(b.segmentAllowed(op.start,op.end,0.25+op.widthMm/2),true);
   else assert.equal(b.pointAllowed(op.position,0.25+op.diameterMm/2),true);
 }
});
test('routing refuses open and unknown contours even when their rectangular envelope looks valid',()=>{
 const src=ROUND.replace('(gr_arc (start 0 6) (mid 1.757359313 1.757359313) (end 6 0) (layer "Edge.Cuts"))','');
 assert.throws(()=>planKicadRoutes(src,{selectedNets:['/SIG']}),/verified native Edge.Cuts/);
});
test('routing capsule detects an entire copper segment crossing a concave board notch',()=>{
 const shape=`(kicad_pcb
 (gr_line (start 0 0) (end 40 0) (layer "Edge.Cuts"))
 (gr_line (start 40 0) (end 40 30) (layer "Edge.Cuts"))
 (gr_line (start 40 30) (end 25 30) (layer "Edge.Cuts"))
 (gr_line (start 25 30) (end 25 15) (layer "Edge.Cuts"))
 (gr_line (start 25 15) (end 15 15) (layer "Edge.Cuts"))
 (gr_line (start 15 15) (end 15 30) (layer "Edge.Cuts"))
 (gr_line (start 15 30) (end 0 30) (layer "Edge.Cuts"))
 (gr_line (start 0 30) (end 0 0) (layer "Edge.Cuts")))`;
 const boundary=buildKicadRoutingBoundary(shape);
 assert.equal(boundary.pointAllowed({x:8,y:25},0.25),true);
 assert.equal(boundary.pointAllowed({x:32,y:25},0.25),true);
 assert.equal(boundary.segmentAllowed({x:8,y:25},{x:32,y:25},0.25),false);
});

test('A* actually routes around a concave board notch instead of crossing an absent piece of PCB',()=>{
 const source=`(kicad_pcb (version 20241229) (generator "test")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0)) (net 0 "") (net 1 "/SIG")
  (footprint "Test:A" (layer "F.Cu") (at 8 25) (property "Reference" "J1")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "/SIG")))
  (footprint "Test:B" (layer "F.Cu") (at 32 25) (property "Reference" "J2")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "/SIG")))
  (gr_line (start 0 0) (end 40 0) (layer "Edge.Cuts"))
  (gr_line (start 40 0) (end 40 30) (layer "Edge.Cuts"))
  (gr_line (start 40 30) (end 25 30) (layer "Edge.Cuts"))
  (gr_line (start 25 30) (end 25 15) (layer "Edge.Cuts"))
  (gr_line (start 25 15) (end 15 15) (layer "Edge.Cuts"))
  (gr_line (start 15 15) (end 15 30) (layer "Edge.Cuts"))
  (gr_line (start 15 30) (end 0 30) (layer "Edge.Cuts"))
  (gr_line (start 0 30) (end 0 0) (layer "Edge.Cuts"))
  (embedded_fonts no))`;
 const boundary=buildKicadRoutingBoundary(source);
 const route=planKicadRoutes(source,{
   selectedNets:['/SIG'],gridMm:0.5,maxOperations:128,
   edgeInsetMm:0.25,defaultWidthMm:0.2,defaultClearanceMm:0.2
 });
 assert.ok(route.operationCount>0);
 assert.ok(route.operations.some(op=>op.kind==='segment'&&Math.min(op.start.y,op.end.y)<15),
   'route must turn around top of the 15mm deep slot');
 for(const op of route.operations){
   if(op.kind==='segment')assert.equal(boundary.segmentAllowed(op.start,op.end,0.25+op.widthMm/2),true);
   else assert.equal(boundary.pointAllowed(op.position,0.25+op.diameterMm/2),true);
 }
});
