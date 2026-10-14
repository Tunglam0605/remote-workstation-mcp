import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {KicadSpecctraImportAdapter} from '../src/adapters/engineering/kicad-specctra-import.js';
import {PolicyEngine} from '../src/policy.js';
import {PathGuard} from '../src/security/path-guard.js';
import type {PolicyConfig} from '../src/model.js';

const BOARD='(kicad_pcb (version 20241229) (generator "test"))';
const DSN='(pcb "test" (structure (layer F.Cu (type signal))))';
const SES='(session "test" (routes))';
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const boardName='shield.kicad_pcb';
async function fixture(fn:(opts:{
  root:string;adapter:KicadSpecctraImportAdapter;request:{
    board:string;ses:string;exportManifest:string;outputDir:string;expectedBoardSha256:string;expectedSessionSha256:string;
  };calls:{number:number};
})=>Promise<void>, candidateImproves=true){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rwmcp-ses-import-'));
  try {
    const dir=path.join(root,'design'),exp=path.join(dir,'dsn');
    await fs.mkdir(exp,{recursive:true});
    await fs.writeFile(path.join(dir,boardName),BOARD);
    await fs.writeFile(path.join(exp,boardName),BOARD);
    await fs.writeFile(path.join(exp,'shield.dsn'),DSN);
    await fs.writeFile(path.join(exp,'shield.ses'),SES);
    const proof={schemaVersion:1,sourceSha256:sha(BOARD),sourceBoard:boardName,
      copiedBoard:'dsn/'+boardName,copiedBoardSha256:sha(BOARD),specctraDsn:'dsn/shield.dsn',
      specctraSha256:sha(DSN),sourcePreserved:true};
    await fs.writeFile(path.join(exp,'specctra-export-manifest.json'),JSON.stringify(proof));
    const policy=new PolicyEngine({
      version:1,mode:'workspace',workspaces:[{id:'projects',root,readOnly:false}],
      filesystem:{maxReadBytes:64*1024*1024,maxWriteBytes:64*1024*1024},
      process:{allowExecutables:[],inheritEnv:['PATH','HOME','TEMP','TMP'],maxOutputBytes:256*1024,maxRuntimeMs:60000},
      engineering:{enabled:true,maxCommandRuntimeMs:60000,allowHardwareMutationInWorkspace:false,allowSerialWriteInWorkspace:false}
    } as PolicyConfig);
    const calls={number:0};
    const runner={run:async(_program:string,args:string[])=>{
      calls.number++;
      if(args[1]==='import pcbnew; print(pcbnew.Version())'){
        return{exitCode:0,timedOut:false,stdout:'10.0.6\n',stderr:''};
      }
      const target=args[4] as string;
      if(target)await fs.copyFile(path.join(dir,boardName),target);
      return{exitCode:0,timedOut:false,stderr:'',stdout:JSON.stringify({
        sessionImported:true,nonRoutingFingerprintPreserved:true,
        protectedSupplyCopperPreserved:true,protectedSupplyTrackCount:0,
        kicadVersion:'10.0.6',sourceTracks:0,candidateTracks:1
      })};
    }};
    let drcCalls=0;
    const kicad={drc:async()=>{
      drcCalls++;
      const u=drcCalls===1?5:candidateImproves?4:5;
      return{report:{counts:{active:{violations:0,unconnected:u,schematicParity:0,bySeverity:{error:u}}}}};
    }};
    const adapter=new KicadSpecctraImportAdapter(policy,new PathGuard(policy),runner as never,kicad as never);
    await fn({root,adapter,request:{
      board:boardName,ses:'dsn/shield.ses',exportManifest:'dsn/specctra-export-manifest.json',
      outputDir:'accepted',expectedBoardSha256:sha(BOARD),expectedSessionSha256:sha(SES)
    },calls});
  }finally{await fs.rm(root,{recursive:true,force:true});}
}

test('SES import refuses stale original or SES hash before invoking native KiCad',async()=>{
 await fixture(async({adapter,request,calls})=>{
  await assert.rejects(adapter.importCopy('projects','design',{
    ...request,expectedBoardSha256:'0'.repeat(64)
  }),/source SHA-256 mismatch/);
  await assert.rejects(adapter.importCopy('projects','design',{
    ...request,expectedSessionSha256:'0'.repeat(64)
  }),/session SHA-256 mismatch/);
  assert.equal(calls.number,0);
 });
});
test('SES refuses tampered exported DSN despite matching caller session SHA',async()=>{
 await fixture(async({root,adapter,request,calls})=>{
  await fs.writeFile(path.join(root,'design','dsn','shield.dsn'),DSN+'tamper');
  await assert.rejects(adapter.importCopy('projects','design',request),/DSN or source copy was modified/);
  assert.equal(calls.number,0);
 });
});
test('SES copy import refuses output reuse and traversal without invoking native KiCad',async()=>{
 await fixture(async({root,adapter,request,calls})=>{
  await fs.mkdir(path.join(root,'design','accepted'));
  await assert.rejects(adapter.importCopy('projects','design',request),/already exists/);
  await assert.rejects(adapter.importCopy('projects','design',{
    ...request,outputDir:'../escape'
  }),/Unsafe Specctra/);
  assert.equal(calls.number,0);
 });
});
test('SES candidate is accepted only with official DRC improvement and unchanged source bytes',async()=>{
 await fixture(async({root,adapter,request,calls})=>{
  const report=await adapter.importCopy('projects','design',request);
  assert.equal(report.status,'candidate-accepted');
  assert.equal(report.baseline.unconnected,5);
  assert.equal(report.candidateDrc.unconnected,4);
  assert.equal(report.nonRoutingFingerprintPreserved,true);
  assert.equal(report.protectedSupplyCopperPreserved,true);
  assert.equal(report.manufacturingApproved,false);
  assert.equal(report.sourcePreserved,true);
  assert.equal(report.candidateSha256,sha(BOARD));
  assert.equal(await fs.readFile(path.join(root,'design',boardName),'utf8'),BOARD);
  assert.ok(calls.number>=2);
 },true);
});
test('SES no connectivity improvement is rejected despite a plausible native import response',async()=>{
 await fixture(async({root,adapter,request})=>{
  const report=await adapter.importCopy('projects','design',request);
  assert.equal(report.status,'candidate-rejected');
  assert.ok(report.reasons.includes('no-strict-connectivity-improvement'));
  assert.equal(report.manufacturingApproved,false);
  const mf=JSON.parse(await fs.readFile(path.join(root,'design','accepted','specctra-ses-import-manifest.json'),'utf8'));
  assert.equal(mf.status,'candidate-rejected');
 },false);
});
