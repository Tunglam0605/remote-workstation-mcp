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


test('schematic synthesis treats KiCad unit-0 pins as common pins for power/helper symbols',()=>{
  const common={...symbol,id:'power:PWR_FLAG',name:'PWR_FLAG',pins:[
    {number:'1',name:'',electricalType:'power_out',shape:'line',xMm:0,yMm:0,rotationDeg:0,lengthMm:0,unit:0,bodyStyle:1,alternates:[]}
  ]};
  const result=synthesizeKicadSchematic(
    [{reference:'PF1',symbol:common,onBoard:false}],
    [{name:'+3V3',endpoints:[{reference:'PF1',pinNumber:'1'}]}],
    {markUnusedNoConnect:true}
  );
  assert.equal(result.components[0]?.pins.some(pin=>pin.number==='1'&&pin.connectedNet==='+3V3'),true);
  assert.equal(result.unusedPins.length,0);
});


test('automatic symbol origins and pin connections use the 50-mil KiCad schematic grid', () => {
  const result = synthesizeKicadSchematic([
    { reference: 'R1', symbol },
    { reference: 'R2', symbol }
  ], [
    { name: 'A', endpoints: [{ reference: 'R1', pinNumber: '1' }, { reference: 'R2', pinNumber: '1' }] },
    { name: 'B', endpoints: [{ reference: 'R1', pinNumber: '2' }, { reference: 'R2', pinNumber: '2' }] }
  ]);
  const step = 1.27;
  const gridAligned = (value: number) => Math.abs(value / step - Math.round(value / step)) < 1e-8;
  for (const component of result.components) {
    assert.ok(gridAligned(component.position.xMm), component.reference + ' x origin off-grid');
    assert.ok(gridAligned(component.position.yMm), component.reference + ' y origin off-grid');
    const sourceSymbol = symbol;
    for (const pin of sourceSymbol.pins) {
      assert.ok(gridAligned(component.position.xMm + pin.xMm), component.reference + ' pin x off-grid');
      assert.ok(gridAligned(component.position.yMm - pin.yMm), component.reference + ' pin y off-grid');
    }
  }
  assert.match(result.source, /\(label "A"\s+\(at 69\.85 50\.8 0\)/);
  assert.match(result.source, /\(label "A"\s+\(at 133\.35 50\.8 0\)/);
});
