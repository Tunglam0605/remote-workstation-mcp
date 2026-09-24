import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { setupConfigDir } from '../setup/settings.js';
import type {
  BrowserElementCandidate,
  BrowserElementTarget,
  BrowserInteraction,
  BrowserProvider,
  BrowserWaitCondition,
  ManagedBrowser,
  SemanticRole
} from './browser-provider.js';

export type DomainPolicy = (hostname: string) => boolean;
export type BrowserUploadFile = { absolutePath: string; name: string; bytes: number; mimeType: string };
type Owner = { principalId: string; workSessionId: string };
type ElementRef = BrowserElementTarget & { id: string; generation: number };
type Tab = { id: string; page: Page; generation: number; refs: Map<string, ElementRef>; nextRef: number };
type DownloadRecord = {
  downloadId: string;
  status: 'ready' | 'failed';
  name: string;
  bytes: number;
  mimeType: string;
  sha256: string;
  path: string;
  sourceDomain: string;
};
type Session = Owner & {
  id: string;
  mode: 'background' | 'visible';
  profile?: string;
  managed: ManagedBrowser;
  tabs: Map<string, Tab>;
  downloads: Map<string, DownloadRecord>;
  activeTabId: string;
  closed: boolean;
};

const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;

function safeDownloadName(value: string): string {
  const base = path.basename(value).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return (base || 'download.bin').slice(0, 180);
}

function mimeForFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const known: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.zip': 'application/zip',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp'
  };
  return known[ext] ?? 'application/octet-stream';
}

async function sha256File(filename: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filename);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

export class BrowserError extends Error {
  constructor(readonly code:
    | 'SESSION_NOT_FOUND'
    | 'SESSION_CLOSED'
    | 'TAB_NOT_FOUND'
    | 'DOMAIN_DENIED'
    | 'ELEMENT_NOT_FOUND'
    | 'ELEMENT_STALE'
    | 'WAIT_TIMEOUT'
    | 'RESOURCE_BUSY'
    | 'UPLOAD_FAILED'
    | 'DOWNLOAD_FAILED',
    message: string) {
    super(message);
    this.name = 'BrowserError';
  }
}

export class BrowserCore {
  private readonly sessions = new Map<string, Session>();
  private readonly profileLocks = new Map<string, string>();

  constructor(
    private readonly provider: BrowserProvider,
    private readonly allowedDomain: DomainPolicy = () => false,
    private readonly artifactRoot = path.join(setupConfigDir(), 'artifacts', 'browser'),
    private readonly profileRoot = path.join(setupConfigDir(), 'profiles', 'browser')
  ) {}

  capabilities() {
    return {
      provider: 'playwright-chromium',
      modes: ['background', 'visible'],
      managedOnly: true,
      recoverable: false,
      actions: ['session', 'tabs', 'navigation', 'inspect', 'find', 'extract', 'screenshot', 'click', 'fill', 'type', 'press', 'select', 'check', 'wait', 'upload', 'download'],
      availability: this.provider.availability()
    };
  }

  private assertUrl(raw: string): URL {
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error('Invalid browser URL.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !this.allowedDomain(url.hostname.toLowerCase())) {
      throw new BrowserError('DOMAIN_DENIED', 'Browser domain denied by policy.');
    }
    return url;
  }

