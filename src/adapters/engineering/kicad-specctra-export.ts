/** Windows-only, owner-local KiCad pcbnew -> Specctra DSN adapter.
 * Never executes third-party autorouters or imports SES. This is the bounded,
 * copy-only prerequisite for a later, independently DRC-gated SES bridge.
 */
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {PolicyEngine} from '../../policy.js';
import type {PathGuard} from '../../security/path-guard.js';
import type {EngineeringCommandRunner} from './command-runner.js';
import {resolveExistingProjectPath} from './project-path.js';
import {copyKicadProjectSupport} from './kicad-autoexperiment-support.js';

const BINARY_LIMIT=32*1024*1024;
const sha=(buffer:Buffer|string)=>createHash('sha256').update(buffer).digest('hex');
const PYTHON_EXPORT=String.raw`import json,os,sys,pcbnew
source,destination=sys.argv[1:3]
if not source.lower().endswith(".kicad_pcb") or not destination.lower().endswith(".dsn"): raise ValueError("Invalid KiCad/Specctra file extension")
board=pcbnew.LoadBoard(source)
if board is None: raise RuntimeError("KiCad PCB did not load")
if not pcbnew.ExportSpecctraDSN(board,destination): raise RuntimeError("Native pcbnew Specctra DSN export failed")
if not os.path.isfile(destination): raise RuntimeError("Native Specctra output missing")
print(json.dumps({"kicadVersion":pcbnew.Version(),"exported":True,"fileBytes":os.path.getsize(destination)}))`;

export async function bundledPython():Promise<string>{
  if(os.platform()!=='win32')throw Error('Specctra export prototype is Windows-only.');
  const roots=[
    process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'Programs','KiCad'):undefined,
    process.env.ProgramFiles?path.join(process.env.ProgramFiles,'KiCad'):undefined
  ].filter((v):v is string=>Boolean(v));
  for(const root of roots){
    const versions=await fs.readdir(root,{withFileTypes:true}).catch(()=>[]);
    const sorted=versions.filter(v=>v.isDirectory()).map(v=>v.name).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
    for(const version of sorted){
      if(Number(version.split('.')[0])<10)continue;
      const py=path.join(root,version,'bin','python.exe');
      const cli=path.join(root,version,'bin','kicad-cli.exe');
      if((await fs.stat(py).catch(()=>undefined))?.isFile()&&
         (await fs.stat(cli).catch(()=>undefined))?.isFile())return py;
    }
  }
  throw Error('No supported bundled KiCad 10+ Python/pcbnew toolchain found on this Windows host.');
}
export function safeDestination(root:string,requested:string){
  if(!requested||requested.length>600||path.isAbsolute(requested))throw Error('Specctra output directory must be project-relative.');
  const parts=requested.split(/[\\/]+/);
  if(parts.some(part=>!part||part==='.'||part==='..'||! /^[A-Za-z0-9_.-]{1,80}$/.test(part)))
    throw Error('Unsafe Specctra project-relative output directory.');
  return path.join(root,...parts);
}
export class KicadSpecctraExportAdapter {
  constructor(private readonly policy:PolicyEngine,
    private readonly paths:PathGuard,
    private readonly runner:EngineeringCommandRunner){}
  async exportCopy(workspace:string,projectPath:string,
    request:{board:string;outputDir:string;expectedBoardSha256:string}){
    this.policy.assertEngineeringExecute();
    this.policy.assertWrite(workspace);
    if(!/^[a-f0-9]{64}$/i.test(request.expectedBoardSha256))throw Error('Specctra export requires exact source board SHA-256.');
    const root=await fs.realpath(await this.paths.resolveExisting(workspace,projectPath));
    const source=await resolveExistingProjectPath(this.paths,workspace,projectPath,request.board,'Specctra source board');
    if(path.extname(source).toLowerCase()!=='.kicad_pcb')throw Error('Specctra source must be .kicad_pcb.');
    const stat=await fs.lstat(source);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>BINARY_LIMIT)throw Error('Invalid Specctra source board size/type.');
    const original=await fs.readFile(source);
    const sourceSha=sha(original);
    if(sourceSha.toLowerCase()!==request.expectedBoardSha256.toLowerCase())throw Error('Specctra export source SHA-256 mismatch.');
    const output=safeDestination(root,request.outputDir);
    const parent=await fs.realpath(path.dirname(output));
    const inside=path.relative(root,parent);
    if(inside==='..'||inside.startsWith('..'+path.sep)||path.isAbsolute(inside))throw Error('Specctra output destination escapes authorized project root.');
    if(await fs.stat(output).catch(()=>undefined))throw Error('Specctra output already exists; refusing overwrite.');
    const python=await bundledPython();
    const probed=await this.runner.run(python,['-c','import pcbnew; print(pcbnew.Version())'],root,10000);
    if(probed.timedOut||probed.exitCode!==0||!/^(10|1[1-9])\./.test(probed.stdout.trim()))
      throw Error('KiCad bundled Python/pcbnew 10+ validation failed.');
    await fs.mkdir(output);
    const filename=path.basename(source);
    const copy=path.join(output,filename);
    const dsn=path.join(output,path.basename(filename,'.kicad_pcb')+'.dsn');
    await fs.writeFile(copy,original);
    await copyKicadProjectSupport(path.dirname(source),output);
    const project=path.join(path.dirname(source),path.basename(filename,'.kicad_pcb')+'.kicad_pro');
    if((await fs.stat(project).catch(()=>undefined))?.isFile())
      await fs.copyFile(project,path.join(output,path.basename(project)));
    const ran=await this.runner.run(python,['-c',PYTHON_EXPORT,copy,dsn],output,60000);
    if(ran.timedOut||ran.exitCode!==0)throw Error('KiCad native Specctra DSN export failed: '+(ran.stderr||ran.stdout).slice(0,600));
    const outStat=await fs.lstat(dsn);
    if(!outStat.isFile()||outStat.isSymbolicLink()||outStat.size<16||outStat.size>BINARY_LIMIT)throw Error('Specctra DSN missing or exceeds bounded size.');
    const dsndata=await fs.readFile(dsn);
    if(sha(await fs.readFile(source))!==sourceSha)throw Error('Source KiCad PCB changed during Specctra export.');
    const report={schemaVersion:1,sourceBoard:request.board,sourceSha256:sourceSha,
      copiedBoard:path.relative(root,copy).split(path.sep).join('/'),
      copiedBoardSha256:sha(await fs.readFile(copy)),
      specctraDsn:path.relative(root,dsn).split(path.sep).join('/'),
      specctraSha256:sha(dsndata),specctraBytes:dsndata.length,
      kicadPythonVersion:probed.stdout.trim(),
      sourcePreserved:true,solverRun:false,sessionImported:false,
      manufacturingApproved:false,
      warnings:['DSN export alone does not perform autorouting. Freerouting Java or equivalent solver must be provisioned separately.',
      'A future SES importer must verify source revision, library parity and official KiCad DRC before any accepted PCB copy.']
    };
    await fs.writeFile(path.join(output,'specctra-export-manifest.json'),JSON.stringify(report,null,2)+'\n','utf8');
    return report;
  }
}
