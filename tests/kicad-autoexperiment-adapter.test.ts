import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KicadAdapter } from '../src/adapters/engineering/kicad.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';
import type { PolicyConfig } from '../src/model.js';

const BOARD=`(kicad_pcb
  (version 20241229)
  (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "") (net 1 "/SIG")
  (footprint "Local:R" (layer "F.Cu") (at 10 10)
    (property "Reference" "R1")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "/SIG")))
  (footprint "Local:R" (layer "F.Cu") (at 30 10)
    (property "Reference" "R2")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "/SIG")))
  (gr_rect (start 0 0) (end 40 20) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))
  (embedded_fonts no))`;
function config(root: string): PolicyConfig {
  return {
    version: 1, mode: 'workspace', workspaces: [{ id: 'w', root, readOnly: false }],
    filesystem: { maxReadBytes: 64 * 1024 * 1024, maxWriteBytes: 64 * 1024 * 1024 },
    process: { allowExecutables: [], inheritEnv: ['PATH', 'HOME', 'TEMP', 'TMP'], maxOutputBytes: 256 * 1024, maxRuntimeMs: 60_000 },
    engineering: { enabled: true, maxCommandRuntimeMs: 60_000, allowHardwareMutationInWorkspace: false, allowSerialWriteInWorkspace: false }
  };
}
const sha=(x:string)=>createHash('sha256').update(x).digest('hex');
function report(unconnected: number) {
  return { report: { counts: { active: { violations: 0, unconnected, schematicParity: 0, bySeverity: { error: unconnected } } } } };
}
test('adapter creates a new project-local experiment only, with project libraries and SHA evidence', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rwmcp-isolated-expt-'));
  try {
    const project=path.join(dir,'design'); await fs.mkdir(project);
    await fs.writeFile(path.join(project,'board.kicad_pcb'), BOARD);
    await fs.writeFile(path.join(project,'board.kicad_pro'), '{}');
    await fs.writeFile(path.join(project,'fp-lib-table'), '(fp_lib_table)');
    await fs.mkdir(path.join(project,'Local.pretty'));
    await fs.writeFile(path.join(project,'Local.pretty','R.kicad_mod'), '(footprint "R")');
    const policy=new PolicyEngine(config(dir));
    const adapter=new KicadAdapter(policy,new PathGuard(policy), {run:async()=>{throw Error('unexpected external runner')}} as never);
    (adapter as any).drc=async (_w:string,_p:string,board:string) => {
      if (!board.includes('expt')) return report(1);
      const source=await fs.readFile(path.join(project,board),'utf8');
      return report(source.includes('(segment') ? 0 : 1);
    };
    const result=await adapter.autoexperimentRun('w','design',{
      board:'board.kicad_pcb',expectedBoardSha256:sha(BOARD),outputDir:'expt/run01',
      routing:{selectedNets:['/SIG'],maxOperations:16}
    });
    assert.equal(result.selectedCandidateId,'routing-only');
    assert.equal(result.originalPreserved,true);
    assert.equal(result.manufacturingApproved,false);
    assert.equal(result.candidates[0]?.status,'candidate-accepted');
    const copy=path.join(project,'expt','run01','routing-only');
    assert.ok((await fs.readFile(path.join(copy,'board.kicad_pcb'),'utf8')).includes('(segment'));
    assert.equal(await fs.readFile(path.join(copy,'fp-lib-table'),'utf8'),'(fp_lib_table)');
    assert.equal(await fs.readFile(path.join(copy,'Local.pretty','R.kicad_mod'),'utf8'),'(footprint "R")');
    assert.equal(await fs.readFile(path.join(project,'board.kicad_pcb'),'utf8'),BOARD);
    assert.equal(JSON.parse(await fs.readFile(path.join(project,'expt','run01','experiment-manifest.json'),'utf8')).selectedCandidateId,'routing-only');
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('adapter rejects stale SHA without modifying source or making any experiment folder', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rwmcp-expt-sha-'));
  try {
    await fs.writeFile(path.join(dir,'board.kicad_pcb'),BOARD);
    const policy=new PolicyEngine(config(dir));
    const adapter=new KicadAdapter(policy,new PathGuard(policy),{run:async()=>{throw Error('unexpected')}} as never);
    await assert.rejects(adapter.autoexperimentRun('w','.',{
      board:'board.kicad_pcb',expectedBoardSha256:'f'.repeat(64),outputDir:'out'
    }),/source SHA mismatch/);
    await assert.rejects(fs.stat(path.join(dir,'out')),{code:'ENOENT'});
    assert.equal(await fs.readFile(path.join(dir,'board.kicad_pcb'),'utf8'),BOARD);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

const BISECT_BOARD = `(kicad_pcb
  (version 20241229) (generator "rwmcp-test") (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "") (net 1 "/SIG") (net 2 "/AUX")
  (footprint "Test:A" (layer "F.Cu") (at 6 10) (property "Reference" "J1")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "/SIG")))
  (footprint "Test:B" (layer "F.Cu") (at 32 10) (property "Reference" "J2")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "/SIG")))
  (footprint "Test:C" (layer "F.Cu") (at 6 30) (property "Reference" "J3")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 2 "/AUX")))
  (footprint "Test:D" (layer "F.Cu") (at 32 30) (property "Reference" "J4")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 2 "/AUX")))
  (gr_rect (start 0 0) (end 40 40) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))
  (embedded_fonts no))`;

test('adapter independently revalidates the final recovered PCB and links exactly that file',async()=>{
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'rwmcp-accepted-copper-'));
  try {
    await fs.writeFile(path.join(root,'board.kicad_pcb'),BISECT_BOARD);
    const policy=new PolicyEngine(config(root));
    const adapter=new KicadAdapter(policy,new PathGuard(policy),{run:async()=>{throw Error('unexpected runner')}} as never);
    (adapter as any).drc=async (_w:string,_p:string,file:string)=>{
      const pcb=await fs.readFile(path.join(root,file),'utf8');
      const sig=/\(segment[\s\S]*?\(net 1\)/.test(pcb);
      const aux=/\(segment[\s\S]*?\(net 2\)/.test(pcb);
      const unresolved=[...(aux?[]:['/AUX']),...(sig?[]:['/SIG'])];
      return {report:{
        counts:{active:{violations:Number(aux),unconnected:unresolved.length,
          schematicParity:0,bySeverity:{error:unresolved.length}}},
        violations:unresolved.map(net=>({type:'unconnected_items',items:[
          {description:'Pad 1 ['+net+'] of J1'}, {description:'Pad 1 ['+net+'] of J2'}]}))
      }};
    };
    const result=await adapter.autoexperimentRun('w','.',{
      board:'board.kicad_pcb',expectedBoardSha256:sha(BISECT_BOARD),
      outputDir:'generated/recovery',
      routing:{maxOperations:48,gridMm:0.5},
      iterations:{maxRounds:1,maxNetsPerRound:2,autoSelectUnconnected:true,
        recoverRejectedBatches:true,maxRecoveryChecks:4}
    });
    assert.equal(result.selectedCandidateId,'routing-only');
    const selected=result.candidates.find(x=>x.id===result.selectedCandidateId);
    assert.ok(selected);
    assert.equal(selected.status,'candidate-accepted');
    assert.equal(selected.candidateDrc?.unconnected,1);
    assert.equal(selected.candidateDrc?.violations,0);
    assert.match(selected.candidateBoard??'',/\/accepted\/board\.kicad_pcb$/);
    const exact=await fs.readFile(path.join(root,selected.candidateBoard!),'utf8');
    assert.equal(sha(exact),selected.candidateSha256);
    assert.equal(/\(segment[\s\S]*?\(net 1\)/.test(exact),true);
    assert.equal(/\(segment[\s\S]*?\(net 2\)/.test(exact),false);
    assert.equal(await fs.readFile(path.join(root,'board.kicad_pcb'),'utf8'),BISECT_BOARD);
    const files=JSON.parse(await fs.readFile(path.join(root,'generated/recovery/experiment-manifest.json'),'utf8'));
    assert.equal(files.candidates[0].candidateSha256,sha(exact));
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('final recovered PCB DRC mismatch refuses manifest even if an earlier trial looked good',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rwmcp-recovery-mismatch-'));
  try {
    await fs.writeFile(path.join(root,'board.kicad_pcb'),BISECT_BOARD);
    const policy=new PolicyEngine(config(root));
    const adapter=new KicadAdapter(policy,new PathGuard(policy),{run:async()=>{throw Error('unexpected')}} as never);
    (adapter as any).drc=async (_w:string,_p:string,file:string)=>{
      const content=await fs.readFile(path.join(root,file),'utf8');
      const sig=/\(segment[\s\S]*?\(net 1\)/.test(content);
      const aux=/\(segment[\s\S]*?\(net 2\)/.test(content);
      const unconnected=2-Number(sig)-Number(aux);
      return {report:{counts:{active:{violations: file.includes('accepted')?1:Number(aux),
        unconnected,schematicParity:0,bySeverity:{error:unconnected}}},
        violations:(!sig?['/SIG']:[]).concat(!aux?['/AUX']:[]).map(net=>({
          type:'unconnected_items',items:[{description:'Pad ['+net+'] x'},{description:'Pad ['+net+'] y'}]}))
      }};
    };
    await assert.rejects(adapter.autoexperimentRun('w','.',{
      board:'board.kicad_pcb',expectedBoardSha256:sha(BISECT_BOARD),
      outputDir:'generated/recovery-mismatch',
      iterations:{maxRounds:1,maxNetsPerRound:2,autoSelectUnconnected:true,
        recoverRejectedBatches:true,maxRecoveryChecks:4},routing:{maxOperations:48}
    }),/final-board DRC disagrees/);
    await assert.rejects(fs.stat(path.join(root,'generated/recovery-mismatch/experiment-manifest.json')),{code:'ENOENT'});
    assert.equal(await fs.readFile(path.join(root,'board.kicad_pcb'),'utf8'),BISECT_BOARD);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
