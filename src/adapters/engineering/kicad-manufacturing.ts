const MAX_BOARD_BYTES=128*1024*1024;
const MAX_FOOTPRINTS=20000;

type FootprintAudit={
  reference:string;
  value:string;
  smd:boolean;
  throughHole:boolean;
  boardOnly:boolean;
  excludeFromBom:boolean;
  excludeFromPos:boolean;
  dnp:boolean;
  hasCourtyard:boolean;
  modelCount:number;
};

function blockEnd(text:string,start:number):number{
  let depth=0,quoted=false,escaped=false;
  for(let i=start;i<text.length;i++){
    const ch=text[i]!;
    if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
    if(ch==='"'){quoted=true;continue;}
    if(ch==='(')depth++;
    else if(ch===')'){depth--;if(depth===0)return i+1;if(depth<0)break;}
  }
  throw new Error('Malformed KiCad S-expression.');
}

function* blocks(text:string,token:string,limit=MAX_FOOTPRINTS):Generator<string>{
  const marker='('+token;
  let cursor=0,count=0;
  while(cursor<text.length){
    const start=text.indexOf(marker,cursor);
    if(start<0)break;
    const next=text[start+marker.length]??'';
    if(next&&!/\s|"/.test(next)){cursor=start+marker.length;continue;}
    const end=blockEnd(text,start);
    if(++count>limit)throw new Error(`KiCad manufacturing audit exceeds ${limit} ${token} blocks.`);
    yield text.slice(start,end);
    cursor=end;
  }
}

function unquote(value:string):string{return value.replace(/\\(["\\])/g,'$1');}
function property(block:string,name:string):string{
  const escaped=name.replace(/[.*+?^$()|[\]\\]/g,'\\$&');
  return unquote(block.match(new RegExp('\\(property\\s+"'+escaped+'"\\s+"((?:\\\\.|[^"\\\\])*)"','i'))?.[1]??'');
}

function parseAttributes(block:string):Set<string>{
  const raw=block.match(/\(attr(?:\s+([^()\r\n]*))?\)/i)?.[1]??'';
  return new Set(raw.trim().split(/\s+/).filter(Boolean));
}

function parseFootprints(source:string):FootprintAudit[]{
  const result:FootprintAudit[]=[];
  for(const block of blocks(source,'footprint')){
    const attrs=parseAttributes(block);
    const reference=property(block,'Reference')||'<unknown>';
    const value=property(block,'Value');
    const hasCourtyard=/\(layer\s+"(?:F|B)\.CrtYd"\)/.test(block);
    const modelCount=[...block.matchAll(/\(model\s+"/g)].length;
    result.push({
      reference,
      value,
      smd:attrs.has('smd'),
      throughHole:attrs.has('through_hole'),
      boardOnly:attrs.has('board_only'),
      excludeFromBom:attrs.has('exclude_from_bom'),
      excludeFromPos:attrs.has('exclude_from_pos_files'),
      dnp:attrs.has('dnp'),
      hasCourtyard,
      modelCount
    });
  }
  return result;
}

function splitCsv(text:string,maxRows=50000):string[][]{
  if(Buffer.byteLength(text,'utf8')>16*1024*1024)throw new Error('KiCad position CSV exceeds 16 MiB.');
  const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
  const pushCell=()=>{if(cell.length>4096)throw new Error('KiCad position CSV cell exceeds 4096 characters.');row.push(cell);cell='';};
  const pushRow=()=>{pushCell();if(row.some(value=>value.length))rows.push(row);row=[];if(rows.length>maxRows+1)throw new Error(`KiCad position CSV exceeds ${maxRows} rows.`);};
  for(let i=0;i<text.length;i++){
    const ch=text[i]!;
    if(quoted){if(ch==='"'){if(text[i+1]==='"'){cell+='"';i++;}else quoted=false;}else cell+=ch;continue;}
    if(ch==='"'&&cell.length===0){quoted=true;continue;}
    if(ch===','){pushCell();continue;}
    if(ch==='\n'){pushRow();continue;}
    if(ch==='\r'){if(text[i+1]==='\n')continue;pushRow();continue;}
    cell+=ch;
  }
  if(quoted)throw new Error('KiCad position CSV ended inside a quoted field.');
  if(cell.length||row.length)pushRow();
  return rows;
}

function normalizeHeader(value:string):string{return value.trim().toLowerCase().replace(/[^a-z0-9]+/g,'');}

export function parseKicadPositionCsv(text:string){
  const rows=splitCsv(text);
  if(!rows.length)return {headers:[],rowCount:0,references:[],duplicates:[] as string[]};
  const headers=rows[0]!.map(x=>x.trim());
  const map=new Map(headers.map((value,index)=>[normalizeHeader(value),index]));
  const refIndex=map.get('ref')??map.get('reference')??0;
  const refs=rows.slice(1).map(row=>(row[refIndex]??'').trim()).filter(Boolean);
  const counts=new Map<string,number>();
  for(const ref of refs)counts.set(ref,(counts.get(ref)??0)+1);
  return {
    headers,
    rowCount:refs.length,
    references:refs,
    duplicates:[...counts.entries()].filter(([,count])=>count>1).map(([ref])=>ref).sort()
  };
}

function splitBomReferences(value:string):string[]{
  return value.split(/[\s,;]+/).map(item=>item.trim()).filter(Boolean);
}

export function auditKicadManufacturing(
  boardSource:string,
  positionReferences:string[]=[],
  bomReferenceGroups:string[]=[]
){
  if(!boardSource||Buffer.byteLength(boardSource,'utf8')>MAX_BOARD_BYTES)throw new Error('KiCad manufacturing audit board must be 1..128 MiB.');
  const footprints=parseFootprints(boardSource);
  const refs=footprints.map(item=>item.reference).filter(ref=>ref!=='<unknown>');
  const counts=new Map<string,number>();
  for(const ref of refs)counts.set(ref,(counts.get(ref)??0)+1);
  const duplicateReferences=[...counts.entries()].filter(([,count])=>count>1).map(([reference,count])=>({reference,count}));

  const expectedPositionRefs=footprints.filter(item=>!item.excludeFromPos&&!item.dnp&&item.reference!=='<unknown>').map(item=>item.reference).sort();
  const actualPositionRefs=[...new Set(positionReferences)].sort();
  const actualPosSet=new Set(actualPositionRefs);
  const expectedPosSet=new Set(expectedPositionRefs);

  const expectedBomRefs=footprints.filter(item=>!item.excludeFromBom&&item.reference!=='<unknown>').map(item=>item.reference).sort();
  const actualBomRefs=[...new Set(bomReferenceGroups.flatMap(splitBomReferences))].sort();
  const actualBomSet=new Set(actualBomRefs);
  const expectedBomSet=new Set(expectedBomRefs);

  const missingPositionRefs=expectedPositionRefs.filter(ref=>!actualPosSet.has(ref));
  const unexpectedPositionRefs=actualPositionRefs.filter(ref=>!expectedPosSet.has(ref));
  const missingBomRefs=bomReferenceGroups.length?expectedBomRefs.filter(ref=>!actualBomSet.has(ref)):[];
  const unexpectedBomRefs=bomReferenceGroups.length?actualBomRefs.filter(ref=>!expectedBomSet.has(ref)):[];

  const missingCourtyardRefs=footprints.filter(item=>!item.boardOnly&&!item.hasCourtyard).map(item=>item.reference).slice(0,200);
  const missing3dModelRefs=footprints.filter(item=>!item.boardOnly&&item.modelCount===0).map(item=>item.reference).slice(0,200);
  const boardOnlyNotExcluded=footprints.filter(item=>item.boardOnly&&(!item.excludeFromBom||!item.excludeFromPos)).map(item=>item.reference).slice(0,200);
  const dnpIncludedInPosition=footprints.filter(item=>item.dnp&&actualPosSet.has(item.reference)).map(item=>item.reference).slice(0,200);

  const findings:Array<{severity:'high'|'review'|'info';code:string;count:number;message:string}>=[];
  const add=(severity:'high'|'review'|'info',code:string,count:number,message:string)=>{if(count)findings.push({severity,code,count,message});};
  add('high','position-export-missing-reference',missingPositionRefs.length,'Expected populated PCB footprints are missing from the generated position file.');
  add('high','position-export-unexpected-reference',unexpectedPositionRefs.length,'Generated position file contains references excluded by PCB assembly intent.');
  add('high','bom-export-missing-reference',missingBomRefs.length,'PCB footprints expected in BOM are missing from generated schematic BOM.');
  add('review','bom-export-unexpected-reference',unexpectedBomRefs.length,'Generated BOM contains references not expected from PCB BOM attributes; review schematic/PCB parity.');
  add('review','duplicate-reference',duplicateReferences.length,'PCB contains duplicate reference designators.');
  add('review','missing-courtyard',missingCourtyardRefs.length,'Non-board-only footprints lack F.CrtYd/B.CrtYd geometry; assembly spacing review is weaker.');
  add('review','missing-3d-model',missing3dModelRefs.length,'Non-board-only footprints have no declared 3D model; mechanical assembly review is incomplete.');
  add('review','board-only-not-excluded',boardOnlyNotExcluded.length,'Board-only footprints should normally be explicitly excluded from BOM and position output.');
  add('high','dnp-present-in-position',dnpIncludedInPosition.length,'DNP footprints unexpectedly appear in the position export generated with --exclude-dnp.');

  return {
    schemaVersion:1,
    footprintSummary:{
      total:footprints.length,
      smd:footprints.filter(item=>item.smd).length,
      throughHole:footprints.filter(item=>item.throughHole).length,
      boardOnly:footprints.filter(item=>item.boardOnly).length,
      dnp:footprints.filter(item=>item.dnp).length,
      excludedFromBom:footprints.filter(item=>item.excludeFromBom).length,
      excludedFromPosition:footprints.filter(item=>item.excludeFromPos).length,
      withCourtyard:footprints.filter(item=>item.hasCourtyard).length,
      with3dModel:footprints.filter(item=>item.modelCount>0).length
    },
    assemblyConsistency:{
      expectedPositionCount:expectedPositionRefs.length,
      actualPositionCount:actualPositionRefs.length,
      missingPositionRefs:missingPositionRefs.slice(0,200),
      unexpectedPositionRefs:unexpectedPositionRefs.slice(0,200),
      expectedBomCount:expectedBomRefs.length,
      actualBomCount:actualBomRefs.length,
      missingBomRefs:missingBomRefs.slice(0,200),
      unexpectedBomRefs:unexpectedBomRefs.slice(0,200),
      dnpIncludedInPosition
    },
    footprintQuality:{
      duplicateReferences,
      missingCourtyardRefs,
      missing3dModelRefs,
      boardOnlyNotExcluded
    },
    findings,
    ready:findings.every(item=>item.severity!=='high')
  };
}
