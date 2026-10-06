import fs from 'node:fs/promises';
import path from 'node:path';

export interface CubeMxPin {
  name: string;
  position: string;
  type: string;
  signals: string[];
  conditionCount: number;
}

export interface CubeMxMcu {
  refName: string;
  family: string;
  line: string;
  packageName: string;
  sourcePath: string;
  frequencyMHz?: number;
  voltageMin?: number;
  voltageMax?: number;
  pins: CubeMxPin[];
  ips: string[];
}

export interface Stm32PinGroupRequest { pattern: string; count: number; }
export interface Stm32PinPlanRequest {
  exactSignals?: string[];
  groups?: Stm32PinGroupRequest[];
  reservedPins?: string[];
  preferredPins?: Record<string,string[]>;
  preserveDebug?: boolean;
}
export interface Stm32PinAssignment {
  request: string;
  signal: string;
  pinName: string;
  position: string;
  pinType: string;
  candidateCount: number;
}

const DEBUG_SIGNALS=new Set(['SYS_JTMS-SWDIO','SYS_JTCK-SWCLK','SYS_JTDI','SYS_JTDO-SWO','SYS_NJTRST']);
const DEBUG_PIN_NAMES=new Set(['PA13','PA14','PA15','PB3','PB4']);

function xmlUnescape(value:string):string{return value.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');}
function attr(block:string,name:string):string|undefined{const m=block.match(new RegExp('\\b'+name+'="([^"]*)"'));return m?.[1]!==undefined?xmlUnescape(m[1]):undefined;}
function expandCharSpec(spec:string):string[]{const alpha='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';const tokens=spec.split('-').filter(Boolean);if(tokens.length===2&&tokens[0]?.length===1&&tokens[1]?.length===1){const a=alpha.indexOf(tokens[0]!.toUpperCase()),b=alpha.indexOf(tokens[1]!.toUpperCase());if(a>=0&&b>=a)return [...alpha.slice(a,b+1)];}return [...new Set(tokens.flatMap(token=>token.length===1?[token.toUpperCase()]:[...token.toUpperCase()]))];}
function refPatternRegex(refName:string):RegExp{let out='^';for(let i=0;i<refName.length;i++){const ch=refName[i]!;if(ch==='('){const end=refName.indexOf(')',i+1);if(end<0){out+='\\(';continue;}const chars=expandCharSpec(refName.slice(i+1,end));out+='['+chars.map(c=>c.replace(/[-\\\]^]/g,'\\$&')).join('')+']';i=end;continue;}if(ch==='x'){out+='[A-Z0-9]';continue;}out+=ch.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}return new RegExp(out+'$','i');}
function normalizeRequestedPart(value:string):string[]{const upper=value.trim().toUpperCase();if(!/^STM32[A-Z0-9()+-]{5,40}$/.test(upper))throw new Error('STM32 partNumber has unsupported characters.');const variants=new Set<string>([upper]);if(/[0-9A-Z]$/.test(upper))variants.add(upper.slice(0,-1)+'X');return [...variants];}

export function discoverCubeMxDbRoot():string{return 'C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX/db/mcu';}

export async function resolveCubeMxMcu(partNumber:string,dbRoot=discoverCubeMxDbRoot()):Promise<CubeMxMcu>{
  const variants=normalizeRequestedPart(partNumber);
  const entries=await fs.readdir(dbRoot,{withFileTypes:true});
  const likelyPrefix=variants[0]!.slice(0,10);
  const files=entries.filter(entry=>entry.isFile()&&entry.name.startsWith('STM32')&&entry.name.endsWith('.xml')&&entry.name.toUpperCase().startsWith(likelyPrefix)).map(entry=>entry.name);
  const fallback=files.length?files:entries.filter(entry=>entry.isFile()&&entry.name.startsWith('STM32')&&entry.name.endsWith('.xml')).map(entry=>entry.name);
  for(const name of fallback){
    const sourcePath=path.join(dbRoot,name);const source=await fs.readFile(sourcePath,'utf8');const root=source.match(/<Mcu\b[^>]*>/)?.[0];if(!root)continue;
    const refName=attr(root,'RefName');if(!refName)continue;const regex=refPatternRegex(refName);if(!variants.some(variant=>regex.test(variant)))continue;
    const pins:CubeMxPin[]=[];
    for(const match of source.matchAll(/<Pin\b([^>]*)\/>|<Pin\b([^>]*)>([\s\S]*?)<\/Pin>/g)){
      const attrs=match[1]??match[2]??'',body=match[3]??'';const pinName=attr('<Pin '+attrs+'>','Name')??'',position=attr('<Pin '+attrs+'>','Position')??'',type=attr('<Pin '+attrs+'>','Type')??'';if(!pinName||!position)continue;
      const signals=[...body.matchAll(/<Signal\b[^>]*Name="([^"]+)"/g)].map(m=>xmlUnescape(m[1]!));pins.push({name:pinName,position,type,signals:[...new Set(signals)],conditionCount:[...body.matchAll(/<Condition\b/g)].length});
    }
    const ips=[...source.matchAll(/<IP\b[^>]*InstanceName="([^"]+)"/g)].map(m=>m[1]!).filter(Boolean);const frequency=Number(source.match(/<Frequency>([^<]+)<\/Frequency>/)?.[1]);const voltage=source.match(/<Voltage\b[^>]*Min="([^"]+)"[^>]*Max="([^"]+)"/);
    return {refName,family:attr(root,'Family')??'',line:attr(root,'Line')??'',packageName:attr(root,'Package')??'',sourcePath,...(Number.isFinite(frequency)?{frequencyMHz:frequency}:{}),...(voltage?.[1]&&Number.isFinite(Number(voltage[1]))?{voltageMin:Number(voltage[1])}:{}),...(voltage?.[2]&&Number.isFinite(Number(voltage[2]))?{voltageMax:Number(voltage[2])}:{}),pins,ips:[...new Set(ips)]};
  }
  throw new Error('STM32CubeMX database has no MCU/package matching '+partNumber+'.');
}

