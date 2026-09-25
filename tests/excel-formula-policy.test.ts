import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeExcelFormulaRisk, assertExcelFormulaSafe } from '../src/office/excel/formula-policy.js';

test('Excel formula policy distinguishes structured references from external workbooks', () => {
  assert.equal(analyzeExcelFormulaRisk('SUM(Table1[Amount])').length, 0);
  assert.equal(assertExcelFormulaSafe('=SUM(Table1[Amount])'), 'SUM(Table1[Amount])');
  assert.deepEqual(analyzeExcelFormulaRisk("'[Other.xlsx]Sheet1'!A1").map(item => item.risk), ['external-workbook-reference']);
});

test('Excel formula policy blocks external data, links, DDE and native-code functions', () => {
  for (const formula of [
    'WEBSERVICE("https://example.com")',
    'RTD("server.prog",,"topic")',
    'IMAGE("https://example.com/a.png")',
    'STOCKHISTORY("MSFT")',
    'HYPERLINK("https://example.com","open")',
    'CALL("xll","proc","J")',
    'REGISTER.ID("xll","proc","J")',
    "'excel'|topic!A1"
  ]) assert.throws(() => assertExcelFormulaSafe(formula), /EXCEL_FORMULA_SIDE_EFFECT_BLOCKED/);
});
