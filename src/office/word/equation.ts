import { DOMParser, type Element } from '@xmldom/xmldom';

export const OMML_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function wordLinearTextToOmml(value: string): string {
  if (!value.trim()) throw new Error('Word linear equation text must not be empty.');
  if (value.length > 2048 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) {
    throw new Error('Word linear equation text is invalid or exceeds 2048 characters.');
  }
  const preserve = /^\s|\s$|\s{2,}/.test(value) ? ' xml:space="preserve"' : '';
  return `<m:oMath xmlns:m="${OMML_NAMESPACE}"><m:r><m:t${preserve}>${escapeXml(value)}</m:t></m:r></m:oMath>`;
}

export function parseOmmlFragment(value: string, allowedRoots: readonly string[] = ['oMath', 'oMathPara']): Element {
  if (!value.trim() || value.length > 256 * 1024) throw new Error('OMML fragment must be non-empty and at most 256 KiB.');
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error('OMML fragment must not contain DTD/entity declarations.');
  const errors: string[] = [];
  const document = new DOMParser({ onError: error => errors.push(String(error)) })
    .parseFromString(value, 'application/xml');
  if (!document || errors.length > 0) {
    throw new Error(`OMML_XML_INVALID: ${errors.join('; ').slice(0, 512)}`);
  }
  const root = document.documentElement;
  const rootName = root?.localName ?? '';
  if (!root || !allowedRoots.includes(rootName) || root.namespaceURI !== OMML_NAMESPACE) {
    throw new Error(`OMML_ROOT_INVALID: expected ${allowedRoots.join(' or ')} in the Office Math namespace.`);
  }
  return root;
}

export function validateOmmlFragment(value: string): { root: 'oMath' | 'oMathPara'; text: string } {
  const root = parseOmmlFragment(value);
  return {
    root: root.localName as 'oMath' | 'oMathPara',
    text: root.textContent ?? ''
  };
}
