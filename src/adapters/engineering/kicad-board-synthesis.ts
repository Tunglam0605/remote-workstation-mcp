import { randomUUID } from 'node:crypto';
import type { KicadResolvedFootprint, KicadResolvedSymbol } from './kicad-library.js';
import type { KicadSchematicNetSpec } from './kicad-schematic-synthesis.js';

export interface KicadBoardComponentSpec {
  reference: string;
  value: string;
  footprint: KicadResolvedFootprint;
  symbol: KicadResolvedSymbol;
  symbolUuid: string;
  xMm?: number;
  yMm?: number;
  rotationDeg?: number;
  side?: 'front' | 'back';
  locked?: boolean;
}

export interface KicadBoardSynthesisOptions {
  projectName: string;
  widthMm: number;
  heightMm: number;
  originXmm?: number;
  originYmm?: number;
  copperLayers?: number;
  thicknessMm?: number;
  edgeClearanceMm?: number;
}

export interface KicadBoardSynthesisResult {
  source: string;
  nets: Array<{ id: number; name: string; canonicalName: string }>;
  components: Array<{ reference: string; footprintId: string; uuid: string; position: { xMm: number; yMm: number; rotationDeg: number; side: 'front' | 'back' } }>;
}

function quote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n\t]/g, ' ');
}

function fmt(value: number): string {
  return String(Number((Math.abs(value) < 1e-9 ? 0 : value).toFixed(4)));
}

function blockEnd(text: string, start: number): number {
  let depth=0, quoted=false, escaped=false;
  for(let i=start;i<text.length;i+=1){
    const ch=text[i]!;
    if(quoted){ if(escaped) escaped=false; else if(ch==='\\') escaped=true; else if(ch==='"') quoted=false; continue; }
    if(ch==='"'){ quoted=true; continue; }
    if(ch==='(') depth+=1;
    else if(ch===')'){ depth-=1; if(depth===0) return i+1; }
  }
  throw new Error('Malformed KiCad footprint S-expression.');
}

