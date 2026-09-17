import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchReleaseAsset, verifySha256 } from '../scripts/lib/release-download.mjs';

test('release asset download falls back to GitHub API only after browser URL HTTP 5xx', async () => {
  const calls: Array<{url: string; headers?: Record<string,string>}> = [];
  const asset = {
    name: 'remote-workstation-mcp-v0.9.10.tgz',
    browser_download_url: 'https://github.com/example/repo/releases/download/v0.9.10/pkg.tgz',
    url: 'https://api.github.com/repos/example/repo/releases/assets/123'
  };
  const fetchImpl = async (url: string, init?: any) => {
    calls.push({ url, headers: init?.headers });
    if (calls.length === 1) return new Response('edge failure', { status: 500 });
    return new Response(Buffer.from('release-bytes'), { status: 200 });
  };
  const buffer = await fetchReleaseAsset(asset, { fetchImpl });
  assert.equal(buffer.toString(), 'release-bytes');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, asset.browser_download_url);
  assert.equal(calls[1].url, asset.url);
  assert.match(String(calls[1].headers?.Accept), /application\/octet-stream/);
});

test('release asset download fails closed on HTTP 4xx without API fallback', async () => {
  let calls = 0;
  const asset = { name: 'pkg.tgz', browser_download_url: 'https://example.invalid/pkg', url: 'https://api.example.invalid/asset/1' };
  await assert.rejects(
    () => fetchReleaseAsset(asset, { fetchImpl: async () => { calls += 1; return new Response('missing', { status: 404 }); } }),
    /HTTP 404/
  );
  assert.equal(calls, 1);
});

test('SHA-256 verification fails closed on checksum mismatch', () => {
  assert.throws(() => verifySha256(Buffer.from('actual'), '0'.repeat(64)), /Checksum mismatch/);
});
