import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalKicadBoardNetName, synthesizeKicadBoard } from '../src/adapters/engineering/kicad-board-synthesis.js';
import type { KicadResolvedFootprint, KicadResolvedSymbol } from '../src/adapters/engineering/kicad-library.js';

const symbol: KicadResolvedSymbol = {
  kind:'symbol',
  id:'Device:R',
  library:'Device',
  name:'R',
  sourcePath:'fixture',
  extendsChain:['R'],
  properties:{Footprint:'Resistor_SMD:R_0603_1608Metric'},
  footprint:'Resistor_SMD:R_0603_1608Metric',
  footprintFilters:['R_*'],
  pins:[
    {number:'1',name:'~',electricalType:'passive',shape:'line',xMm:0,yMm:3.81,rotationDeg:270,lengthMm:2.54,unit:1,bodyStyle:1,alternates:[]},
    {number:'2',name:'~',electricalType:'passive',shape:'line',xMm:0,yMm:-3.81,rotationDeg:90,lengthMm:2.54,unit:1,bodyStyle:1,alternates:[]}
  ],
  embeddedDefinition:''
};

const footprint: KicadResolvedFootprint = {
  kind:'footprint',
  id:'Resistor_SMD:R_0603_1608Metric',
  library:'Resistor_SMD',
  name:'R_0603_1608Metric',
  sourcePath:'fixture',
  description:'fixture',
  tags:['fixture'],
  attributes:['smd'],
  pads:[
    {number:'1',type:'smd',shape:'roundrect',at:{xMm:-0.775,yMm:0,rotationDeg:0},size:{xMm:0.9,yMm:0.95},layers:['F.Cu','F.Paste','F.Mask']},
    {number:'2',type:'smd',shape:'roundrect',at:{xMm:0.775,yMm:0,rotationDeg:0},size:{xMm:0.9,yMm:0.95},layers:['F.Cu','F.Paste','F.Mask']}
  ],
  modelPaths:['${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step'],
  source:`(footprint "R_0603_1608Metric"
    (version 20240108)
    (generator pcbnew)
    (layer "F.Cu")
    (property "Reference" "R" (at 0 -1.5 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "R_0603_1608Metric" (at 0 1.5 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd roundrect (at -0.775 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25))
    (pad "2" smd roundrect (at 0.775 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25))
    (model "\${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
  )`
};

