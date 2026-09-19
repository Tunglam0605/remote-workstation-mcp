import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TerminalManager } from '../../src/adapters/engineering/terminal-manager.js';
import type { PolicyConfig } from '../../src/model.js';
import { PolicyEngine } from '../../src/policy.js';
import { PathGuard } from '../../src/security/path-guard.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-pty-natural-'));
const config: PolicyConfig = {
  version: 1,
  mode: 'workspace',
  workspaces: [{ id: 'w', root, readOnly: false }],
  filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
  process: { allowExecutables: [process.execPath], inheritEnv: ['PATH', 'HOME', 'TEMP', 'TMP'], maxOutputBytes: 65536, maxRuntimeMs: 60000, maxInputBytes: 65536 }
};
const policy = new PolicyEngine(config);
const terminals = new TerminalManager(policy, new PathGuard(policy), 'owner');
const session = await terminals.start('w', process.execPath, ['-e', "console.log('PTY_NATURAL_EXIT')"], '.');
const deadline = Date.now() + 8000;
while (Date.now() < deadline && terminals.read(session.id).session.status === 'running') {
  await new Promise(resolve => setTimeout(resolve, 20));
}
const final = terminals.read(session.id).session;
if (final.status !== 'exited') {
  throw new Error(`Natural PTY exit did not converge before deadline (status=${final.status}).`);
}
if (final.exitCode !== 0) {
  throw new Error(`Natural PTY exit returned exitCode=${String(final.exitCode)}.`);
}
await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
