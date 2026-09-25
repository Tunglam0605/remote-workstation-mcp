import assert from 'node:assert/strict';
import test from 'node:test';
import { parseKicadBomCsv } from '../src/adapters/engineering/kicad-bom.js';

test('KiCad BOM parser handles quoted CSV, quantities and DNP state', () => {
  const report = parseKicadBomCsv(`Refs,Value,Footprint,Qty,DNP\n"R1,R2","10k, 1%",R_0603,2,\nC1,100n,C_0603,1,1\n`, 10);
  assert.equal(report.rowCount, 2);
  assert.equal(report.totalQuantity, 3);
  assert.equal(report.dnpRows, 1);
  assert.deepEqual(report.rows[0], { refs: 'R1,R2', value: '10k, 1%', footprint: 'R_0603', quantity: 2, dnp: false });
  assert.deepEqual(report.rows[1], { refs: 'C1', value: '100n', footprint: 'C_0603', quantity: 1, dnp: true });
});

test('KiCad BOM parser bounds rows and reports truncation', () => {
  const report = parseKicadBomCsv('Refs,Value,Footprint,Qty,DNP\nR1,1k,R,1,\nR2,2k,R,1,\nR3,3k,R,1,\n', 2);
  assert.equal(report.rows.length, 2);
  assert.equal(report.rowsTruncated, true);
});

test('KiCad BOM parser rejects malformed quoted CSV', () => {
  assert.throws(() => parseKicadBomCsv('Refs,Value\n"R1,10k\n'), /quoted field/);
});
