import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { footprintMatchesFilters, resolveKicadFootprint, resolveKicadSymbol, searchKicadFootprints, searchKicadSymbols, type KicadLibraryPaths } from '../src/adapters/engineering/kicad-library.js';

async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rwmcp-kicad-lib-'));
  const symbolRoot=path.join(root,'symbols');
  const footprintRoot=path.join(root,'footprints');
  await fs.mkdir(symbolRoot,{recursive:true});
  await fs.mkdir(path.join(footprintRoot,'Package_QFP.pretty'),{recursive:true});
  const symbols=`(kicad_symbol_lib\n  (version 20231120)\n  (generator kicad_symbol_editor)\n  (symbol "MCU_BASE"\n    (in_bom yes) (on_board yes)\n    (property "Reference" "U" (at 0 5 0) (effects (font (size 1.27 1.27))))\n    (property "Value" "MCU_BASE" (at 0 -5 0) (effects (font (size 1.27 1.27))))\n    (property "Footprint" "Package_QFP:LQFP-4_Test" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))\n    (property "Description" "Base microcontroller" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))\n    (property "ki_fp_filters" "LQFP*Test*" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))\n    (symbol "MCU_BASE_0_1" (rectangle (start -5 5) (end 5 -5) (stroke (width 0.2) (type default)) (fill (type background))))\n    (symbol "MCU_BASE_1_1"\n      (pin bidirectional line (at -10 2.5 0) (length 5) (name "PA9" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))) (alternate "USART1_TX" bidirectional line))\n      (pin power_in line (at 0 -10 90) (length 5) (name "VDD" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))\n    )\n  )\n  (symbol "MCU_TEST"\n    (extends "MCU_BASE")\n    (property "Reference" "U" (at 0 6 0) (effects (font (size 1.27 1.27))))\n    (property "Value" "MCU_TEST" (at 0 -6 0) (effects (font (size 1.27 1.27))))\n    (property "Description" "Test inherited microcontroller" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))\n  )\n)`;
  await fs.writeFile(path.join(symbolRoot,'MCU_TESTLIB.kicad_sym'),symbols);
  const footprint=`(footprint "LQFP-4_Test"\n  (version 20240108) (generator pcbnew) (layer "F.Cu")\n  (descr "Test LQFP") (tags "LQFP test") (attr smd)\n  (pad "1" smd rect (at -1 -1) (size 0.5 1.2) (layers "F.Cu" "F.Paste" "F.Mask"))\n  (pad "2" smd rect (at 1 -1) (size 0.5 1.2) (layers "F.Cu" "F.Paste" "F.Mask"))\n  (model "\${KICAD9_3DMODEL_DIR}/Package_QFP.3dshapes/LQFP-4_Test.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))\n)`;
  await fs.writeFile(path.join(footprintRoot,'Package_QFP.pretty','LQFP-4_Test.kicad_mod'),footprint);
  const paths:KicadLibraryPaths={shareRoot:root,symbolRoot,footprintRoot,blankProjectTemplate:path.join(root,'kicad.kicad_pro')};
  await fs.writeFile(paths.blankProjectTemplate,'{}');
  return {root,paths};
}

test('KiCad library resolver flattens inherited symbols and exposes exact pins/alternates', async()=>{
  const {root,paths}=await fixture();
  try {
    const symbol=await resolveKicadSymbol(paths,'MCU_TESTLIB:MCU_TEST');
    assert.deepEqual(symbol.extendsChain,['MCU_TEST','MCU_BASE']);
    assert.equal(symbol.properties.Value,'MCU_TEST');
    assert.equal(symbol.footprint,'Package_QFP:LQFP-4_Test');
    assert.equal(symbol.pins.length,2);
    assert.deepEqual(symbol.pins.find(pin=>pin.number==='1')?.alternates,['USART1_TX']);
    assert.match(symbol.embeddedDefinition,/symbol "MCU_TESTLIB:MCU_TEST"/);
    assert.doesNotMatch(symbol.embeddedDefinition,/\(extends /);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('KiCad footprint resolver and search keep compatibility evidence bounded', async()=>{
  const {root,paths}=await fixture();
  try {
    const symbol=await resolveKicadSymbol(paths,'MCU_TESTLIB:MCU_TEST');
    const footprint=await resolveKicadFootprint(paths,'Package_QFP:LQFP-4_Test');
    assert.equal(footprint.pads.length,2);
    assert.equal(footprint.modelPaths.length,1);
    assert.equal(footprintMatchesFilters(footprint.id,symbol.footprintFilters),true);
    const symbols=await searchKicadSymbols(paths,'MCU_TEST',5);
    assert.equal(symbols[0]?.id,'MCU_TESTLIB:MCU_TEST');
    assert.ok(symbols.some(item=>item.id==='MCU_TESTLIB:MCU_TEST'));
    assert.deepEqual((await searchKicadFootprints(paths,'LQFP 4 Test',5)).map(item=>item.id),['Package_QFP:LQFP-4_Test']);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
