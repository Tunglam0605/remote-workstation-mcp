import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TerminalManager } from '../../src/adapters/engineering/terminal-manager.js';
import type { PolicyConfig } from '../../src/model.js';
import { PolicyEngine } from '../../src/policy.js';
import { PathGuard } from '../../src/security/path-guard.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-pty-race-'));
try {
  const config: PolicyConfig = {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'w', root, readOnly: false }],
    filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
    process: {
      allowExecutables: [process.execPath],
      inheritEnv: ['PATH', 'HOME', 'TEMP', 'TMP'],
      maxOutputBytes: 65536,
      maxRuntimeMs: 60000,
      maxInputBytes: 65536
    }
  };
  const policy = new PolicyEngine(config);
  const terminals = new TerminalManager(policy, new PathGuard(policy), 'owner');
  const session = await terminals.start('w', process.execPath, ['-e', "console.log('PTY_RACE_OK')"], '.');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !terminals.read(session.id).text.includes('PTY_RACE_OK')) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await terminals.stop(session.id);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