test('board synthesis creates stackup, Edge.Cuts, pad-net linkage and deterministic placement evidence', () => {
  const result=synthesizeKicadBoard([
    {reference:'R1',value:'10k',symbol,footprint,symbolUuid:'11111111-1111-4111-8111-111111111111',xMm:30,yMm:25},
    {reference:'R2',value:'1k',symbol,footprint,symbolUuid:'22222222-2222-4222-8222-222222222222',xMm:45,yMm:25,rotationDeg:90}
  ],[
    {name:'SIG',endpoints:[{reference:'R1',pinNumber:'1'},{reference:'R2',pinNumber:'1'}]},
    {name:'+3V3',endpoints:[{reference:'R1',pinNumber:'2'},{reference:'R2',pinNumber:'2'}]}
  ],{projectName:'robot',widthMm:60,heightMm:40,copperLayers:4,thicknessMm:1.6,originXmm:20,originYmm:20});

  assert.equal(result.components.length,2);
  assert.equal(result.nets.length,2);
  assert.equal(result.nets.find(n=>n.name==='SIG')?.canonicalName,'/SIG');
  assert.equal(result.nets.find(n=>n.name==='+3V3')?.canonicalName,'/+3V3');
  assert.match(result.source,/\(general \(thickness 1\.6\)/);
  assert.match(result.source,/\(layer "F\.Cu" \(type "copper"\)/);
  assert.match(result.source,/\(layer "In1\.Cu" \(type "copper"\)/);
  assert.match(result.source,/\(layer "B\.Cu" \(type "copper"\)/);
  assert.match(result.source,/\(gr_rect[\s\S]*\(start 20 20\)[\s\S]*\(end 80 60\)[\s\S]*\(layer "Edge\.Cuts"\)/);
  assert.match(result.source,/\(path "\/11111111-1111-4111-8111-111111111111"\)/);
  assert.match(result.source,/\(net 1 "\/SIG"\)/);
  assert.match(result.source,/\(pinfunction "~"\)/);
  assert.match(result.source,/\(at 45 25 90\)/);
  assert.match(result.source,/\(property "Reference" "R2"[\s\S]*?\(at 0 -1\.5 90\)/);
  assert.match(result.source,/\(pad "1" smd roundrect[\s\S]*?\(at -0\.775 0 90\)/);
});

test('board net-name canonicalization preserves power/global names and roots local names',()=>{
  assert.equal(canonicalKicadBoardNetName('SIG'),'/SIG');
  assert.equal(canonicalKicadBoardNetName('/BUS/SIG'),'/BUS/SIG');
  assert.equal(canonicalKicadBoardNetName('+3V3'),'/+3V3');
  assert.equal(canonicalKicadBoardNetName('GND'),'/GND');
});


test('board synthesis keeps child coordinates local and serializes absolute child orientation when footprint is rotated',()=>{
  const result=synthesizeKicadBoard([
    {reference:'R1',value:'10k',symbol,footprint,symbolUuid:'33333333-3333-4333-8333-333333333333',xMm:30,yMm:25,rotationDeg:90}
  ],[{name:'SIG',endpoints:[{reference:'R1',pinNumber:'1'}]}],{projectName:'rotated',widthMm:60,heightMm:40});
  assert.match(result.source,/\(at 30 25 90\)/);
  assert.match(result.source,/\(pad "1"[\s\S]*?\(at -0\.775 0 90\)/);
});

test('board synthesis rejects unknown endpoints and unsupported copper-layer counts',()=>{
  assert.throws(()=>synthesizeKicadBoard([
    {reference:'R1',value:'10k',symbol,footprint,symbolUuid:'11111111-1111-4111-8111-111111111111'}
  ],[{name:'BAD',endpoints:[{reference:'R9',pinNumber:'1'}]}],{projectName:'robot',widthMm:60,heightMm:40}),/unknown component R9/);
  assert.throws(()=>synthesizeKicadBoard([
    {reference:'R1',value:'10k',symbol,footprint,symbolUuid:'11111111-1111-4111-8111-111111111111'}
  ],[],{projectName:'robot',widthMm:60,heightMm:40,copperLayers:3}),/even integer/);
});


test('board synthesis preserves KiCad no-connect nets and symbol parity fields',()=>{
  const mcuLike: KicadResolvedSymbol = {
    ...symbol,
    id:'MCU_Test:U',
    name:'U',
    properties:{...symbol.properties,Datasheet:'https://example.com/mcu.pdf',Description:'Synthetic MCU'},
    pins:[
      {...symbol.pins[0]!,name:'PA11'},
      {...symbol.pins[1]!,name:'PA12'}
    ]
  };
  const noConnect='unconnected-(U1-PA12-Pad2)';
  const result=synthesizeKicadBoard([
    {reference:'U1',value:'MCU',symbol:mcuLike,footprint,symbolUuid:'33333333-3333-4333-8333-333333333333'}
  ],[
    {name:'USB_DM',endpoints:[{reference:'U1',pinNumber:'1'}]},
    {name:noConnect,endpoints:[{reference:'U1',pinNumber:'2'}]}
  ],{projectName:'mcu',widthMm:60,heightMm:40});

  assert.equal(canonicalKicadBoardNetName(noConnect),noConnect);
  assert.equal(result.nets.find(net=>net.name===noConnect)?.canonicalName,noConnect);
  assert.match(result.source,/\(net 2 "unconnected-\(U1-PA12-Pad2\)"\)/);
  assert.match(result.source,/\(property "Datasheet" "https:\/\/example\.com\/mcu\.pdf"/);
  assert.match(result.source,/\(property "Description" "Synthetic MCU"/);
});

test('board synthesis replaces stale footprint Datasheet/Description with the schematic symbol fields', () => {
  const fields = [
    '(property "Datasheet" "OLD" (at 0 0 0) (layer "F.Fab") (effects (font (size 1 1))))',
    '(property "Description" "" (at 0 0 0) (layer "F.Fab") (effects (font (size 1 1))))'
  ].join('\n    ');
  const withStaleFields = { ...footprint, source: footprint.source.replace('(generator pcbnew)', '(generator pcbnew)\n    ' + fields) };
  const symbolWithFields: KicadResolvedSymbol = {
    ...symbol,
    description: 'Real part description',
    properties: { ...symbol.properties, Datasheet: 'https://example.com/stm32.pdf' }
  };
  const result = synthesizeKicadBoard([
    { reference: 'R1', value: '10k', symbol: symbolWithFields, footprint: withStaleFields,
      symbolUuid: '66666666-6666-4666-8666-666666666666', xMm: 40, yMm: 35 }
  ], [], { projectName: 'parity', widthMm: 60, heightMm: 40 });
  assert.match(result.source, /\(property "Datasheet" "https:\/\/example\.com\/stm32\.pdf"/);
  assert.match(result.source, /\(property "Description" "Real part description"/);
  assert.doesNotMatch(result.source, /\(property "Datasheet" "OLD"/);
  assert.doesNotMatch(result.source, /\(property "Description" ""/);
});
