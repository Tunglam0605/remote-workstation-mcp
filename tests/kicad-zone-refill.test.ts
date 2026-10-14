import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {KicadZoneRefillAdapter} from '../src/adapters/engineering/kicad-zone-refill.js';
import {PolicyEngine} from '../src/policy.js';
import {PathGuard} from '../src/security/path-guard.js';
import type {PolicyConfig} from '../src/model.js';

const PCB='(kicad_pcb (version 20241229) (zone (net "/GND") (layer "B.Cu")))';
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
async function fixture(fn:(data:{root:string;adapter:KicadZoneRefillAdapter;
 request:{board:string;outputDir:string;expectedBoardSha256:string};nativeCalls:{count:number}})=>Promise<void>,
 newCount=4) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rwmcp-zone-fill-test-'));
 try{
  await fs.mkdir(path.join(root,'design'));
  await fs.writeFile(path.join(root,'design','board.kicad_pcb'),PCB);
  const cfg:PolicyConfig={
   version:1,mode:'workspace',workspaces:[{id:'projects',root,readOnly:false}],
   filesystem:{maxReadBytes:64*1024*1024,maxWriteBytes:64*1024*1024},
   process:{allowExecutables:[],inheritEnv:['PATH','HOME','TEMP','TMP'],maxOutputBytes:256*1024,maxRuntimeMs:60000},
   engineering:{enabled:true,maxCommandRuntimeMs:60000,allowHardwareMutationInWorkspace:false,allowSerialWriteInWorkspace:false}
  };
  const policy=new PolicyEngine(cfg),paths=new PathGuard(policy);
  const nativeCalls={count:0};
  const runner={run:async(_program:string,args:string[])=>{
   nativeCalls.count++;
   if(args[1]==='import pcbnew; print(pcbnew.Version())')
     return{exitCode:0,timedOut:false,stdout:'10.0.6\n',stderr:''};
   const out=args[3]!;
   await fs.copyFile(path.join(root,'design','board.kicad_pcb'),out);
   return{exitCode:0,timedOut:false,stdout:JSON.stringify({
     kicadVersion:'10.0.6',regularCopperZones:1,totalZones:1,
     filledAreaBefore:0,filledAreaAfter:123456,
     savedAndReopened:true,nonFillDesignPreserved:true
   }),stderr:''};
  }};
  let checks=0;
  const kicad={drc:async()=>{
   const u=(++checks===1)?5:newCount;
   return{report:{counts:{active:{
     unconnected:u,violations:0,schematicParity:0,bySeverity:{error:u}
   }}}};
  }};
  const adapter=new KicadZoneRefillAdapter(policy,paths,runner as never,kicad as never,
    async()=>process.execPath);
  await fn({root,adapter,request:{
    board:'board.kicad_pcb',outputDir:'refilled',expectedBoardSha256:sha(PCB)
  },nativeCalls});
 }finally{await fs.rm(root,{recursive:true,force:true});}
}
test('SHA mismatch refuses native zone refill before any mutation',async()=>{
 await fixture(async({root,adapter,request,nativeCalls})=>{
  await assert.rejects(adapter.refillCopy('projects','design',{
   ...request,expectedBoardSha256:'0'.repeat(64)
  }),/source SHA mismatch/);
  assert.equal(nativeCalls.count,0);
  assert.equal(await fs.readFile(path.join(root,'design','board.kicad_pcb'),'utf8'),PCB);
 });
});
test('existing output cannot be overwritten or a traversal directory chosen',async()=>{
 await fixture(async({root,adapter,request,nativeCalls})=>{
  await fs.mkdir(path.join(root,'design','refilled'));
  await fs.writeFile(path.join(root,'design','refilled','keep.txt'),'KEEP');
  await assert.rejects(adapter.refillCopy('projects','design',request),/output directory exists/);
  await assert.rejects(adapter.refillCopy('projects','design',{
   ...request,outputDir:'../escape'
  }),/Unsafe Specctra/);
  assert.equal(nativeCalls.count,0);
  assert.equal(await fs.readFile(path.join(root,'design','refilled','keep.txt'),'utf8'),'KEEP');
 });
});
test('DRC non-regression gate accepts stable design and preserves source', {skip:process.platform!=='win32'},async()=>{
 await fixture(async({root,adapter,request,nativeCalls})=>{
  const result=await adapter.refillCopy('projects','design',request);
  assert.equal(result.status,'candidate-accepted');
  assert.equal(result.baseline.unconnected,5);
  assert.equal(result.candidateDrc.unconnected,4);
  assert.equal(result.zoneFacts.regularCopperZones,1);
  assert.equal(result.manufacturingApproved,false);
  assert.equal(result.sourcePreserved,true);
  assert.equal(await fs.readFile(path.join(root,'design','board.kicad_pcb'),'utf8'),PCB);
  assert.ok(nativeCalls.count>=2);
 });
});
test('official DRC regression rejects otherwise valid refill preview', {skip:process.platform!=='win32'},async()=>{
 await fixture(async({root,adapter,request})=>{
  const result=await adapter.refillCopy('projects','design',request);
  assert.equal(result.status,'candidate-rejected');
  assert.ok(result.reasons.includes('zone-refill-unconnected-regression'));
  assert.equal(result.manufacturingApproved,false);
  const manifest=JSON.parse(await fs.readFile(path.join(root,'design','refilled','zone-refill-manifest.json'),'utf8'));
  assert.equal(manifest.status,'candidate-rejected');
 },6);
});
