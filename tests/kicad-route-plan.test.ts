import assert from 'node:assert/strict';
import test from 'node:test';
import { planKicadRoutes } from '../src/adapters/engineering/kicad-route-plan.js';
import { applyKicadRouteBatch } from '../src/adapters/engineering/kicad-route-batch.js';

const BOARD = `(kicad_pcb
  (version 20241229)
  (generator "rwmcp-test")
  (general (thickness 1.6))
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (37 "F.SilkS" user "f.silkscreen")
    (44 "Edge.Cuts" user)
    (31 "F.CrtYd" user "F.Courtyard")
  )
  (setup
    (pad_to_mask_clearance 0)
  )
  (net 0 "")
  (net 1 "/SIG")
  (net 2 "/AUX")
  (footprint "Test:Source"
    (layer "F.Cu")
    (at 5 15 0)
    (property "Reference" "U1")
    (property "Value" "SRC")
    (fp_rect (start -2 -2) (end 2 2) (stroke (width 0.05) (type default)) (fill none) (layer "F.CrtYd"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "/SIG"))
  )
  (footprint "Test:Sink"
    (layer "F.Cu")
    (at 35 15 0)
    (property "Reference" "U2")
    (property "Value" "DST")
    (fp_rect (start -2 -2) (end 2 2) (stroke (width 0.05) (type default)) (fill none) (layer "F.CrtYd"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "/SIG"))
  )
  (footprint "Test:Obstacle"
    (layer "F.Cu")
    (at 20 15 0)
    (property "Reference" "J1")
    (property "Value" "BLOCK")
    (fp_rect (start -4 -5) (end 4 5) (stroke (width 0.05) (type default)) (fill none) (layer "F.CrtYd"))
  )
  (footprint "Test:AuxA"
    (layer "F.Cu")
    (at 8 25 0)
    (property "Reference" "R1")
    (property "Value" "A")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 2 "/AUX"))
  )
  (footprint "Test:AuxB"
    (layer "F.Cu")
    (at 32 25 0)
    (property "Reference" "R2")
    (property "Value" "B")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 2 "/AUX"))
  )
  (gr_rect
    (start 0 0)
    (end 40 30)
    (stroke (width 0.05) (type default))
    (fill none)
    (layer "Edge.Cuts")
  )
  (embedded_fonts no)
)
`;


const PAD_CLEARANCE_BOARD = `(kicad_pcb
  (version 20241229)
  (generator "rwmcp-test")
  (general (thickness 1.6))
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (44 "Edge.Cuts" user)
  )
  (setup (pad_to_mask_clearance 0))
  (net 0 "")
  (net 1 "/B_P")
  (net 2 "/B_N")
  (footprint "Resistor_SMD:R_0603_1608Metric"
    (layer "F.Cu")
    (at 91.5 78.5)
    (property "Reference" "R3")
    (property "Value" "1k")
    (pad "1" smd roundrect (at -0.825 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "/B_P"))
    (pad "2" smd roundrect (at 0.825 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (net 2 "/B_N"))
  )
  (footprint "Resistor_SMD:R_0603_1608Metric"
    (layer "F.Cu")
    (at 100 87)
    (property "Reference" "R4")
    (property "Value" "1k")
    (pad "1" smd roundrect (at -0.825 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "/B_P"))
    (pad "2" smd roundrect (at 0.825 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (net 2 "/B_N"))
  )
  (gr_rect
    (start 80 70)
    (end 110 100)
    (stroke (width 0.05) (type default))
    (fill none)
    (layer "Edge.Cuts")
  )
)`;

function segmentIntersectsRect(
  op: { start:{x:number;y:number}; end:{x:number;y:number} },
  rect: { minX:number; minY:number; maxX:number; maxY:number }
): boolean {
  let t0=0,t1=1;
  const dx=op.end.x-op.start.x,dy=op.end.y-op.start.y;
  for(const [p,q] of [[-dx,op.start.x-rect.minX],[dx,rect.maxX-op.start.x],[-dy,op.start.y-rect.minY],[dy,rect.maxY-op.start.y]] as const){
    if(Math.abs(p)<1e-12){if(q<0)return false;continue;}
    const t=q/p;
    if(p<0)t0=Math.max(t0,t);else t1=Math.min(t1,t);
    if(t0>t1)return false;
  }
  return true;
}

function segmentCrossesObstacle(op: { start:{x:number;y:number}; end:{x:number;y:number} }): boolean {
  // Obstacle courtyard is x=16..24, y=10..20. A straight orthogonal segment crosses
  // it only if its fixed coordinate lies inside the range and its span overlaps.
  if (Math.abs(op.start.y - op.end.y) < 1e-9) {
    const y = op.start.y;
    const minX = Math.min(op.start.x, op.end.x);
    const maxX = Math.max(op.start.x, op.end.x);
    return y >= 10 && y <= 20 && maxX >= 16 && minX <= 24;
  }
  if (Math.abs(op.start.x - op.end.x) < 1e-9) {
    const x = op.start.x;
    const minY = Math.min(op.start.y, op.end.y);
    const maxY = Math.max(op.start.y, op.end.y);
    return x >= 16 && x <= 24 && maxY >= 10 && minY <= 20;
  }
  return false;
}

