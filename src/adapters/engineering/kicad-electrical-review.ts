const COPPER_RESISTIVITY_OHM_M_20C = 1.724e-8;
const MAX_BLOCKS = 250000;

type Point={x:number;y:number};
export type KicadElectricalNetKind='power'|'clock'|'differential'|'can'|'rs485'|'pwm'|'encoder'|'analog'|'digital'|'high_speed';
export interface KicadElectricalNetIntent{
  netName:string;
  kind:KicadElectricalNetKind;
  currentA?:number;
  voltageV?:number;
  maxVoltageDropPct?:number;
  maxLengthMm?:number;
  maxViaCount?:number;
  targetImpedanceOhm?:number;
  pairWith?:string;
  maxSkewMm?:number;
}

type Route={name:string;segments:number;arcs:number;vias:number;lengthMm:number;layers:Set<string>;resistanceOhm?:number;resistanceCoverageLengthMm:number;widths:Set<number>};

function blockEnd(text:string,start:number):number{let depth=0,quoted=false,escaped=false;for(let i=start;i<text.length;i++){const ch=text[i]!;if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}if(ch==='"'){quoted=true;continue;}if(ch==='(')depth++;else if(ch===')'){depth--;if(depth===0)return i+1;}}throw new Error('Malformed KiCad S-expression.');}
function* blocks(text:string,token:string,limit=MAX_BLOCKS):Generator<string>{const marker='('+token;let cursor=0,count=0;while(cursor<text.length){const start=text.indexOf(marker,cursor);if(start<0)break;const next=text[start+marker.length]??'';if(next&&!/\s|"/.test(next)){cursor=start+marker.length;continue;}const end=blockEnd(text,start);if(++count>limit)throw new Error('KiCad electrical review block limit exceeded for '+token+'.');yield text.slice(start,end);cursor=end;}}
function num(block:string,token:string):number|undefined{const m=block.match(new RegExp('\\('+token+'\\s+(-?\\d+(?:\\.\\d+)?)'));return m?.[1]!==undefined?Number(m[1]):undefined;}
function point(block:string,token:string):Point|undefined{const m=block.match(new RegExp('\\('+token+'\\s+(-?\\d+(?:\\.\\d+)?)\\s+(-?\\d+(?:\\.\\d+)?)'));return m?.[1]&&m[2]?{x:Number(m[1]),y:Number(m[2])}:undefined;}
function layer(block:string):string|undefined{return block.match(/\(layer\s+"([^"]+)"\)/)?.[1];}
function netNames(source:string):Map<number,string>{const map=new Map<number,string>();for(const m of source.matchAll(/\(net\s+(\d+)\s+"((?:\\.|[^"\\])*)"\)/g)){if(m[1]&&m[2]!==undefined&&!map.has(Number(m[1])))map.set(Number(m[1]),m[2].replace(/\\(["\\])/g,'$1'));}return map;}
function normalizeSweep(v:number){let x=v%(Math.PI*2);if(x<0)x+=Math.PI*2;return x;}
function arcLength(a:Point,m:Point,c:Point):number{const d=2*(a.x*(m.y-c.y)+m.x*(c.y-a.y)+c.x*(a.y-m.y));if(Math.abs(d)<1e-9)return Math.hypot(m.x-a.x,m.y-a.y)+Math.hypot(c.x-m.x,c.y-m.y);const ux=((a.x*a.x+a.y*a.y)*(m.y-c.y)+(m.x*m.x+m.y*m.y)*(c.y-a.y)+(c.x*c.x+c.y*c.y)*(a.y-m.y))/d;const uy=((a.x*a.x+a.y*a.y)*(c.x-m.x)+(m.x*m.x+m.y*m.y)*(a.x-c.x)+(c.x*c.x+c.y*c.y)*(m.x-a.x))/d;const r=Math.hypot(a.x-ux,a.y-uy);const angle=(p:Point)=>Math.atan2(p.y-uy,p.x-ux);const a0=normalizeSweep(angle(a)),am=normalizeSweep(angle(m)),a1=normalizeSweep(angle(c));const ccw=normalizeSweep(a1-a0),mid=normalizeSweep(am-a0);return r*(mid<=ccw+1e-9?ccw:Math.PI*2-ccw);}
function copperThicknessByLayer(source:string):Map<string,number>{const out=new Map<string,number>();const setup=[...blocks(source,'setup',4)][0];if(!setup)return out;const stack=[...blocks(setup,'stackup',4)][0];if(!stack)return out;for(const b of blocks(stack,'layer',128)){const name=b.match(/^\(layer\s+(?:"([^"]+)"|([^\s()]+))/)?.slice(1).find(Boolean);const type=b.match(/\(type\s+"([^"]+)"\)/)?.[1];const t=num(b.split(/\baddsublayer\b/)[0]??b,'thickness');if(name&&t!==undefined&&(name.endsWith('.Cu')||type?.toLowerCase()==='copper'))out.set(name,t);}return out;}
function canonicalCandidates(name:string):string[]{const n=name.trim();return [...new Set([n,n.startsWith('/')?n.slice(1):'/'+n])];}

export function analyzeKicadElectrical(boardSource:string,intents:KicadElectricalNetIntent[]){
  if(!boardSource||Buffer.byteLength(boardSource,'utf8')>128*1024*1024)throw new Error('KiCad electrical review board must be 1..128 MiB.');
  if(!intents.length||intents.length>128)throw new Error('KiCad electrical review requires 1..128 net intents.');
  const names=netNames(boardSource),thickness=copperThicknessByLayer(boardSource);const routes=new Map<number,Route>();
  const get=(id:number)=>{let r=routes.get(id);if(!r){r={name:names.get(id)??'#'+id,segments:0,arcs:0,vias:0,lengthMm:0,layers:new Set(),resistanceCoverageLengthMm:0,widths:new Set()};routes.set(id,r);}return r;};
  const addResistance=(r:Route,lenMm:number,widthMm:number,layerName:string)=>{const t=thickness.get(layerName);if(t===undefined||t<=0||widthMm<=0)return;const resistance=COPPER_RESISTIVITY_OHM_M_20C*1000*lenMm/(widthMm*t);r.resistanceOhm=(r.resistanceOhm??0)+resistance;r.resistanceCoverageLengthMm+=lenMm;};
  for(const b of blocks(boardSource,'segment')){const id=num(b,'net'),w=num(b,'width'),l=layer(b),a=point(b,'start'),c=point(b,'end');if(id===undefined||w===undefined||!l||!a||!c)continue;const len=Math.hypot(c.x-a.x,c.y-a.y),r=get(id);r.segments++;r.lengthMm+=len;r.layers.add(l);r.widths.add(w);addResistance(r,len,w,l);}
  for(const b of blocks(boardSource,'arc')){const id=num(b,'net'),w=num(b,'width'),l=layer(b),a=point(b,'start'),m=point(b,'mid'),c=point(b,'end');if(id===undefined||w===undefined||!l||!a||!m||!c)continue;const len=arcLength(a,m,c),r=get(id);r.arcs++;r.lengthMm+=len;r.layers.add(l);r.widths.add(w);addResistance(r,len,w,l);}
  for(const b of blocks(boardSource,'via')){const id=num(b,'net');if(id===undefined)continue;const r=get(id);r.vias++;for(const m of b.matchAll(/"((?:F|B|In\d+)\.Cu)"/g))if(m[1])r.layers.add(m[1]);}
  const byName=new Map([...routes.values()].map(r=>[r.name,r]));
  const results=intents.map(intent=>{
    if(!intent.netName||intent.netName.length>128)throw new Error('Electrical intent netName must contain 1..128 characters.');
    const route=canonicalCandidates(intent.netName).map(n=>byName.get(n)).find(Boolean);
    const length=route?.lengthMm??0,resistance=route?.resistanceOhm;const drop=intent.currentA!==undefined&&resistance!==undefined?intent.currentA*resistance:undefined;const power=intent.currentA!==undefined&&resistance!==undefined?intent.currentA*intent.currentA*resistance:undefined;const dropPct=drop!==undefined&&intent.voltageV!==undefined&&intent.voltageV>0?drop/intent.voltageV*100:undefined;
    const findings:Array<{severity:'high'|'review'|'info';code:string;message:string}>=[];
    if(!route)findings.push({severity:'high',code:'net-not-routed',message:'No explicit track/arc/via routing evidence was found for this net.'});
    if(intent.maxLengthMm!==undefined&&length>intent.maxLengthMm)findings.push({severity:'review',code:'length-over-intent',message:`Explicit route length ${length.toFixed(3)} mm exceeds design-intent limit ${intent.maxLengthMm} mm.`});
    if(intent.maxViaCount!==undefined&&(route?.vias??0)>intent.maxViaCount)findings.push({severity:'review',code:'via-count-over-intent',message:`Via count ${route?.vias??0} exceeds design-intent limit ${intent.maxViaCount}.`});
    if(intent.maxVoltageDropPct!==undefined&&dropPct!==undefined&&dropPct>intent.maxVoltageDropPct)findings.push({severity:'high',code:'dc-drop-over-intent',message:`Estimated copper-only DC drop ${dropPct.toFixed(3)}% exceeds design-intent limit ${intent.maxVoltageDropPct}%.`});
    if(['clock','differential','high_speed'].includes(intent.kind)&&(route?.vias??0)>0)findings.push({severity:'review',code:'critical-net-layer-transition',message:'Critical/high-speed net uses vias/layer transitions; inspect reference-plane continuity and return path.'});
    if(intent.targetImpedanceOhm!==undefined)findings.push({severity:'info',code:'impedance-solver-required',message:`Target impedance ${intent.targetImpedanceOhm} ohm is recorded but not verified; RWMCP does not replace a 2D/3D field solver.`});
    if(resistance!==undefined&&route&&route.resistanceCoverageLengthMm+1e-6<route.lengthMm)findings.push({severity:'info',code:'partial-resistance-coverage',message:'DC resistance excludes routed length on copper layers without declared stackup thickness and excludes via/contact resistance.'});
    return {netName:intent.netName,matchedBoardNet:route?.name,kind:intent.kind,route:{lengthMm:Number(length.toFixed(4)),segments:route?.segments??0,arcs:route?.arcs??0,vias:route?.vias??0,layers:[...(route?.layers??[])].sort(),widthsMm:[...(route?.widths??[])].sort((a,b)=>a-b)},dcCopper20C:{resistanceOhm:resistance!==undefined?Number(resistance.toFixed(6)):undefined,currentA:intent.currentA,voltageV:intent.voltageV,voltageDropV:drop!==undefined?Number(drop.toFixed(6)):undefined,voltageDropPct:dropPct!==undefined?Number(dropPct.toFixed(4)):undefined,i2rLossW:power!==undefined?Number(power.toFixed(6)):undefined,note:'Copper-only estimate at 20 C from explicit track/arc length, width and declared layer copper thickness; via/contact resistance and thermal self-heating are not modeled.'},findings};
  });
  for(const result of results){const intent=intents.find(i=>i.netName===result.netName)!;if(!intent.pairWith)continue;const other=results.find(r=>canonicalCandidates(intent.pairWith!).includes(r.matchedBoardNet??''));if(!other){result.findings.push({severity:'high',code:'pair-net-missing',message:'Requested paired net has no matching routing evidence.'});continue;}const skew=Math.abs(result.route.lengthMm-other.route.lengthMm);if(intent.maxSkewMm!==undefined&&skew>intent.maxSkewMm)result.findings.push({severity:'high',code:'pair-skew-over-intent',message:`Explicit routed-length skew ${skew.toFixed(3)} mm exceeds design-intent limit ${intent.maxSkewMm} mm.`});}
  const counts={high:0,review:0,info:0};for(const result of results)for(const f of result.findings)counts[f.severity]++;
  return {schemaVersion:1,copperModel:{resistivityOhmM20C:COPPER_RESISTIVITY_OHM_M_20C,declaredCopperThicknessMm:Object.fromEntries([...thickness.entries()])},nets:results,findings:counts,limitations:['No IPC-2152 ampacity/temperature-rise claim is made.','No controlled-impedance claim is made without a field solver.','Return-path, crosstalk, EMI and thermal findings are geometry/design-intent evidence, not electromagnetic simulation.']};
}