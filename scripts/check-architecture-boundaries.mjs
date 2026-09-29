import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('src');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs']);
const violations = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) inspect(full);
  }
}

function importsExtension(specifier) {
  return specifier.includes('/extensions/')
    || specifier.startsWith('../extensions')
    || specifier.startsWith('./extensions');
}

function inspect(file) {
  const relative = path.relative(ROOT, file).replaceAll('\\', '/');
  const text = fs.readFileSync(file, 'utf8');
  const imports = [...text.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)].map(match => match[2]);
  const lowerLayer = relative.startsWith('security/')
    || relative.startsWith('adapters/')
    || relative.startsWith('engineering/')
    || relative.startsWith('office/');

  if (lowerLayer || relative.startsWith('tools/')) {
    for (const specifier of imports) {
      if (importsExtension(specifier)) {
        violations.push(`${relative}: reverse dependency on extension composition: ${specifier}`);
      }
    }
  }
}

walk(ROOT);

if (violations.length) {
  console.error('Architecture boundary violations:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log('Architecture boundaries: OK');
