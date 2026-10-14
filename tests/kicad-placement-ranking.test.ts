import assert from 'node:assert/strict';
import test from 'node:test';
import { rankConstrainedPlacementScenarios } from '../src/adapters/engineering/kicad-placement-ranking.js';
import type { PlacementRankingInput } from '../src/adapters/engineering/kicad-placement-ranking.js';

const BASE: PlacementRankingInput = {
  parts: [
    { reference: 'J1', position: { x: 10, y: 10 }, locked: false,
      courtyard: { minX: 8, minY: 8, maxX: 12, maxY: 12 } },
    { reference: 'J2', position: { x: 30, y: 14 }, locked: false,
      courtyard: { minX: 28, minY: 12, maxX: 32, maxY: 16 } },
    { reference: 'J3', position: { x: 50, y: 10 }, locked: false,
      courtyard: { minX: 48, minY: 8, maxX: 52, maxY: 12 } }
  ],
  constraints: {
    alignmentGroups: [{ id: 'IO', axis: 'row', anchorReference: 'J1', references: ['J1', 'J2'] }],
    boardBounds: { minX: 0, minY: 0, maxX: 70, maxY: 50 },
    minCourtyardGapMm: 0.2
  },
  fixedReferences: new Set<string>(['J1']),
  gridMm: 0.5,
  maxStepMm: 4,
  routeBaseline: { trackLengthMm: 151.5, viaCount: 12, segmentCount: 45 },
  terminals: [
    { netName: 'D4', reference: 'J1', position: { x: 10, y: 10 } },
    { netName: 'D4', reference: 'J2', position: { x: 30, y: 14 } },
    { netName: 'D5', reference: 'J3', position: { x: 50, y: 10 } },
    { netName: 'D5', reference: 'J2', position: { x: 30, y: 14 } }
  ]
};

test('ranker evaluates three bounded hypotheses, recommends best reviewed placement', () => {
  const before = JSON.stringify(BASE.parts);
  const report = rankConstrainedPlacementScenarios(BASE);
  assert.equal(report.hypothesisCount, 3);
  assert.equal(report.rankedScenarios.length, 3);
  assert.ok(report.recommendedScenarioId);
  const selected = report.rankedScenarios.find(item => item.id === report.recommendedScenarioId);
  assert.ok(selected);
  assert.equal(selected.status, 'review-only');
  assert.equal(selected.metrics.originalViaCount, 12);
  assert.equal(selected.metrics.originalRoutedTrackLengthMm, 151.5);
  assert.equal(selected.metrics.newlyRoutedTrackLengthKnown, false);
  assert.equal(selected.manufacturingApproved, false);
  assert.equal(selected.rerouteAndOfficialDrcRequired, true);
  assert.ok(selected.metrics.alignmentDistanceAfterMm < selected.metrics.alignmentDistanceBeforeMm);
  assert.ok(selected.metrics.hpwlProxyGainMm > 0);
  assert.equal(JSON.stringify(BASE.parts), before);
  assert.equal(report.evidenceLimits.noCopperOrKiCadDrcOnHypotheses, true);
  assert.deepEqual(report, rankConstrainedPlacementScenarios(BASE));
});

test('ranker rejects all alternatives colliding with a third-party fixed connector', () => {
  const changed: PlacementRankingInput = {
    ...BASE,
    parts: [...BASE.parts.slice(0, 2), {
      reference: 'J3', position: { x: 30, y: 10 }, locked: true,
      courtyard: { minX: 28, minY: 8, maxX: 32, maxY: 12 }
    }]
  };
  const result = rankConstrainedPlacementScenarios(changed);
  assert.equal(result.recommendedScenarioId, null);
  assert.ok(result.rankedScenarios.every(item => item.status === 'blocked'));
  assert.ok(result.rankedScenarios.some(item => item.blockers.some(x => x.includes('courtyard'))));
});

test('ranker never suggests moving the anchor footprint', () => {
  const report = rankConstrainedPlacementScenarios(BASE);
  for (const scenario of report.rankedScenarios) {
    assert.equal(scenario.movedReferences.includes('J1'), false);
    assert.ok(scenario.proposals.every(item => item.reference === 'J2'));
  }
});

test('ranker fails closed when candidate has no courtyard or is locked', () => {
  const parts = [...BASE.parts];
  parts[1] = { reference: 'J2', position: { x: 30, y: 14 }, locked: true };
  const result = rankConstrainedPlacementScenarios({ ...BASE, parts });
  assert.equal(result.recommendedScenarioId, null);
  assert.ok(result.rankedScenarios.every(x => x.status === 'blocked'));
  assert.ok(result.rankedScenarios.every(x => x.blockers.some(b => b.includes('fixed-or-locked-footprint'))));
});

test('ranker rejects unknown net pads and malformed baseline metrics', () => {
  assert.throws(() => rankConstrainedPlacementScenarios({
    ...BASE, terminals: [{ netName: 'MYSTERY', reference: 'Z99', position: { x: 1, y: 1 } }]
  }), /Unknown placement net terminal/);
  assert.throws(() => rankConstrainedPlacementScenarios({
    ...BASE, routeBaseline: { ...BASE.routeBaseline, viaCount: -1 }
  }), /Invalid original-board routing metrics/);
});

test('wirelength regression needs explicit engineering tradeoff approval before recommendation', () => {
  const regression: PlacementRankingInput = {
    ...BASE,
    parts: [...BASE.parts.slice(0, 2), {
      reference: 'J3', position: { x: 50, y: 30 }, locked: false,
      courtyard: { minX: 48, minY: 28, maxX: 52, maxY: 32 }
    }],
    terminals: [
      { netName: 'MOTOR', reference: 'J2', position: { x: 30, y: 14 } },
      { netName: 'MOTOR', reference: 'J3', position: { x: 50, y: 30 } }
    ]
  };
  const guarded = rankConstrainedPlacementScenarios(regression);
  assert.equal(guarded.recommendedScenarioId, null);
  assert.ok(guarded.rankedScenarios.every(item => item.status === 'tradeoff-review'));
  assert.ok(guarded.rankedScenarios.every(item => item.reviewHolds.some(x => x.includes('HPWL'))));
  const manuallyAllowed = rankConstrainedPlacementScenarios({ ...regression, maxHpwlRegressionMm: 10 });
  assert.ok(manuallyAllowed.recommendedScenarioId);
  assert.ok(manuallyAllowed.rankedScenarios.some(item => item.status === 'review-only'));
  assert.equal(manuallyAllowed.evidenceLimits.noCopperOrKiCadDrcOnHypotheses, true);
  assert.throws(() => rankConstrainedPlacementScenarios({ ...regression, maxHpwlRegressionMm: -1 }), /maxHpwlRegressionMm/);
});
