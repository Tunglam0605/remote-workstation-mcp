import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeKicadElectrical } from '../src/adapters/engineering/kicad-electrical-review.js';

const BOARD=`(kicad_pcb
  (version 20250101)
  (generator pcbnew)
  (general (thickness 1.6))
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (44 "Edge.Cuts" user)
  )
  (setup
    (stackup
      (layer "F.Cu" (type "copper") (thickness 0.035))
      (layer "dielectric 1" (type "core") (thickness 1.53) (material "FR4") (epsilon_r 4.2) (loss_tangent 0.02))
      (layer "B.Cu" (type "copper") (thickness 0.035))
    )
  )
  (net 0 "")
  (net 1 "PWR")
  (net 2 "CLK")
  (net 3 "USB_P")
  (net 4 "USB_N")
  (segment (start 0 0) (end 100 0) (width 0.5) (layer "F.Cu") (net 1))
  (segment (start 0 10) (end 20 10) (width 0.2) (layer "F.Cu") (net 2))
  (via (at 20 10) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 2))
  (segment (start 0 20) (end 20 20) (width 0.18) (layer "F.Cu") (net 3))
  (segment (start 0 21) (end 25 21) (width 0.18) (layer "F.Cu") (net 4))
)`;

test('KiCad electrical review estimates copper DC drop and flags intent exceedance without ampacity claims',()=>{
  const review=analyzeKicadElectrical(BOARD,[
    {netName:'PWR',kind:'power',currentA:2,voltageV:5,maxVoltageDropPct:1,maxLengthMm:80,maxViaCount:0},
    {netName:'CLK',kind:'clock',maxLengthMm:30,maxViaCount:0,targetImpedanceOhm:50},
    {netName:'USB_P',kind:'differential',pairWith:'USB_N',maxSkewMm:2,targetImpedanceOhm:90},
    {netName:'USB_N',kind:'differential',pairWith:'USB_P',maxSkewMm:2,targetImpedanceOhm:90},
    {netName:'MISSING',kind:'digital'}
  ]);

  const pwr=review.nets.find(item=>item.netName==='PWR')!;
  assert.equal(pwr.route.lengthMm,100);
  assert.ok((pwr.dcCopper20C.resistanceOhm??0)>0.09);
  assert.ok((pwr.dcCopper20C.voltageDropPct??0)>3);
  assert.ok(pwr.findings.some(item=>item.code==='dc-drop-over-intent'));
  assert.ok(pwr.findings.some(item=>item.code==='length-over-intent'));

  const clk=review.nets.find(item=>item.netName==='CLK')!;
  assert.equal(clk.route.vias,1);
  assert.ok(clk.findings.some(item=>item.code==='critical-net-layer-transition'));
  assert.ok(clk.findings.some(item=>item.code==='impedance-solver-required'));

  const usbP=review.nets.find(item=>item.netName==='USB_P')!;
  assert.ok(usbP.findings.some(item=>item.code==='pair-skew-over-intent'));
  assert.ok(usbP.findings.some(item=>item.code==='impedance-solver-required'));

  const missing=review.nets.find(item=>item.netName==='MISSING')!;
  assert.ok(missing.findings.some(item=>item.code==='net-not-routed'));

  assert.ok(review.findings.high>=3);
  assert.match(review.limitations.join(' '),/IPC-2152 ampacity/i);
  assert.match(review.limitations.join(' '),/field solver/i);
  assert.match(review.limitations.join(' '),/EMI/i);
});

test('KiCad electrical review reports partial resistance coverage when routed copper layer thickness is missing',()=>{
  const source=BOARD.replace('(layer "B.Cu" (type "copper") (thickness 0.035))','(layer "B.Cu" (type "copper"))')
    .replace('(segment (start 0 10) (end 20 10) (width 0.2) (layer "F.Cu") (net 2))',
             '(segment (start 0 10) (end 20 10) (width 0.2) (layer "B.Cu") (net 2))');
  const review=analyzeKicadElectrical(source,[{netName:'CLK',kind:'clock',currentA:0.1,voltageV:3.3}]);
  const clk=review.nets[0]!;
  assert.equal(clk.route.lengthMm,20);
  assert.equal(clk.dcCopper20C.resistanceOhm,undefined);
  assert.ok(clk.findings.some(item=>item.code==='critical-net-layer-transition'));
});
