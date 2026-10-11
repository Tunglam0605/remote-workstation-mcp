import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateKicadDesignAcceptance } from '../src/adapters/engineering/kicad-acceptance.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function fixture() {
  return {
    files: { schematic: 'board.kicad_sch', board: 'board.kicad_pcb' },
    analysis: {
      sources: {
        schematic: { sha256: HASH_A, bytes: 200 },
        board: { sha256: HASH_B, bytes: 400 }
      },
      schematic: { duplicateReferences: [], missingFootprintAssignments: [] },
      consistency: {
        missingOnBoard: [], boardOnlyDeclared: [], unexpectedOnBoard: [],
        valueMismatches: [], footprintMismatches: [],
        duplicateSchematicReferences: [], duplicateBoardReferences: []
      },
      routing: { netCount: 69, segmentCount: 452, viaCount: 29 },
      models3d: { footprintWithoutModelCount: 1 }
    },
    validation: {
      erc: { report: { counts: { active: { bySeverity: {} } } } },
      drc: { report: { counts: { ignoredChecks: 5, active: { bySeverity: {}, unconnected: 0, schematicParity: 0 } } } }
    }
  };
}

test('clean electrical acceptance retains explicit physical and manufacturing hold', () => {
  const out = evaluateKicadDesignAcceptance(fixture());
  assert.equal(out.electricallyAccepted, true);
  assert.equal(out.manufacturingAccepted, false);
  assert.equal(out.requiresPhysicalReview, true);
  assert.equal(out.decision, 'ELECTRICAL_PASS_PHYSICAL_HOLD');
  assert.equal(out.metrics.netsRouted, 69);
  assert.equal(out.metrics.trackSegments, 452);
  assert.equal(out.metrics.vias, 29);
  assert.equal(out.metrics.missing3dModels, 1);
  assert.equal(out.metrics.ignoredChecks, 5);
  assert.deepEqual(out.source, { schematicSha256: HASH_A, boardSha256: HASH_B });
  assert.match(out.reviewHolds.join('\n'), /polarity/i);
  assert.match(out.reviewHolds.join('\n'), /ignored/i);
});

test('ERC/DRC errors, warnings, missing pads and parity block electrical sign-off', () => {
  const input = fixture();
  input.validation.erc.report.counts.active.bySeverity = { error: 2 } as never;
  input.validation.drc.report.counts.active.bySeverity = { warning: 1 } as never;
  input.validation.drc.report.counts.active.unconnected = 2;
  input.validation.drc.report.counts.active.schematicParity = 1;
  input.analysis.consistency.missingOnBoard.push('J7' as never);
  const out = evaluateKicadDesignAcceptance(input);
  assert.equal(out.electricallyAccepted, false);
  assert.equal(out.decision, 'ELECTRICAL_BLOCKED');
  assert.match(out.blockers.join(' '), /ERC errors: 2/);
  assert.match(out.blockers.join(' '), /DRC warnings: 1/);
  assert.match(out.blockers.join(' '), /Unconnected: 2/);
  assert.match(out.blockers.join(' '), /Schematic parity: 1/);
  assert.match(out.blockers.join(' '), /missingOnBoard: 1/);
});

test('unrouted copper cannot pass even with inaccurate zero DRC output', () => {
  const input = fixture();
  input.analysis.routing.netCount = 0;
  input.analysis.routing.segmentCount = 0;
  const out = evaluateKicadDesignAcceptance(input);
  assert.equal(out.electricallyAccepted, false);
  assert.match(out.blockers.join(' '), /No routed copper/);
});

test('official ERC/DRC proof and both SHA-256 fingerprints are mandatory', () => {
  const input = fixture();
  delete (input as { validation?: unknown }).validation;
  assert.throws(() => evaluateKicadDesignAcceptance(input), /missing official KiCad rule checks/i);
  const noSha = fixture();
  noSha.analysis.sources.board.sha256 = 'stale';
  assert.throws(() => evaluateKicadDesignAcceptance(noSha), /source SHA-256 fingerprints/);
});

test('malformed or truncated metric and comparison evidence fails closed', () => {
  const input = fixture();
  delete (input.analysis.consistency as Record<string, unknown>).valueMismatches;
  assert.throws(() => evaluateKicadDesignAcceptance(input), /missing valueMismatches/);
  const broken = fixture();
  (broken.analysis.routing as Record<string, unknown>).viaCount = -1;
  assert.throws(() => evaluateKicadDesignAcceptance(broken), /invalid vias/);
});
