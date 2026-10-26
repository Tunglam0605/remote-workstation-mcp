import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KicadAdapter } from '../src/adapters/engineering/kicad.js';
import type { EngineeringCommandResult } from '../src/engineering/types.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

const BOARD=`(kicad_pcb
  (version 20250101)
  (generator pcbnew)
  (general (thickness 1.6))
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (44 "Edge.Cuts" user)
  )
  (setup)
  (net 0 "")
  (net 1 "/SIG")
  (embedded_fonts no)
)`;

function sha256(value:string){return createHash('sha256').update(value,'utf8').digest('hex');}

function config(root:string):PolicyConfig{
  return {
    version:1,
    mode:'workspace',
    workspaces:[{id:'w',root,readOnly:false}],
    filesystem:{maxReadBytes:64*1024*1024,maxWriteBytes:64*1024*1024},
    process:{allowExecutables:[],inheritEnv:['PATH','HOME','TEMP','TMP'],maxOutputBytes:256*1024,maxRuntimeMs:60000},
    engineering:{enabled:true,maxCommandRuntimeMs:60000,allowHardwareMutationInWorkspace:false,allowSerialWriteInWorkspace:false}
  };
}

async function fakeExecutable(dir:string){
  await fs.mkdir(dir,{recursive:true});
  if(process.platform==='win32') await fs.writeFile(path.join(dir,'kicad-cli.cmd'),'@echo off\r\nexit /b 0\r\n');
  else {
    const file=path.join(dir,'kicad-cli');
    await fs.writeFile(file,'#!/bin/sh\nexit 0\n');
    await fs.chmod(file,0o755);
  }
}

function commandResult(program:string,args:string[],cwd:string):EngineeringCommandResult{
  return {program,args:[...args],cwd,exitCode:0,stdout:'',stderr:'',timedOut:false,durationMs:1};
}

async function makeAdapter(root:string,rejectCandidate:boolean){
  const runner={
    async run(program:string,args:string[],cwd:string):Promise<EngineeringCommandResult>{
      const outputIndex=args.indexOf('--output');
      const output=outputIndex>=0?args[outputIndex+1]:undefined;
      if(args.includes('drc')&&output){
        const boardArg=args.at(-1)!;
        const source=await fs.readFile(boardArg,'utf8');
        const candidate=source.includes('(segment');
        await fs.writeFile(output,JSON.stringify({
          violations: candidate&&rejectCandidate ? [{severity:'error',description:'candidate clearance regression',items:[]}] : [],
          unconnected_items:[],
          schematic_parity:[],
          ignored_checks:[]
        }));
      }
      return commandResult(program,args,cwd);
    }
  };
  const policy=new PolicyEngine(config(root));
  return new KicadAdapter(policy,new PathGuard(policy),runner as never);
}

test('KiCad route batch rolls back the entire PCB when DRC regresses',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rwmcp-kicad-route-rollback-'));
  const bin=path.join(root,'bin');
  const oldPath=process.env.PATH;
  await fakeExecutable(bin);
  process.env.PATH=`${bin}${path.delimiter}${oldPath??''}`;
  const boardPath=path.join(root,'robot.kicad_pcb');
  await fs.writeFile(boardPath,BOARD);
  try{
    const adapter=await makeAdapter(root,true);
    await assert.rejects(()=>adapter.routeBatchApply('w','.',{
      board:'robot.kicad_pcb',
      expectedBoardSha256:sha256(BOARD),
      operations:[{kind:'segment',netName:'/SIG',layer:'F.Cu',start:{x:10,y:10},end:{x:20,y:10},widthMm:0.25}],
      requireNoNewViolations:true,
      requireUnconnectedNonIncrease:true,
      requireParityNonIncrease:true
    }),/rejected and rolled back/);
    assert.equal(await fs.readFile(boardPath,'utf8'),BOARD);
  } finally {
    process.env.PATH=oldPath;
    await fs.rm(root,{recursive:true,force:true});
  }
});

