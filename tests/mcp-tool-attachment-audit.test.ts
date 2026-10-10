import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve('scripts/audit-mcp-tool-attachment.mjs');
const catalog = {
  version: '0.70.0-dev.6',
  actionSchemaVersion: 72,
  capabilities: [
    { id: 'baseline', tools: ['alpha', 'beta'], exposure: { exposed: true } },
    { id: 'media', tools: ['media_probe'], exposure: { exposed: true } },
    { id: 'inactive', tools: ['camera_probe'], exposure: { exposed: false } }
  ]
};

function audit(client: unknown, mcp?: unknown, source = catalog) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rwmcp-tool-audit-'));
  try {
    writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(source));
    writeFileSync(path.join(dir, 'client.json'), JSON.stringify(client));
    const args = [script, '--catalog', path.join(dir, 'catalog.json'), '--client', path.join(dir, 'client.json')];
    if (mcp !== undefined) {
      writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify(mcp));
      args.push('--mcp', path.join(dir, 'mcp.json'));
    }
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, report: result.status === 1 ? undefined : JSON.parse(result.stdout) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('all three surfaces match even with unselected packs and capability overlaps', () => {
  const result = audit(['beta', 'alpha', 'media_probe'], { tools: [{ name: 'media_probe' }, { name: 'alpha' }, { name: 'beta' }] });
  assert.equal(result.code, 0);
  assert.equal(result.report.status, 'PASS');
  assert.deepEqual(result.report.counts, { advertised: 3, chatgptAttached: 3, rawMcp: 3, advertisedNotClient: 0, advertisedNotMcp: 0, rawMcpNotClient: 0 });
});

test('server registration gap is distinguished from client attachment gap', () => {
  const serverGap = audit(['alpha', 'beta'], ['alpha', 'beta']);
  assert.equal(serverGap.code, 2);
  assert.deepEqual(serverGap.report.evidence.advertisedNotMcp, ['media_probe']);
  assert.deepEqual(serverGap.report.evidence.rawMcpNotClient, []);
  assert.match(serverGap.report.diagnosis, /server registration/);

  const clientGap = audit(['alpha', 'beta'], ['alpha', 'beta', 'media_probe']);
  assert.equal(clientGap.code, 2);
  assert.deepEqual(clientGap.report.evidence.advertisedNotMcp, []);
  assert.deepEqual(clientGap.report.evidence.rawMcpNotClient, ['media_probe']);
  assert.match(clientGap.report.diagnosis, /client connector/);
});

test('missing raw tools/list is explicitly incomplete and does not guess a cause', () => {
  const result = audit(['alpha']);
  assert.equal(result.code, 3);
  assert.equal(result.report.status, 'UNVERIFIED_RAW_MCP');
  assert.equal(result.report.counts.rawMcp, null);
  assert.equal(result.report.counts.advertisedNotClient, 2);
  assert.equal(result.report.evidence.groups.length, 2);
});

test('partial paginated tools/list cannot be mistaken for a server registration failure', () => {
  const result = audit(['alpha', 'beta', 'media_probe'], { tools: [{ name: 'alpha' }], nextCursor: 'next-page' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /paginated/);
});

test('duplicate or malformed tool names fail closed without exposing snapshot values', () => {
  const duplicates = audit(['alpha', 'alpha']);
  assert.equal(duplicates.code, 1);
  assert.match(duplicates.stderr, /duplicate tool names/);
  const malformed = audit(['alpha', 'secret:abc']);
  assert.equal(malformed.code, 1);
  assert.match(malformed.stderr, /invalid tool name/);
  assert.doesNotMatch(malformed.stderr, /secret:abc/);
});
