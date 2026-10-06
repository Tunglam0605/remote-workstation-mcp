export type KicadPlacementRole =
  | 'mcu'
  | 'connector'
  | 'debug'
  | 'power'
  | 'transceiver'
  | 'crystal'
  | 'decoupling'
  | 'sensor'
  | 'driver'
  | 'generic';

export interface KicadPlacementHint {
  reference: string;
  role?: KicadPlacementRole;
  anchorRef?: string;
  edge?: 'top' | 'bottom' | 'left' | 'right';
  locked?: boolean;
}

export interface KicadPlacementPlanOptions {
  widthMm: number;
  heightMm: number;
  originXmm?: number;
  originYmm?: number;
  gridMm?: number;
  minSpacingMm?: number;
  edgeInsetMm?: number;
  maxDetails?: number;
  hints?: KicadPlacementHint[];
}

type ManifestComponent = {
  reference: string;
  symbolId: string;
  value: string;
  footprintId?: string;
  onBoard: boolean;
};

type ManifestNet = {
  name: string;
  endpoints: Array<{ reference: string; pinNumber: string }>;
};

type Point = { x: number; y: number };

type Placement = {
  reference: string;
  role: KicadPlacementRole;
  xMm: number;
  yMm: number;
  rotationDeg: number;
  side: 'front';
  locked: boolean;
  rationale: string[];
};

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function parsePlacementManifest(raw: unknown): { components: ManifestComponent[]; nets: ManifestNet[] } {
  const root=asRecord(raw);
  const components=asArray(root.components).map(asRecord).filter(item=>item.onBoard!==false).map(item=>({
    reference: typeof item.reference==='string'?item.reference:'',
    symbolId: typeof item.symbolId==='string'?item.symbolId:'',
    value: typeof item.value==='string'?item.value:'',
    ...(typeof item.footprintId==='string'?{footprintId:item.footprintId}:{}),
    onBoard:item.onBoard!==false
  })).filter(item=>item.reference && item.symbolId);
  const nets=asArray(root.nets).map(asRecord).map(item=>({
    name: typeof item.name==='string'?item.name:'',
    endpoints: asArray(item.endpoints).map(asRecord).map(ep=>({
      reference: typeof ep.reference==='string'?ep.reference:'',
      pinNumber: typeof ep.pinNumber==='string'?ep.pinNumber:''
    })).filter(ep=>ep.reference&&ep.pinNumber)
  })).filter(net=>net.name&&net.endpoints.length);
  return {components,nets};
}

function inferRole(component: ManifestComponent): KicadPlacementRole {
  const hay=(component.reference+' '+component.symbolId+' '+component.value+' '+(component.footprintId??'')).toLowerCase();
  const ref=component.reference.toUpperCase();
  if (/(?:^|[^a-z0-9])(?:stm32|esp32|mcu|microcontroller|rp2040|atmega|samd|nrf52|gd32)/.test(hay)) return 'mcu';
  if (/\b(?:swd|jtag|debug|tag-connect)\b/.test(hay)) return 'debug';
  if (/\b(?:can|rs485|rs-485|transceiver|sn65|tja10|max3485|adm3485)\b/.test(hay)) return 'transceiver';
  if (/\b(?:crystal|xtal|oscillator|osc_)\b/.test(hay) || /^Y\d+/i.test(ref)) return 'crystal';
  if (/\b(?:buck|boost|ldo|regulator|dc-dc|dcdc|power|mosfet|inductor)\b/.test(hay) || /^L\d+/i.test(ref)) return 'power';
  if (/\b(?:connector|header|usb-c|terminal|jack|jst|molex)\b/.test(hay) || /^(J|P)\d+/i.test(ref)) return 'connector';
  if (/\b(?:imu|accelerometer|gyroscope|sensor|encoder)\b/.test(hay)) return 'sensor';
  if (/\b(?:driver|gate_driver|motor)\b/.test(hay)) return 'driver';
  if (/^C\d+/i.test(ref) && /(?:100n|0\.1u|100nf|1u|2\.2u|4\.7u|10u)/i.test(component.value)) return 'decoupling';
  return 'generic';
}

function snap(v:number,grid:number){return Math.round(v/grid)*grid;}
function clamp(v:number,min:number,max:number){return Math.max(min,Math.min(max,v));}
function distance(a:Point,b:Point){return Math.hypot(a.x-b.x,a.y-b.y);}