test('KiCad route batch accepts a DRC-nonregressing batch and returns a new board SHA',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rwmcp-kicad-route-accept-'));
  const bin=path.join(root,'bin');
  const oldPath=process.env.PATH;
  await fakeExecutable(bin);
  process.env.PATH=`${bin}${path.delimiter}${oldPath??''}`;
  const boardPath=path.join(root,'robot.kicad_pcb');
  await fs.writeFile(boardPath,BOARD);
  try{
    const adapter=await makeAdapter(root,false);
    const result=await adapter.routeBatchApply('w','.',{
      board:'robot.kicad_pcb',
      expectedBoardSha256:sha256(BOARD),
      operations:[
        {kind:'segment',netName:'/SIG',layer:'F.Cu',start:{x:10,y:10},end:{x:20,y:10},widthMm:0.25},
        {kind:'via',netName:'/SIG',position:{x:20,y:10},diameterMm:0.6,drillMm:0.3,layers:['F.Cu','B.Cu']}
      ]
    });
    assert.equal(result.accepted,true);
    assert.notEqual(result.afterSha256,result.beforeSha256);
    assert.equal(result.summary.segments,1);
    assert.equal(result.summary.vias,1);
    const after=await fs.readFile(boardPath,'utf8');
    assert.match(after,/\(segment/);
    assert.match(after,/\(via/);
  } finally {
    process.env.PATH=oldPath;
    await fs.rm(root,{recursive:true,force:true});
  }
});


test('KiCad route batch zone-refill acceptance persists filled zones and rolls back a failed durable DRC', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-zone-route-'));
  const bin = path.join(root, 'bin');
  const previousPath = process.env.PATH;
  await fakeExecutable(bin);
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
  const board = path.join(root, 'route.kicad_pcb');
  await fs.writeFile(board, BOARD);
  const calls: string[][] = [];
  let rejectSaved = false;
  const runner = {
    async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
      calls.push([...args]);
      const boardArg = args.at(-1)!;
      const outputAt = args.indexOf('--output');
      if (args.includes('drc') && outputAt >= 0) {
        let content = await fs.readFile(boardArg, 'utf8');
        const candidate = content.includes('(segment');
        const refill = args.includes('--refill-zones');
        const save = args.includes('--save-board');
        if (save) {
          assert.equal(refill, true);
          await fs.appendFile(boardArg, '\n; saved-zone-fill-marker');
          content += '\n; saved-zone-fill-marker';
        }
        const saved = content.includes('saved-zone-fill-marker');
        const bad = candidate && (!refill && (!saved || rejectSaved));
        await fs.writeFile(args[outputAt + 1]!, JSON.stringify({
          violations: bad ? [{ severity: 'error', description: 'unrefilled GND copper collision', items: [] }] : [],
          unconnected_items: [], schematic_parity: [], ignored_checks: []
        }));
      }
      return commandResult(program, args, cwd);
    }
  };
  const policy = new PolicyEngine(config(root));
  const adapter = new KicadAdapter(policy, new PathGuard(policy), runner as never);
  const operation = { kind: 'segment' as const, netName: '/SIG', layer: 'F.Cu',
    start: { x: 10, y: 10 }, end: { x: 20, y: 10 }, widthMm: 0.25 };
  try {
    // Existing/default route behavior is unchanged: stale fill fails DRC.
    await assert.rejects(() => adapter.routeBatchApply('w', '.', {
      board: 'route.kicad_pcb', expectedBoardSha256: sha256(BOARD),
      operations: [operation]
    }), /rejected and rolled back/);
    assert.equal(await fs.readFile(board, 'utf8'), BOARD);
    calls.length = 0;

    const accepted = await adapter.routeBatchApply('w', '.', {
      board: 'route.kicad_pcb', expectedBoardSha256: sha256(BOARD),
      operations: [operation], refillZones: true
    });
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.zonesRefilledAndSaved, true);
    assert.ok(calls.some(args => args.includes('--refill-zones') && args.includes('--save-board')));
    assert.equal(calls.at(-1)?.includes('--refill-zones'), false);
    assert.match(await fs.readFile(board, 'utf8'), /saved-zone-fill-marker/);

    // Even if in-memory refilling passed, a regression in saved fills
    // must trigger a complete rollback of the source and zone state.
    await fs.writeFile(board, BOARD);
    rejectSaved = true;
    await assert.rejects(() => adapter.routeBatchApply('w', '.', {
      board: 'route.kicad_pcb', expectedBoardSha256: sha256(BOARD),
      operations: [operation], refillZones: true
    }), /saved-zone DRC rejected and rolled back/);
    assert.equal(await fs.readFile(board, 'utf8'), BOARD);
  } finally {
    process.env.PATH = previousPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('strict connection-improvement gate rolls back a DRC-clean route that fixes no ratsnest', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-route-strict-'));
  const bin = path.join(root, 'bin');
  const oldPath = process.env.PATH;
  await fakeExecutable(bin);
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  const board = path.join(root, 'strict.kicad_pcb');
  await fs.writeFile(board, BOARD);
  try {
    const adapter = await makeAdapter(root, false);
    await assert.rejects(() => adapter.routeBatchApply('w', '.', {
      board: 'strict.kicad_pcb', expectedBoardSha256: sha256(BOARD),
      operations: [{kind:'segment',netName:'/SIG',layer:'F.Cu',
        start:{x:10,y:10},end:{x:20,y:10},widthMm:0.25}],
      requireUnconnectedDecrease: true
    }), /unconnected did not decrease 0->0/);
    assert.equal(await fs.readFile(board, 'utf8'), BOARD);
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});
