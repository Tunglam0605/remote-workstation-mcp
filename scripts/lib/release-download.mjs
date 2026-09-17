import crypto from 'node:crypto';

const USER_AGENT = 'remote-workstation-mcp-updater';

async function responseBuffer(response) {
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchReleaseAsset(asset, { fetchImpl = globalThis.fetch } = {}) {
  if (!asset?.name || !asset?.browser_download_url) throw new Error('Release asset is missing name or browser_download_url.');
  const primary = await fetchImpl(asset.browser_download_url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow'
  });
  if (primary.ok) return await responseBuffer(primary);

  const status = Number(primary.status);
  const mayFallback = status >= 500 && status <= 599 && typeof asset.url === 'string' && asset.url.length > 0;
  if (!mayFallback) throw new Error(`Download failed with HTTP ${status}: ${asset.browser_download_url}`);

  const fallback = await fetchImpl(asset.url, {
    headers: {
      Accept: 'application/octet-stream',
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28'
    },
    redirect: 'follow'
  });
  if (!fallback.ok) {
    throw new Error(`Download failed with HTTP ${status} and GitHub API fallback HTTP ${fallback.status}: ${asset.name}`);
  }
  return await responseBuffer(fallback);
}

export function verifySha256(buffer, expectedSha256) {
  const expected = String(expectedSha256 ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('Expected SHA-256 is invalid.');
  const actual = crypto.createHash('sha256').update(buffer).digest('hex');
  if (actual !== expected) throw new Error(`Checksum mismatch: expected ${expected}, got ${actual}.`);
  return actual;
}
