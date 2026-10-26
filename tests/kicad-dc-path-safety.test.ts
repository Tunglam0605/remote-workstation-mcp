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
test('Overlapping, midspan T-junction and crossing tracks must never support a single series DC estimate',()=>{
  const overlap=inspectDcPath([edge(0,0,10,0),edge(0,0,5,0)],0,false);
  assert.equal(overlap.eligible,false);
  assert.equal(overlap.reason,'track-geometric-intersection-or-overlap');
  const tJunction=inspectDcPath([edge(0,0,10,0),edge(5,0,5,5)],0,false);
  assert.equal(tJunction.eligible,false);
  const crossed=inspectDcPath([edge(0,0,10,10),edge(0,10,10,0)],0,false);
  assert.equal(crossed.eligible,false);
  const endpointChain=inspectDcPath([edge(0,0,5,0),edge(5,0,10,0)],0,false);
  assert.equal(endpointChain.eligible,true);
});

test('DC topology check fails closed on excessive track count instead of quadratic work',()=>{
 const oversized=Array.from({length:1025},(_,i)=>edge(i,0,i+1,0));
 const result=inspectDcPath(oversized,0,false);
 assert.equal(result.eligible,false);
 assert.equal(result.reason,'topology-analysis-complexity-limit');
});
test('Vias and zones deny unsupported point-to-point DC drop even if all traces are valid',()=>{
  assert.equal(inspectDcPath([edge(0,0,10,0)],1,false).eligible,false);
  assert.equal(inspectDcPath([edge(0,0,10,0)],0,true).eligible,false);
  assert.equal(inspectDcPath([],0,false).eligible,false);
});
