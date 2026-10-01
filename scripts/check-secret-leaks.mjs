import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const FALLBACK_EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.rwmcp']);
const PATTERNS = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{30,}/],
  ['openai-key', /sk-[A-Za-z0-9_-]{32,}/],
  ['aws-access-key', /AKIA[0-9A-Z]{16}/],
];

function walkSourceTree(dir, root, output) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && FALLBACK_EXCLUDED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSourceTree(full, root, output);
    else if (entry.isFile()) output.push(path.relative(root, full).replaceAll('\\', '/'));
  }
}

function candidateFiles() {
  try {
    const tracked = execFileSync('git', ['ls-files', '-z'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\0').filter(Boolean);
    return { files: tracked, source: 'git-index' };
  } catch {
    const root = process.cwd();
    const files = [];
    walkSourceTree(root, root, files);
    return { files, source: 'source-tree-fallback' };
  }
}

const { files, source } = candidateFiles();
const findings = [];
let inspected = 0;

for (const file of files) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) continue;

  const buffer = fs.readFileSync(file);
  if (buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0)) continue;
  const text = buffer.toString('utf8');
  inspected += 1;

  for (const [label, pattern] of PATTERNS) {
    if (pattern.test(text)) findings.push({ label, file });
  }
}

if (findings.length) {
  console.error('High-confidence secret patterns detected:');
  for (const finding of findings) {
    console.error(`- ${finding.label}: ${finding.file}`);
  }
  process.exit(1);
}

console.error(`Secret scan: OK (${inspected} text files inspected; source=${source})`);
