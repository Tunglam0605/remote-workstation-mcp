import { randomUUID } from 'node:crypto';
import type { OfficeDomain } from './contracts.js';
import type { OfficeDocumentIdentity } from './document-identity.js';

export type OfficeSessionMode = 'read' | 'write';
export type OfficeSessionStatus = 'open' | 'closed';

export interface OfficeSession {
  version: 1;
  id: string;
  principalId: string;
  workSessionId: string;
  domain: OfficeDomain;
  workspace: string;
  documentPath: string;
  mode: OfficeSessionMode;
  status: OfficeSessionStatus;
  originalIdentity: OfficeDocumentIdentity;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export class OfficeSessionStore {
  private readonly sessions = new Map<string, OfficeSession>();

  create(
    input: Omit<OfficeSession, 'version' | 'id' | 'status' | 'createdAt' | 'updatedAt'>,
    now = new Date()
  ): OfficeSession {
    if (!input.principalId.trim() || !input.workSessionId.trim()) throw new Error('Office session owner must be explicit.');
    if (!input.workspace.trim() || !input.documentPath.trim()) {
      throw new Error('Office session workspace/documentPath must be explicit.');
    }
    const timestamp = now.toISOString();
    const session: OfficeSession = {
      version: 1, id: randomUUID(), ...input, status: 'open',
      originalIdentity: { ...input.originalIdentity }, createdAt: timestamp, updatedAt: timestamp
    };
    this.sessions.set(session.id, session);
    return this.snapshot(session);
  }

  inspect(id: string, principalId: string, workSessionId: string): OfficeSession {
    return this.snapshot(this.requireOwned(id, principalId, workSessionId));
  }

  list(principalId: string, workSessionId: string): OfficeSession[] {
    return [...this.sessions.values()]
      .filter(item => item.principalId === principalId && item.workSessionId === workSessionId)
      .map(item => this.snapshot(item));
  }

  close(id: string, principalId: string, workSessionId: string, now = new Date()): OfficeSession {
    const session = this.requireOwned(id, principalId, workSessionId);
    if (session.status === 'closed') return this.snapshot(session);
    const timestamp = now.toISOString();
    const closed: OfficeSession = { ...session, status: 'closed', closedAt: timestamp, updatedAt: timestamp };
    this.sessions.set(id, closed);
    return this.snapshot(closed);
  }

  private requireOwned(id: string, principalId: string, workSessionId: string): OfficeSession {
    const session = this.sessions.get(id);
    if (!session || session.principalId !== principalId || session.workSessionId !== workSessionId) {
      throw new Error(`Unknown Office session '${id}'.`);
    }
    return session;
  }

  private snapshot(session: OfficeSession): OfficeSession {
    return { ...session, originalIdentity: { ...session.originalIdentity } };
  }
}
