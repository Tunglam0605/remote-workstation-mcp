import { randomUUID } from 'node:crypto';
import type { ExistingChromeBridgeClient } from './existing-chrome-bridge.js';

type Owner = { principalId: string; workSessionId: string };
type Session = Owner & { id: string; tabId: number; createdAt: string };

export class ExistingChromeSessionService {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly client: Pick<ExistingChromeBridgeClient, 'request' | 'availability'>) {}

  private owned(id: string, owner: Owner): Session {
    const session = this.sessions.get(id);
    if (!session || session.principalId !== owner.principalId || session.workSessionId !== owner.workSessionId) {
      throw new Error('Existing Chrome session not found.');
    }
    return session;
  }

  async bridgeStatus() {
    return await this.client.request('status', {}, 3_000);
  }

  async open(owner: Owner, requestedTabId?: number) {
    if (!owner.principalId || !owner.workSessionId) throw new Error('Explicit principal and Work Session ownership required.');
    if (this.sessions.size > 0) {
      const current = [...this.sessions.values()][0]!;
      if (current.principalId !== owner.principalId || current.workSessionId !== owner.workSessionId) {
        throw new Error('RESOURCE_BUSY: Existing Chrome is owned by another Work Session.');
      }
      throw new Error('RESOURCE_BUSY: This Work Session already owns an Existing Chrome session.');
    }
    const status = await this.client.request('status', {}, 3_000) as any;
    const tabs = Array.isArray(status?.tabs) ? status.tabs : [];
    const selected = requestedTabId !== undefined
      ? tabs.find((tab: any) => Number(tab?.tabId) === requestedTabId)
      : tabs.find((tab: any) => tab?.active) ?? tabs[0];
    if (!selected || !Number.isInteger(Number(selected.tabId))) throw new Error('No authenticated NotebookLM tab is available in Existing Chrome.');
    const id = randomUUID();
    const session: Session = {
      ...owner,
      id,
      tabId: Number(selected.tabId),
      createdAt: new Date().toISOString()
    };
    this.sessions.set(id, session);
    return {
      sessionId: id,
      tabId: session.tabId,
      title: String(selected.title ?? '').slice(0, 256),
      url: String(selected.url ?? '').slice(0, 2048),
      provider: 'existing-chrome-extension'
    };
  }

  status(id: string, owner: Owner) {
    const session = this.owned(id, owner);
    return { sessionId: session.id, tabId: session.tabId, createdAt: session.createdAt, provider: 'existing-chrome-extension' };
  }

  async inspect(id: string, owner: Owner, maxItems = 30) {
    const session = this.owned(id, owner);
    return await this.client.request('page.inspect', { tabId: session.tabId, maxItems }, 8_000);
  }

  async find(id: string, owner: Owner, role: string, name: string, maxItems = 20) {
    const session = this.owned(id, owner);
    return await this.client.request('page.find', { tabId: session.tabId, role, name, maxItems }, 8_000);
  }

  async extract(id: string, owner: Owner, maxChars = 8_000) {
    const session = this.owned(id, owner);
    return await this.client.request('page.extract', { tabId: session.tabId, maxChars }, 8_000);
  }

  async click(id: string, owner: Owner, elementId: string) {
    const session = this.owned(id, owner);
    return await this.client.request('page.click', { tabId: session.tabId, elementId }, 8_000);
  }

  async fill(id: string, owner: Owner, elementId: string, value: string) {
    const session = this.owned(id, owner);
    return await this.client.request('page.fill', { tabId: session.tabId, elementId, value }, 8_000);
  }

  close(id: string, owner: Owner) {
    const session = this.owned(id, owner);
    this.sessions.delete(id);
    return { closed: true, sessionId: session.id, tabId: session.tabId };
  }

  countOwned(principalId: string, workSessionId: string): number {
    return [...this.sessions.values()].filter(session => session.principalId === principalId && session.workSessionId === workSessionId).length;
  }

  listOwned(principalId: string, workSessionId: string) {
    return [...this.sessions.values()]
      .filter(session => session.principalId === principalId && session.workSessionId === workSessionId)
      .map(session => ({ sessionId: session.id, tabId: session.tabId, createdAt: session.createdAt }));
  }

  closeAll() {
    this.sessions.clear();
  }
}
