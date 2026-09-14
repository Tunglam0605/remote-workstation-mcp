#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const marketplacePath = path.join(root, '.agents/plugins/marketplace.json');
const pluginRoot = path.join(root, 'plugins/remote-workstation');
const manifestPath = path.join(pluginRoot, 'plugin.json');
const compatPath = path.join(pluginRoot, '.codex-plugin/plugin.json');
const mcpPath = path.join(pluginRoot, 'mcp.json');
const legacyMcpPath = path.join(pluginRoot, '.mcp.json');
const skillPath = path.join(pluginRoot, 'skills/workstation-operator/SKILL.md');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

const [marketplace, manifest, compat, mcp, legacyMcp] = await Promise.all([
  readJson(marketplacePath),
  readJson(manifestPath),
  readJson(compatPath),
  readJson(mcpPath),
  readJson(legacyMcpPath)
]);

assert(manifest.$schema === 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'portable plugin schema is missing or unsupported');
assert(mcp.$schema === 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', 'portable MCP schema is missing or unsupported');
assert(manifest.name === 'remote-workstation', 'portable plugin name mismatch');
assert(compat.name === manifest.name, 'compatibility manifest name mismatch');
assert(manifest.version === packageJson.version, `plugin version ${manifest.version} must match package version ${packageJson.version}`);
assert(compat.version === packageJson.version, `compatibility plugin version ${compat.version} must match package version ${packageJson.version}`);
assert(Array.isArray(marketplace.plugins) && marketplace.plugins.length >= 1, 'marketplace must contain at least one plugin');
const entry = marketplace.plugins.find(item => item.name === manifest.name);
assert(entry, 'marketplace entry for remote-workstation is missing');
assert(entry.source?.source === 'local', 'marketplace source must be local for repo distribution');
assert(entry.source?.path === './plugins/remote-workstation', 'marketplace source.path must target ./plugins/remote-workstation');
assert(entry.policy?.installation === 'AVAILABLE', 'marketplace plugin must be installable');
assert(['ON_INSTALL', 'ON_USE'].includes(entry.policy?.authentication), 'marketplace authentication policy is invalid');

const portableServer = mcp.mcpServers?.['remote-workstation'];
const legacyServer = legacyMcp.mcpServers?.['remote-workstation'];
assert(portableServer, 'portable MCP mapping is missing');
assert(portableServer.type === 'streamable-http', 'portable MCP transport must be streamable-http');
assert(portableServer.url === 'http://127.0.0.1:8765/mcp', 'portable MCP URL must remain loopback-only');
assert(legacyServer, 'legacy MCP mapping is missing');
assert(legacyServer.type === 'http', 'legacy MCP transport must be http');
assert(legacyServer.url === 'http://127.0.0.1:8765/mcp', 'legacy MCP URL must remain loopback-only');
assert(compat.mcpServers === './.mcp.json', 'compatibility manifest must reference ./.mcp.json');
assert(compat.skills === './skills/', 'compatibility manifest must reference ./skills/');

const skill = await fs.readFile(skillPath, 'utf8');
assert(skill.startsWith('---\n'), 'workstation operator skill needs YAML frontmatter');
assert(skill.includes('name: workstation-operator'), 'workstation operator skill name mismatch');

const openai = manifest.extensions?.['com.openai'];
assert(openai?.interface?.displayName === 'Remote Workstation', 'OpenAI display name is missing');
assert(Array.isArray(openai.interface.defaultPrompt) && openai.interface.defaultPrompt.length <= 3, 'defaultPrompt must contain at most 3 prompts');
for (const prompt of openai.interface.defaultPrompt) {
  assert(typeof prompt === 'string' && prompt.length <= 128, 'each default prompt must be at most 128 characters');
}

for (const doc of ['docs/PRIVACY.md', 'docs/PLUGIN_TERMS.md']) {
  await fs.access(path.join(root, doc));
}

console.log(`Plugin package valid: ${manifest.name} v${manifest.version}`);
console.log(`Marketplace: ${marketplace.interface?.displayName ?? marketplace.name}`);
console.log(`Portable MCP: ${portableServer.url}`);
console.log(`Legacy MCP: ${legacyServer.url}`);
