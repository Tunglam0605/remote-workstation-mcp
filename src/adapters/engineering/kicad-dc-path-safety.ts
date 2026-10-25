/**
 * Conservative path eligibility for track-only DC estimates.
 *
 * This graph does not resolve pad injection points, filled zones, vias, copper
 * planes, parallel copper or source/load assignment. Reject those configurations.
 * A passing result only supports a conditional straight series-track estimate,
 * never an IPC-2152 ampacity or full voltage-drop certification.
 */
export interface DcPoint { x:number; y:number }
export interface DcEdge { layer:string; start:DcPoint; end:DcPoint }
export interface DcPathSafety { eligible:boolean; reason:string; branches:number; disconnectedComponents:number }
function key(layer:string,p:DcPoint):string { return layer+'|'+p.x.toFixed(4)+'|'+p.y.toFixed(4); }
const MAX_EXPLICIT_TRACK_EDGES = 1024;
const GEOMETRY_EPS_MM = 1e-7;
function orientation(a:DcPoint,b:DcPoint,p:DcPoint):number {
  const cross=(b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x);
  const threshold=GEOMETRY_EPS_MM*Math.hypot(b.x-a.x,b.y-a.y);
  return Math.abs(cross)<=threshold?0:Math.sign(cross);
}
function onSegmentInterior(a:DcPoint,b:DcPoint,p:DcPoint):boolean {
  if(orientation(a,b,p)!==0)return false;
  const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
  const projected=((p.x-a.x)*dx+(p.y-a.y)*dy)/length;
  return projected>GEOMETRY_EPS_MM&&projected<length-GEOMETRY_EPS_MM;
}
function unsafeSameLayerContact(first:DcEdge,second:DcEdge):boolean {
  if(first.layer!==second.layer)return false;
  const a=first.start,b=first.end,c=second.start,d=second.end;
  const o1=orientation(a,b,c),o2=orientation(a,b,d);
  const o3=orientation(c,d,a),o4=orientation(c,d,b);
  if(o1===0&&o2===0) {
    // Sharing a terminal is a valid series junction; sharing copper length is not.
    const useX=Math.abs(b.x-a.x)>=Math.abs(b.y-a.y);
    const axis=(p:DcPoint)=>useX?p.x:p.y;
    const overlap=Math.min(Math.max(axis(a),axis(b)),Math.max(axis(c),axis(d)))
      -Math.max(Math.min(axis(a),axis(b)),Math.min(axis(c),axis(d)));
    if(overlap>GEOMETRY_EPS_MM)return true;
  }
  if(onSegmentInterior(a,b,c)||onSegmentInterior(a,b,d)
    ||onSegmentInterior(c,d,a)||onSegmentInterior(c,d,b))return true;
  return o1*o2<0&&o3*o4<0;
}
export function inspectDcPath(edges:DcEdge[], viaCount:number, copperZonePresent:boolean):DcPathSafety {
  const deny=(reason:string,branches=0,disconnectedComponents=0):DcPathSafety=>({eligible:false,reason,branches,disconnectedComponents});
  if(!edges.length) return deny('no-explicit-copper-track');
  if(viaCount>0) return deny('via-resistance-and-layer-current-path-unknown');
  if(copperZonePresent) return deny('zone-or-parallel-current-distribution-unknown');
  if(edges.length>MAX_EXPLICIT_TRACK_EDGES)return deny('topology-analysis-complexity-limit');
  const adjacency=new Map<string,Set<string>>();
  const connect=(a:string,b:string)=>{
    if(!adjacency.has(a))adjacency.set(a,new Set());
    if(!adjacency.has(b))adjacency.set(b,new Set());
    adjacency.get(a)!.add(b);adjacency.get(b)!.add(a);
  };
  for(const e of edges) {
    if(![e.start.x,e.start.y,e.end.x,e.end.y].every(Number.isFinite))return deny('invalid-geometry');
    const a=key(e.layer,e.start),b=key(e.layer,e.end);
    if(a===b)return deny('zero-length-track');
    if(adjacency.get(a)?.has(b))return deny('parallel-or-duplicate-tracks');
    connect(a,b);
  }
  // End-point graph topology alone misses partial overlap and midspan connections.
  // Fail closed before a summed series-track resistance could be reported.
  for(let i=0;i<edges.length;i++)for(let j=i+1;j<edges.length;j++){
    if(unsafeSameLayerContact(edges[i]!,edges[j]!))return deny('track-geometric-intersection-or-overlap');
  }
  let branches=0,leaves=0;
  for(const neighbors of adjacency.values()){
    if(neighbors.size>2)branches++;
    else if(neighbors.size===1)leaves++;
  }
  if(branches>0)return deny('branched-track-network',branches);
  const unseen=new Set(adjacency.keys());
  let components=0;
  while(unseen.size) {
    components++;
    const first=unseen.values().next().value as string;
    const stack=[first];unseen.delete(first);
    while(stack.length) for(const n of adjacency.get(stack.pop()!)??[])if(unseen.delete(n))stack.push(n);
  }
  if(components!==1 || leaves!==2)return deny('disconnected-or-looped-track-network',branches,components);
  return {eligible:true,reason:'single-series-track-assumption-no-pads-or-parallel-paths-verified',branches:0,disconnectedComponents:1};
}
