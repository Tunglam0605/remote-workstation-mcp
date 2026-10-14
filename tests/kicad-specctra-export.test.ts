import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {KicadSpecctraExportAdapter} from '../src/adapters/engineering/kicad-specctra-export.js';
import {PolicyEngine} from '../src/policy.js';
import {PathGuard} from '../src/security/path-guard.js';
import type {PolicyConfig} from '../src/model.js';
const CONTENT='(kicad_pcb (version 20241229) (generator "test"))';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function make(root:string){
 const config:PolicyConfig={
  version:1,mode:'workspace',workspaces:[{id:'projects',root,readOnly:false}],
  filesystem:{maxReadBytes:64*1024*1024,maxWriteBytes:64*1024*1024},
  process:{allowExecutables:[],inheritEnv:['PATH','HOME','TEMP','TMP'],maxOutputBytes:256*1024,maxRuntimeMs:60000},
  engineering:{enabled:true,maxCommandRuntimeMs:60000,allowHardwareMutationInWorkspace:false,allowSerialWriteInWorkspace:false}
 };
 const policy=new PolicyEngine(config);
 return new KicadSpecctraExportAdapter(policy,new PathGuard(policy),{
  run:async()=>{throw Error('Refuse external process for negative safety unit test');}
 } as never);
}
async function workspace(run:(root:string)=>Promise<void>){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rwmcp-specctra-test-'));
 try{
  await fs.mkdir(path.join(root,'design'));
  await fs.writeFile(path.join(root,'design','shield.kicad_pcb'),CONTENT);
  await run(root);
 }finally{await fs.rm(root,{recursive:true,force:true});}
}
test('Specctra adapter rejects stale source SHA before staging artifacts or invoking KiCad',async()=>{
 await workspace(async root=>{
  await assert.rejects(make(root).exportCopy('projects','design',{
   board:'shield.kicad_pcb',outputDir:'new-export',
   expectedBoardSha256:'0'.repeat(64)
  }),/source SHA-256 mismatch/);
  await assert.rejects(fs.stat(path.join(root,'design','new-export')),{code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(root,'design','shield.kicad_pcb'),'utf8'),CONTENT);
 });
});
test('Specctra adapter refuses project escape, filename trick and output traversal',async()=>{
 await workspace(async root=>{
  const adapter=make(root);
  for(const name of ['../outside','x/../out','..\\outside']){
   await assert.rejects(adapter.exportCopy('projects','design',{
    board:'shield.kicad_pcb',outputDir:name,
    expectedBoardSha256:hash(CONTENT)
   }),/Unsafe Specctra/);
  }
  await assert.rejects(adapter.exportCopy('projects','design',{
   board:'../outside.kicad_pcb',outputDir:'dsn',expectedBoardSha256:hash(CONTENT)
  }));
  await assert.rejects(adapter.exportCopy('projects','design',{
   board:'shield.kicad_pcb',outputDir:'../out',expectedBoardSha256:hash(CONTENT)
  }),/Unsafe Specctra/);
  assert.equal(await fs.readFile(path.join(root,'design','shield.kicad_pcb'),'utf8'),CONTENT);
 });
});
test('Specctra output cannot overwrite a previous candidate or any existing project path',async()=>{
 await workspace(async root=>{
  const folder=path.join(root,'design','existing');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder,'manifest.txt'),'DO NOT MODIFY');
  await assert.rejects(make(root).exportCopy('projects','design',{
   board:'shield.kicad_pcb',outputDir:'existing',expectedBoardSha256:hash(CONTENT)
  }),/already exists/);
  assert.equal(await fs.readFile(path.join(folder,'manifest.txt'),'utf8'),'DO NOT MODIFY');
 });
});
