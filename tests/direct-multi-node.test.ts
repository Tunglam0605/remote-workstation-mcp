import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { requiredScopeForTool } from '../src/security/request-principal.js';

test('direct multi-node identity is read-only and Linux direct-node scripts are shipped', async () => {
  assert.equal(requiredScopeForTool('workstation_identity'), 'workstation.read');
  const capabilities = await fs.readFile('src/capabilities.ts', 'utf8');
  const server = await fs.readFile('src/server.ts', 'utf8');
  const install = await fs.readFile('scripts/install-openai-tunnel-linux.sh', 'utf8');
  const installUser = await fs.readFile('scripts/install-user.sh', 'utf8');
  const setup = await fs.readFile('scripts/setup-direct-node-linux.sh', 'utf8');
  const status = await fs.readFile('scripts/direct-node-status-linux.sh', 'utf8');

  assert.match(capabilities, /multi_device\.direct_nodes/);
  assert.match(server, /Do not route routine multi-device work through SSH/);
  assert.match(install, /VERSION="v0\.0\.14"/);
  assert.match(install, /ASSET="tunnel-client-\$\{VERSION\}-linux-\$\{ARCH\}\.zip"/);
  assert.match(install, /SHA-256 verified/);
  assert.match(setup, /remote-workstation-mcp-openai\.service/);
  assert.match(setup, /disable --now remote-workstation-mcp\.service/);
  assert.match(setup, /Use one distinct OpenAI Secure MCP Tunnel ID per workstation/);
  assert.match(setup, /export PATH="\$HOME\/.local\/bin:\$PATH"/);
  assert.match(installUser, /DIRECT_NODE_CONFIGURED/);
  assert.match(installUser, /restart remote-workstation-mcp-openai\.service/);
  assert.match(installUser, /disable --now remote-workstation-mcp\.service/);
  assert.match(status, /Direct Node/);
  assert.match(installUser, /Prebuilt release package detected/);
  assert.match(installUser, /npm install --omit=dev --no-audit --no-fund --ignore-scripts/);
  assert.match(installUser, /BUILT_VERSION=/);
});