function adjacency(nets: ManifestNet[]): Map<string, Map<string, number>> {
  const map=new Map<string,Map<string,number>>();
  for(const net of nets){
    const refs=[...new Set(net.endpoints.map(ep=>ep.reference))];
    const weight=1/Math.max(1,refs.length-1);
    for(let i=0;i<refs.length;i++) for(let j=i+1;j<refs.length;j++){
      const a=refs[i]!, b=refs[j]!;
      for(const [from,to] of [[a,b],[b,a]] as const){
        const row=map.get(from)??new Map<string,number>();
        row.set(to,(row.get(to)??0)+weight);
        map.set(from,row);
      }
    }
  }
  return map;
}

function nearestAnchor(ref:string,role:KicadPlacementRole,hints:Map<string,KicadPlacementHint>,placed:Map<string,Placement>,links:Map<string,Map<string,number>>):string|undefined {
  const explicit=hints.get(ref)?.anchorRef;
  if(explicit&&placed.has(explicit)) return explicit;
  const neighbors=[...(links.get(ref)?.entries()??[])].filter(([candidate])=>placed.has(candidate)).sort((a,b)=>b[1]-a[1]);
  if(role==='decoupling'||role==='crystal'){
    const mcu=neighbors.find(([candidate])=>placed.get(candidate)?.role==='mcu');
    if(mcu) return mcu[0];
  }
  if(role==='transceiver'){
    const connector=neighbors.find(([candidate])=>placed.get(candidate)?.role==='connector');
    if(connector) return connector[0];
  }
  return neighbors[0]?.[0];
}

function collisionFree(candidate:Point,placed:Map<string,Placement>,minSpacing:number,bounds:{minX:number;maxX:number;minY:number;maxY:number},grid:number):Point {
  const ok=(p:Point)=>[...placed.values()].every(existing=>distance(p,{x:existing.xMm,y:existing.yMm})>=minSpacing-1e-9);
  const normalize=(p:Point)=>({x:snap(clamp(p.x,bounds.minX,bounds.maxX),grid),y:snap(clamp(p.y,bounds.minY,bounds.maxY),grid)});
  let p=normalize(candidate);
  if(ok(p)) return p;
  for(let ring=1;ring<=40;ring++){
    const d=ring*grid;
    const candidates=[
      {x:p.x+d,y:p.y},{x:p.x-d,y:p.y},{x:p.x,y:p.y+d},{x:p.x,y:p.y-d},
      {x:p.x+d,y:p.y+d},{x:p.x-d,y:p.y+d},{x:p.x+d,y:p.y-d},{x:p.x-d,y:p.y-d}
    ].map(normalize);
    const free=candidates.find(ok);
    if(free) return free;
  }
  return p;
}

