/** Windows KiCad 10 native copper-zone refill on isolated, SHA-bound copies.
 * The original board and original project files are never modified.
 */
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {PolicyEngine} from '../../policy.js';
import type {PathGuard} from '../../security/path-guard.js';
import type {EngineeringCommandRunner} from './command-runner.js';
import type {KicadAdapter} from './kicad.js';
import {resolveExistingProjectPath} from './project-path.js';
import {copyKicadProjectSupport} from './kicad-autoexperiment-support.js';
import {bundledPython,safeDestination} from './kicad-specctra-export.js';

const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const valid=/^[a-f0-9]{64}$/i;
const SCRIPT=String.raw`import json,pcbnew,sys
src,out=sys.argv[1:3]
board=pcbnew.LoadBoard(src)
if board is None: raise RuntimeError("Cannot load KiCad source PCB")
zones=list(board.Zones())
regular=[z for z in zones if not z.GetIsRuleArea()]
if not regular: raise RuntimeError("Board has no copper zones to refill")
if len(zones)>128: raise RuntimeError("KiCad zone count exceeds bounded refill size")
def immutable(b):
  f=[]
  for fp in b.GetFootprints():
    x=fp.GetPosition()
    pads=[]
    for p in fp.Pads():
      a=p.GetPosition()
      pads.append([str(p.m_Uuid.AsString()),str(p.GetNumber()),str(p.GetNetname()),
        int(a.x),int(a.y),str(p.GetLayerSet().FmtBin())])
    f.append([str(fp.m_Uuid.AsString()),str(fp.GetReference()),int(x.x),int(x.y),
      int(fp.GetOrientationDegrees()),sorted(pads)])
  copper=[]
  for t in b.GetTracks():
    a=t.GetStart()
    z=t.GetEnd()
    copper.append([str(t.m_Uuid.AsString()),str(t.GetNetname()),str(t.GetClass()),
      str(t.GetLayerName()),int(a.x),int(a.y),int(z.x),int(z.y),int(t.GetWidth(t.GetLayer()) if isinstance(t,pcbnew.PCB_VIA) else t.GetWidth())])
  zones=[]
  for z in b.Zones():
    # Source zone polygon/identity must remain intact; filled polygons change.
    box=z.GetBoundingBox()
    zones.append([str(z.m_Uuid.AsString()),str(z.GetNetname()),str(z.GetLayerSet().FmtBin()),
      bool(z.GetIsRuleArea()),int(box.GetX()),int(box.GetY()),int(box.GetWidth()),int(box.GetHeight()),
      z.GetNumCorners()])
  edges=[]
  for obj in b.GetDrawings():
    if obj.GetLayerName()=="Edge.Cuts":
      box=obj.GetBoundingBox()
      edges.append([str(obj.m_Uuid.AsString()),str(obj.GetClass()),
        int(box.GetX()),int(box.GetY()),int(box.GetWidth()),int(box.GetHeight())])
  return [sorted(f),sorted(copper),sorted(zones),sorted(edges)]
before=immutable(board)
filledBefore=sum(float(z.GetFilledArea()) for z in regular)
success=pcbnew.ZONE_FILLER(board).Fill(board.Zones())
if success is False: raise RuntimeError("Native KiCad zone filler rejected candidate")
after=immutable(board)
if before!=after: raise RuntimeError("Native zone refill changed protected footprints/pads/tracks/zone outlines/Edge.Cuts")
filledAfter=sum(float(z.GetFilledArea()) for z in regular)
if not (filledAfter>=0): raise RuntimeError("Negative native filled zone area")
saved=pcbnew.SaveBoard(out,board)
if saved is False: raise RuntimeError("KiCad refused to save refill preview")
reloaded=pcbnew.LoadBoard(out)
if reloaded is None or immutable(reloaded)!=before: raise RuntimeError("Saved refilled copy changed protected board identity")
print(json.dumps({"kicadVersion":pcbnew.Version(),"regularCopperZones":len(regular),
  "totalZones":len(zones),"filledAreaBefore":filledBefore,"filledAreaAfter":filledAfter,
  "savedAndReopened":True,"nonFillDesignPreserved":True}))`;

