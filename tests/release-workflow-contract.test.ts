import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('Release Request publishes and verifies the complete cross-platform release asset set', async () => {
  const workflow = await fs.readFile('.github/workflows/release-request.yml', 'utf8');

  assert.match(workflow, /run: npm ci --no-audit --no-fund/);
  assert.match(workflow, /cp scripts\/install-linux\.sh release\/install-linux\.sh/);
  assert.match(workflow, /npm sbom --sbom-format cyclonedx > release\/rwmcp-sbom\.cdx\.json/);

  const buildStart = workflow.indexOf('- name: Build release assets');
  const smokeStart = workflow.indexOf('- name: Smoke-test packed release', buildStart);
  assert.ok(buildStart >= 0 && smokeStart > buildStart);
  const buildBlock = workflow.slice(buildStart, smokeStart);
  assert.match(buildBlock, /remote-workstation-mcp-\$\{TAG\}\.tgz/);
  assert.match(buildBlock, /install-windows\.ps1 install-windows\.cmd install-linux\.sh/);
  assert.match(buildBlock, /rwmcp-sbom\.cdx\.json > SHA256SUMS\.txt/);

  const publishStart = workflow.indexOf('- name: Publish GitHub Release');
  const verifyStart = workflow.indexOf('- name: Verify published release assets', publishStart);
  assert.ok(publishStart >= 0 && verifyStart > publishStart);
  const publishBlock = workflow.slice(publishStart, verifyStart);
  for (const asset of [
    'install-windows.ps1',
    'install-windows.cmd',
    'install-linux.sh',
    'rwmcp-sbom.cdx.json',
    'SHA256SUMS.txt'
  ]) {
    assert.match(publishBlock, new RegExp(asset.replaceAll('.', '\\.')));
  }

  const verifyBlock = workflow.slice(verifyStart);
  assert.match(verifyBlock, /gh release view "\$TAG" --json assets/);
  assert.match(verifyBlock, /Missing required release asset/);
  assert.match(verifyBlock, /install-linux\.sh/);
  assert.match(verifyBlock, /rwmcp-sbom\.cdx\.json/);
});
