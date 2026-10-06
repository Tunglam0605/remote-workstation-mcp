import assert from 'node:assert/strict';
import test from 'node:test';
import { planKicadSemanticPlacement } from '../src/adapters/engineering/kicad-semantic-placement.js';

const manifest={
  schemaVersion:1,
  projectName:'robot',
  components:[
    {reference:'U1',symbolId:'MCU_ST_STM32F4:STM32F407VETx',value:'STM32F407VET6',footprintId:'Package_QFP:LQFP-100_14x14mm_P0.5mm',onBoard:true},
    {reference:'J1',symbolId:'Connector_Generic:Conn_01x04',value:'CAN',footprintId:'Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical',onBoard:true},
    {reference:'U2',symbolId:'Interface_CAN_LIN:TJA1051T',value:'CAN transceiver',footprintId:'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm',onBoard:true},
    {reference:'C1',symbolId:'Device:C',value:'100n',footprintId:'Capacitor_SMD:C_0603_1608Metric',onBoard:true},
    {reference:'Y1',symbolId:'Device:Crystal',value:'8MHz crystal',footprintId:'Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm',onBoard:true},
    {reference:'U3',symbolId:'Regulator_Switching:TPS5430',value:'Buck regulator',footprintId:'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm',onBoard:true},
    {reference:'R1',symbolId:'Device:R',value:'10k',footprintId:'Resistor_SMD:R_0603_1608Metric',onBoard:true}
  ],
  nets:[
    {name:'CAN_TX',endpoints:[{reference:'U1',pinNumber:'1'},{reference:'U2',pinNumber:'1'}]},
    {name:'CAN_RX',endpoints:[{reference:'U1',pinNumber:'2'},{reference:'U2',pinNumber:'2'}]},
    {name:'CAN_H',endpoints:[{reference:'U2',pinNumber:'3'},{reference:'J1',pinNumber:'1'}]},
    {name:'CAN_L',endpoints:[{reference:'U2',pinNumber:'4'},{reference:'J1',pinNumber:'2'}]},
    {name:'+3V3',endpoints:[{reference:'U1',pinNumber:'5'},{reference:'C1',pinNumber:'1'},{reference:'R1',pinNumber:'1'}]},
    {name:'OSC_IN',endpoints:[{reference:'U1',pinNumber:'6'},{reference:'Y1',pinNumber:'1'}]},
    {name:'VIN',endpoints:[{reference:'U3',pinNumber:'1'},{reference:'J1',pinNumber:'3'}]}
  ]
};

test('semantic placement applies MCU center, connector edge and anchor-aware local placement',()=>{
  const plan=planKicadSemanticPlacement(manifest,{
    widthMm:80,heightMm:60,originXmm:20,originYmm:20,gridMm:0.5,minSpacingMm:3,edgeInsetMm:4,
    hints:[
      {reference:'J1',role:'connector',edge:'right'},
      {reference:'C1',role:'decoupling',anchorRef:'U1'},
      {reference:'Y1',role:'crystal',anchorRef:'U1'},
      {reference:'U2',role:'transceiver',anchorRef:'J1'}
    ]
  });
  const byRef=new Map(plan.placements.map(p=>[p.reference,p]));
  assert.equal(byRef.get('U1')?.role,'mcu');
  assert.ok(Math.abs((byRef.get('U1')?.xMm??0)-60)<=0.5);
  assert.ok(Math.abs((byRef.get('U1')?.yMm??0)-50)<=0.5);
  assert.equal(byRef.get('J1')?.xMm,96);
  assert.equal(byRef.get('J1')?.rotationDeg,90);
  assert.ok(Math.hypot((byRef.get('C1')?.xMm??0)-(byRef.get('U1')?.xMm??0),(byRef.get('C1')?.yMm??0)-(byRef.get('U1')?.yMm??0))<=7);
  assert.ok(Math.hypot((byRef.get('Y1')?.xMm??0)-(byRef.get('U1')?.xMm??0),(byRef.get('Y1')?.yMm??0)-(byRef.get('U1')?.yMm??0))<=9);
  assert.ok(Math.hypot((byRef.get('U2')?.xMm??0)-(byRef.get('J1')?.xMm??0),(byRef.get('U2')?.yMm??0)-(byRef.get('J1')?.yMm??0))<=11);
  assert.equal(byRef.get('U3')?.role,'power');
  for(const p of plan.placements){
    assert.equal((p.xMm*2)%1,0);
    assert.equal((p.yMm*2)%1,0);
  }
  for(let i=0;i<plan.placements.length;i++) for(let j=i+1;j<plan.placements.length;j++){
    const a=plan.placements[i]!,b=plan.placements[j]!;
    assert.ok(Math.hypot(a.xMm-b.xMm,a.yMm-b.yMm)>=2.99,`${a.reference}/${b.reference} overlap`);
  }
  assert.equal(plan.executionHint.tool,'kicad_board_synthesize');
});

test('semantic placement rejects unknown hints and preserves explicit locked hints',()=>{
  assert.throws(()=>planKicadSemanticPlacement(manifest,{widthMm:80,heightMm:60,hints:[{reference:'BAD',role:'connector'}]}),/unknown component BAD/);
  const plan=planKicadSemanticPlacement(manifest,{widthMm:80,heightMm:60,hints:[{reference:'J1',role:'connector',edge:'left',locked:true}]});
  const j1=plan.placements.find(p=>p.reference==='J1');
  assert.equal(j1?.locked,true);
  assert.equal(j1?.xMm,24);
});
