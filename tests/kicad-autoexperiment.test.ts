import assert from 'node:assert/strict';
import test from 'node:test';
import { runKicadCopyExperiments } from '../src/adapters/engineering/kicad-autoexperiment.js';

const PCB = `(kicad_pcb
  (version 20241229)
  (generator "test")
  (general (thickness 1.6))
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (44 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "")
  (net 1 "/SIG")
  (footprint "Test:R" (layer "F.Cu") (at 10 10)
    (property "Reference" "R1")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "/SIG")))
  (footprint "Test:R" (layer "F.Cu") (at 30 10)
    (property "Reference" "R2")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "/SIG")))
  (gr_rect (start 0 0) (end 40 20) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))
  (embedded_fonts no)
)`;
const BASE = { violations: 0, unconnected: 1, schematicParity: 0, errors: 0 };
const routing = { selectedNets: ['/SIG'], maxOperations: 32 };
const defaultScenario = { id: 'route-1', status: 'review-only' as const, score: 0, proposals: [] };

test('routed copy strictly improves official connectivity; original source stays byte-identical', async () => {
  let seen = '';
  const answer = await runKicadCopyExperiments(PCB, {
    scenarios: [defaultScenario], routing, baseline: BASE,
    validate: async (_, board) => {
      seen = board;
      return { ...BASE, unconnected: board.includes('(segment') ? 0 : 1 };
    }
  });
  assert.equal(answer.selectedCandidateId, 'route-1');
  assert.equal(answer.candidates[0]?.status, 'candidate-accepted');
  assert.ok((answer.candidates[0]?.operationCount ?? 0) > 0);
  assert.ok(seen.includes('(segment'));
  assert.equal(PCB.includes('(segment'), false);
  assert.equal(answer.manufacturingApproved, false);
});

test('official KiCad DRC regressions reject an apparently useful layout', async () => {
  const answer = await runKicadCopyExperiments(PCB, {
    scenarios: [defaultScenario], routing, baseline: BASE,
    validate: async () => ({ ...BASE, unconnected: 0, violations: 2, errors: 2 })
  });
  assert.equal(answer.selectedCandidateId, null);
  assert.equal(answer.candidates[0]?.status, 'candidate-rejected');
  assert.ok(answer.candidates[0]?.reasons.includes('drc-violations-regression'));
});

test('original SHA proof can be enforced by caller before running, while candidate names are bounded', async () => {
  await assert.rejects(() => runKicadCopyExperiments(PCB, {
    scenarios: [{ ...defaultScenario, id: '../outside' }], routing, baseline: BASE, validate: async () => BASE
  }), /Invalid or duplicate/);
});

test('tradeoff and blocked placement variants are not executed without explicit permit', async () => {
  let calls = 0;
  const report = await runKicadCopyExperiments(PCB, {
    scenarios: [
      { id: 'blocked', status: 'blocked', score: 10, proposals: [] },
      { id: 'needs-tradeoff', status: 'tradeoff-review', score: 20, proposals: [] }
    ], routing, baseline: BASE,
    validate: async () => { calls++; return BASE; }
  });
  assert.equal(calls, 0);
  assert.equal(report.selectedCandidateId, null);
  assert.deepEqual(report.candidates.map(x => x.status), ['blocked','tradeoff-review']);
});

test('footprint translations only patch copied candidate and require official DRC improvement', async () => {
  const report = await runKicadCopyExperiments(PCB, {
    scenarios: [{
      id: 'move-R2', status: 'review-only', score: 5,
      proposals: [{ reference: 'R2', from: { x: 30, y: 10 }, to: { x: 27, y: 10 } }]
    }],
    routing: { selectedNets: ['/SIG'], maxOperations: 32 }, baseline: BASE,
    validate: async (_, board) => {
      assert.match(board, /\(property "Reference" "R2"\)/);
      assert.match(board, /\(at 27 10\)/);
      return { ...BASE, unconnected: 0 };
    }
  });
  assert.equal(report.selectedCandidateId, 'move-R2');
  assert.match(PCB, /\(at 30 10\)/);
});

test('no official unconnected improvement means no recommended completed board', async () => {
  const report = await runKicadCopyExperiments(PCB, {
    scenarios: [defaultScenario], routing, baseline: BASE,
    validate: async () => BASE
  });
  assert.equal(report.selectedCandidateId, null);
  assert.ok(report.candidates[0]?.reasons.includes('no-official-connectivity-improvement'));
});

test('invalid DRC counts fail closed and are never accepted', async () => {
  await assert.rejects(() => runKicadCopyExperiments(PCB, {
    scenarios: [defaultScenario], routing, baseline: { ...BASE, unconnected: -1 }, validate: async () => BASE
  }), /Invalid official/);
});
