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
export function inspectDcPath(edges:DcEdge[], viaCount:number, copperZonePresent:boolean):DcPathSafety {
  const deny=(reason:string,branches=0,disconnectedComponents=0):DcPathSafety=>({eligible:false,reason,branches,disconnectedComponents});
  if(!edges.length) return deny('no-explicit-copper-track');
  if(viaCount>0) return deny('via-resistance-and-layer-current-path-unknown');
  if(copperZonePresent) return deny('zone-or-parallel-current-distribution-unknown');
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
