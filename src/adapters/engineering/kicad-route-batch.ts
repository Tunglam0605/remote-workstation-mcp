import { randomUUID } from 'node:crypto';

export type KicadRouteBatchOperation =
  | { kind:'segment'; netName:string; layer:string; start:{x:number;y:number}; end:{x:number;y:number}; widthMm:number; locked?:boolean }
  | { kind:'via'; netName:string; position:{x:number;y:number}; diameterMm:number; drillMm:number; layers?:[string,string]; locked?:boolean };

function fmt(v:number):string{return String(Number((Math.abs(v)<1e-9?0:v).toFixed(4)));}
function quote(v:string):string{return v.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/[\r\n\t]/g,' ');}

export function inspectKicadRoutingContext(source:string){
  const nets=new Map<string,number>();
  for(const match of source.matchAll(/\(net\s+(\d+)\s+"((?:\\.|[^"\\])*)"\)/g)){
    if(!match[1]||match[2]===undefined)continue;
    const name=match[2].replace(/\\(["\\])/g,'$1');
    if(!nets.has(name))nets.set(name,Number(match[1]));
  }
  const copperLayers=new Set<string>();
  const layersBlock=source.match(/\(layers([\s\S]*?)\n\s*\)\n\s*\(setup/ )?.[1]??'';
  for(const match of layersBlock.matchAll(/\(\d+\s+"([^"]+\.Cu)"/g)) if(match[1]) copperLayers.add(match[1]);
  if(!copperLayers.size){
    for(const match of source.matchAll(/\(layer\s+"([^"]+\.Cu)"\)/g)) if(match[1])copperLayers.add(match[1]);
  }
  return {nets,copperLayers};
}

function validPoint(p:{x:number;y:number}):boolean{return Number.isFinite(p.x)&&Number.isFinite(p.y)&&Math.abs(p.x)<=100000&&Math.abs(p.y)<=100000;}

export function applyKicadRouteBatch(source:string,operations:KicadRouteBatchOperation[]){
  if(!operations.length||operations.length>256)throw new Error('KiCad route batch requires 1..256 operations.');
  const {nets,copperLayers}=inspectKicadRoutingContext(source);
  if(!nets.size)throw new Error('KiCad board contains no routable named nets.');
  if(!copperLayers.size)throw new Error('KiCad board contains no detectable copper layers.');
  const rendered:string[]=[];
  const summary={segments:0,vias:0,nets:new Set<string>(),layers:new Set<string>(),totalStraightLengthMm:0};
  for(const [index,op] of operations.entries()){
    const netId=nets.get(op.netName);
    if(netId===undefined)throw new Error(`Route operation ${index+1} references unknown net ${op.netName}.`);
    summary.nets.add(op.netName);
    if(op.kind==='segment'){
      if(!copperLayers.has(op.layer))throw new Error(`Route operation ${index+1} references non-copper/unknown layer ${op.layer}.`);
      if(!validPoint(op.start)||!validPoint(op.end))throw new Error(`Route operation ${index+1} has invalid coordinates.`);
      if(Math.hypot(op.end.x-op.start.x,op.end.y-op.start.y)<1e-6)throw new Error(`Route operation ${index+1} segment length must be non-zero.`);
      if(!Number.isFinite(op.widthMm)||op.widthMm<0.05||op.widthMm>20)throw new Error(`Route operation ${index+1} widthMm must be 0.05..20.`);
      rendered.push(`\t(segment\n\t\t(start ${fmt(op.start.x)} ${fmt(op.start.y)})\n\t\t(end ${fmt(op.end.x)} ${fmt(op.end.y)})\n\t\t(width ${fmt(op.widthMm)})\n\t\t(layer "${quote(op.layer)}")\n\t\t(net ${netId})${op.locked?'\n\t\t(locked yes)':''}\n\t\t(uuid "${randomUUID()}")\n\t)`);
      summary.segments+=1;summary.layers.add(op.layer);summary.totalStraightLengthMm+=Math.hypot(op.end.x-op.start.x,op.end.y-op.start.y);
    }else{
      if(!validPoint(op.position))throw new Error(`Route operation ${index+1} has invalid via position.`);
      if(!Number.isFinite(op.diameterMm)||op.diameterMm<0.1||op.diameterMm>20)throw new Error(`Route operation ${index+1} diameterMm must be 0.1..20.`);
      if(!Number.isFinite(op.drillMm)||op.drillMm<0.05||op.drillMm>=op.diameterMm)throw new Error(`Route operation ${index+1} drillMm must be >=0.05 and smaller than diameterMm.`);
      const layers=op.layers??['F.Cu','B.Cu'];
      if(!copperLayers.has(layers[0])||!copperLayers.has(layers[1])||layers[0]===layers[1])throw new Error(`Route operation ${index+1} via layers must be two distinct existing copper layers.`);
      rendered.push(`\t(via${op.locked?' locked':''}\n\t\t(at ${fmt(op.position.x)} ${fmt(op.position.y)})\n\t\t(size ${fmt(op.diameterMm)})\n\t\t(drill ${fmt(op.drillMm)})\n\t\t(layers "${quote(layers[0])}" "${quote(layers[1])}")\n\t\t(net ${netId})\n\t\t(uuid "${randomUUID()}")\n\t)`);
      summary.vias+=1;summary.layers.add(layers[0]);summary.layers.add(layers[1]);
    }
  }
  const marker='(embedded_fonts no)';
  const markerAt=source.lastIndexOf(marker);
  if(markerAt<0)throw new Error('KiCad route batch could not locate the board insertion boundary.');
  const lineStart=source.lastIndexOf('\n',markerAt);
  const at=lineStart>=0?lineStart+1:markerAt;
  const next=source.slice(0,at)+rendered.join('\n')+'\n'+source.slice(at);
  return {source:next,summary:{segments:summary.segments,vias:summary.vias,nets:[...summary.nets].sort(),layers:[...summary.layers].sort(),totalStraightLengthMm:Number(summary.totalStraightLengthMm.toFixed(4))}};
}