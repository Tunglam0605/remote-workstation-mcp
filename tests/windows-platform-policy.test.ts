import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string) => readFileSync(path.join(repo, relative), 'utf8');
const workflow = (name: string) => YAML.parse(read('.github/workflows/' + name)) as {
  jobs: Record<string, { 'runs-on'?: string; steps?: Array<{name?: string; run?: string}> }>
};

test('active CI tests Windows rather than developing frozen Ubuntu', () => {
  const ci = workflow('ci.yml');
  assert.deepEqual(Object.keys(ci.jobs), ['build-test-windows']);
  const win = ci.jobs['build-test-windows'];
  assert.equal(win['runs-on'], 'windows-latest');
  const steps = win.steps ?? [];
  assert.ok(steps.some(s => s.name === 'Audit production dependencies'));
  assert.ok(steps.some(s => s.name === 'Generate CycloneDX SBOM'));
  assert.ok(steps.some(s => s.name === 'Smoke-test packed Windows engineering runtime'));
  assert.ok(steps.some(s => s.name === 'PTY/ConPTY lifecycle soak'));
});

test('future release jobs only publish Windows installer artifacts', () => {
  const release = workflow('release.yml');
  const request = workflow('release-request.yml');
  assert.equal(release.jobs.release['runs-on'], 'windows-latest');
  assert.equal(request.jobs['create-tag']['runs-on'], 'windows-latest');
  const steps = release.jobs.release.steps ?? [];
  const combined = steps.map(s => s.run ?? '').join('\n');
  assert.doesNotMatch(combined, /install-linux[.]sh/);
  assert.match(combined, /install-windows[.]ps1/);
  assert.match(combined, /install-windows[.]cmd/);
  assert.ok(steps.some(s => s.name === 'Smoke-test packed Windows release'));
  assert.match(combined, /smoke-package-windows[.]ps1/);
});

test('legacy Ubuntu release is deliberately version-pinned and kept immutable', () => {
  const policy = read('docs/PLATFORM_SUPPORT_POLICY.md');
  assert.match(policy, /v0[.]66[.]0/);
  assert.match(policy, /RWMCP_VERSION=0[.]66[.]0/);
  assert.match(policy, /Ubuntu Vision PC/);
  assert.match(policy, /External SSD Ubuntu PC/);
  assert.match(policy, /historical|legacy|immutable/i);
});