type Counts={violations:number;unconnected:number;schematicParity:number;errors:number};
const getCounts=(r:Awaited<ReturnType<KicadAdapter['drc']>>['report']):Counts=>{
  const a=r.counts.active;
  const x={violations:Number(a.violations),unconnected:Number(a.unconnected),
    schematicParity:Number(a.schematicParity),errors:Number(a.bySeverity.error??0)};
  if(Object.values(x).some(v=>!Number.isSafeInteger(v)||v<0))throw Error('Invalid zone refill official DRC count.');
  return x;
};
const nonRegression=(before:Counts,after:Counts)=>{
  const reasons:string[]=[];
  if(after.violations>before.violations)reasons.push('zone-refill-drc-regression');
  if(after.unconnected>before.unconnected)reasons.push('zone-refill-unconnected-regression');
  if(after.errors>before.errors)reasons.push('zone-refill-error-regression');
  if(after.schematicParity>before.schematicParity)reasons.push('zone-refill-schematic-parity-regression');
  return reasons;
};
async function ensureFile(file:string){
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>32*1024*1024)
    throw Error('Invalid KiCad refill source file type or size.');
  return fs.readFile(file);
}
function relative(root:string,file:string){
  const rel=path.relative(root,file);
  if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('Zone refill output escapes authorized project.');
  return rel.split(path.sep).join('/');
}
export class KicadZoneRefillAdapter {
  constructor(private readonly policy:PolicyEngine,private readonly paths:PathGuard,
    private readonly runner:EngineeringCommandRunner,private readonly kicad:KicadAdapter,
    private readonly pythonResolver:()=>Promise<string>=bundledPython){}
  async refillCopy(workspace:string,projectPath:string,request:{
    board:string;schematic?:string;outputDir:string;expectedBoardSha256:string;
  }){
    this.policy.assertEngineeringExecute();
    this.policy.assertWrite(workspace);
    if(!valid.test(request.expectedBoardSha256))throw Error('Zone refill requires original PCB SHA-256.');
    const root=await fs.realpath(await this.paths.resolveExisting(workspace,projectPath));
    const source=await resolveExistingProjectPath(this.paths,workspace,projectPath,request.board,'KiCad refill source');
    if(path.extname(source).toLowerCase()!=='.kicad_pcb')throw Error('Zone refill source must be a .kicad_pcb.');
    const initial=await ensureFile(source);
    const sourceSha=sha(initial);
    if(sourceSha!==request.expectedBoardSha256.toLowerCase())throw Error('Zone refill source SHA mismatch.');
    const stem=path.basename(source,'.kicad_pcb');
    const sch=request.schematic?await resolveExistingProjectPath(this.paths,workspace,projectPath,
      request.schematic,'KiCad refill schematic'):undefined;
    if(sch&&path.basename(sch)!==stem+'.kicad_sch')throw Error('Refill parity schematic basename mismatch.');
    const destination=safeDestination(root,request.outputDir);
    await fs.realpath(path.dirname(destination)).then(parent=>relative(root,parent));
    if(await fs.stat(destination).catch(()=>undefined))throw Error('Zone refill output directory exists.');
    const baseline=getCounts((await this.kicad.drc(workspace,projectPath,request.board,Boolean(sch))).report);
    const py=await this.pythonResolver();
    const version=await this.runner.run(py,['-c','import pcbnew; print(pcbnew.Version())'],root,10000);
    if(version.timedOut||version.exitCode!==0||!/^(10|1[1-9])\./.test(version.stdout.trim()))
      throw Error('Zone refill needs bundled KiCad 10+ pcbnew Python.');
    await fs.mkdir(destination);
    const name=path.basename(source);
    const originalCopy=path.join(destination,'source-'+name),candidate=path.join(destination,name);
    await fs.writeFile(originalCopy,initial);
    const pro=path.join(path.dirname(source),stem+'.kicad_pro');
    if((await fs.stat(pro).catch(()=>undefined))?.isFile())await fs.copyFile(pro,path.join(destination,path.basename(pro)));
    if(sch)await fs.copyFile(sch,path.join(destination,path.basename(sch)));
    await copyKicadProjectSupport(path.dirname(source),destination);
    const result=await this.runner.run(py,['-c',SCRIPT,originalCopy,candidate],destination,120000);
    if(result.timedOut||result.exitCode!==0)throw Error(
      'Native KiCad copper zone refill failed closed: '+(result.stderr||result.stdout).slice(0,850));
    const facts=JSON.parse(result.stdout.trim()) as{
      kicadVersion:string;totalZones:number;regularCopperZones:number;
      filledAreaBefore:number;filledAreaAfter:number;
      savedAndReopened:boolean;nonFillDesignPreserved:boolean;
    };
    if(facts.savedAndReopened!==true||facts.nonFillDesignPreserved!==true||
      !Number.isSafeInteger(facts.regularCopperZones)||facts.regularCopperZones<1)
      throw Error('Native KiCad zone refill lacks immutable design proof.');
    const candidateBytes=await ensureFile(candidate);
    const updated=getCounts((await this.kicad.drc(workspace,projectPath,relative(root,candidate),Boolean(sch))).report);
    const reasons=nonRegression(baseline,updated);
    if(sha(await fs.readFile(source))!==sourceSha)throw Error('Original KiCad PCB changed during zone refill.');
    const manifest={schemaVersion:1,sourceBoard:request.board,sourceSha256:sourceSha,
      candidateBoard:relative(root,candidate),candidateSha256:sha(candidateBytes),
      outputDir:relative(root,destination),status:reasons.length?'candidate-rejected':'candidate-accepted',
      reasons,baseline,candidateDrc:updated,zoneFacts:facts,sourcePreserved:true,
      manufacturingApproved:false,
      warnings:['Copy-only copper zone refill is not a substitute for electrical, return-path, EMI, thermal or assembly review.']};
    await fs.writeFile(path.join(destination,'zone-refill-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    return manifest;
  }
}