function wildcardRegex(pattern:string):RegExp{if(!pattern||pattern.length>128||!/^[A-Za-z0-9_*?+.-]+$/.test(pattern))throw new Error('Invalid STM32 signal pattern: '+pattern);return new RegExp('^'+pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.')+'$','i');}
type Variable={request:string;candidates:Array<{signal:string;pin:CubeMxPin}>};
function candidateScore(signal:string,pin:CubeMxPin,preferred:Record<string,string[]>):number{const prefs=preferred[signal]??[];const index=prefs.findIndex(value=>value.toUpperCase()===pin.name.toUpperCase());let score=index>=0?1000-index*10:0;if(/^P[A-Z]\d+$/i.test(pin.name))score+=10;score-=Number(pin.position)||0;return score;}

export function planStm32Pins(mcu:CubeMxMcu,request:Stm32PinPlanRequest){
  const reserved=new Set((request.reservedPins??[]).map(value=>value.toUpperCase()));if(request.preserveDebug!==false)for(const name of DEBUG_PIN_NAMES)reserved.add(name);const preferred=request.preferredPins??{};
  const allPairs:Array<{signal:string;pin:CubeMxPin}>=[];for(const pin of mcu.pins)for(const signal of pin.signals)allPairs.push({signal,pin});const variables:Variable[]=[];
  for(const signal of [...new Set(request.exactSignals??[])]){const candidates=allPairs.filter(pair=>pair.signal.toUpperCase()===signal.toUpperCase()&&(!reserved.has(pair.pin.name.toUpperCase())||DEBUG_SIGNALS.has(signal)));if(!candidates.length)throw new Error('No available CubeMX pin exposes requested signal '+signal+' on '+mcu.refName+'.');variables.push({request:signal,candidates});}
  for(const group of request.groups??[]){if(!Number.isInteger(group.count)||group.count<1||group.count>64)throw new Error('STM32 signal group '+group.pattern+' count must be 1..64.');const regex=wildcardRegex(group.pattern);const candidates=allPairs.filter(pair=>regex.test(pair.signal)&&!reserved.has(pair.pin.name.toUpperCase()));const uniqueSignals=new Set(candidates.map(pair=>pair.signal));if(uniqueSignals.size<group.count)throw new Error('STM32 signal group '+group.pattern+' requests '+group.count+', but only '+uniqueSignals.size+' distinct signals are available after reservations.');for(let i=0;i<group.count;i++)variables.push({request:group.pattern+'#'+(i+1),candidates});}
  if(variables.length>96)throw new Error('STM32 pin planner supports at most 96 requested signal slots.');
  const ordered=variables.map((v,index)=>({v,index})).sort((a,b)=>a.v.candidates.length-b.v.candidates.length);const usedPins=new Set<string>(),usedSignals=new Set<string>();const chosen=new Map<number,{signal:string;pin:CubeMxPin;candidates:number}>();
  const solve=(depth:number):boolean=>{if(depth>=ordered.length)return true;const {v,index}=ordered[depth]!;const candidates=[...v.candidates].sort((a,b)=>candidateScore(b.signal,b.pin,preferred)-candidateScore(a.signal,a.pin,preferred));for(const pair of candidates){const pinKey=pair.pin.name.toUpperCase(),signalKey=pair.signal.toUpperCase();if(usedPins.has(pinKey)||usedSignals.has(signalKey))continue;usedPins.add(pinKey);usedSignals.add(signalKey);chosen.set(index,{...pair,candidates:v.candidates.length});if(solve(depth+1))return true;chosen.delete(index);usedPins.delete(pinKey);usedSignals.delete(signalKey);}return false;};
  if(!solve(0))throw new Error('STM32 pin planner found no conflict-free assignment for all requested signals.');
  const assignments=variables.map((v,index)=>{const c=chosen.get(index)!;return {request:v.request,signal:c.signal,pinName:c.pin.name,position:c.pin.position,pinType:c.pin.type,candidateCount:c.candidates} satisfies Stm32PinAssignment;});
  return {schemaVersion:1,mcu:{refName:mcu.refName,family:mcu.family,line:mcu.line,package:mcu.packageName,frequencyMHz:mcu.frequencyMHz,voltageMin:mcu.voltageMin,voltageMax:mcu.voltageMax,pinCount:mcu.pins.length},preserveDebug:request.preserveDebug!==false,reservedPins:[...reserved].sort(),assignments,conditionEvidence:{assignedPinsWithCubeMxConditions:assignments.filter(a=>mcu.pins.find(p=>p.name===a.pinName)?.conditionCount).map(a=>a.pinName),note:'CubeMX pin-level conditions are not re-evaluated by RWMCP; generate/validate the final .ioc in STM32CubeMX when peripheral mode combinations matter.'}};
}