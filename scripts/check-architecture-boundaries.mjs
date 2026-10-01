import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('src');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs']);
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,127}$/;
const PROJECT_SPECIFIC_CORE_TOKENS = [
  ['AUBOT', /\bAUBOT\b/i],
  ['B300', /\bB300\b/i],
  ['T500', /\bT500\b/i],
  ['Callbox', /\bCallbox\b/i],
  ['liftSensorStatus', /liftSensorStatus/i],
  ['aubotagv', /aubotagv/i],
];
const EXTENSION_FORBIDDEN_TOP_LEVEL_IMPORTS = new Set([
  'bootstrap',
  'tools',
  'tui',
  'web',
  'workers',
]);

const violations = [];
const registeredTools = new Map();
let inspectedFiles = 0;

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

function resolveSourceTopLevel(file, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const resolved = path.resolve(path.dirname(file), specifier);
  const relative = path.relative(ROOT, resolved).replaceAll('\\', '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return undefined;
  return relative.split('/')[0];
}

function recordTool(name, relative) {
  if (!TOOL_NAME_PATTERN.test(name)) {
    violations.push(`${relative}: public tool name '${name}' must use generic lowercase snake_case`);
  }
  const locations = registeredTools.get(name) ?? [];
  locations.push(relative);
  registeredTools.set(name, locations);
}

function inspect(file) {
  inspectedFiles += 1;
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

  if (relative.startsWith('extensions/') && relative !== 'extensions/builtin.ts') {
    for (const specifier of imports) {
      const topLevel = resolveSourceTopLevel(file, specifier);
      if (topLevel && EXTENSION_FORBIDDEN_TOP_LEVEL_IMPORTS.has(topLevel)) {
        violations.push(`${relative}: extension implementation must not depend on ${topLevel}/: ${specifier}`);
      }
    }
  }

  for (const match of text.matchAll(/server\.registerTool\('([^']+)'/g)) {
    recordTool(match[1], relative);
  }

  for (const [label, pattern] of PROJECT_SPECIFIC_CORE_TOKENS) {
    if (pattern.test(text)) {
      violations.push(
        `${relative}: project-specific token '${label}' must live in project/profile/manifest data, not shipping source`
      );
    }
  }
}

walk(ROOT);

for (const [tool, locations] of registeredTools) {
  if (locations.length > 1) {
    violations.push(`duplicate public MCP tool '${tool}' registered in: ${locations.join(', ')}`);
  }
}

if (violations.length) {
  console.error('Architecture boundary violations:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  `Architecture boundaries: OK (${inspectedFiles} source files, ${registeredTools.size} unique public MCP tools)`
);