  private profileName(value: string): string {
    const profile = value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile)) {
      throw new Error('Browser profile name must match [a-z0-9][a-z0-9._-]{0,63}.');
    }
    return profile;
  }

  private profilePath(profile: string): string {
    return path.join(this.profileRoot, this.profileName(profile));
  }

  async profileStatus(profileName: string) {
    const profile = this.profileName(profileName);
    const directory = this.profilePath(profile);
    let exists = false;
    try {
      exists = (await fs.stat(directory)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return {
      profile,
      exists,
      active: this.profileLocks.has(profile),
      sessionId: this.profileLocks.get(profile)
    };
  }

  private async guard(context: BrowserContext): Promise<void> {
    await context.route('**/*', async route => {
      try {
        this.assertUrl(route.request().url());
        await route.continue();
      } catch {
        await route.abort('blockedbyclient').catch(() => {});
      }
    });
  }

  private newTab(id: string, page: Page): Tab {
    return { id, page, generation: 0, refs: new Map(), nextRef: 1 };
  }

  async create(owner: Owner, mode: 'background' | 'visible' = 'background', profileName?: string) {
    if (!owner.principalId || !owner.workSessionId) throw new Error('Explicit principal and Work Session ownership required.');
    const profile = profileName ? this.profileName(profileName) : undefined;
    const id = randomUUID();
    if (profile) {
      const current = this.profileLocks.get(profile);
      if (current) throw new BrowserError('RESOURCE_BUSY', `Browser profile '${profile}' is already active.`);
      this.profileLocks.set(profile, id);
      await fs.mkdir(this.profilePath(profile), { recursive: true, mode: 0o700 });
    }
    let managed: ManagedBrowser | undefined;
    try {
      managed = await this.provider.launch(mode, profile ? this.profilePath(profile) : undefined);
      await this.guard(managed.context);
      const tabId = randomUUID();
      const session: Session = {
        ...owner,
        id,
        mode,
        profile,
        managed,
        tabs: new Map([[tabId, this.newTab(tabId, managed.page)]]),
        downloads: new Map(),
        activeTabId: tabId,
        closed: false
      };
      managed.browser.on('disconnected', () => {
        session.closed = true;
        if (profile && this.profileLocks.get(profile) === id) this.profileLocks.delete(profile);
      });
      managed.context.on('page', page => {
        if (page === managed!.page || session.closed) return;
        const newId = randomUUID();
        session.tabs.set(newId, this.newTab(newId, page));
      });
      this.sessions.set(id, session);
      return { sessionId: id, tabId, mode, profile, persistent: Boolean(profile), recoverable: false };
    } catch (error) {
      if (profile && this.profileLocks.get(profile) === id) this.profileLocks.delete(profile);
      if (managed) await managed.close().catch(() => {});
      throw error;
    }
  }

  private session(id: string, owner: Owner): Session {
    const session = this.sessions.get(id);
    if (!session || session.principalId !== owner.principalId || session.workSessionId !== owner.workSessionId) {
      throw new BrowserError('SESSION_NOT_FOUND', 'Browser session not found.');
    }
    if (session.closed || !session.managed.browser.isConnected()) throw new BrowserError('SESSION_CLOSED', 'Browser session closed.');
    return session;
  }

  private tab(session: Session, tabId: string): Tab {
    const tab = session.tabs.get(tabId);
    if (!tab || tab.page.isClosed()) throw new BrowserError('TAB_NOT_FOUND', 'Browser tab not found.');
    if (tab.page.url() !== 'about:blank') this.assertUrl(tab.page.url());
    return tab;
  }

  private invalidate(tab: Tab) {
    tab.generation += 1;
    tab.nextRef = 1;
  }

  private publishRefs(tab: Tab, candidates: BrowserElementCandidate[]) {
    tab.refs.clear();
    tab.nextRef = 1;
    return candidates.map(candidate => {
      const elementId = `el_${tab.generation}_${tab.nextRef++}`;
      tab.refs.set(elementId, {
        id: elementId,
        generation: tab.generation,
        role: candidate.role,
        name: candidate.name,
        ordinal: candidate.ordinal
      });
      return {
        elementId,
        role: candidate.role,
        name: candidate.name,
        visible: candidate.visible,
        enabled: candidate.enabled
      };
    });
  }

  private element(tab: Tab, elementId: string): ElementRef {
    const ref = tab.refs.get(elementId);
    if (!ref) throw new BrowserError('ELEMENT_NOT_FOUND', 'Semantic element reference was not found; inspect the page again.');
    if (ref.generation !== tab.generation) throw new BrowserError('ELEMENT_STALE', 'Semantic element reference is stale; inspect the page again.');
    return ref;
  }

  countOwned(principalId: string, workSessionId: string): number {
    return [...this.sessions.values()].filter(session =>
      !session.closed &&
      session.principalId === principalId &&
      session.workSessionId === workSessionId
    ).length;
  }

  status(id: string, owner: Owner) {
    const session = this.session(id, owner);
    return {
      sessionId: session.id,
      mode: session.mode,
      profile: session.profile,
      persistent: Boolean(session.profile),
      activeTabId: session.activeTabId,
      tabCount: session.tabs.size,
      downloadCount: session.downloads.size,
      recoverable: false
    };
  }

  async close(id: string, owner: Owner) {
    const session = this.session(id, owner);
    session.closed = true;
    this.sessions.delete(id);
    if (session.profile && this.profileLocks.get(session.profile) === id) this.profileLocks.delete(session.profile);
    await session.managed.close();
    return { closed: true };
  }

  async closeAll() {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map(async session => {
      session.closed = true;
      if (session.profile && this.profileLocks.get(session.profile) === session.id) this.profileLocks.delete(session.profile);
      await session.managed.close();
    }));
  }

  tabs(id: string, owner: Owner) {
    const session = this.session(id, owner);
    return [...session.tabs.values()].filter(tab => !tab.page.isClosed()).map(tab => ({
      tabId: tab.id,
      url: tab.page.url(),
      active: tab.id === session.activeTabId,
      generation: tab.generation
    }));
  }

  async openTab(id: string, owner: Owner) {
    const session = this.session(id, owner);
    const page = await this.provider.openTab(session.managed.context);
    const existing = [...session.tabs.values()].find(tab => tab.page === page);
    const tabId = existing?.id ?? randomUUID();
    if (!existing) session.tabs.set(tabId, this.newTab(tabId, page));
    session.activeTabId = tabId;
    return { tabId };
  }

  activateTab(id: string, tabId: string, owner: Owner) {
    const session = this.session(id, owner);
    this.tab(session, tabId);
    session.activeTabId = tabId;
    return { tabId };
  }

  async closeTab(id: string, tabId: string, owner: Owner) {
    const session = this.session(id, owner);
    const tab = this.tab(session, tabId);
    await this.provider.closeTab(tab.page);
    session.tabs.delete(tabId);
    if (session.activeTabId === tabId) session.activeTabId = session.tabs.keys().next().value ?? '';
    return { closed: true };
  }

  async navigate(id: string, tabId: string, owner: Owner, action: 'goto' | 'back' | 'forward' | 'reload', url?: string) {
    const tab = this.tab(this.session(id, owner), tabId);
    if (action === 'goto') this.assertUrl(url ?? '');
    const previousUrl = tab.page.url();
    if (action !== 'goto' && previousUrl !== 'about:blank') this.assertUrl(previousUrl);
    try {
      await this.provider.navigate(tab.page, action, url);
      if (tab.page.url() !== 'about:blank') this.assertUrl(tab.page.url());
    } finally {
      this.invalidate(tab);
    }
    return { tabId, url: tab.page.url(), generation: tab.generation };
  }

  async inspect(id: string, tabId: string, owner: Owner, maxItems = 30) {
    const tab = this.tab(this.session(id, owner), tabId);
    const elements = this.publishRefs(tab, await this.provider.inspect(tab.page, maxItems));
    return {
      tabId,
      url: tab.page.url(),
      title: (await tab.page.title()).slice(0, 256),
      generation: tab.generation,
      elements
    };
  }

  async find(id: string, tabId: string, owner: Owner, role: SemanticRole, name: string, maxItems = 20) {
    const tab = this.tab(this.session(id, owner), tabId);
    const result = await this.provider.find(tab.page, role, name, maxItems);
    return {
      matches: this.publishRefs(tab, result.matches),
      truncated: result.truncated,
      generation: tab.generation
    };
  }

  async interact(id: string, tabId: string, owner: Owner, elementId: string, action: BrowserInteraction) {
    const tab = this.tab(this.session(id, owner), tabId);
    const ref = this.element(tab, elementId);
    try {
      await this.provider.interact(tab.page, ref, action);
      if (tab.page.url() !== 'about:blank') this.assertUrl(tab.page.url());
      return {
        action: action.kind,
        element: { role: ref.role, name: ref.name },
        url: tab.page.url(),
        generation: tab.generation + 1
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('ELEMENT_STALE:')) {
        throw new BrowserError('ELEMENT_STALE', message.slice('ELEMENT_STALE:'.length).trim());
      }
      throw error;
    } finally {
      this.invalidate(tab);
    }
  }

  async upload(id: string, tabId: string, owner: Owner, elementId: string, files: BrowserUploadFile[]) {
    const tab = this.tab(this.session(id, owner), tabId);
    const ref = this.element(tab, elementId);
    if (ref.role !== 'file') throw new BrowserError('UPLOAD_FAILED', 'browser_upload requires a semantic file input reference.');
    if (files.length < 1 || files.length > 8) throw new BrowserError('UPLOAD_FAILED', 'browser_upload accepts 1 to 8 files.');
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    if (files.some(file => file.bytes < 0 || file.bytes > 32 * 1024 * 1024) || totalBytes > 64 * 1024 * 1024) {
      throw new BrowserError('UPLOAD_FAILED', 'Browser upload exceeds the bounded file size policy.');
    }
    try {
      await this.provider.upload(tab.page, ref, files.map(file => file.absolutePath));
      return {
        uploaded: files.map(file => ({ name: file.name, bytes: file.bytes, mimeType: file.mimeType })),
        totalBytes,
        generation: tab.generation + 1
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('ELEMENT_STALE:')) {
        throw new BrowserError('ELEMENT_STALE', message.slice('ELEMENT_STALE:'.length).trim());
      }
      throw new BrowserError('UPLOAD_FAILED', 'Browser upload failed.');
    } finally {
      this.invalidate(tab);
    }
  }

  async download(id: string, tabId: string, owner: Owner, elementId: string, timeoutMs = 30_000) {
    const session = this.session(id, owner);
    const tab = this.tab(session, tabId);
    const ref = this.element(tab, elementId);
    const source = tab.page.url() === 'about:blank' ? undefined : this.assertUrl(tab.page.url());
    let temporaryPath: string | undefined;
    try {
      const result = await this.provider.download(tab.page, ref, timeoutMs);
      temporaryPath = result.temporaryPath;
      const stat = await fs.stat(temporaryPath);
      if (!stat.isFile() || stat.size > MAX_DOWNLOAD_BYTES) {
        throw new BrowserError('DOWNLOAD_FAILED', 'Downloaded artifact violates the bounded file policy.');
      }
      const downloadId = randomUUID();
      const name = safeDownloadName(result.suggestedFilename);
      const directory = path.join(this.artifactRoot, session.id, 'downloads');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const destination = path.join(directory, `${downloadId}-${name}`);
      await fs.copyFile(temporaryPath, destination, fsConstants.COPYFILE_EXCL);
      const sha256 = await sha256File(destination);
      const record: DownloadRecord = {
        downloadId,
        status: 'ready',
        name,
        bytes: stat.size,
        mimeType: mimeForFilename(name),
        sha256,
        path: destination,
        sourceDomain: source?.hostname ?? ''
      };
      session.downloads.set(downloadId, record);
      return { ...record, generation: tab.generation + 1 };
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw new BrowserError('DOWNLOAD_FAILED', 'Browser download failed.');
    } finally {
      this.invalidate(tab);
      if (temporaryPath) await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  downloadStatus(id: string, owner: Owner, downloadId: string) {
    const session = this.session(id, owner);
    const record = session.downloads.get(downloadId);
    if (!record) throw new BrowserError('DOWNLOAD_FAILED', 'Browser download record not found.');
    return record;
  }

  async wait(id: string, tabId: string, owner: Owner, condition: BrowserWaitCondition, timeoutMs = 10_000) {
    const tab = this.tab(this.session(id, owner), tabId);
    if (condition.kind === 'url') {
      const target = this.assertUrl(condition.value);
      condition = { ...condition, value: target.toString() };
    }
    try {
      await this.provider.wait(tab.page, condition, timeoutMs);
      if (tab.page.url() !== 'about:blank') this.assertUrl(tab.page.url());
      return { satisfied: true, url: tab.page.url(), generation: tab.generation };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timeout/i.test(message)) throw new BrowserError('WAIT_TIMEOUT', 'Browser wait condition timed out.');
      throw error;
    }
  }

  async extract(id: string, tabId: string, owner: Owner, maxChars = 8_000) {
    const tab = this.tab(this.session(id, owner), tabId);
    return { url: tab.page.url(), ...await this.provider.extract(tab.page, maxChars), generation: tab.generation };
  }

  async screenshot(id: string, tabId: string, owner: Owner) {
    const tab = this.tab(this.session(id, owner), tabId);
    const directory = path.join(this.artifactRoot, id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const artifactId = randomUUID();
    const filename = path.join(directory, `${artifactId}.png`);
    const buffer = await this.provider.screenshot(tab.page);
    if (buffer.length > 8 * 1024 * 1024) throw new Error('Browser screenshot exceeds the artifact size limit.');
    await fs.writeFile(filename, buffer, { flag: 'wx', mode: 0o600 });
    return {
      artifactId,
      path: filename,
      mimeType: 'image/png',
      bytes: buffer.length,
      tabId,
      generation: tab.generation
    };
  }
}
