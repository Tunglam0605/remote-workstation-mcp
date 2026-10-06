import assert from 'node:assert/strict';
import test from 'node:test';
import { synthesizeKicadSchematic, verifyKicadSchematicNetlist } from '../src/adapters/engineering/kicad-schematic-synthesis.js';
import type { KicadResolvedSymbol } from '../src/adapters/engineering/kicad-library.js';

const symbol: KicadResolvedSymbol={
  kind:'symbol',id:'Device:R',library:'Device',name:'R',sourcePath:'fixture',extendsChain:['R'],properties:{Footprint:'Resistor_SMD:R_0603_1608Metric'},footprint:'Resistor_SMD:R_0603_1608Metric',footprintFilters:['R_*'],pins:[
    {number:'1',name:'~',electricalType:'passive',shape:'line',xMm:0,yMm:3.81,rotationDeg:270,lengthMm:2.54,unit:1,bodyStyle:1,alternates:[]},
    {number:'2',name:'~',electricalType:'passive',shape:'line',xMm:0,yMm:-3.81,rotationDeg:90,lengthMm:2.54,unit:1,bodyStyle:1,alternates:[]}
  ],embeddedDefinition:'(symbol "Device:R" (property "Reference" "R" (at 0 0 0) (effects (font (size 1.27 1.27)))) (property "Value" "R" (at 0 0 0) (effects (font (size 1.27 1.27)))) (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 2.54) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))) (pin passive line (at 0 -3.81 90) (length 2.54) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))'
};

test('schematic synthesis maps Cartesian symbol Y into sheet Y and labels exact requested pins',()=>{
  const result=synthesizeKicadSchematic([
    {reference:'R1',symbol,xMm:80,yMm:70},
    {reference:'R2',symbol,xMm:120,yMm:70}
  ],[{name:'SIG',endpoints:[{reference:'R1',pinNumber:'1'},{reference:'R2',pinNumber:'1'}]}]);
  assert.match(result.source,/\(label "SIG"\s+\(at 80 66\.19 0\)/);
  assert.match(result.source,/\(label "SIG"\s+\(at 120 66\.19 0\)/);
  assert.match(result.source,/\(no_connect\s+\(at 80 73\.81\)/);
  assert.equal(result.components[0]?.pins.find(pin=>pin.number==='1')?.connectedNet,'SIG');
});

test('schematic synthesis rejects pin-name mismatch and unconnected power inputs',()=>{
  const power={...symbol,pins:[{...symbol.pins[0]!,name:'VDD',electricalType:'power_in'}]};
  assert.throws(()=>synthesizeKicadSchematic([{reference:'U1',symbol:power}],[],{}),/Unconnected power-input/);
  assert.throws(()=>synthesizeKicadSchematic([{reference:'R1',symbol}],[{name:'SIG',endpoints:[{reference:'R1',pinNumber:'1',expectedPinName:'BAD'}]}],{}),/Pin-name guard failed/);
});

test('netlist verification canonicalizes root-sheet net names and catches missing endpoints',()=>{
  const expected=[{name:'SIG',endpoints:[{reference:'R1',pinNumber:'1'},{reference:'R2',pinNumber:'1'}]}];
  const actual=[{name:'SIG',nodes:[{reference:'R1',pin:'1'},{reference:'R2',pin:'1'}]}];
  assert.equal(verifyKicadSchematicNetlist(expected,actual).valid,true);
  assert.equal(verifyKicadSchematicNetlist(expected,[{name:'SIG',nodes:[{reference:'R1',pin:'1'}]}]).valid,false);
});
