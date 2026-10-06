import type { KicadRouteBatchOperation } from './kicad-route-batch.js';

const MAX_BOARD_BYTES = 128 * 1024 * 1024;
const MAX_FOOTPRINTS = 512;
const MAX_PADS = 8192;
const MAX_NETS = 2048;
const MAX_GRID_STATES = 650_000;

type Point = { x: number; y: number };
type Rect = { minX: number; minY: number; maxX: number; maxY: number; reference?: string };
type Pad = { reference: string; number: string; netId: number; netName: string; position: Point; layers: string[]; obstacle: Rect };
type Footprint = { reference: string; at: Point; rotationDeg: number; pads: Pad[]; obstacle?: Rect };
type RouteStyle = { netName: string; widthMm?: number; clearanceMm?: number; preferredLayer?: string; priority?: number };

export interface KicadRoutePlanOptions {
  layers?: [string, string];
  gridMm?: number;
  edgeInsetMm?: number;
  defaultWidthMm?: number;
  defaultClearanceMm?: number;
  viaDiameterMm?: number;
  viaDrillMm?: number;
  viaCostMm?: number;
  turnPenaltyMm?: number;
  wrongWayPenaltyMm?: number;
  maxPadsPerNet?: number;
  maxOperations?: number;
  selectedNets?: string[];
  skipNets?: string[];
  styles?: RouteStyle[];
}

type GridState = { x: number; y: number; layer: number; dir: number };

function blockEnd(text:string,start:number):number{
  let depth=0,quoted=false,escaped=false;
  for(let i=start;i<text.length;i++){
    const ch=text[i]!;
    if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
    if(ch==='"'){quoted=true;continue;}
    if(ch==='(')depth+=1;
    else if(ch===')'){depth-=1;if(depth===0)return i+1;if(depth<0)break;}
  }
  throw new Error('Malformed KiCad S-expression.');
}

