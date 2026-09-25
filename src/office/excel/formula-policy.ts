export type ExcelFormulaRisk =
  | 'external-workbook-reference'
  | 'dde-reference'
  | 'external-data-function'
  | 'external-link-function'
  | 'native-code-function';

export interface ExcelFormulaRiskFinding {
  risk: ExcelFormulaRisk;
  token: string;
}

const EXTERNAL_DATA_FUNCTIONS = [
  'WEBSERVICE', 'RTD', 'IMAGE', 'STOCKHISTORY',
  'CUBEMEMBER', 'CUBEVALUE', 'CUBESET', 'CUBESETCOUNT', 'CUBERANKEDMEMBER', 'CUBEKPIMEMBER'
] as const;
const EXTERNAL_LINK_FUNCTIONS = ['HYPERLINK'] as const;
const NATIVE_CODE_FUNCTIONS = ['CALL', 'REGISTER.ID'] as const;

function functionCall(formula: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Z0-9_.])${escaped}\\s*\\(`, 'i').test(formula);
}

export function analyzeExcelFormulaRisk(formula: string): ExcelFormulaRiskFinding[] {
  const value = formula.startsWith('=') ? formula.slice(1) : formula;
  const findings: ExcelFormulaRiskFinding[] = [];
  // External workbook references contain a workbook name in brackets. Keep ordinary structured-table refs (Table[Column]) valid.
  const externalWorkbook = value.match(/\[([^\]]*(?:\.(?:xlsx?|xlsm|xlsb|xltx|xltm|xlam|csv|ods)|[\\/:])[^\]]*)\]/i);
  if (externalWorkbook) findings.push({ risk: 'external-workbook-reference', token: externalWorkbook[0].slice(0, 256) });
  // Excel DDE links use the application|topic!item form; pipe is not a normal worksheet formula operator.
  if (value.includes('|')) findings.push({ risk: 'dde-reference', token: '|' });
  for (const name of EXTERNAL_DATA_FUNCTIONS) if (functionCall(value, name)) findings.push({ risk: 'external-data-function', token: name });
  for (const name of EXTERNAL_LINK_FUNCTIONS) if (functionCall(value, name)) findings.push({ risk: 'external-link-function', token: name });
  for (const name of NATIVE_CODE_FUNCTIONS) if (functionCall(value, name)) findings.push({ risk: 'native-code-function', token: name });
  return findings;
}

export function assertExcelFormulaSafe(formula: string): string {
  const value = formula.startsWith('=') ? formula.slice(1) : formula;
  if (!value || value.length > 32_768 || /[\0\r\n]/.test(value)) throw new Error('Excel formula must contain 1..32768 safe characters.');
  const findings = analyzeExcelFormulaRisk(value);
  if (findings.length) {
    throw new Error(`EXCEL_FORMULA_SIDE_EFFECT_BLOCKED: ${findings.map(item => `${item.risk}:${item.token}`).join(', ')}.`);
  }
  return value;
}
