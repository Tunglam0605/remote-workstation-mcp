import assert from 'node:assert/strict';
import test from 'node:test';
import { planConstrainedPlacement } from '../src/adapters/engineering/kicad-placement-constraints.js';
import type { PlacementPart, PlacementConstraintOptions } from '../src/adapters/engineering/kicad-placement-constraints.js';

const parts: PlacementPart[] = [
  { reference: 'J1', position: { x: 10, y: 10 }, locked: false, courtyard: { minX: 8, minY: 8, maxX: 12, maxY: 12 } },
  { reference: 'J2', position: { x: 30, y: 14 }, locked: false, courtyard: { minX: 28, minY: 12, maxX: 32, maxY: 16 } },
  { reference: 'J3', position: { x: 50, y: 18 }, locked: false, courtyard: { minX: 48, minY: 16, maxX: 52, maxY: 20 } }
];
const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
function analyze(opts: PlacementConstraintOptions, list = parts, fixed = new Set<string>()) {
  return planConstrainedPlacement(list, opts, fixed, 20, 0.5);
}

test('constraint engine proposes row alignment while preserving anchor location', () => {
  const output = analyze({ alignmentGroups: [{ id: 'UART', axis: 'row', references: ['J1', 'J2', 'J3'], anchorReference: 'J1' }], boardBounds: bounds });
  assert.equal(output.counts.proposals, 2);
  assert.equal(output.counts.blocked, 0);
  assert.equal(output.candidates[0]?.status, 'review');
  assert.deepEqual(output.candidates[0]?.proposedPositionMm, { x: 30, y: 10 });
  assert.deepEqual(output.candidates[1]?.proposedPositionMm, { x: 50, y: 10 });
  assert.equal(output.candidates.some(x => x.reference === 'J1'), false);
  assert.equal(output.requiresFreshCopperAndMechanicalReview, true);
});

test('spacing rule respects anchor and refuses current courtyard overlaps', () => {
  const output = analyze({ alignmentGroups: [{ id: 'connectors', axis: 'row', references: ['J1', 'J2', 'J3'], pitchMm: 10 }] });
  assert.equal(output.candidates[0]?.targetPositionMm.x, 20);
  assert.equal(output.candidates[1]?.targetPositionMm.x, 30);
  assert.ok(output.candidates[1]?.blockers.includes('courtyard:J2'));
});

test('fixed footprint cannot be moved by alignment group', () => {
  const output = analyze({ alignmentGroups: [{ id: 'motor', axis: 'column', references: ['J1', 'J2'] }] }, parts, new Set(['J2']));
  assert.equal(output.counts.blocked, 1);
  assert.ok(output.candidates[0]?.blockers.includes('fixed-or-locked-footprint'));
});

test('declared keepout blocks candidate despite passing a simple alignment check', () => {
  const output = analyze({
    alignmentGroups: [{ id: 'headers', axis: 'row', references: ['J1', 'J2'] }],
    keepouts: [{ id: 'USB', bounds: { minX: 29, maxX: 31, minY: 9, maxY: 11 } }]
  });
  assert.ok(output.candidates[0]?.blockers.includes('keepout:USB'));
});

test('declared board bounds stop placement beyond the allowed PCB envelope', () => {
  const output = analyze({
    alignmentGroups: [{ id: 'edge', axis: 'row', references: ['J1', 'J2'] }],
    boardBounds: { minX: 0, minY: 0, maxX: 29, maxY: 100 }
  });
  assert.ok(output.candidates[0]?.blockers.includes('outside-declared-board-bounds'));
});

test('missing courtyard geometry fails closed and still shows target for review', () => {
  const output = analyze({ alignmentGroups: [{ id: 'test', axis: 'row', references: ['J1', 'J2'] }] }, [
    parts[0]!, { reference: 'J2', position: { x: 30, y: 14 }, locked: false }
  ]);
  assert.equal(output.candidates[0]?.status, 'blocked');
  assert.ok(output.candidates[0]?.blockers.includes('missing-courtyard-geometry'));
});

test('placement is bounded per step and advertises remaining misalignment', () => {
  const output = planConstrainedPlacement([
    parts[0]!, { reference: 'J2', position: { x: 30, y: 90 }, locked: false, courtyard: { minX: 28, minY: 88, maxX: 32, maxY: 92 } }
  ], { alignmentGroups: [{ id: 'slow', axis: 'row', references: ['J1', 'J2'] }] }, new Set(), 5, 0.5);
  assert.deepEqual(output.candidates[0]?.proposedPositionMm, { x: 30, y: 85 });
  assert.ok((output.candidates[0]?.remainingToTargetMm ?? 0) > 70);
  assert.ok(output.candidates[0]?.reviewNotes.some(x => x.includes('not yet reached')));
});

test('bounded move never exceeds maxStep after coordinate/grid quantization', () => {
  const generated = planConstrainedPlacement([
    parts[0]!, { reference: 'J2', position: { x: 30, y: 86.75 }, locked: false, courtyard: { minX: 28, minY: 84.75, maxX: 32, maxY: 88.75 } }
  ], { alignmentGroups: [{ id: 'top', axis: 'row', references: ['J1', 'J2'] }] }, new Set(), 5, 0.5);
  assert.deepEqual(generated.candidates[0]?.proposedPositionMm, { x: 30, y: 81.75 });
  assert.equal(generated.candidates[0]?.displacementMm, 5);
  assert.ok((generated.candidates[0]?.remainingToTargetMm ?? 0) > 0);

  const tinyStep = planConstrainedPlacement(parts, {
    alignmentGroups: [{ id: 'tiny', axis: 'row', references: ['J1', 'J2'] }]
  }, new Set(), 0.1, 0.5);
  assert.ok(tinyStep.candidates[0]?.blockers.includes('step-too-small-for-placement-grid'));
});

test('invalid references, duplicate group membership and geometry are rejected', () => {
  assert.throws(() => analyze({ alignmentGroups: [{ id: 'bad', axis: 'row', references: ['J1', 'J404'] }] }), /Unknown placement reference/);
  assert.throws(() => analyze({ alignmentGroups: [{ id: 'bad', axis: 'row', references: ['J1', 'J1'] }] }), /Duplicate reference/);
  assert.throws(() => analyze({ alignmentGroups: [
    { id: 'row', axis: 'row', references: ['J1', 'J2'] },
    { id: 'column', axis: 'column', references: ['J2', 'J3'] }
  ] }), /Overlapping placement groups/);
  assert.throws(() => analyze({ keepouts: [{ id: 'broken', bounds: { minX: 10, minY: 0, maxX: 0, maxY: 1 } }] }), /Invalid placement rectangle/);
});
