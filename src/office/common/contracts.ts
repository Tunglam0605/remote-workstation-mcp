export const OFFICE_PACK_API_VERSION = 1 as const;

export const OFFICE_DOMAINS = ['word', 'excel', 'powerpoint'] as const;
export type OfficeDomain = typeof OFFICE_DOMAINS[number];

export const OFFICE_BACKENDS = ['ooxml', 'windows-com', 'ui-automation'] as const;
export type OfficeBackendId = typeof OFFICE_BACKENDS[number];

export const OFFICE_CAPABILITIES = [
  'package.inspect',
  'package.validate',
  'word.inspect',
  'word.edit',
  'word.equation.omml',
  'word.equation.native-verify',
  'word.render.pdf',
  'excel.inspect',
  'excel.edit',
  'excel.calculate',
  'excel.render.pdf',
  'powerpoint.inspect',
  'powerpoint.edit',
  'powerpoint.render'
] as const;
export type OfficeCapability = typeof OFFICE_CAPABILITIES[number];

export type OfficeBackendStatus = 'available' | 'unavailable' | 'not-implemented';

export interface OfficeBackendDescriptor {
  id: OfficeBackendId;
  status: OfficeBackendStatus;
  domains: OfficeDomain[];
  capabilities: OfficeCapability[];
  nativeApplication: boolean;
  headless: boolean;
  reason?: string;
}

export interface OfficeBackendRequirement {
  domain: OfficeDomain;
  capabilities: OfficeCapability[];
  allowedBackends?: OfficeBackendId[];
}

export interface OfficeValidationAssertion {
  id: string;
  passed: boolean;
  expected?: string | number | boolean;
  actual?: string | number | boolean;
  detail?: string;
}

export interface OfficeValidationResult {
  passed: boolean;
  assertions: OfficeValidationAssertion[];
}

export interface OfficeEvidenceArtifact {
  kind: 'structural-report' | 'render' | 'pdf' | 'application-open' | 'package-validation';
  path?: string;
  sha256?: string;
  createdAt: string;
  backend?: OfficeBackendId;
}
