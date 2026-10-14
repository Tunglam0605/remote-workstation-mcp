/**
 * Exact-source board outline preview from KiCad Edge.Cuts.
 *
 * Converts straight segments, rectangles and three-point circular arcs into
 * a conservative sampled *inner* polygon. Any unsupported, open, fragmented
 * or multiply connected contour is explicitly unverified (never approved).
 * Geometry reports are not a substitute for KiCad DRC or 3D assembly checks.
 */
import type { PlacementPoint as Point, PlacementRect as Rect } from './kicad-placement-constraints.js';

export interface BoardOutline {
  status: 'verified-contour' | 'missing' | 'unsupported';
  reason?: string;
  outlinePoints: Point[];
  lineCount: number;
  arcCount: number;
  bounds?: Rect;
  areaMm2?: number;
}
type Edge = { start: Point; end: Point; points: Point[] };
const EPS = 0.025;
const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) <= EPS;
function blockEnd(src: string, start: number): number {
  let depth=0, quote=false, escape=false;
  for(let i=start;i<src.length;i++){
    const c=src[i]!;
    if(quote){ if(escape)escape=false; else if(c==='\\')escape=true;else if(c==='"')quote=false;continue;}
    if(c==='"'){quote=true;continue;}
    if(c==='(')depth++;else if(c===')'){depth--;if(depth===0)return i+1;}
  }
  throw new Error('Unbalanced KiCad Edge.Cuts shape.');
}
function scan(src:string,token:string):string[]{
  const output:string[]=[]; let i=0; const match='('+token;
  while((i=src.indexOf(match,i))>=0){
    if(!/[\s(]/.test(src[i+match.length]??' ')){i+=match.length;continue;}
    const end=blockEnd(src,i);output.push(src.slice(i,end));i=end;
    if(output.length>128)throw new Error('Too many Edge.Cuts primitives.');
  }
  return output;
}
function point(src:string,key:string):Point|undefined{
  const m=src.match(new RegExp('\\('+key+'\\s+(-?\\d+(?:\\.\\d+)?)\\s+(-?\\d+(?:\\.\\d+)?)\\)'));
  return m?.[1]!==undefined&&m[2]!==undefined ? {x:Number(m[1]),y:Number(m[2])}:undefined;
}
const twoPi=Math.PI*2;
const norm=(x:number)=>((x%twoPi)+twoPi)%twoPi;
function arcPoints(a:Point,m:Point,b:Point):Point[]{
  const d=2*(a.x*(m.y-b.y)+m.x*(b.y-a.y)+b.x*(a.y-m.y));
  if(Math.abs(d)<1e-9)throw Error('Degenerate circular Edge.Cuts arc.');
  const aa=a.x*a.x+a.y*a.y,mm=m.x*m.x+m.y*m.y,bb=b.x*b.x+b.y*b.y;
  const cx=(aa*(m.y-b.y)+mm*(b.y-a.y)+bb*(a.y-m.y))/d;
  const cy=(aa*(b.x-m.x)+mm*(a.x-b.x)+bb*(m.x-a.x))/d;
  const r=Math.hypot(a.x-cx,a.y-cy);
  if(r<0.1||r>100000||Math.abs(Math.hypot(m.x-cx,m.y-cy)-r)>EPS)throw Error('Invalid Edge.Cuts arc radius.');
  const t0=Math.atan2(a.y-cy,a.x-cx),tm=Math.atan2(m.y-cy,m.x-cx),t1=Math.atan2(b.y-cy,b.x-cx);
  const ccw=norm(t1-t0),viaMid=norm(tm-t0);
  const sweep=viaMid<=ccw+1e-8?ccw:-(twoPi-ccw);
  if(Math.abs(sweep)<1e-6||Math.abs(sweep)>=twoPi-1e-6)throw Error('Unsupported complete-circle Edge.Cuts arc.');
  const steps=Math.max(2,Math.ceil(Math.abs(sweep)*r/0.15));
  if(steps>2048)throw Error('Edge.Cuts arc exceeds tessellation limit.');
  const pts:Point[]=[];
  for(let i=0;i<=steps;i++){
    const t=t0+sweep*i/steps;
    pts.push(i===0?a:i===steps?b:{x:cx+r*Math.cos(t),y:cy+r*Math.sin(t)});
  }
  return pts;
}
function unsupported(reason:string,lineCount=0,arcCount=0):BoardOutline{
  return{status:'unsupported',reason,outlinePoints:[],lineCount,arcCount};
}
export function readKicadBoardOutline(src:string):BoardOutline{
  if(!src||Buffer.byteLength(src,'utf8')>32*1024*1024)throw Error('KiCad board outline source exceeds size limits.');
  const edges:Edge[]=[];
  let lines=0,arcs=0;
  for(const token of ['gr_line','gr_arc','gr_rect','gr_circle','gr_poly','gr_curve']){
    const shapes=scan(src,token);
    for(const shape of shapes){
      if(!/\(layer\s+"Edge\.Cuts"\)/.test(shape))continue;
      if(token==='gr_circle'||token==='gr_poly'||token==='gr_curve')
        return unsupported('Unsupported Edge.Cuts geometry: '+token,lines,arcs);
      const a=point(shape,'start'),b=point(shape,'end');
      if(!a||!b||near(a,b))return unsupported('Malformed or zero-length Edge.Cuts '+token,lines,arcs);
      if(token==='gr_line'){edges.push({start:a,end:b,points:[a,b]});lines++;}
      else if(token==='gr_rect'){
        const c={x:a.x,y:b.y},d={x:b.x,y:a.y};
        for(const [u,v] of [[a,d],[d,b],[b,c],[c,a]] as [Point,Point][]){
          edges.push({start:u,end:v,points:[u,v]});lines++;
        }
      }else{
        const m=point(shape,'mid');
        if(!m)return unsupported('Arc missing midpoint.',lines,arcs);
        try{edges.push({start:a,end:b,points:arcPoints(a,m,b)});arcs++;}
        catch(error){return unsupported(error instanceof Error?error.message:'Invalid arc.',lines,arcs);}
      }
    }
  }
  if(!edges.length)return{status:'missing',outlinePoints:[],lineCount:0,arcCount:0,reason:'No Edge.Cuts outline.'};
  if(edges.length>128)return unsupported('More than 128 outline segments.',lines,arcs);
  const todo=[...edges],first=todo.shift()!,outline=[...first.points];let cursor=first.end;
  while(todo.length){
    const index=todo.findIndex(e=>near(e.start,cursor)||near(e.end,cursor));
    if(index<0)return unsupported('Open or disconnected Edge.Cuts outline.',lines,arcs);
    const next=todo.splice(index,1)[0]!;
    const oriented=near(next.start,cursor)?next.points:[...next.points].reverse();
    outline.push(...oriented.slice(1));cursor=oriented.at(-1)!;
    if(outline.length>8192)return unsupported('Outline exceeds 8192 points.',lines,arcs);
    if(near(cursor,first.start)&&todo.length)return unsupported('Multiple Edge.Cuts contours or holes; unverified.',lines,arcs);
  }
  if(!near(cursor,first.start))return unsupported('Open Edge.Cuts outline.',lines,arcs);
  outline.pop();
  if(outline.length<3)return unsupported('Insufficient closed contour.',lines,arcs);
  if(outline.length>2048)return unsupported('Contour too detailed to prove self-intersection-free.',lines,arcs);
  for(let i=0;i<outline.length;i++){
    const a=outline[i]!,b=outline[(i+1)%outline.length]!;
    for(let j=i+2;j<outline.length;j++){
      if(i===0 && j===outline.length-1)continue;
      if(intersect(a,b,outline[j]!,outline[(j+1)%outline.length]!)){
        return unsupported('Self-intersecting Edge.Cuts contour.',lines,arcs);
      }
    }
  }
  const signedArea=outline.reduce((sum,p,i)=>{
    const q=outline[(i+1)%outline.length]!;
    return sum+p.x*q.y-q.x*p.y;
  },0)/2;
  if(!Number.isFinite(signedArea)||Math.abs(signedArea)<1e-5)return unsupported('Degenerate outline area.',lines,arcs);
  const bounds={minX:Math.min(...outline.map(p=>p.x)),minY:Math.min(...outline.map(p=>p.y)),
    maxX:Math.max(...outline.map(p=>p.x)),maxY:Math.max(...outline.map(p=>p.y))};
  return{status:'verified-contour',outlinePoints:outline,lineCount:lines,arcCount:arcs,bounds,
    areaMm2:Number(Math.abs(signedArea).toFixed(4))};
}
function cross(a:Point,b:Point,c:Point){return(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);}
function onSegment(p:Point,a:Point,b:Point){
  return Math.abs(cross(a,b,p))<1e-7&&
    p.x>=Math.min(a.x,b.x)-1e-7&&p.x<=Math.max(a.x,b.x)+1e-7&&
    p.y>=Math.min(a.y,b.y)-1e-7&&p.y<=Math.max(a.y,b.y)+1e-7;
}
function inside(p:Point,polygon:Point[]):boolean{
  let hit=false;
  for(let j=polygon.length-1,i=0;i<polygon.length;j=i++){
    const a=polygon[i]!,b=polygon[j]!;
    if(onSegment(p,a,b))return true;
    if(((a.y>p.y)!==(b.y>p.y))&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)hit=!hit;
  }
  return hit;
}
function segmentDistance(p:Point,a:Point,b:Point){
  const vx=b.x-a.x,vy=b.y-a.y,len=vx*vx+vy*vy;
  const t=len>1e-15?Math.max(0,Math.min(1,((p.x-a.x)*vx+(p.y-a.y)*vy)/len)):0;
  return Math.hypot(p.x-a.x-t*vx,p.y-a.y-t*vy);
}
function rectSegments(r:Rect):[Point,Point][]{
  const a={x:r.minX,y:r.minY},b={x:r.maxX,y:r.minY},c={x:r.maxX,y:r.maxY},d={x:r.minX,y:r.maxY};
  return[[a,b],[b,c],[c,d],[d,a]];
}
function intersect(a:Point,b:Point,c:Point,d:Point){
  return (cross(a,b,c)*cross(a,b,d)<-1e-9)&&(cross(c,d,a)*cross(c,d,b)<-1e-9);
}
/** Rectangle is completely inside a closed Edge.Cuts contour with edge clearance. */
export function rectWithinBoardOutline(r:Rect,outline:BoardOutline,clearanceMm=0):boolean{
  if(outline.status!=='verified-contour'||!Number.isFinite(clearanceMm)||clearanceMm<0||clearanceMm>20)return false;
  const points=outline.outlinePoints, edges=rectSegments(r);
  if(!edges.every(([a])=>inside(a,points)))return false;
  // Polygon vertices inside the rectangle may represent a concave intruding notch.
  for(const p of points)if(p.x>r.minX+1e-7&&p.x<r.maxX-1e-7&&p.y>r.minY+1e-7&&p.y<r.maxY-1e-7)return false;
  for(let i=0;i<points.length;i++){
    const c=points[i]!,d=points[(i+1)%points.length]!;
    for(const [a,b] of edges){
      if(intersect(a,b,c,d))return false;
      // Minimum between segments can occur at either of their endpoints.
      if(clearanceMm>0 && Math.min(segmentDistance(a,c,d),segmentDistance(b,c,d),
          segmentDistance(c,a,b),segmentDistance(d,a,b))<clearanceMm-1e-7)return false;
    }
  }
  return true;
}