function tokenOf(block:string):string { return block.match(/^\(\s*([^\s()]+)/)?.[1] ?? ''; }

function immediateChildren(block:string):Array<{token:string;block:string}> {
  const out:Array<{token:string;block:string}>=[];
  let depth=0, quoted=false, escaped=false;
  for(let i=0;i<block.length;i+=1){
    const ch=block[i]!;
    if(quoted){ if(escaped) escaped=false; else if(ch==='\\') escaped=true; else if(ch==='"') quoted=false; continue; }
    if(ch==='"'){ quoted=true; continue; }
    if(ch==='('){
      if(depth===0){depth=1;continue;}
      if(depth===1){const end=blockEnd(block,i);const child=block.slice(i,end);out.push({token:tokenOf(child),block:child});i=end-1;continue;}
      depth+=1;
    } else if(ch===')') depth=Math.max(0,depth-1);
  }
  return out;
}

function firstQuotedArg(block:string,token:string):string|undefined {
  const escaped=token.replace(/[.*+?^$()|[\]\\]/g,'\\$&');
  const m=block.match(new RegExp('^\\('+escaped+'\\s+"((?:\\\\.|[^"\\\\])*)"','i'));
  return m?.[1]?.replace(/\\(["\\])/g,'$1');
}

function withUuid(block:string):string {
  if(/\(uuid\s+"[^"]+"\)/.test(block)) return block;
  return block.slice(0,-1)+`\n\t\t(uuid "${randomUUID()}")\n\t)`;
}

function propertyName(block:string):string|undefined { return firstQuotedArg(block,'property'); }

function replacePropertyValue(block:string,value:string):string {
  return block.replace(/^(\(property\s+"(?:\\.|[^"\\])*"\s+)"(?:\\.|[^"\\])*"/, `$1"${quote(value)}"`);
}

function rotateChildAt(block:string,footprintRotationDeg:number):string {
  const normalizedFootprint=((footprintRotationDeg%360)+360)%360;
  if(Math.abs(normalizedFootprint)<1e-9)return block;
  return block.replace(/\(at\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+(-?\d+(?:\.\d+)?))?\)/,(_match,x,y,angle)=>{
    const local=angle===undefined?0:Number(angle);
    const rotated=((local+normalizedFootprint)%360+360)%360;
    return `(at ${x} ${y} ${fmt(rotated)})`;
  });
}

function stripImmediateTokens(block:string,tokens:Set<string>):string {
  let result=block;
  const children=immediateChildren(block).filter(child=>tokens.has(child.token)).sort((a,b)=>block.indexOf(b.block)-block.indexOf(a.block));
  for(const child of children){const idx=result.indexOf(child.block);if(idx>=0) result=result.slice(0,idx)+result.slice(idx+child.block.length);}
  return result;
}

function injectBeforeClose(block:string,lines:string[]):string {
  return block.slice(0,-1)+lines.map(line=>'\n\t\t'+line).join('')+'\n\t)';
}

export function canonicalKicadBoardNetName(name:string):string {
  // KiCad's auto-generated no-connect net names are already canonical and must
  // stay unscoped so PCB/schematic parity can match them exactly.
  if(name.startsWith('unconnected-(')) return name;
  // Schematic synthesis currently emits local labels, so KiCad canonicalizes every
  // root-sheet label as /NAME regardless of conventional power-like spelling.
  // True global labels/power-symbol nets will require an explicit net-scope field.
  if(name.startsWith('/')) return name;
  return '/'+name;
}

function copperLayerTable(count:number):string[] {
  if(!Number.isInteger(count) || count<2 || count>12 || count%2!==0) throw new Error('Board copperLayers must be an even integer in range 2..12.');
  const rows=['\t\t(0 "F.Cu" signal)'];
  for(let i=1;i<count-1;i+=1) rows.push(`\t\t(${2+i*2} "In${i}.Cu" ${i%2===0?'power':'signal'})`);
  rows.push('\t\t(2 "B.Cu" signal)');
  rows.push('\t\t(9 "F.Adhes" user "F.Adhesive")','\t\t(11 "B.Adhes" user "B.Adhesive")','\t\t(13 "F.Paste" user)','\t\t(15 "B.Paste" user)','\t\t(5 "F.SilkS" user "F.Silkscreen")','\t\t(7 "B.SilkS" user "B.Silkscreen")','\t\t(1 "F.Mask" user)','\t\t(3 "B.Mask" user)','\t\t(17 "Dwgs.User" user "User.Drawings")','\t\t(19 "Cmts.User" user "User.Comments")','\t\t(21 "Eco1.User" user "User.Eco1")','\t\t(23 "Eco2.User" user "User.Eco2")','\t\t(25 "Edge.Cuts" user)','\t\t(27 "Margin" user)','\t\t(31 "F.CrtYd" user "F.Courtyard")','\t\t(29 "B.CrtYd" user "B.Courtyard")','\t\t(35 "F.Fab" user)','\t\t(33 "B.Fab" user)');
  return rows;
}

function stackup(count:number,thickness:number):string {
  const copper=0.035;
  const mask=0.01;
  const dielectricCount=count-1;
  const dielectric=Math.max(0.05,(thickness-copper*count-mask*2)/dielectricCount);
  const lines=['\t\t(stackup','\t\t\t(layer "F.SilkS" (type "Top Silk Screen"))','\t\t\t(layer "F.Paste" (type "Top Solder Paste"))','\t\t\t(layer "F.Mask" (type "Top Solder Mask") (thickness 0.01))','\t\t\t(layer "F.Cu" (type "copper") (thickness 0.035))'];
  for(let i=1;i<count;i+=1){
    lines.push(`\t\t\t(layer "dielectric ${i}" (type "${i%2===1?'prepreg':'core'}") (thickness ${fmt(dielectric)}) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02))`);
    const copperName=i===count-1?'B.Cu':`In${i}.Cu`;
    lines.push(`\t\t\t(layer "${copperName}" (type "copper") (thickness 0.035))`);
  }
  lines.push('\t\t\t(layer "B.Mask" (type "Bottom Solder Mask") (thickness 0.01))','\t\t\t(layer "B.Paste" (type "Bottom Solder Paste"))','\t\t\t(layer "B.SilkS" (type "Bottom Silk Screen"))','\t\t\t(copper_finish "ENIG")','\t\t\t(dielectric_constraints no)','\t\t)');
  return lines.join('\n');
}

function autoPosition(index:number,width:number,height:number,ox:number,oy:number):{x:number;y:number} {
  const cols=Math.max(1,Math.ceil(Math.sqrt(index+1)));
  const margin=Math.min(10,Math.min(width,height)*0.15);
  const usableW=Math.max(1,width-2*margin), usableH=Math.max(1,height-2*margin);
  const x=ox+margin+(index%cols+0.5)*(usableW/cols);
  const rows=Math.ceil((index+1)/cols);
  const y=oy+margin+(Math.floor(index/cols)+0.5)*(usableH/Math.max(1,rows));
  return {x,y};
}

function boardFootprint(component:KicadBoardComponentSpec,netIds:Map<string,{id:number;canonical:string}>,pinNets:Map<string,string>,projectName:string,index:number,width:number,height:number,ox:number,oy:number):{source:string;uuid:string;position:{xMm:number;yMm:number;rotationDeg:number;side:'front'|'back'}} {
  const uuid=randomUUID();
  const auto=autoPosition(index,width,height,ox,oy);
  const x=component.xMm??auto.x, y=component.yMm??auto.y, rotation=component.rotationDeg??0, side=component.side??'front';
  const layer=side==='front'?'F.Cu':'B.Cu';
  const children=immediateChildren(component.footprint.source);
  const body:string[]=[];
  let hadRef=false,hadValue=false;
  for(const child of children){
    if(['version','generator','generator_version','layer','uuid','at','embedded_fonts'].includes(child.token)) continue;
    if(child.token==='property'){
      const name=propertyName(child.block);
      let block=child.block;
      if(name==='Reference'){block=replacePropertyValue(block,component.reference);hadRef=true;}
      else if(name==='Value'){block=replacePropertyValue(block,component.value);hadValue=true;}
      block=rotateChildAt(block,rotation);
      body.push(withUuid(block));
      continue;
    }
    if(child.token==='pad'){
      const padNumber=firstQuotedArg(child.block,'pad')??'';
      let block=rotateChildAt(stripImmediateTokens(child.block,new Set(['net','pinfunction','pintype','uuid'])),rotation);
      const netName=pinNets.get(component.reference+'\u0000'+padNumber);
      const pin=component.symbol.pins.find(p=>p.number===padNumber);
      const lines:string[]=[];
      if(netName){const entry=netIds.get(netName)!;lines.push(`(net ${entry.id} "${quote(entry.canonical)}")`);}
      if(pin){lines.push(`(pinfunction "${quote(pin.name)}")`,`(pintype "${quote(pin.electricalType)}")`);}
      lines.push(`(uuid "${randomUUID()}")`);
      block=injectBeforeClose(block,lines);
      body.push(block);
      continue;
    }
    if(['fp_text','fp_text_box'].includes(child.token)) body.push(withUuid(rotateChildAt(child.block,rotation)));
    else if(['fp_line','fp_arc','fp_rect','fp_circle','fp_poly','zone','group'].includes(child.token)) body.push(withUuid(child.block));
    else body.push(child.block);
  }
  if(!hadRef) body.unshift(`(property "Reference" "${quote(component.reference)}" (at 0 -2 ${fmt(((rotation%360)+360)%360)}) (layer "F.SilkS") (uuid "${randomUUID()}") (effects (font (size 1 1) (thickness 0.15))))`);
  if(!hadValue) body.unshift(`(property "Value" "${quote(component.value)}" (at 0 2 ${fmt(((rotation%360)+360)%360)}) (layer "F.Fab") (uuid "${randomUUID()}") (effects (font (size 1 1) (thickness 0.15))))`);
  const datasheet=component.symbol.properties.Datasheet?.trim();
  if(datasheet && datasheet!=='~' && !body.some(block=>propertyName(block)==='Datasheet')) {
    body.push(`(property "Datasheet" "${quote(datasheet)}" (at 0 0 ${fmt(((rotation%360)+360)%360)}) (layer "F.Fab") (hide yes) (uuid "${randomUUID()}") (effects (font (size 1 1) (thickness 0.15))))`);
  }
  const description=component.symbol.properties.Description?.trim();
  if(description && !body.some(block=>propertyName(block)==='Description')) {
    body.push(`(property "Description" "${quote(description)}" (at 0 0 ${fmt(((rotation%360)+360)%360)}) (layer "F.Fab") (hide yes) (uuid "${randomUUID()}") (effects (font (size 1 1) (thickness 0.15))))`);
  }
  const rendered=[`\t(footprint "${quote(component.footprint.id)}"`,`\t\t(layer "${layer}")`,`\t\t(uuid "${uuid}")`,`\t\t(at ${fmt(x)} ${fmt(y)} ${fmt(rotation)})`,`\t\t(path "/${component.symbolUuid}")`,'\t\t(sheetname "/")',`\t\t(sheetfile "${quote(projectName)}.kicad_sch")`,...body.map(block=>'\t\t'+block.replace(/\n/g,'\n\t\t')),'\t\t(embedded_fonts no)','\t)'].join('\n');
  return {source:rendered,uuid,position:{xMm:x,yMm:y,rotationDeg:rotation,side}};
}

export function synthesizeKicadBoard(components:KicadBoardComponentSpec[],nets:KicadSchematicNetSpec[],options:KicadBoardSynthesisOptions):KicadBoardSynthesisResult {
  if(components.length<1||components.length>128) throw new Error('Board synthesis requires 1..128 components.');
  if(!Number.isFinite(options.widthMm)||options.widthMm<10||options.widthMm>1000||!Number.isFinite(options.heightMm)||options.heightMm<10||options.heightMm>1000) throw new Error('Board width/height must be in range 10..1000 mm.');
  const copperLayers=options.copperLayers??2, thickness=options.thicknessMm??1.6, ox=options.originXmm??20, oy=options.originYmm??20;
  if(!Number.isFinite(thickness)||thickness<0.2||thickness>10) throw new Error('Board thickness must be in range 0.2..10 mm.');
  const netList=nets.map((net,index)=>({id:index+1,name:net.name,canonical:canonicalKicadBoardNetName(net.name)}));
  const netIds=new Map(netList.map(net=>[net.name,{id:net.id,canonical:net.canonical}]));
  const pinNets=new Map<string,string>();
  for(const net of nets) for(const ep of net.endpoints){const key=ep.reference+'\u0000'+ep.pinNumber;if(pinNets.has(key)) throw new Error(`Board pin ${ep.reference}.${ep.pinNumber} belongs to multiple nets.`);pinNets.set(key,net.name);}
  const refSet=new Set(components.map(c=>c.reference));
  for(const net of nets) for(const ep of net.endpoints) if(!refSet.has(ep.reference)) throw new Error(`Board net ${net.name} references unknown component ${ep.reference}.`);
  const fpRendered=components.map((component,index)=>boardFootprint(component,netIds,pinNets,options.projectName,index,options.widthMm,options.heightMm,ox,oy));
  const edge=`\t(gr_rect\n\t\t(start ${fmt(ox)} ${fmt(oy)})\n\t\t(end ${fmt(ox+options.widthMm)} ${fmt(oy+options.heightMm)})\n\t\t(stroke (width 0.05) (type default))\n\t\t(fill none)\n\t\t(layer "Edge.Cuts")\n\t\t(uuid "${randomUUID()}")\n\t)`;
  const source=['(kicad_pcb','\t(version 20241229)','\t(generator "rwmcp")','\t(generator_version "0.68")',`\t(general (thickness ${fmt(thickness)}) (legacy_teardrops no))`,'\t(paper "A4")','\t(layers',...copperLayerTable(copperLayers),'\t)','\t(setup',stackup(copperLayers,thickness),'\t\t(pad_to_mask_clearance 0)','\t\t(allow_soldermask_bridges_in_footprints no)','\t\t(tenting front back)','\t)', '\t(net 0 "")',...netList.map(net=>`\t(net ${net.id} "${quote(net.canonical)}")`),...fpRendered.map(item=>item.source),edge,'\t(embedded_fonts no)',')',''].join('\n');
  return {source,nets:netList.map(net=>({id:net.id,name:net.name,canonicalName:net.canonical})),components:fpRendered.map((item,index)=>({reference:components[index]!.reference,footprintId:components[index]!.footprint.id,uuid:item.uuid,position:item.position}))};
}
