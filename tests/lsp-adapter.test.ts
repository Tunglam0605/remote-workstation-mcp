import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LspAdapter } from '../src/adapters/lsp.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function removeEventually(target: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM') throw error;
      await sleep(100);
    }
  }
  throw lastError;
}

test('LSP adapter provides bounded semantic queries and redacts external paths', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-lsp-'));
  t.after(async () => removeEventually(root));
  await fs.writeFile(path.join(root, 'main.cpp'), 'int demo;\nint main() { return demo; }\n', 'utf8');

  const executable = path.basename(process.execPath);
  const config: PolicyConfig = {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'w', root }],
    filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
    process: { allowExecutables: [executable], inheritEnv: ['PATH', 'SystemRoot', 'WINDIR'], maxOutputBytes: 4096, maxRuntimeMs: 5000 },
    lsp: {
      requestTimeoutMs: 3000,
      maxMessageBytes: 64 * 1024,
      diagnosticsSettleMs: 20,
      servers: {
        fake: {
          program: process.execPath,
          args: [path.resolve('tests/fixtures/fake-lsp.mjs')],
          languages: { '.cpp': 'cpp' }
        }
      }
    }
  };
  const policy = new PolicyEngine(config);
  const adapter = new LspAdapter(policy, new PathGuard(policy), () => 'principal-a');

  assert.deepEqual(adapter.listServers(), [{ id: 'fake', program: executable, languages: { '.cpp': 'cpp' } }]);

  const definition = await adapter.definition('w', 'fake', 'main.cpp', 1, 20);
  assert.equal((definition.locations[0] as { path?: string }).path, 'main.cpp');

  const references = await adapter.references('w', 'fake', 'main.cpp', 1, 20, true);
  assert.equal((references.locations[0] as { path?: string }).path, 'main.cpp');
  assert.equal((references.locations[1] as { external?: boolean }).external, true);
  assert.equal(JSON.stringify(references).includes('secret.cpp'), false);

  const hover = await adapter.hover('w', 'fake', 'main.cpp', 1, 20) as { contents?: { value?: string } };
  assert.equal(hover.contents?.value, '`int demo`');

  const diagnostics = await adapter.diagnostics('w', 'fake', 'main.cpp') as { diagnostics: Array<{ message?: string }> };
  assert.equal(diagnostics.diagnostics[0]?.message, 'fake warning');

  const symbols = await adapter.documentSymbols('w', 'fake', 'main.cpp') as Array<{ name?: string }>;
  assert.equal(symbols[0]?.name, 'demo');
  await sleep(100);
});

test('LSP adapter requires the configured server executable to be owner-allowlisted', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-lsp-policy-'));
  t.after(async () => removeEventually(root));
  await fs.writeFile(path.join(root, 'main.cpp'), 'int main() {}\n', 'utf8');

  const config: PolicyConfig = {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'w', root }],
    filesystem: { maxReadBytes: 1024, maxWriteBytes: 1024 },
    process: { allowExecutables: [], inheritEnv: ['PATH'], maxOutputBytes: 1024, maxRuntimeMs: 5000 },
    lsp: {
      requestTimeoutMs: 1000,
      maxMessageBytes: 64 * 1024,
      diagnosticsSettleMs: 0,
      servers: { fake: { program: process.execPath, args: [], languages: { '.cpp': 'cpp' } } }
    }
  };
  const policy = new PolicyEngine(config);
  const adapter = new LspAdapter(policy, new PathGuard(policy), () => 'principal-a');
  await assert.rejects(adapter.definition('w', 'fake', 'main.cpp', 0, 0), /not in process\.allowExecutables/);
});
