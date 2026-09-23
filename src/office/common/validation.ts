import type { OfficeValidationAssertion, OfficeValidationResult } from './contracts.js';

export function officeValidationResult(assertions: OfficeValidationAssertion[]): OfficeValidationResult {
  if (assertions.length === 0) throw new Error('Office validation requires at least one assertion.');
  return { passed: assertions.every(item => item.passed), assertions: assertions.map(item => ({ ...item })) };
}

export function requireOfficeValidationPass(result: OfficeValidationResult): void {
  if (result.passed) return;
  throw new Error(
    `OFFICE_ACCEPTANCE_FAILED: ${result.assertions.filter(item => !item.passed).map(item => item.id).join(', ')}`
  );
}
