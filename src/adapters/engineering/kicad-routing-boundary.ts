/**
 * Exact native Edge.Cuts routing envelope. Every copper centerline, via and
 * completed segment must fit inside a verified contour with copper-to-edge
 * clearance. Never interpret the rectangle enclosing rounded corners as PCB.
 */
import { readKicadBoardOutline, type BoardOutline } from './kicad-board-outline.js';
type P={x:number;y:number};
const cross=(a:P,b:P,c:P)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const distance=(p:P,a:P,b:P)=>{
  const dx=b.x-a.x,dy=b.y-a.y,den=dx*dx+dy*dy;
  const t=den>1e-15?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/den)):0;
  return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
};
const intersects=(a:P,b:P,c:P,d:P)=>{
  const ab1=cross(a,b,c),ab2=cross(a,b,d),cd1=cross(c,d,a),cd2=cross(c,d,b);
  return ab1*ab2<-1e-10&&cd1*cd2<-1e-10;
};
function inside(p:P,vertices:P[]){
  let parity=false;
  for(let i=0,j=vertices.length-1;i<vertices.length;j=i++){
    const a=vertices[i]!,b=vertices[j]!;
    if(distance(p,a,b)<1e-8)return true;
    if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)parity=!parity;
  }
  return parity;
}
export interface KicadRoutingBoundary {
  outline:BoardOutline;
  pointAllowed:(point:P,edgeGapMm:number)=>boolean;
  segmentAllowed:(start:P,end:P,edgeGapMm:number)=>boolean;
}
export function buildKicadRoutingBoundary(source:string):KicadRoutingBoundary{
  const outline=readKicadBoardOutline(source);
  if(outline.status!=='verified-contour')throw Error(
    'KiCad routing requires a verified native Edge.Cuts contour, not bounding-box-only geometry: '+(outline.reason??outline.status)
  );
  const vertices=outline.outlinePoints;
  const segments=vertices.map((v,i)=>[v,vertices[(i+1)%vertices.length]!] as const);
  const limits=outline.bounds!;
  // Cache only exact numerical coordinates; rounded keys could merge a
  // just-outside point with a just-inside point at fine copper edge clearance.
  const memo=new Map<string,boolean>();
  const pointAllowed=(p:P,edgeGapMm:number)=>{
    if(!Number.isFinite(edgeGapMm)||edgeGapMm<0||edgeGapMm>20||
       !Number.isFinite(p.x)||!Number.isFinite(p.y))return false;
    const key=String(p.x)+','+String(p.y)+','+String(edgeGapMm);
    const cached=memo.get(key);
    if(cached!==undefined)return cached;
    let good=p.x>=limits.minX+edgeGapMm-1e-7&&p.x<=limits.maxX-edgeGapMm+1e-7&&
      p.y>=limits.minY+edgeGapMm-1e-7&&p.y<=limits.maxY-edgeGapMm+1e-7&&inside(p,vertices);
    if(good){
      for(const [a,b] of segments){
        if(distance(p,a,b)<edgeGapMm-1e-7){good=false;break;}
      }
    }
    if(memo.size<400000)memo.set(key,good);
    return good;
  };
  const segmentAllowed=(a:P,b:P,gap:number)=>{
    if(!pointAllowed(a,gap)||!pointAllowed(b,gap))return false;
    if(Math.hypot(b.x-a.x,b.y-a.y)<1e-9)return true;
    for(const [c,d] of segments){
      if(intersects(a,b,c,d))return false;
      if(gap>0 && Math.min(distance(a,c,d),distance(b,c,d),
        distance(c,a,b),distance(d,a,b))<gap-1e-7)return false;
    }
    // Endpoint tests and crossing checks suffice for a simple closed contour.
    return true;
  };
  return {outline,pointAllowed,segmentAllowed};
}