function* blocks(text:string,token:string,limit:number):Generator<string>{
  const marker='('+token;
  let cursor=0,count=0;
  while(cursor<text.length){
    const start=text.indexOf(marker,cursor);
    if(start<0)break;
    const next=text[start+marker.length]??'';
    if(next&&!/\s|"/.test(next)){cursor=start+marker.length;continue;}
    const end=blockEnd(text,start);
    if(++count>limit)throw new Error(`KiCad route planner exceeds ${limit} ${token} blocks.`);
    yield text.slice(start,end);
    cursor=end;
  }
}

function unquote(value:string):string{return value.replace(/\\(["\\])/g,'$1');}
function property(block:string,name:string):string|undefined{
  const escaped=name.replace(/[.*+?^$()|[\]\\]/g,'\\$&');
  return block.match(new RegExp('\\(property\\s+"'+escaped+'"\\s+"((?:\\\\.|[^"\\\\])*)"','i'))?.[1]?.replace(/\\(["\\])/g,'$1');
}
function at(block:string):{x:number;y:number;rotationDeg:number}|undefined{
  const m=block.match(/\(at\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+(-?\d+(?:\.\d+)?))?/);
  return m?.[1]&&m[2]?{x:Number(m[1]),y:Number(m[2]),rotationDeg:Number(m[3]??0)}:undefined;
}
function pointToken(block:string,token:string):Point|undefined{
  const escaped=token.replace(/[.*+?^$()|[\]\\]/g,'\\$&');
  const m=block.match(new RegExp('\\('+escaped+'\\s+(-?\\d+(?:\\.\\d+)?)\\s+(-?\\d+(?:\\.\\d+)?)','i'));
  return m?.[1]&&m[2]?{x:Number(m[1]),y:Number(m[2])}:undefined;
}
function numberToken(block:string,token:string):number|undefined{
  const escaped=token.replace(/[.*+?^$()|[\]\\]/g,'\\$&');
  const m=block.match(new RegExp('\\('+escaped+'\\s+(-?\\d+(?:\\.\\d+)?)\\)','i'));
  return m?.[1]!==undefined?Number(m[1]):undefined;
}
function rotate(p:Point,degrees:number):Point{
  const r=degrees*Math.PI/180,c=Math.cos(r),s=Math.sin(r);
  return {x:p.x*c-p.y*s,y:p.x*s+p.y*c};
}
function transform(p:Point,origin:Point,rotationDeg:number):Point{
  const q=rotate(p,rotationDeg);return{x:origin.x+q.x,y:origin.y+q.y};
}
function layersOf(block:string):string[]{
  const raw=block.match(/\(layers\s+([^\r\n()]+)\)/)?.[1]??'';
  return [...raw.matchAll(/"([^"]+)"/g)].map(m=>m[1]!).slice(0,32);
}
function netOf(block:string):{id:number;name:string}|undefined{
  const m=block.match(/\(net\s+(\d+)\s+"((?:\\.|[^"\\])*)"\)/);
  return m?.[1]&&m[2]!==undefined?{id:Number(m[1]),name:unquote(m[2])}:undefined;
}
function padNumber(block:string):string{
  return unquote(block.match(/^\(pad\s+"((?:\\.|[^"\\])*)"/)?.[1]??'');
}
function padSize(block:string):{x:number;y:number}{
  const m=block.match(/\(size\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\)/);
  return {x:Number(m?.[1]??1),y:Number(m?.[2]??1)};
}
function rectUnion(rects:Rect[]):Rect|undefined{
  if(!rects.length)return undefined;
  return {
    minX:Math.min(...rects.map(r=>r.minX)),minY:Math.min(...rects.map(r=>r.minY)),
    maxX:Math.max(...rects.map(r=>r.maxX)),maxY:Math.max(...rects.map(r=>r.maxY))
  };
}
function normalizeRect(a:Point,b:Point):Rect{return{minX:Math.min(a.x,b.x),minY:Math.min(a.y,b.y),maxX:Math.max(a.x,b.x),maxY:Math.max(a.y,b.y)};}

function parseBoardBounds(source:string):Rect{
  for(const block of blocks(source,'gr_rect',20000)){
    if(!/\(layer\s+"Edge\.Cuts"\)/.test(block))continue;
    const start=pointToken(block,'start'),end=pointToken(block,'end');
    if(start&&end)return normalizeRect(start,end);
  }
  const points:Point[]=[];
  for(const block of blocks(source,'gr_line',20000)){
    if(!/\(layer\s+"Edge\.Cuts"\)/.test(block))continue;
    const start=pointToken(block,'start'),end=pointToken(block,'end');
    if(start)points.push(start);if(end)points.push(end);
  }
  if(points.length<2)throw new Error('KiCad route planner requires a detectable rectangular/line Edge.Cuts boundary.');
  return {minX:Math.min(...points.map(p=>p.x)),minY:Math.min(...points.map(p=>p.y)),maxX:Math.max(...points.map(p=>p.x)),maxY:Math.max(...points.map(p=>p.y))};
}

function parseFootprints(source:string):{footprints:Footprint[];pads:Pad[]}{
  const footprints:Footprint[]=[];const allPads:Pad[]=[];
  for(const block of blocks(source,'footprint',MAX_FOOTPRINTS)){
    const origin=at(block);if(!origin)continue;
    const reference=property(block,'Reference')??'<unknown>';
    const pads:Pad[]=[];const localObstacles:Rect[]=[];
    for(const pblock of blocks(block,'pad',4096)){
      const pAt=at(pblock)??{x:0,y:0,rotationDeg:0};
      const position=transform({x:pAt.x,y:pAt.y},{x:origin.x,y:origin.y},origin.rotationDeg);
      const net=netOf(pblock);if(!net||net.id===0)continue;
      const layers=layersOf(pblock);
      const size=padSize(pblock),halfX=size.x/2,halfY=size.y/2;
      const padRotation=origin.rotationDeg+pAt.rotationDeg;
      const padCorners=[
        transform({x:-halfX,y:-halfY},position,padRotation),
        transform({x:-halfX,y:halfY},position,padRotation),
        transform({x:halfX,y:-halfY},position,padRotation),
        transform({x:halfX,y:halfY},position,padRotation)
      ];
      const padObstacle:Rect={minX:Math.min(...padCorners.map(p=>p.x)),minY:Math.min(...padCorners.map(p=>p.y)),maxX:Math.max(...padCorners.map(p=>p.x)),maxY:Math.max(...padCorners.map(p=>p.y))};
      const pad:Pad={reference,number:padNumber(pblock),netId:net.id,netName:net.name,position,layers,obstacle:padObstacle};
      pads.push(pad);allPads.push(pad);
      if(allPads.length>MAX_PADS)throw new Error(`KiCad route planner exceeds ${MAX_PADS} connected pads.`);
      localObstacles.push({minX:pAt.x-halfX,minY:pAt.y-halfY,maxX:pAt.x+halfX,maxY:pAt.y+halfY});
    }
    for(const token of ['fp_rect','fp_line']){
      for(const item of blocks(block,token,4096)){
        if(!/\(layer\s+"(?:F|B)\.CrtYd"\)/.test(item))continue;
        const a=pointToken(item,'start'),b=pointToken(item,'end');
        if(a&&b)localObstacles.push(normalizeRect(a,b));
      }
    }
    const local=rectUnion(localObstacles);
    let obstacle:Rect|undefined;
    if(local){
      const corners=[
        transform({x:local.minX,y:local.minY},{x:origin.x,y:origin.y},origin.rotationDeg),
        transform({x:local.minX,y:local.maxY},{x:origin.x,y:origin.y},origin.rotationDeg),
        transform({x:local.maxX,y:local.minY},{x:origin.x,y:origin.y},origin.rotationDeg),
        transform({x:local.maxX,y:local.maxY},{x:origin.x,y:origin.y},origin.rotationDeg)
      ];
      obstacle={reference,minX:Math.min(...corners.map(p=>p.x)),minY:Math.min(...corners.map(p=>p.y)),maxX:Math.max(...corners.map(p=>p.x)),maxY:Math.max(...corners.map(p=>p.y))};
    }
    footprints.push({reference,at:{x:origin.x,y:origin.y},rotationDeg:origin.rotationDeg,pads,obstacle});
  }
  return {footprints,pads:allPads};
}

function parseCopperLayers(source:string):string[]{
  const layerBlock=source.match(/\(layers([\s\S]*?)\n\s*\)\s*\n\s*\(setup/)?.[1]??'';
  const found=[...layerBlock.matchAll(/\(\d+\s+"([^"]+\.Cu)"/g)].map(m=>m[1]!);
  return found.length?found:['F.Cu','B.Cu'];
}

function parseExistingTracks(source:string,grid:{originX:number;originY:number;step:number},layers:string[]):Array<Set<string>>{
  const occupied=layers.map(()=>new Set<string>());
  const indexOf=new Map(layers.map((layer,index)=>[layer,index]));
  const mark=(layer:string,a:Point,b:Point,width:number)=>{
    const li=indexOf.get(layer);if(li===undefined)return;
    const length=Math.hypot(b.x-a.x,b.y-a.y),steps=Math.max(1,Math.ceil(length/(grid.step/2)));
    const radius=Math.max(grid.step,width/2)/grid.step;
    for(let i=0;i<=steps;i++){
      const t=i/steps,x=a.x+(b.x-a.x)*t,y=a.y+(b.y-a.y)*t;
      const ix=Math.round((x-grid.originX)/grid.step),iy=Math.round((y-grid.originY)/grid.step);
      const r=Math.ceil(radius);
      for(let dx=-r;dx<=r;dx++)for(let dy=-r;dy<=r;dy++)occupied[li]!.add((ix+dx)+','+(iy+dy));
    }
  };
  for(const block of blocks(source,'segment',250000)){
    const layer=block.match(/\(layer\s+"([^"]+)"\)/)?.[1],a=pointToken(block,'start'),b=pointToken(block,'end'),width=numberToken(block,'width')??0.25;
    if(layer&&a&&b)mark(layer,a,b,width);
  }
  for(const block of blocks(source,'arc',250000)){
    const layer=block.match(/\(layer\s+"([^"]+)"\)/)?.[1],a=pointToken(block,'start'),b=pointToken(block,'end'),mid=pointToken(block,'mid'),width=numberToken(block,'width')??0.25;
    if(layer&&a&&b&&mid){mark(layer,a,mid,width);mark(layer,mid,b,width);}
  }
  for(const block of blocks(source,'via',250000)){
    const p=at(block);if(!p)continue;
    const size=numberToken(block,'size')??0.6,r=Math.ceil((size/2)/grid.step);
    const ix=Math.round((p.x-grid.originX)/grid.step),iy=Math.round((p.y-grid.originY)/grid.step);
    for(const set of occupied)for(let dx=-r;dx<=r;dx++)for(let dy=-r;dy<=r;dy++)set.add((ix+dx)+','+(iy+dy));
  }
  return occupied;
}

function mstEdges(pads:Pad[]):Array<[Pad,Pad]>{
  if(pads.length<2)return[];
  const used=new Set<number>([0]);const edges:Array<[Pad,Pad]>=[];
  while(used.size<pads.length){
    let best:{a:number;b:number;d:number}|undefined;
    for(const a of used)for(let b=0;b<pads.length;b++){
      if(used.has(b))continue;
      const d=Math.hypot(pads[a]!.position.x-pads[b]!.position.x,pads[a]!.position.y-pads[b]!.position.y);
      if(!best||d<best.d)best={a,b,d};
    }
    if(!best)break;
    used.add(best.b);edges.push([pads[best.a]!,pads[best.b]!]);
  }
  return edges;
}

class MinHeap<T>{
  private items:Array<{score:number;value:T}>=[];
  push(score:number,value:T){const item={score,value};this.items.push(item);let i=this.items.length-1;while(i>0){const p=(i-1)>>1;if(this.items[p]!.score<=score)break;this.items[i]=this.items[p]!;i=p;}this.items[i]=item;}
  pop():{score:number;value:T}|undefined{if(!this.items.length)return undefined;const root=this.items[0]!,last=this.items.pop()!;if(this.items.length){let i=0;while(true){let c=i*2+1;if(c>=this.items.length)break;if(c+1<this.items.length&&this.items[c+1]!.score<this.items[c]!.score)c++;if(this.items[c]!.score>=last.score)break;this.items[i]=this.items[c]!;i=c;}this.items[i]=last;}return root;}
  get size(){return this.items.length;}
}

function stateKey(s:GridState):string{return s.layer+':'+s.x+':'+s.y+':'+s.dir;}
function cellKey(x:number,y:number):string{return x+','+y;}

export function planKicadRoutes(source:string,options:KicadRoutePlanOptions={}){
  if(!source||Buffer.byteLength(source,'utf8')>MAX_BOARD_BYTES)throw new Error('KiCad route planner board must be 1..128 MiB.');
  const board=parseBoardBounds(source);
  const parsed=parseFootprints(source);
  const availableLayers=parseCopperLayers(source);
  const layers=options.layers??(['F.Cu','B.Cu'] as [string,string]);
  for(const layer of layers)if(!availableLayers.includes(layer))throw new Error(`KiCad route planner layer ${layer} is not present on the board.`);
  if(layers[0]===layers[1])throw new Error('KiCad route planner requires two distinct routing layers.');
  const gridMm=options.gridMm??0.5,edgeInset=options.edgeInsetMm??0.5,defaultWidth=options.defaultWidthMm??0.25,defaultClearance=options.defaultClearanceMm??0.2;
  const viaDiameter=options.viaDiameterMm??0.6,viaDrill=options.viaDrillMm??0.3,viaCost=options.viaCostMm??8,turnPenalty=options.turnPenaltyMm??0.25,wrongWayPenalty=options.wrongWayPenaltyMm??0.15;
  const maxPads=options.maxPadsPerNet??32,maxOperations=options.maxOperations??4096;
  if(!(gridMm>=0.1&&gridMm<=5))throw new Error('KiCad route planner gridMm must be 0.1..5.');
  if(!(edgeInset>=0&&edgeInset<=20))throw new Error('KiCad route planner edgeInsetMm must be 0..20.');
  if(!(defaultWidth>=0.05&&defaultWidth<=20))throw new Error('KiCad route planner defaultWidthMm must be 0.05..20.');
  if(!(defaultClearance>=0&&defaultClearance<=10))throw new Error('KiCad route planner defaultClearanceMm must be 0..10.');
  if(!(viaDiameter>=0.1&&viaDiameter<=20&&viaDrill>=0.05&&viaDrill<viaDiameter))throw new Error('KiCad route planner via geometry is invalid.');
  if(!Number.isInteger(maxPads)||maxPads<2||maxPads>128)throw new Error('KiCad route planner maxPadsPerNet must be 2..128.');
  if(!Number.isInteger(maxOperations)||maxOperations<1||maxOperations>8192)throw new Error('KiCad route planner maxOperations must be 1..8192.');

  const minX=board.minX+edgeInset,minY=board.minY+edgeInset,maxX=board.maxX-edgeInset,maxY=board.maxY-edgeInset;
  if(maxX<=minX||maxY<=minY)throw new Error('KiCad route planner board is too small for the requested edge inset.');
  const nx=Math.floor((maxX-minX)/gridMm)+1,ny=Math.floor((maxY-minY)/gridMm)+1;
  if(nx*ny*layers.length>MAX_GRID_STATES)throw new Error(`KiCad route planner grid exceeds ${MAX_GRID_STATES} states; increase gridMm or reduce board area.`);
  const grid={originX:minX,originY:minY,step:gridMm,nx,ny};
  const existing=parseExistingTracks(source,grid,layers);
  const planned=layers.map(()=>new Set<string>());
  const obstacles=parsed.footprints.flatMap(fp=>fp.obstacle?[fp.obstacle]:[]);
  const byNet=new Map<string,Pad[]>();
  for(const pad of parsed.pads){const list=byNet.get(pad.netName)??[];list.push(pad);byNet.set(pad.netName,list);}
  if(byNet.size>MAX_NETS)throw new Error(`KiCad route planner exceeds ${MAX_NETS} named nets.`);

  const normalize=(name:string)=>name.startsWith('/')?name:'/'+name;
  const selected=options.selectedNets?.length?new Set(options.selectedNets.map(normalize)):undefined;
  const skippedExplicit=new Set((options.skipNets??[]).map(normalize));
  const styleMap=new Map((options.styles??[]).map(style=>[normalize(style.netName),style]));
  const operations:KicadRouteBatchOperation[]=[];
  const routed:Array<{netName:string;priority:number;padCount:number;edges:number;operations:number;estimatedLengthMm:number;viaCount:number}>=[];
  const skipped:Array<{netName:string;reason:string;padCount:number}>=[];

  const toGrid=(p:Point)=>({x:Math.max(0,Math.min(nx-1,Math.round((p.x-minX)/gridMm))),y:Math.max(0,Math.min(ny-1,Math.round((p.y-minY)/gridMm)))});
  const toPoint=(x:number,y:number):Point=>({x:Number((minX+x*gridMm).toFixed(4)),y:Number((minY+y*gridMm).toFixed(4))});
  const layerAccess=(pad:Pad,layer:string)=>pad.layers.includes(layer)||pad.layers.includes('*.Cu')||pad.layers.includes('F&B.Cu');
  const insideObstacle=(x:number,y:number,inflate:number,exempt:Set<string>)=>{
    const p=toPoint(x,y);
    return obstacles.some(o=>!exempt.has(o.reference??'')&&p.x>=o.minX-inflate&&p.x<=o.maxX+inflate&&p.y>=o.minY-inflate&&p.y<=o.maxY+inflate);
  };
  const padOccupied=layers.map(()=>new Map<string,Set<string>>());
  for(const pad of parsed.pads)for(let li=0;li<layers.length;li++){
    if(!layerAccess(pad,layers[li]!))continue;
    const minPadX=Math.max(0,Math.floor((pad.obstacle.minX-minX)/gridMm));
    const maxPadX=Math.min(nx-1,Math.ceil((pad.obstacle.maxX-minX)/gridMm));
    const minPadY=Math.max(0,Math.floor((pad.obstacle.minY-minY)/gridMm));
    const maxPadY=Math.min(ny-1,Math.ceil((pad.obstacle.maxY-minY)/gridMm));
    for(let x=minPadX;x<=maxPadX;x++)for(let y=minPadY;y<=maxPadY;y++){
      const key=cellKey(x,y),nets=padOccupied[li]!.get(key)??new Set<string>();
      nets.add(pad.netName);padOccupied[li]!.set(key,nets);
    }
  }
  const nearForeignPad=(layer:number,x:number,y:number,radiusMm:number,netName:string)=>{
    const radiusCells=Math.ceil(Math.max(0,radiusMm)/gridMm);
    for(let dx=-radiusCells;dx<=radiusCells;dx++)for(let dy=-radiusCells;dy<=radiusCells;dy++){
      if(Math.hypot(dx*gridMm,dy*gridMm)>radiusMm+gridMm*1.5)continue;
      const nets=padOccupied[layer]!.get(cellKey(x+dx,y+dy));
      if(nets&&[...nets].some(name=>name!==netName))return true;
    }
    return false;
  };
  const nearOccupied=(set:Set<string>,x:number,y:number,radiusMm:number)=>{
    const radiusCells=Math.ceil(Math.max(0,radiusMm)/gridMm);
    for(let dx=-radiusCells;dx<=radiusCells;dx++)for(let dy=-radiusCells;dy<=radiusCells;dy++){
      if(Math.hypot(dx*gridMm,dy*gridMm)>radiusMm+gridMm*0.75)continue;
      if(set.has(cellKey(x+dx,y+dy)))return true;
    }
    return false;
  };

  const findPath=(netName:string,start:Pad,end:Pad,width:number,clearance:number,preferredLayer?:string)=>{
    const s=toGrid(start.position),e=toGrid(end.position);
    const startLayers=layers.map((layer,index)=>({layer,index})).filter(x=>layerAccess(start,x.layer)).map(x=>x.index);
    const endLayers=new Set(layers.map((layer,index)=>({layer,index})).filter(x=>layerAccess(end,x.layer)).map(x=>x.index));
    if(!startLayers.length||!endLayers.size)return undefined;
    const exempt=new Set([start.reference,end.reference]);
    const inflate=clearance+width/2;
    const open=new MinHeap<GridState>(),g=new Map<string,number>(),parent=new Map<string,string>(),states=new Map<string,GridState>();
    for(const li of startLayers){const state={x:s.x,y:s.y,layer:li,dir:4};const key=stateKey(state);g.set(key,0);states.set(key,state);open.push(Math.hypot(e.x-s.x,e.y-s.y)*gridMm,state);}
    let expanded=0,goalKey:string|undefined;
    const dirs=[[1,0],[-1,0],[0,1],[0,-1]] as const;
    while(open.size){
      const item=open.pop()!,cur=item.value,curKey=stateKey(cur),curG=g.get(curKey);
      if(curG===undefined)continue;
      if(cur.x===e.x&&cur.y===e.y&&endLayers.has(cur.layer)){goalKey=curKey;break;}
      if(++expanded>MAX_GRID_STATES)break;
      for(let di=0;di<dirs.length;di++){
        const [dx,dy]=dirs[di]!,x=cur.x+dx,y=cur.y+dy;
        if(x<0||y<0||x>=nx||y>=ny)continue;
        const endpoint=(x===s.x&&y===s.y)||(x===e.x&&y===e.y);
        if(nearForeignPad(cur.layer,x,y,inflate,netName))continue;
        if(!endpoint&&(nearOccupied(existing[cur.layer]!,x,y,inflate)||nearOccupied(planned[cur.layer]!,x,y,inflate)||insideObstacle(x,y,inflate,exempt)))continue;
        const horizontal=dy===0,layerName=layers[cur.layer]!;
        const preferred=preferredLayer?layerName===preferredLayer:(cur.layer===0?horizontal:!horizontal);
        const step=gridMm+(preferred?0:wrongWayPenalty)+(cur.dir<4&&cur.dir!==di?turnPenalty:0);
        const next:GridState={x,y,layer:cur.layer,dir:di},key=stateKey(next),ng=curG+step;
        if(ng<(g.get(key)??Infinity)){g.set(key,ng);parent.set(key,curKey);states.set(key,next);open.push(ng+Math.hypot(e.x-x,e.y-y)*gridMm,next);}
      }
      const other=cur.layer===0?1:0;
      const endpoint=(cur.x===s.x&&cur.y===s.y)||(cur.x===e.x&&cur.y===e.y);
      const viaInflate=Math.max(inflate,viaDiameter/2+clearance);
      const viaForeignPadBlocked=[cur.layer,other].some(li=>nearForeignPad(li,cur.x,cur.y,viaInflate,netName));
      const viaBlocked=[cur.layer,other].some(li=>nearOccupied(existing[li]!,cur.x,cur.y,viaInflate)||nearOccupied(planned[li]!,cur.x,cur.y,viaInflate)||insideObstacle(cur.x,cur.y,viaInflate,exempt));
      if(!viaForeignPadBlocked&&(endpoint||!viaBlocked)){
        const next:GridState={x:cur.x,y:cur.y,layer:other,dir:4},key=stateKey(next),ng=curG+viaCost;
        if(ng<(g.get(key)??Infinity)){g.set(key,ng);parent.set(key,curKey);states.set(key,next);open.push(ng+Math.hypot(e.x-cur.x,e.y-cur.y)*gridMm,next);}
      }
    }
    if(!goalKey)return undefined;
    const path:GridState[]=[];let key:string|undefined=goalKey;
    while(key){const state=states.get(key);if(!state)break;path.push(state);key=parent.get(key);}
    path.reverse();
    return path;
  };

  const pathToOperations=(netName:string,path:GridState[],start:Pad,end:Pad,width:number)=>{
    const out:KicadRouteBatchOperation[]=[];
    if(path.length<1)return out;
    const points=path.map(s=>({...toPoint(s.x,s.y),layer:s.layer}));
    points[0]={...start.position,layer:points[0]!.layer};
    points[points.length-1]={...end.position,layer:points[points.length-1]!.layer};
    let segmentStart=points[0]!,prev=points[0]!,prevDir:{dx:number;dy:number;layer:number}|undefined;
    for(let i=1;i<points.length;i++){
      const cur=points[i]!;
      if(cur.layer!==prev.layer){
        if(Math.hypot(prev.x-segmentStart.x,prev.y-segmentStart.y)>1e-6)out.push({kind:'segment',netName,layer:layers[prev.layer]!,start:{x:segmentStart.x,y:segmentStart.y},end:{x:prev.x,y:prev.y},widthMm:width});
        out.push({kind:'via',netName,position:{x:prev.x,y:prev.y},diameterMm:viaDiameter,drillMm:viaDrill,layers:[layers[0],layers[1]]});
        segmentStart={...cur};prevDir=undefined;prev=cur;continue;
      }
      const dx=Math.sign(cur.x-prev.x),dy=Math.sign(cur.y-prev.y),dir={dx,dy,layer:cur.layer};
      if(prevDir&&(dir.dx!==prevDir.dx||dir.dy!==prevDir.dy||dir.layer!==prevDir.layer)){
        if(Math.hypot(prev.x-segmentStart.x,prev.y-segmentStart.y)>1e-6)out.push({kind:'segment',netName,layer:layers[prev.layer]!,start:{x:segmentStart.x,y:segmentStart.y},end:{x:prev.x,y:prev.y},widthMm:width});
        segmentStart={...prev};
      }
      prevDir=dir;prev=cur;
    }
    if(Math.hypot(prev.x-segmentStart.x,prev.y-segmentStart.y)>1e-6)out.push({kind:'segment',netName,layer:layers[prev.layer]!,start:{x:segmentStart.x,y:segmentStart.y},end:{x:prev.x,y:prev.y},widthMm:width});
    return out;
  };

  const priorityFor=(name:string)=>styleMap.get(name)?.priority??0;
  const candidateNets=[...byNet.entries()]
    .filter(([name,pads])=>pads.length>=2&&(!selected||selected.has(name))&&!skippedExplicit.has(name))
    .sort((a,b)=>priorityFor(b[0])-priorityFor(a[0])||a[1].length-b[1].length||a[0].localeCompare(b[0]));

  for(const [netName,pads] of candidateNets){
    if(pads.length>maxPads){skipped.push({netName,reason:`pad-count-exceeds-${maxPads}`,padCount:pads.length});continue;}
    const style=styleMap.get(netName),width=style?.widthMm??defaultWidth,clearance=style?.clearanceMm??defaultClearance,priority=style?.priority??0;
    if(width<0.05||width>20||clearance<0||clearance>10||!Number.isInteger(priority)||priority<-1000||priority>1000){skipped.push({netName,reason:'invalid-style',padCount:pads.length});continue;}
    const edges=mstEdges(pads),netOps:KicadRouteBatchOperation[]=[];const added:Array<{layer:number;cell:string}>=[];let failed=false,length=0,vias=0;
    const reserveRadius=Math.max(width/2,viaDiameter/2)+clearance;
    const reserve=(state:GridState)=>{const r=Math.ceil(reserveRadius/gridMm);for(let dx=-r;dx<=r;dx++)for(let dy=-r;dy<=r;dy++){if(Math.hypot(dx*gridMm,dy*gridMm)>reserveRadius+gridMm*0.75)continue;const x=state.x+dx,y=state.y+dy;if(x<0||y<0||x>=nx||y>=ny)continue;const cell=cellKey(x,y);if(!planned[state.layer]!.has(cell)){planned[state.layer]!.add(cell);added.push({layer:state.layer,cell});}}};
    for(const [a,b] of edges){
      const path=findPath(netName,a,b,width,clearance,style?.preferredLayer);
      if(!path){failed=true;break;}
      const edgeOps=pathToOperations(netName,path,a,b,width);
      if(operations.length+netOps.length+edgeOps.length>maxOperations){failed=true;break;}
      netOps.push(...edgeOps);
      for(const state of path)reserve(state);
      for(const op of edgeOps){if(op.kind==='segment')length+=Math.hypot(op.end.x-op.start.x,op.end.y-op.start.y);else vias++;}
    }
    if(failed){for(const item of added)planned[item.layer]!.delete(item.cell);skipped.push({netName,reason:operations.length+netOps.length>=maxOperations?'operation-limit':'no-obstacle-safe-grid-path',padCount:pads.length});continue;}
    operations.push(...netOps);routed.push({netName,priority,padCount:pads.length,edges:edges.length,operations:netOps.length,estimatedLengthMm:Number(length.toFixed(4)),viaCount:vias});
  }

  for(const [netName,pads] of byNet){
    if(pads.length<2)continue;
    if(selected&&!selected.has(netName))skipped.push({netName,reason:'not-selected',padCount:pads.length});
    else if(skippedExplicit.has(netName))skipped.push({netName,reason:'explicitly-skipped',padCount:pads.length});
  }

  return {
    schemaVersion:1,
    board:{bounds:board,widthMm:Number((board.maxX-board.minX).toFixed(4)),heightMm:Number((board.maxY-board.minY).toFixed(4)),availableCopperLayers:availableLayers,routingLayers:layers,gridMm},
    options:{edgeInsetMm:edgeInset,defaultWidthMm:defaultWidth,defaultClearanceMm:defaultClearance,viaDiameterMm:viaDiameter,viaDrillMm:viaDrill,viaCostMm:viaCost,turnPenaltyMm:turnPenalty,wrongWayPenaltyMm:wrongWayPenalty,maxPadsPerNet:maxPads,maxOperations},
    nets:{totalNamed:byNet.size,routableCandidateCount:candidateNets.length,routedCount:routed.length,skippedCount:skipped.length},
    routed,
    skipped:skipped.slice(0,512),
    operations,
    operationCount:operations.length,
    complete:skipped.filter(item=>!['not-selected','explicitly-skipped'].includes(item.reason)).length===0,
    execution:{
      tool:'kicad_route_batch_apply',
      requiresExactBoardSha:true,
      note:'Candidate routes are geometry-only. Apply in bounded batches and accept only after KiCad DRC/schematic-parity non-regression.'
    },
    limitations:[
      'Planner uses priority-ordered grid-based orthogonal routing on two selected copper layers with through-via transitions.',
      'Footprint courtyards/pad envelopes and existing copper are treated as obstacles, but KiCad DRC remains authoritative.',
      'Controlled impedance, differential-pair coupling, RF, DDR, length tuning, return-path quality and thermal/EMI behavior require explicit engineering review or specialized solvers.'
    ]
  };
}
