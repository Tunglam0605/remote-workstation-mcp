import { readFileSync } from 'node:fs';

const template = readFileSync(new URL('../../assets/moonlight/index.html', import.meta.url), 'utf8');

export function setupHtml(token: string): string {
  // Escape even though server-generated tokens use only the base64url alphabet.
  const escaped = token.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll("'", '&#39;');
  return template.replace('__RWMCP_SETUP_TOKEN__', () => escaped);
}
