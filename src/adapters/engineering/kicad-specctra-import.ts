/** Source-bound, copy-only KiCad 10 Specctra SES import gate.
 *
 * External SES is not trusted. Every candidate is checked against the original
 * design revision, export provenance, KiCad-native non-routing invariants and
 * KiCad CLI official DRC / parity. This never alters the source board.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PolicyEngine } from '../../policy.js';
import type { PathGuard } from '../../security/path-guard.js';
import type { EngineeringCommandRunner } from './command-runner.js';
import type { KicadAdapter } from './kicad.js';
import { resolveExistingProjectPath } from './project-path.js';
import { copyKicadProjectSupport } from './kicad-autoexperiment-support.js';
import { bundledPython, safeDestination } from './kicad-specctra-export.js';

const sha=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
const HEX=/^[a-f0-9]{64}$/i;
const LIMIT=32*1024*1024;
const PYTHON_IMPORT=String.raw`import json,sys,pcbnew
from collections import Counter
source,ses,out=sys.argv[1:4]
def sig(board):
    footprints=[]
    for fp in board.GetFootprints():
        pads=[]
        for pad in fp.Pads():
            point=pad.GetPosition()
            pads.append([str(pad.m_Uuid),str(pad.GetNumber()),str(pad.GetNetname()),
              int(point.x),int(point.y),str(pad.GetLayerSet().FmtBin())])
        pos=fp.GetPosition()
        footprints.append([str(fp.m_Uuid),str(fp.GetReference()),str(fp.GetValue()),
          int(pos.x),int(pos.y),int(fp.GetOrientationDegrees()),sorted(pads)])
    drawings=[]
    for obj in board.GetDrawings():
        if obj.GetLayerName() == "Edge.Cuts":
            box=obj.GetBoundingBox()
            drawings.append([str(obj.m_Uuid),str(obj.GetClass()),
               int(box.GetX()),int(box.GetY()),int(box.GetWidth()),int(box.GetHeight())])
    zones=[]
    for zone in board.Zones():
        box=zone.GetBoundingBox()
        zones.append([str(zone.m_Uuid),str(zone.GetNetname()),str(zone.GetLayerSet().FmtBin()),
          int(box.GetX()),int(box.GetY()),int(box.GetWidth()),int(box.GetHeight())])
    nets=sorted([str(net.GetNetname()) for net in board.GetNetInfo().NetsByNetcode().values()])
    return {"footprints":sorted(footprints),"edgeDrawings":sorted(drawings),
      "zones":sorted(zones),"netNames":nets}
def protected_tracks(board):
    tracks=[]
    for track in board.GetTracks():
        name=str(track.GetNetname()).upper().lstrip("/")
        if not (name in ("GND","PGND","AGND","DGND","5V","3V3","VCC","VBUS") or
            name.startswith(("BUCK_","VIN","EFUSE_","VCC_","VDD_","VSYS","VBAT")) or
            name.endswith(("_GND","_RTN","_RETURN"))):
            continue
        a=track.GetStart()
        b=track.GetEnd()
        ends=sorted([[int(a.x),int(a.y)],[int(b.x),int(b.y)]])
        tracks.append((name,str(track.GetClass()),str(track.GetLayerName()),
            int(track.GetWidth()),tuple(map(tuple,ends))))
    return Counter(tracks)
board=pcbnew.LoadBoard(source)
if board is None: raise RuntimeError("PCB source did not load")
before=sig(board)
oldProtected=protected_tracks(board)
if not pcbnew.ImportSpecctraSES(board,ses): raise RuntimeError("Native KiCad ImportSpecctraSES refused external session")
after=sig(board)
lostProtected=oldProtected-protected_tracks(board)
if lostProtected: raise RuntimeError("SES removed or modified an existing protected supply/return copper track")
if before != after: raise RuntimeError("SES changed non-routing identity (footprint/pads/nets/Edge.Cuts/zones)")
result=pcbnew.SaveBoard(out,board)
if result is False: raise RuntimeError("Native KiCad board save refused imported session")
check=pcbnew.LoadBoard(out)
if check is None or sig(check)!=before: raise RuntimeError("Saved SES candidate lost protected board identity")
print(json.dumps({"kicadVersion":pcbnew.Version(),"sessionImported":True,
  "protectedSupplyCopperPreserved":True,"protectedSupplyTrackCount":sum(oldProtected.values()),
  "sourceTracks":len(pcbnew.LoadBoard(source).GetTracks()),
  "candidateTracks":len(check.GetTracks()),"nonRoutingFingerprintPreserved":True}))`;

type Counts={violations:number;unconnected:number;schematicParity:number;errors:number};
type ExportProof={
  schemaVersion:number;
  sourceSha256:string;
  sourceBoard:string;
  copiedBoard:string;
  copiedBoardSha256:string;
  specctraDsn:string;
  specctraSha256:string;
  sourcePreserved:boolean;
};
export interface KicadSpecctraImportRequest {
  board:string;
  schematic?:string;
  ses:string;
  exportManifest:string;
  outputDir:string;
  expectedBoardSha256:string;
  expectedSessionSha256:string;
}
function counts(report:Awaited<ReturnType<KicadAdapter['drc']>>['report']):Counts{
  const active=report.counts.active;
  const data={violations:Number(active.violations),unconnected:Number(active.unconnected),
    schematicParity:Number(active.schematicParity),errors:Number(active.bySeverity.error??0)};
  if(Object.values(data).some(x=>!Number.isSafeInteger(x)||x<0))throw Error('Invalid official KiCad DRC counts.');
  return data;
}
function gate(before:Counts,after:Counts):string[]{
  const reasons:string[]=[];
  if(after.violations>before.violations)reasons.push('geometry-drc-regression');
  if(after.errors>before.errors)reasons.push('official-drc-errors-regression');
  if(after.schematicParity>before.schematicParity)reasons.push('schematic-parity-regression');
  if(after.unconnected>=before.unconnected)reasons.push('no-strict-connectivity-improvement');
  return reasons;
}
async function strictFile(file:string,limit=LIMIT){
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>limit)
    throw Error('Invalid regular KiCad/Specctra file type or size.');
  return fs.readFile(file);
}
function relative(root:string,full:string){
  const rel=path.relative(root,full);
  if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('Specctra referenced artifact escapes project root.');
  return rel.split(path.sep).join('/');
}
async function sourceBoundProof(paths:PathGuard,workspace:string,projectPath:string,
  input:KicadSpecctraImportRequest,root:string,shaSource:string){
  const manifest=await resolveExistingProjectPath(paths,workspace,projectPath,
    input.exportManifest,'Specctra provenance manifest');
  if(path.basename(manifest)!=='specctra-export-manifest.json')throw Error('Specctra provenance filename mismatch.');
  const json=JSON.parse((await strictFile(manifest,1024*1024)).toString('utf8')) as ExportProof;
  if(json.schemaVersion!==1||json.sourcePreserved!==true||json.sourceSha256!==shaSource||
    !HEX.test(json.copiedBoardSha256)||!HEX.test(json.specctraSha256)||
    typeof json.specctraDsn!=='string'||typeof json.copiedBoard!=='string'){
      throw Error('Specctra provenance manifest does not match source revision.');
  }
  if(json.sourceBoard!==input.board.replace(/\\/g,'/')&&
    path.basename(json.sourceBoard)!==path.basename(input.board)){
    throw Error('Specctra manifest refers to a different source board.');
  }
  const dsn=await resolveExistingProjectPath(paths,workspace,projectPath,json.specctraDsn,'Provenance DSN');
  const copy=await resolveExistingProjectPath(paths,workspace,projectPath,json.copiedBoard,'Provenance source PCB copy');
  if(path.dirname(manifest)!==path.dirname(dsn)||path.dirname(dsn)!==path.dirname(copy))
    throw Error('Specctra provenance files are not co-located in the same export.');
  if(path.extname(dsn).toLowerCase()!=='.dsn'||path.extname(copy).toLowerCase()!=='.kicad_pcb')
    throw Error('Specctra provenance file extension mismatch.');
  if(sha(await strictFile(dsn))!==json.specctraSha256||
    sha(await strictFile(copy))!==json.copiedBoardSha256||
    json.copiedBoardSha256!==shaSource){
    throw Error('Specctra DSN or source copy was modified since the verified export.');
  }
  return {dsn:relative(root,dsn),dsnSha256:json.specctraSha256,manifest:relative(root,manifest)};
}
export class KicadSpecctraImportAdapter {
  constructor(private readonly policy:PolicyEngine,private readonly paths:PathGuard,
    private readonly runner:EngineeringCommandRunner,private readonly kicad:KicadAdapter){}
  async importCopy(workspace:string,projectPath:string,input:KicadSpecctraImportRequest){
    this.policy.assertEngineeringExecute();
    this.policy.assertWrite(workspace);
    if(!HEX.test(input.expectedBoardSha256)||!HEX.test(input.expectedSessionSha256))
      throw Error('Specctra SES import needs exact source and session SHA-256.');
    const root=await fs.realpath(await this.paths.resolveExisting(workspace,projectPath));
    const pcb=await resolveExistingProjectPath(this.paths,workspace,projectPath,input.board,'Specctra source PCB');
    if(path.extname(pcb).toLowerCase()!=='.kicad_pcb')throw Error('Specctra source must be a KiCad PCB.');
    const original=await strictFile(pcb);
    const sourceSha=sha(original);
    if(sourceSha!==input.expectedBoardSha256.toLowerCase())
      throw Error('Specctra SES source SHA-256 mismatch.');
    const ses=await resolveExistingProjectPath(this.paths,workspace,projectPath,input.ses,'Specctra SES session');
    if(path.extname(ses).toLowerCase()!=='.ses')throw Error('Specctra import requires a .ses session.');
    const sesData=await strictFile(ses);
    const sesSha=sha(sesData);
    if(sesSha!==input.expectedSessionSha256.toLowerCase())
      throw Error('Specctra session SHA-256 mismatch.');
    if(!/^\s*\(session(?:\s|\()/i.test(sesData.toString('utf8',0,256)))
      throw Error('Specctra session root is not a session S-expression.');
    const proof=await sourceBoundProof(this.paths,workspace,projectPath,input,root,sourceSha);
    const stem=path.basename(pcb,'.kicad_pcb');
    const sch=input.schematic
      ? await resolveExistingProjectPath(this.paths,workspace,projectPath,input.schematic,'KiCad schematic for SES parity')
      :undefined;
    if(sch&&path.basename(sch)!==stem+'.kicad_sch')throw Error('SES schematic basename does not match source PCB.');
    const output=safeDestination(root,input.outputDir);
    const parent=await fs.realpath(path.dirname(output));
    relative(root,parent);
    if(await fs.stat(output).catch(()=>undefined))throw Error('Specctra SES output folder already exists.');
    const before=counts((await this.kicad.drc(workspace,projectPath,input.board,Boolean(sch))).report);
    const python=await bundledPython();
    const probe=await this.runner.run(python,['-c','import pcbnew; print(pcbnew.Version())'],root,10000);
    if(probe.exitCode!==0||probe.timedOut||!/^(10|1[1-9])\./.test(probe.stdout.trim()))
      throw Error('KiCad bundled pcbnew version mismatch.');
    await fs.mkdir(output);
    const name=path.basename(pcb);
    const sourceCopy=path.join(output,'source-'+name);
    const candidate=path.join(output,name);
    await fs.writeFile(sourceCopy,original);
    await copyKicadProjectSupport(path.dirname(pcb),output);
    const pro=path.join(path.dirname(pcb),stem+'.kicad_pro');
    if((await fs.stat(pro).catch(()=>undefined))?.isFile())await fs.copyFile(pro,path.join(output,path.basename(pro)));
    if(sch)await fs.copyFile(sch,path.join(output,path.basename(sch)));
    const copySes=path.join(output,stem+'.ses');
    await fs.writeFile(copySes,sesData);
    const native=await this.runner.run(python,
      ['-c',PYTHON_IMPORT,sourceCopy,copySes,candidate],output,60000);
    if(native.timedOut||native.exitCode!==0)
      throw Error('Native KiCad SES import failed closed: '+(native.stderr||native.stdout).slice(0,800));
    const parsed=JSON.parse(native.stdout.trim()) as {
      kicadVersion:string;sessionImported:boolean;nonRoutingFingerprintPreserved:boolean;
      sourceTracks:number;candidateTracks:number;
      protectedSupplyCopperPreserved:boolean;protectedSupplyTrackCount:number;
    };
    if(parsed.sessionImported!==true||parsed.nonRoutingFingerprintPreserved!==true||
      parsed.protectedSupplyCopperPreserved!==true)
      throw Error('KiCad SES import lacks immutable design proof.');
    const bytes=await strictFile(candidate);
    const after=counts((await this.kicad.drc(workspace,projectPath,
      relative(root,candidate),Boolean(sch))).report);
    const reasons=gate(before,after);
    if(sha(await fs.readFile(pcb))!==sourceSha)
      throw Error('Original KiCad PCB changed during SES import.');
    const accepted=reasons.length===0;
    const manifest={
      schemaVersion:1,originalBoard:input.board,originalSha256:sourceSha,
      ses:input.ses,sessionSha256:sesSha,
      sourceExportManifest:proof.manifest,sourceDsn:proof.dsn,sourceDsnSha256:proof.dsnSha256,
      candidateBoard:relative(root,candidate),candidateSha256:sha(bytes),
      baseline:before,candidateDrc:after,
      status:accepted?'candidate-accepted':'candidate-rejected',reasons,
      sourceTracks:parsed.sourceTracks,candidateTracks:parsed.candidateTracks,
      nativeKicadVersion:parsed.kicadVersion,nonRoutingFingerprintPreserved:true,
      protectedSupplyCopperPreserved:true,protectedSupplyTrackCount:parsed.protectedSupplyTrackCount,
      sourcePreserved:true,manufacturingApproved:false,
      warnings:['Review-only candidate. External solver origin is not independently trusted beyond pinned SES bytes.',
        'Official DRC may pass while power/thermal/return paths, 3D assembly, EMI and manufacturer checks remain incomplete.']
    };
    await fs.writeFile(path.join(output,'specctra-ses-import-manifest.json'),
      JSON.stringify(manifest,null,2)+'\n','utf8');
    return manifest;
  }
}