test('route planner detours around courtyard obstacles and emits batch-applicable operations', () => {
  const planned = planKicadRoutes(BOARD, {
    gridMm: 0.5,
    edgeInsetMm: 0.5,
    defaultWidthMm: 0.25,
    defaultClearanceMm: 0.2,
    viaDiameterMm: 0.6,
    viaDrillMm: 0.3,
    selectedNets: ['/SIG'],
    maxOperations: 256
  });

  assert.equal(planned.nets.routedCount, 1);
  assert.equal(planned.routed[0]?.netName, '/SIG');
  assert.ok(planned.operations.length >= 2);
  assert.equal(planned.execution.tool, 'kicad_route_batch_apply');
  assert.equal(planned.execution.requiresExactBoardSha, true);
  for (const op of planned.operations) {
    if (op.kind === 'segment') assert.equal(segmentCrossesObstacle(op), false, JSON.stringify(op));
  }

  const applied = applyKicadRouteBatch(BOARD, planned.operations);
  assert.ok(applied.summary.segments > 0);
  assert.deepEqual(applied.summary.nets, ['/SIG']);
  assert.match(applied.source, /\(segment/);
});


test('route planner treats sibling pads on a different net as copper obstacles', () => {
  const planned = planKicadRoutes(PAD_CLEARANCE_BOARD, {
    gridMm: 0.5,
    edgeInsetMm: 1,
    defaultWidthMm: 0.3,
    defaultClearanceMm: 0.2,
    viaDiameterMm: 0.7,
    viaDrillMm: 0.35,
    selectedNets: ['/B_N'],
    maxOperations: 128
  });
  assert.equal(planned.routed.length, 1);
  assert.equal(planned.routed[0]?.netName, '/B_N');

  // R4 pad 1 belongs to /B_P. Its 0.9 x 0.95 mm copper envelope is expanded
  // by current-track half-width (0.15 mm) + clearance (0.2 mm).
  const forbidden={minX:98.375,minY:86.175,maxX:99.975,maxY:87.825};
  const fCuSegments=planned.operations.filter((op): op is Extract<(typeof planned.operations)[number],{kind:'segment'}> => op.kind==='segment'&&op.layer==='F.Cu');
  assert.ok(fCuSegments.length>0);
  for(const op of fCuSegments) assert.equal(segmentIntersectsRect(op,forbidden),false,JSON.stringify(op));
});

test('route planner supports unprefixed selected net names and per-net styles', () => {
  const planned = planKicadRoutes(BOARD, {
    gridMm: 1,
    selectedNets: ['AUX'],
    styles: [{ netName: 'AUX', widthMm: 0.5, clearanceMm: 0.3, preferredLayer: 'F.Cu' }]
  });
  assert.equal(planned.routed.length, 1);
  assert.equal(planned.routed[0]?.netName, '/AUX');
  const segments = planned.operations.filter(op => op.kind === 'segment');
  assert.ok(segments.length > 0);
  assert.ok(segments.every(op => op.widthMm === 0.5));
});


test('route planner honors explicit semantic priority before fanout/name ordering', () => {
  const planned = planKicadRoutes(BOARD, {
    gridMm: 0.5,
    styles: [
      { netName: 'SIG', priority: 100 },
      { netName: 'AUX', priority: 700 }
    ]
  });
  assert.ok(planned.routed.length >= 2);
  assert.equal(planned.routed[0]?.netName, '/AUX');
  assert.equal(planned.routed[0]?.priority, 700);
  assert.equal(planned.routed.find(item => item.netName === '/SIG')?.priority, 100);
});

test('route planner skips high-fanout nets instead of pretending to route them', () => {
  const manyPads = Array.from({ length: 5 }, (_, index) =>
    `(footprint "Test:P${index}" (layer "F.Cu") (at ${5 + index * 6} 5) (property "Reference" "P${index}") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "/SIG")))`
  ).join('\n');
  const source = BOARD.replace(/\(footprint "Test:Source"[\s\S]*?\n  \(footprint "Test:Sink"/, manyPads + '\n  (footprint "Test:Sink"');
  const planned = planKicadRoutes(source, { maxPadsPerNet: 3, selectedNets: ['/SIG'] });
  assert.equal(planned.routed.length, 0);
  assert.equal(planned.skipped.some(item => item.netName === '/SIG' && item.reason === 'pad-count-exceeds-3'), true);
});

test('route planner rejects invalid routing layers and oversized grids', () => {
  assert.throws(() => planKicadRoutes(BOARD, { layers: ['F.Cu', 'In9.Cu'] }), /not present/);
  const largeBoard = BOARD.replace('(end 40 30)', '(end 400 300)');
  assert.throws(() => planKicadRoutes(largeBoard, { gridMm: 0.1 }), /grid exceeds/);
});
