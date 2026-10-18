import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectDcPath } from '../src/adapters/engineering/kicad-dc-path-safety.js';
const edge=(x1:number,y1:number,x2:number,y2:number)=>({layer:'F.Cu',start:{x:x1,y:y1},end:{x:x2,y:y2}});
test('Only one continuous two-endpoint series copper path is provisionally eligible',()=>{
  const valid=inspectDcPath([edge(0,0,10,0),edge(10,0,10,10)],0,false);
  assert.equal(valid.eligible,true);
  assert.match(valid.reason,/assumption/);
});
test('Branched or disconnected copper cannot be reduced to series resistance',()=>{
  assert.equal(inspectDcPath([edge(0,0,10,0),edge(10,0,20,0),edge(10,0,10,10)],0,false).reason,'branched-track-network');
  assert.equal(inspectDcPath([edge(0,0,10,0),edge(20,0,30,0)],0,false).eligible,false);
  assert.equal(inspectDcPath([edge(0,0,10,0),edge(10,0,0,0)],0,false).eligible,false);
});
test('Vias and zones deny unsupported point-to-point DC drop even if all traces are valid',()=>{
  assert.equal(inspectDcPath([edge(0,0,10,0)],1,false).eligible,false);
  assert.equal(inspectDcPath([edge(0,0,10,0)],0,true).eligible,false);
  assert.equal(inspectDcPath([],0,false).eligible,false);
});
