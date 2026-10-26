import assert from 'node:assert/strict';
import test from 'node:test';
import { readKicadBoardOutline, rectWithinBoardOutline } from '../src/adapters/engineering/kicad-board-outline.js';
import { analyzeKicadLayoutOptimization } from '../src/adapters/engineering/kicad-layout-optimization.js';

export const ROUNDED=`(kicad_pcb
  (gr_line (start 20 111) (end 20 -8) (layer "Edge.Cuts"))
  (gr_arc (start 143 111) (mid 141.828427 113.828427) (end 139 115) (layer "Edge.Cuts"))
  (gr_line (start 24 -12) (end 139 -12) (layer "Edge.Cuts"))
  (gr_arc (start 20 -8) (mid 21.171572 -10.828427) (end 24 -12) (layer "Edge.Cuts"))
  (gr_line (start 143 -8) (end 143 111) (layer "Edge.Cuts"))
  (gr_arc (start 139 -12) (mid 141.828427 -10.828427) (end 143 -8) (layer "Edge.Cuts"))
  (gr_line (start 139 115) (end 24 115) (layer "Edge.Cuts"))
  (gr_arc (start 24 115) (mid 21.171572 113.828427) (end 20 111) (layer "Edge.Cuts"))
)`;

test('reads the actual rounded KiCad 123 by 127 outline irrespective of mixed arc/line ordering',()=>{
  const result=readKicadBoardOutline(ROUNDED);
  assert.equal(result.status,'verified-contour');
  assert.equal(result.lineCount,4);
  assert.equal(result.arcCount,4);
  assert.deepEqual(result.bounds,{minX:20,minY:-12,maxX:143,maxY:115});
  assert.ok(result.areaMm2!>15500&&result.areaMm2!<15621);
  assert.ok(result.outlinePoints.length>100);
  assert.equal(rectWithinBoardOutline({minX:20.5,minY:-11.5,maxX:21,minY:-11},result),false);
  assert.equal(rectWithinBoardOutline({minX:25,minY:-8,maxX:27,maxY:-6},result),true);
  assert.equal(rectWithinBoardOutline({minX:25,minY:-8,maxX:27,maxY:-6},result,1),true);
});
test('cuts out forbidden corner placement even though rectangular bounds accept it',()=>{
  const board=ROUNDED.replace(')\n',`)\n`);
  const pcb=board.slice(0,-1)+`
    (footprint "Connector:Test" (layer "F.Cu") (at 23 -11)
      (property "Reference" "J1")
      (fp_rect (start -0.2 -0.2) (end 0.2 0.2) (layer "F.CrtYd")))
    (footprint "Connector:Test" (layer "F.Cu") (at 21 -8)
      (property "Reference" "J2")
      (fp_rect (start -0.2 -0.2) (end 0.2 0.2) (layer "F.CrtYd")))
  )`;
  const out=analyzeKicadLayoutOptimization({board:pcb},{
    alignmentGroups:[{id:'jst',references:['J1','J2'],axis:'row',anchorReference:'J1'}],
    boardBounds:{minX:20,minY:-12,maxX:143,maxY:115},
    maxSuggestedStepMm:5,placementGridMm:0.5,rankScenarios:true
  });
  assert.equal(out.boardMechanicalOutline.status,'verified-contour');
  assert.equal(out.constraintPlacement?.candidates[0]?.status,'blocked');
  assert.ok(out.constraintPlacement?.candidates[0]?.blockers.includes('outside-native-edgecuts'));
  assert.ok(out.rankedPlacement?.rankedScenarios.some(x => x.blockers.some(y => y.includes('outside-native-edgecuts'))));
  assert.equal(out.rankedPlacement?.rankedScenarios.find(x => x.id === 'scenario-3')?.status,'blocked');
});
test('rejects open edge path and incomplete multi-contour boundaries',()=>{
  const open=`(kicad_pcb
    (gr_line (start 0 0) (end 20 0) (layer "Edge.Cuts"))
    (gr_line (start 20 0) (end 20 20) (layer "Edge.Cuts")))`;
  assert.equal(readKicadBoardOutline(open).status,'unsupported');
  const multi=`(kicad_pcb
    (gr_rect (start 0 0) (end 20 20) (layer "Edge.Cuts"))
    (gr_rect (start 5 5) (end 10 10) (layer "Edge.Cuts")))`;
  assert.equal(readKicadBoardOutline(multi).status,'unsupported');
});
test('blocks unknown board cutout primitive instead of trusting a bounding box',()=>{
  const board=`(kicad_pcb (gr_circle (center 12 12) (end 14 12) (layer "Edge.Cuts")))`;
  assert.equal(readKicadBoardOutline(board).status,'unsupported');
  const outline=readKicadBoardOutline(ROUNDED);
  assert.equal(rectWithinBoardOutline({minX:25,minY:-8,maxX:27,maxY:-6},outline,5),false);
});
test('handles rectangle-only native contours and interior slots conservatively',()=>{
  const rect=readKicadBoardOutline('(kicad_pcb (gr_rect (start 0 0) (end 20 10) (layer "Edge.Cuts")))');
  assert.equal(rect.status,'verified-contour');
  assert.equal(rect.areaMm2,200);
  assert.equal(rectWithinBoardOutline({minX:1,minY:1,maxX:3,maxY:3},rect),true);
  assert.equal(rectWithinBoardOutline({minX:-1,minY:1,maxX:3,maxY:3},rect),false);
});

test('rejects self-intersecting but otherwise closed board outlines',()=>{
  const bad=`(kicad_pcb
    (gr_line (start 0 0) (end 5 10) (layer "Edge.Cuts"))
    (gr_line (start 5 10) (end 10 0) (layer "Edge.Cuts"))
    (gr_line (start 10 0) (end 0 7) (layer "Edge.Cuts"))
    (gr_line (start 0 7) (end 10 7) (layer "Edge.Cuts"))
    (gr_line (start 10 7) (end 0 0) (layer "Edge.Cuts")))`;
  const result=readKicadBoardOutline(bad);
  assert.equal(result.status,'unsupported');
});

test('many unrelated graphic primitives do not consume the Edge.Cuts contour limit', () => {
  const silkscreen = Array.from({ length: 512 }, (_, i) =>
    `(gr_line (start ${i} 1) (end ${i} 2) (layer "F.Silkscreen"))`
  ).join('\n');
  const fab = Array.from({ length: 160 }, (_, i) =>
    `(gr_rect (start ${i} 3) (end ${i+1} 4) (layer "F.Fab"))`
  ).join('\n');
  const text = ROUNDED.replace('(kicad_pcb', '(kicad_pcb\n' + silkscreen + '\n' + fab);
  const outline = readKicadBoardOutline(text);
  assert.equal(outline.status, 'verified-contour');
  assert.equal(outline.lineCount, 4);
  assert.equal(outline.arcCount, 4);
});

test('actual Edge.Cuts limit still fails closed above 128 primitives', () => {
  const shapes = Array.from({ length: 129 }, (_, i) =>
    `(gr_line (start ${i} 0) (end ${i+1} 0) (layer "Edge.Cuts"))`
  ).join('\n');
  assert.throws(() => readKicadBoardOutline('(kicad_pcb\n' + shapes + '\n)'), /Too many Edge.Cuts/);
});