export function planKicadSemanticPlacement(manifest:unknown,options:KicadPlacementPlanOptions){
  if(!finite(options.widthMm)||options.widthMm<20||options.widthMm>1000||!finite(options.heightMm)||options.heightMm<20||options.heightMm>1000) throw new Error('Semantic placement board width/height must be in range 20..1000 mm.');
  const originX=options.originXmm??20, originY=options.originYmm??20;
  const grid=options.gridMm??0.5, minSpacing=options.minSpacingMm??3, edgeInset=options.edgeInsetMm??4;
  if(!finite(grid)||grid<=0||grid>10) throw new Error('Semantic placement gridMm must be in range >0..10.');
  if(!finite(minSpacing)||minSpacing<0.5||minSpacing>50) throw new Error('Semantic placement minSpacingMm must be in range 0.5..50.');
  if(!finite(edgeInset)||edgeInset<1||edgeInset>50) throw new Error('Semantic placement edgeInsetMm must be in range 1..50.');
  const parsed=parsePlacementManifest(manifest);
  if(!parsed.components.length) throw new Error('Semantic placement manifest has no on-board components.');
  if(parsed.components.length>256) throw new Error('Semantic placement supports at most 256 on-board components.');
  const hintMap=new Map((options.hints??[]).map(h=>[h.reference,h]));
  for(const hint of options.hints??[]) if(!parsed.components.some(c=>c.reference===hint.reference)) throw new Error(`Placement hint references unknown component ${hint.reference}.`);
  const roles=new Map(parsed.components.map(c=>[c.reference,hintMap.get(c.reference)?.role??inferRole(c)]));
  const links=adjacency(parsed.nets);
  const placed=new Map<string,Placement>();
  const bounds={minX:originX+edgeInset,maxX:originX+options.widthMm-edgeInset,minY:originY+edgeInset,maxY:originY+options.heightMm-edgeInset};
  const center={x:originX+options.widthMm/2,y:originY+options.heightMm/2};
  const byRole=(role:KicadPlacementRole)=>parsed.components.filter(c=>roles.get(c.reference)===role);

  const put=(component:ManifestComponent,point:Point,rotation:number,rationale:string[])=>{
    const safe=collisionFree(point,placed,minSpacing,bounds,grid);
    placed.set(component.reference,{reference:component.reference,role:roles.get(component.reference)??'generic',xMm:safe.x,yMm:safe.y,rotationDeg:rotation,side:'front',locked:hintMap.get(component.reference)?.locked===true,rationale});
  };

  const mcu=byRole('mcu');
  mcu.forEach((c,i)=>put(c,{x:center.x+(i-(mcu.length-1)/2)*Math.max(minSpacing,8),y:center.y},0,['MCU/core logic is placed near the board center to reduce average fanout distance.']));

  const edgeRoles:KicadPlacementRole[]=['connector','debug'];
  for(const role of edgeRoles){
    const list=byRole(role);
    list.forEach((c,i)=>{
      const edge=hintMap.get(c.reference)?.edge??(role==='debug'?'top':'right');
      const frac=(i+1)/(list.length+1);
      let p:Point; let rotation=0;
      if(edge==='right'){p={x:bounds.maxX,y:originY+edgeInset+frac*(options.heightMm-2*edgeInset)};rotation=90;}
      else if(edge==='left'){p={x:bounds.minX,y:originY+edgeInset+frac*(options.heightMm-2*edgeInset)};rotation=90;}
      else if(edge==='bottom'){p={x:originX+edgeInset+frac*(options.widthMm-2*edgeInset),y:bounds.maxY};rotation=0;}
      else {p={x:originX+edgeInset+frac*(options.widthMm-2*edgeInset),y:bounds.minY};rotation=0;}
      put(c,p,rotation,[`${role} component is edge-biased for cable/debug accessibility.`,`Preferred edge: ${edge}.`]);
    });
  }

  const power=byRole('power');
  power.forEach((c,i)=>put(c,{x:bounds.minX+(i%2)*Math.max(minSpacing,6),y:bounds.minY+Math.floor(i/2)*Math.max(minSpacing,6)},0,['Power-stage component is grouped into a board-corner region to bound switching-current loops and separate noisy power from core logic.']));

  for(const role of ['transceiver','crystal','decoupling','sensor','driver'] as KicadPlacementRole[]){
    for(const c of byRole(role)){
      const anchor=nearestAnchor(c.reference,role,hintMap,placed,links);
      if(anchor){
        const a=placed.get(anchor)!;
        const index=[...placed.values()].filter(p=>p.rationale.some(r=>r.includes(anchor))).length;
        const radius=role==='decoupling'?3:role==='crystal'?5:role==='transceiver'?7:8;
        const angle=(index%8)*(Math.PI/4);
        put(c,{x:a.xMm+Math.cos(angle)*radius,y:a.yMm+Math.sin(angle)*radius},0,[`${role} component is kept near connectivity anchor ${anchor}.`,`Nominal semantic radius: ${radius} mm.`]);
      }else{
        put(c,{x:center.x,y:center.y},0,[`${role} component had no resolved placed anchor; fallback uses central placement and requires review.`]);
      }
    }
  }

  const remaining=parsed.components.filter(c=>!placed.has(c.reference));
  for(const c of remaining){
    const neighbors=[...(links.get(c.reference)?.entries()??[])].filter(([ref])=>placed.has(ref));
    let target=center;
    if(neighbors.length){
      let sx=0,sy=0,sw=0;
      for(const [ref,w] of neighbors){const p=placed.get(ref)!;sx+=p.xMm*w;sy+=p.yMm*w;sw+=w;}
      if(sw>0) target={x:sx/sw,y:sy/sw};
    }
    put(c,target,0,[neighbors.length?'Generic component uses weighted centroid of already-placed connected neighbors.':'Generic component has no placed connectivity anchor; fallback uses board center.']);
  }

  const placements=[...placed.values()].sort((a,b)=>a.reference.localeCompare(b.reference,undefined,{numeric:true}));
  const roleCounts:Record<string,number>={};
  for(const p of placements) roleCounts[p.role]=(roleCounts[p.role]??0)+1;
  return {
    schemaVersion:1,
    board:{widthMm:options.widthMm,heightMm:options.heightMm,originXmm:originX,originYmm:originY,gridMm:grid,minSpacingMm:minSpacing,edgeInsetMm:edgeInset},
    componentCount:placements.length,
    roleCounts,
    placements,
    executionHint:{
      tool:'kicad_board_synthesize',
      field:'placements',
      note:'Use these placements when synthesizing a new board; each placement remains a reviewable typed input rather than an implicit mutation.'
    }
  };
}
