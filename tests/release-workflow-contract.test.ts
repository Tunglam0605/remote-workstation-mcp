import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('Release Request validates/tag-gates and delegates to the canonical publisher workflow', async () => {
  const workflow = await fs.readFile('.github/workflows/release-request.yml', 'utf8');

  assert.match(workflow, /name: Create canonical release tag/);
  assert.match(workflow, /git tag -a "\$TAG"/);
  assert.match(workflow, /git push origin "refs\/tags\/\$TAG"/);
  assert.match(workflow, /outputs:\s*\n\s*tag: \$\{\{ steps\.release\.outputs\.tag \}\}/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/release\.yml/);
  assert.match(workflow, /tag: \$\{\{ needs\.create-tag\.outputs\.tag \}\}/);

  assert.doesNotMatch(workflow, /Build release assets/);
  assert.doesNotMatch(workflow, /gh release create/);
  assert.doesNotMatch(workflow, /gh release upload/);
  assert.doesNotMatch(workflow, /npm sbom/);
});

test('Release workflow is the single reusable and tag-triggered publisher with complete gates', async () => {
  const workflow = await fs.readFile('.github/workflows/release.yml', 'utf8');

  assert.match(workflow, /tags:\s*\n\s*- 'v\*\.\*\.\*'/);
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /tag:\s*\n\s*description: Exact release tag to publish\./);
  assert.match(workflow, /group: release-\$\{\{ inputs\.tag \|\| github\.ref_name \}\}/);
  assert.match(workflow, /RELEASE_TAG: \$\{\{ inputs\.tag \|\| github\.ref_name \}\}/);

  assert.match(workflow, /npm run supply-chain:validate/);
  assert.match(workflow, /npm run architecture:check/);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /npm run plugin:validate/);
  assert.match(workflow, /npm sbom --sbom-format cyclonedx > release\/rwmcp-sbom\.cdx\.json/);
  assert.match(workflow, /Smoke-test packed release/);
  assert.match(workflow, /bash scripts\/smoke-package\.sh "release\/remote-workstation-mcp-\$\{RELEASE_TAG\}\.tgz"/);

  assert.match(workflow, /Create GitHub Release if absent/);
  assert.match(workflow, /gh release view "\$RELEASE_TAG"/);
  assert.match(workflow, /gh release create "\$RELEASE_TAG"/);
  assert.match(workflow, /gh release upload "\$RELEASE_TAG"/);
  assert.match(workflow, /--clobber/);
  assert.match(workflow, /Missing required release asset/);

  for (const asset of [
    'install-windows.ps1',
    'install-windows.cmd',
    'install-linux.sh',
    'rwmcp-sbom.cdx.json',
    'SHA256SUMS.txt'
  ]) {
    assert.match(workflow, new RegExp(asset.replaceAll('.', '\\.')));
  }
});
