import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditLogger, audited } from '../src/security/audit.js';
import { runAsPrincipal } from '../src/security/request-principal.js';

test('audit records request-scoped authenticated principal instead of fallback actor', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-audit-principal-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const auditPath = path.join(root, 'audit.jsonl');
  const logger = new AuditLogger(auditPath, { clientId: 'fallback', clientType: 'local' });

  await runAsPrincipal(
    { id: 'chatgpt-web', type: 'mcp-http', scopes: ['workstation.read'], authenticated: true },
    () => audited(logger, 'system_info', undefined, async () => 'ok')
  );

  const [line] = (await fs.readFile(auditPath, 'utf8')).trim().split(/\r?\n/);
  const entry = JSON.parse(line ?? '{}') as { actor?: { clientId?: string; clientType?: string; authenticated?: boolean; scopes?: string[] } };
  assert.deepEqual(entry.actor, {
    clientId: 'chatgpt-web',
    clientType: 'mcp-http',
    authenticated: true,
    scopes: ['workstation.read']
  });
});
