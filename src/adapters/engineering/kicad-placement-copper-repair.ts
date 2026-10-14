/**
 * Conservative KiCad copper repair after a small footprint translation.
 *
 * Retarget ONLY an unambiguous same-net straight-track endpoint at the
 * exact old pad center. Never touch arcs, vias, power nets, locked segments,
 * shared-junction pads or copper running through a pad. KiCad DRC on an
 * isolated copy is mandatory before a result may be accepted.
 */
import { isProtectedPowerNet } from './kicad-route-iterations.js';

type Point = { x:number; y:number };
type CopperMove = {reference:string;from:Point;to:Point};
type Block = {start:number;end:number;text:string};
type Pad = {reference:string;number:string;net:string;position:Point;layers:string[];moving:boolean;newPosition:Point};
type Segment = {block:Block;start:Point;end:Point;net:string;layer:string;locked:boolean};
const eps=0.002;
const same=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y)<=eps;
const regexEsc=(s:string)=>s.replace(/[.*+?^$()|[\]\\]/g,'\\$&');
function scan(source:string,token:string,max=200000):Block[]{
  const marker='('+token,out:Block[]=[];let cursor=0;
  while(cursor<source.length){
    const start=source.indexOf(marker,cursor);
    if(start<0)break;
    const next=source[start+marker.length]??'';
    if(next&&!/\s|"/.test(next)){cursor=start+marker.length;continue;}
    let quote=false,escaped=false,depth=0,end=-1;
    for(let i=start;i<source.length;i++){
      const char=source[i]!;
      if(quote){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quote=false;}
      else if(char==='"')quote=true;
      else if(char==='(')depth++;
      else if(char===')'){depth--;if(depth===0){end=i+1;break;}}
    }
    if(end<0)throw Error('Unbalanced KiCad '+token+' S-expression.');
    out.push({start,end,text:source.slice(start,end)});
    if(out.length>max)throw Error('KiCad '+token+' block count exceeds limit.');
    cursor=end;
  }
  return out;
}
function ptoken(text:string,token:string):Point|undefined{
  const m=text.match(new RegExp('\\('+regexEsc(token)+'\\s+(-?\\d+(?:\\.\\d+)?)\\s+(-?\\d+(?:\\.\\d+)?)'));
  return m?.[1]!==undefined&&m[2]!==undefined?{x:+m[1],y:+m[2]}:undefined;
}
function at(text:string):{x:number;y:number;angle:number}|undefined{
  const match=text.match(/\(at\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+(-?\d+(?:\.\d+)?))?/);
  return match?.[1]!==undefined&&match[2]!==undefined?{x:+match[1],y:+match[2],angle:Number(match[3]??0)}:undefined;
}
function rotate(p:Point,degrees:number):Point{
  const a=degrees*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
  return{x:p.x*c+p.y*s,y:-p.x*s+p.y*c};
}
function netName(block:string,table:Map<number,string>):string|undefined{
  const named=block.match(/\(net\s+"((?:\\.|[^"\\])*)"\)/)?.[1];
  if(named!==undefined)return named.replace(/\\(["\\])/g,'$1');
  const numeric=block.match(/\(net\s+(\d+)(?:\s+"((?:\\.|[^"\\])*)")?\)/);
  if(!numeric?.[1]||numeric[1]==='0')return undefined;
  return numeric[2]!==undefined?numeric[2].replace(/\\(["\\])/g,'$1'):table.get(+numeric[1]);
}
function padLayers(block:string):string[]{
  const m=block.match(/\(layers\s+([^()]*)\)/)?.[1]??'';
  return [...m.matchAll(/"([^"]+)"/g)].map(v=>v[1]!);
}
function distToSegment(p:Point,a:Point,b:Point){
  const ux=b.x-a.x,uy=b.y-a.y;
  const t=Math.max(0,Math.min(1,((p.x-a.x)*ux+(p.y-a.y)*uy)/(ux*ux+uy*uy||1)));
  return Math.hypot(p.x-a.x-t*ux,p.y-a.y-t*uy);
}
function format(x:number){return String(Number(x.toFixed(4)));}
export interface KicadCopperRepairMove extends CopperMove {}
export interface KicadCopperRepairResult {
  source:string;
  adjustedSegments:number;
  adjustedPadCount:number;
  changedNets:string[];
  holdReasons:string[];
  previewOnly:true;
  requiresOfficialDrc:true;
}
export function reanchorMovedPadCopperEndpoints(
  original:string, moves:KicadCopperRepairMove[], maxMoveMm=3
):KicadCopperRepairResult {
  if(Buffer.byteLength(original,'utf8')>32*1024*1024||!original.trim())
    throw Error('Copper repair PCB source must be nonempty and <=32 MiB.');
  if(moves.length<1||moves.length>16)throw Error('Copper repair requires 1..16 bounded moves.');
  if(!Number.isFinite(maxMoveMm)||maxMoveMm<=0||maxMoveMm>5)throw Error('Invalid maximum copper-repair translation.');
  const byRef=new Map<string,CopperMove>();
  for(const m of moves){
    if(!/^[A-Za-z][A-Za-z0-9._+-]{0,31}$/.test(m.reference))throw Error('Invalid moved PCB reference.');
    if([...Object.values(m.from),...Object.values(m.to)].some(x=>!Number.isFinite(x)||Math.abs(x)>100000) ||
      Math.hypot(m.to.x-m.from.x,m.to.y-m.from.y)>maxMoveMm+1e-7)
      throw Error('Copper repair move exceeds bounded distance.');
    if(byRef.has(m.reference.toUpperCase()))throw Error('Duplicate copper-repair footprint move.');
    byRef.set(m.reference.toUpperCase(),m);
  }
  if(scan(original,'zone',2048).length) {
    throw Error('Copper endpoint repair refuses filled/unfilled zones until official zone-refill support exists.');
  }
  const netTable=new Map<number,string>();
  for(const m of original.matchAll(/\(net\s+(\d+)\s+"((?:\\.|[^"\\])*)"\)/g))
    netTable.set(Number(m[1]),(m[2]??'').replace(/\\(["\\])/g,'$1'));
  const pads:Pad[]=[];
  const footprints=scan(original,'footprint',1024);
  const found=new Set<string>();
  for(const footprint of footprints){
    const ref=footprint.text.match(/\(property\s+"Reference"\s+"([^"]+)"/)?.[1];
    if(!ref)continue;
    const placement=at(footprint.text);
    if(!placement)continue;
    const move=byRef.get(ref.toUpperCase());
    if(move){
      found.add(ref.toUpperCase());
      if(!same({x:placement.x,y:placement.y},move.from))throw Error('Copper repair footprint origin changed; stale request '+ref);
      if(/\(locked\s+yes\)|\(locked\b/.test(footprint.text))throw Error('Locked footprint cannot be repaired: '+ref);
    }
    for(const p of scan(footprint.text,'pad',4096)){
      const net=netName(p.text,netTable);
      if(!net)continue;
      const pAt=at(p.text)??{x:0,y:0,angle:0};
      const rel=rotate({x:pAt.x,y:pAt.y},placement.angle);
      const position={x:placement.x+rel.x,y:placement.y+rel.y};
      const delta=move?{x:move.to.x-move.from.x,y:move.to.y-move.from.y}:{x:0,y:0};
      if(pads.length>=4096)throw Error('Copper repair exceeds bounded total PCB pad count.');
      pads.push({
        reference:ref,number:p.text.match(/^\(pad\s+"([^"]*)"/)?.[1]??'',
        net,position,newPosition:{x:position.x+delta.x,y:position.y+delta.y},
        layers:padLayers(p.text),moving:Boolean(move)
      });
    }
  }
  if(found.size!==byRef.size)throw Error('Copper repair unknown footprint reference.');
  const segments:Segment[]=scan(original,'segment',16000).map(block=>{
    const start=ptoken(block.text,'start'),end=ptoken(block.text,'end');
    const net=netName(block.text,netTable);
    const layer=block.text.match(/\(layer\s+"([^"]+)"\)/)?.[1];
    if(!start||!end||!net||!layer)throw Error('Cannot certify copper segment structure; repair refused.');
    return{block,start,end,net,layer,locked:/\(locked\s+yes\)|\(segment\s+locked\b/.test(block.text)};
  });
  const arcs=scan(original,'arc',100000).filter(b=>/\(layer\s+"(?:F|B|In\d+)\.Cu"/.test(b.text));
  const vias=scan(original,'via',100000);
  const holds:string[]=[];
  type Patch={start:number;end:number;value:string};
  const patches:Patch[]=[];
  const changedNets=new Set<string>(),handledPads=new Set<string>();
  const reserved=new Set<string>();
  for(const pad of pads.filter(x=>x.moving)){
    const key=pad.reference+':'+pad.number;
    const connected=segments.flatMap(s=>{
      if(s.net!==pad.net || !pad.layers.some(l=>l===s.layer||l==='*.Cu'||l==='F&B.Cu'))return [];
      const result:('start'|'end')[]=[];
      if(same(s.start,pad.position))result.push('start');
      if(same(s.end,pad.position))result.push('end');
      return result.map(endpoint=>({s,endpoint}));
    });
    if(!connected.length){
      if(segments.some(s=>s.layer && pad.layers.some(l=>l===s.layer||l==='*.Cu'||l==='F&B.Cu')&&
        distToSegment(pad.position,s.start,s.end)<eps)){
        holds.push(key+':copper-touch-without-same-net-track-end');
      }
      continue;
    }
    if(isProtectedPowerNet(pad.net)){
      holds.push(key+':power-net-protected:'+pad.net);continue;
    }
    if(!pad.layers.some(l=>l.endsWith('.Cu')||l==='*.Cu'||l==='F&B.Cu')){
      holds.push(key+':unsupported-pad-copper-layer');continue;
    }
    if(connected.length!==1){
      holds.push(key+':ambiguous-track-junction:'+connected.length);continue;
    }
    const touch=connected[0]!;
    if(touch.s.locked){holds.push(key+':locked-track');continue;}
    if(pads.some(p=>p!==pad&&same(p.position,pad.position))){
      holds.push(key+':shared-pad-origin');continue;
    }
    if(vias.some(v=>{const point=at(v.text);return point&&same(point,pad.position);})){
      holds.push(key+':via-at-pad-origin');continue;
    }
    if(arcs.some(a=>{
      if(netName(a.text,netTable)!==pad.net)return false;
      const a0=ptoken(a.text,'start'),a1=ptoken(a.text,'mid'),a2=ptoken(a.text,'end');
      return a0&&a1&&a2&&[a0,a1,a2].some(p=>same(p,pad.position));
    })){holds.push(key+':copper-arc-at-pad');continue;}
    if(segments.some(s=>s!==touch.s&&s.net===pad.net&&s.layer===touch.s.layer&&
      distToSegment(pad.position,s.start,s.end)<eps)){
      holds.push(key+':midsegment-copper-junction');continue;
    }
    if(same(pad.newPosition,touch.endpoint==='start'?touch.s.end:touch.s.start)){
      holds.push(key+':zero-length-track-after-reanchor');continue;
    }
    const editKey=touch.s.block.start+':'+touch.endpoint;
    if(reserved.has(editKey)){holds.push(key+':duplicate-track-endpoint');continue;}
    reserved.add(editKey);
    const re=new RegExp('\\('+touch.endpoint+'\\s+-?\\d+(?:\\.\\d+)?\\s+-?\\d+(?:\\.\\d+)?\\)');
    const match=re.exec(touch.s.block.text);
    if(!match){holds.push(key+':track-coordinate-cannot-be-patched');continue;}
    patches.push({
      start:touch.s.block.start+match.index,end:touch.s.block.start+match.index+match[0].length,
      value:'('+touch.endpoint+' '+format(pad.newPosition.x)+' '+format(pad.newPosition.y)+')'
    });
    handledPads.add(key);changedNets.add(pad.net);
  }
  // Fail-closed: never claim a partial pad re-anchoring operation is safe.
  // A wholly unmodified preview can still use the normal DRC gate.
  if(holds.length)return {
    source:original,adjustedSegments:0,adjustedPadCount:0,changedNets:[],
    holdReasons:[...new Set(holds)].sort(),previewOnly:true,requiresOfficialDrc:true
  };
  let source=original;
  for(const patch of patches.sort((a,b)=>b.start-a.start)){
    source=source.slice(0,patch.start)+patch.value+source.slice(patch.end);
  }
  return{
    source,adjustedSegments:patches.length,adjustedPadCount:handledPads.size,
    changedNets:[...changedNets].sort(),holdReasons:[],
    previewOnly:true,requiresOfficialDrc:true
  };
}
