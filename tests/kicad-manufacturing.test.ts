import assert from 'node:assert/strict';
import test from 'node:test';
import { auditKicadManufacturing, parseKicadPositionCsv } from '../src/adapters/engineering/kicad-manufacturing.js';

const BOARD=`(kicad_pcb
  (version 20250101)
  (generator pcbnew)
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (footprint "Package_QFP:LQFP-64_10x10mm_P0.5mm"
    (layer "F.Cu")
    (at 20 20)
    (property "Reference" "U1")
    (property "Value" "STM32F407")
    (attr smd)
    (fp_rect (start -6 -6) (end 6 6) (stroke (width 0.05) (type default)) (fill none) (layer "F.CrtYd"))
    (model "\${KICAD10_3DMODEL_DIR}/Package_QFP.3dshapes/LQFP-64_10x10mm_P0.5mm.step")
  )
  (footprint "Resistor_SMD:R_0603_1608Metric"
    (layer "F.Cu")
    (at 10 10)
    (property "Reference" "R1")
    (property "Value" "10k")
    (attr smd dnp)
    (fp_rect (start -1 -1) (end 1 1) (stroke (width 0.05) (type default)) (fill none) (layer "F.CrtYd"))
    (model "\${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step")
  )
  (footprint "Connector_Generic:Conn_01x04"
    (layer "F.Cu")
    (at 5 20)
    (property "Reference" "J1")
    (property "Value" "CAN")
    (attr through_hole)
  )
  (footprint "MountingHole:MountingHole_3.2mm_M3"
    (layer "F.Cu")
    (at 5 5)
    (property "Reference" "H1")
    (property "Value" "M3")
    (attr board_only exclude_from_bom exclude_from_pos_files)
    (fp_circle (center 0 0) (end 3 0) (stroke (width 0.05) (type default)) (fill none) (layer "F.CrtYd"))
  )
  (embedded_fonts no)
)`;

const POS=`Ref,Val,Package,PosX,PosY,Rot,Side
"U1","STM32F407","LQFP-64_10x10mm_P0.5mm",20,20,0,top
"J1","CAN","Conn_01x04",5,20,0,top
`;

test('KiCad manufacturing audit reconciles PCB assembly intent with BOM and position outputs',()=>{
  const pos=parseKicadPositionCsv(POS);
  assert.equal(pos.rowCount,2);
  assert.deepEqual(pos.references,['U1','J1']);
  assert.deepEqual(pos.duplicates,[]);

  const audit=auditKicadManufacturing(BOARD,pos.references,['U1','R1','J1']);
  assert.equal(audit.footprintSummary.total,4);
  assert.equal(audit.footprintSummary.smd,2);
  assert.equal(audit.footprintSummary.throughHole,1);
  assert.equal(audit.footprintSummary.boardOnly,1);
  assert.equal(audit.footprintSummary.dnp,1);
  assert.equal(audit.assemblyConsistency.expectedPositionCount,2);
  assert.deepEqual(audit.assemblyConsistency.missingPositionRefs,[]);
  assert.deepEqual(audit.assemblyConsistency.unexpectedPositionRefs,[]);
  assert.deepEqual(audit.assemblyConsistency.missingBomRefs,[]);
  assert.deepEqual(audit.assemblyConsistency.unexpectedBomRefs,[]);
  assert.deepEqual(audit.assemblyConsistency.dnpIncludedInPosition,[]);
  assert.deepEqual(audit.footprintQuality.missingCourtyardRefs,['J1']);
  assert.deepEqual(audit.footprintQuality.missing3dModelRefs,['J1']);
  assert.deepEqual(audit.footprintQuality.boardOnlyNotExcluded,[]);
  assert.equal(audit.ready,true);
  assert.ok(audit.findings.some(item=>item.code==='missing-courtyard'&&item.severity==='review'));
  assert.ok(audit.findings.some(item=>item.code==='missing-3d-model'&&item.severity==='review'));
});

test('KiCad manufacturing audit blocks missing/forbidden position and BOM references',()=>{
  const audit=auditKicadManufacturing(BOARD,['U1','R1','H1'],['U1']);
  assert.equal(audit.ready,false);
  assert.deepEqual(audit.assemblyConsistency.missingPositionRefs,['J1']);
  assert.deepEqual(audit.assemblyConsistency.unexpectedPositionRefs,['H1','R1']);
  assert.deepEqual(audit.assemblyConsistency.missingBomRefs,['J1','R1']);
  assert.deepEqual(audit.assemblyConsistency.dnpIncludedInPosition,['R1']);
  const high=new Set(audit.findings.filter(item=>item.severity==='high').map(item=>item.code));
  assert.equal(high.has('position-export-missing-reference'),true);
  assert.equal(high.has('position-export-unexpected-reference'),true);
  assert.equal(high.has('bom-export-missing-reference'),true);
  assert.equal(high.has('dnp-present-in-position'),true);
});

test('KiCad position parser reports duplicate references and quoted cells safely',()=>{
  const parsed=parseKicadPositionCsv(`Ref,Val,Package,PosX,PosY,Rot,Side
"U1","MCU, main","LQFP",1,2,0,top
"U1","MCU, main","LQFP",1,2,0,top
`);
  assert.equal(parsed.rowCount,2);
  assert.deepEqual(parsed.duplicates,['U1']);
});
