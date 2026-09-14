export interface UpdateStatus {
  repository: string;
  installedVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  releaseUrl?: string;
  status: 'ok' | 'no_releases' | 'unavailable';
  message?: string;
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/, '');
}

function parts(value: string): number[] | undefined {
  const match = normalizeVersion(value).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function newer(latest: string, current: string): boolean {
  const a = parts(latest);
  const b = parts(current);
  if (!a || !b) return normalizeVersion(latest) !== normalizeVersion(current);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export class UpdateAdapter {
  constructor(private readonly installedVersion: string) {}

  async check(): Promise<UpdateStatus> {
    const repository = process.env.RWMCP_UPDATE_REPO ?? 'Tunglam0605/remote-workstation-mcp';
    const url = `https://api.github.com/repos/${repository}/releases/latest`;
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `remote-workstation-mcp/${this.installedVersion}` },
        signal: AbortSignal.timeout(5000)
      });
      if (response.status === 404) {
        return { repository, installedVersion: this.installedVersion, updateAvailable: false, status: 'no_releases', message: 'No GitHub releases are published yet.' };
      }
      if (!response.ok) throw new Error(`GitHub releases API returned HTTP ${response.status}.`);
      const payload = await response.json() as { tag_name?: string; html_url?: string };
      if (!payload.tag_name) throw new Error('Latest release has no tag_name.');
      const latestVersion = normalizeVersion(payload.tag_name);
      return {
        repository,
        installedVersion: this.installedVersion,
        latestVersion,
        updateAvailable: newer(latestVersion, this.installedVersion),
        releaseUrl: payload.html_url,
        status: 'ok'
      };
    } catch (error) {
      return {
        repository,
        installedVersion: this.installedVersion,
        updateAvailable: false,
        status: 'unavailable',
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
