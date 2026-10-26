import assert from 'node:assert/strict';
import test from 'node:test';
import { CrossNodeReceiptLedger } from '../src/security/cross-node-receipt-ledger.js';

const intent = {
  grantId: 'ssd-to-win', sourceNodeId: 'ssd', destinationNodeId: 'windows',
  sourceWorkspace: 'src', destinationWorkspace: 'dst', sourcePath: 'exports/source.zip',
  destinationBasePath: 'incoming', destinationFileName: 'source.zip',
  sha256: 'a'.repeat(64), size: 4096, transport: 'relay' as const
};

test('handoff receipt ledger rejects forged receipts and exact-scope mismatches', () => {
  const ledger = new CrossNodeReceiptLedger();
  const verifiedPath = `.rwmcp/transfers/verified/${intent.sha256}-source.zip`;
  assert.throws(() => ledger.assertReceived({ authorization: intent, verifiedPath }), /receipt|provenance/i);
  ledger.recordReceived({ authorization: intent, verifiedPath });
  assert.doesNotThrow(() => ledger.assertReceived({ authorization: intent, verifiedPath }));
  assert.throws(() => ledger.assertReceived({ authorization: { ...intent, grantId: 'attacker' }, verifiedPath }), /receipt|provenance/i);
  assert.throws(() => ledger.assertReceived({ authorization: intent, verifiedPath: 'incoming/forged.zip' }), /receipt|provenance/i);
});

test('handoff receipt ledger expires and clears when the runtime generation changes', () => {
  let now = 1000;
  const ledger = new CrossNodeReceiptLedger({ now: () => now, ttlMs: 3000 });
  const verifiedPath = `.rwmcp/transfers/verified/${intent.sha256}-source.zip`;
  ledger.recordReceived({ authorization: intent, verifiedPath });
  now = 4000;
  assert.throws(() => ledger.assertReceived({ authorization: intent, verifiedPath }), /receipt|expired|provenance/i);
  const nextRuntime = new CrossNodeReceiptLedger();
  assert.throws(() => nextRuntime.assertReceived({ authorization: intent, verifiedPath }), /receipt|provenance/i);
});
