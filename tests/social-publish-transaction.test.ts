import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SocialPublishTransactionStore } from '../src/web/social-publish-transaction.js';

const H='a'.repeat(64), S='b'.repeat(64);

test('social transaction store is deterministic and idempotent per platform/plan', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rwmcp-social-tx-'));
  try {
    const store=new SocialPublishTransactionStore(root);
    const a=await store.ensure({platform:'youtube',planSha256:H,sourceSha256:S,principalId:'p',workSessionId:'w'});
    const b=await store.ensure({platform:'youtube',planSha256:H,sourceSha256:S,principalId:'p',workSessionId:'w2'});
    assert.equal(a.created,true);
    assert.equal(b.created,false);
    assert.equal(a.transaction.id,b.transaction.id);
    assert.equal(b.transaction.createdWorkSessionId,'w');
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('interrupted mutation requires reconciliation instead of blind retry', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rwmcp-social-tx-reconcile-'));
  try {
    const store=new SocialPublishTransactionStore(root);
    const {transaction}=await store.ensure({platform:'youtube',planSha256:H,sourceSha256:S,principalId:'p',workSessionId:'w'});
    const started=await store.startMutation(transaction.id,'upload');
    assert.equal(started.transaction.phase,'upload-applying');
    await assert.rejects(()=>store.startMutation(transaction.id,'upload'),/SOCIAL_TRANSACTION_RECONCILE_REQUIRED/);
    const reconciled=await store.reconcileMutation(transaction.id,'upload','applied',{observedAt:new Date().toISOString(),remoteId:'vid123'});
    assert.equal(reconciled.phase,'uploaded');
    const repeat=await store.startMutation(transaction.id,'upload');
    assert.equal(repeat.alreadyCompleted,true);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('social mutation phase order blocks metadata before upload and advances with bounded evidence', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rwmcp-social-tx-order-'));
  try {
    const store=new SocialPublishTransactionStore(root);
    const {transaction}=await store.ensure({platform:'tiktok',planSha256:H,sourceSha256:S,principalId:'p',workSessionId:'w'});
    await assert.rejects(()=>store.startMutation(transaction.id,'metadata'),/SOCIAL_TRANSACTION_PHASE_ORDER/);
    await store.startMutation(transaction.id,'upload');
    await store.completeMutation(transaction.id,'upload',{observedAt:new Date().toISOString(),note:'upload accepted'});
    await store.startMutation(transaction.id,'metadata');
    const done=await store.completeMutation(transaction.id,'metadata',{observedAt:new Date().toISOString(),fields:['title','description']});
    assert.equal(done.phase,'metadata-applied');
    assert.deepEqual(done.evidence.metadata?.fields,['title','description']);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('not-applied reconciliation rewinds safely for a retry', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rwmcp-social-tx-rewind-'));
  try {
    const store=new SocialPublishTransactionStore(root);
    const {transaction}=await store.ensure({platform:'youtube',planSha256:H,sourceSha256:S,principalId:'p',workSessionId:'w'});
    await store.startMutation(transaction.id,'upload');
    const rewind=await store.reconcileMutation(transaction.id,'upload','not-applied',{observedAt:new Date().toISOString(),note:'remote video absent'});
    assert.equal(rewind.phase,'planned');
    const retry=await store.startMutation(transaction.id,'upload');
    assert.equal(retry.transaction.attempts.upload,2);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
