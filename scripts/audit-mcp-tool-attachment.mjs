#!/usr/bin/env node
// Offline, credential-free MCP tool attachment reconciler.
// Inputs are owner-supplied JSON snapshots. Never fetch MCP tokens or endpoints.
import { readFile, writeFile } from 'node:fs/promises';

const allowedName = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const maxBytes = 5_000_000;
const maxNames = 2_000;

function usage() {
  throw new Error('Usage: node scripts/audit-mcp-tool-attachment.mjs --catalog <capabilities_list.json> --client <chatgpt_names.json> [--mcp <tools_list.json>] [--output <report.json>]');
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--catalog', '--client', '--mcp', '--output'].includes(key) || !argv[i + 1] || options[key]) usage();
    options[key] = argv[i + 1];
  }
  if (!options['--catalog'] || !options['--client']) usage();
  return options;
}

async function load(path) {
  const raw = await readFile(path);
  if (raw.byteLength > maxBytes) throw new Error('Snapshot exceeds maximum accepted size.');
  return JSON.parse(raw.toString('utf8'));
}

function namesFrom(value, label) {
  const list = Array.isArray(value) ? value : value?.tools ?? value?.names ?? value?.actions;
  if (!Array.isArray(list) || list.length > maxNames) throw new Error(label + ' must provide a bounded array of tool names.');
  const names = list.map(item => typeof item === 'string' ? item : item?.name);
  if (names.some(name => typeof name !== 'string' || !allowedName.test(name))) throw new Error(label + ' has an invalid tool name.');
  if (new Set(names).size !== names.length) throw new Error(label + ' contains duplicate tool names.');
  return names.sort();
}

function fromCatalog(catalog) {
  if (!Array.isArray(catalog?.capabilities)) throw new Error('Catalog is missing capabilities.');
  const groups = [];
  const set = new Set();
  for (const c of catalog.capabilities) {
    if (c?.exposure?.exposed !== true) continue;
    if (typeof c.id !== 'string' || !Array.isArray(c.tools)) throw new Error('Invalid exposed capability.');
    if (c.tools.length > maxNames) throw new Error('Capability is too large.');
    const names = c.tools.map(x => x);
    if (names.some(n => typeof n !== 'string' || !allowedName.test(n))) throw new Error('Invalid catalog tool name.');
    for (const n of names) set.add(n);
    groups.push({ id: c.id, tools: [...new Set(names)].sort() });
  }
  if (set.size > maxNames) throw new Error('Catalog tool count is too large.');
  return { names: [...set].sort(), groups };
}

function missing(a, b) {
  const lookup = new Set(b);
  return a.filter(name => !lookup.has(name));
}

function groupedMissing(groups, clientNames) {
  const client = new Set(clientNames);
  return groups.map(group => ({
    capability: group.id,
    missing: group.tools.filter(name => !client.has(name))
  })).filter(group => group.missing.length > 0);
}

export function reconcile(catalog, clientSnapshot, rawMcpSnapshot) {
  const declared = fromCatalog(catalog);
  const attached = namesFrom(clientSnapshot, 'ChatGPT attached registry');
  if (rawMcpSnapshot && typeof rawMcpSnapshot === 'object' && rawMcpSnapshot.nextCursor != null) {
    throw new Error('Raw MCP tools/list is paginated: supply a complete merged snapshot of all pages.');
  }
  const mcp = rawMcpSnapshot === undefined ? null : namesFrom(rawMcpSnapshot, 'Raw MCP tools/list');
  // Optional per-server registration ledger is NOT a protocol tools/list snapshot.
  const registered = catalog.registeredToolSurface === undefined ? null
    : namesFrom(catalog.registeredToolSurface, 'MCP server registration ledger');
  const advertisedNotRegistered = registered === null ? null : missing(declared.names, registered);
  const registeredNotAttached = registered === null ? null : missing(registered, attached);
  const advertisedNotClient = missing(declared.names, attached);
  const clientNotAdvertised = missing(attached, declared.names);
  const serverMissing = mcp === null ? null : missing(declared.names, mcp);
  const clientMissing = mcp === null ? null : missing(mcp, attached);
  const staleClient = mcp === null ? null : missing(attached, mcp);
  const status = mcp === null ? 'UNVERIFIED_RAW_MCP' : (
    serverMissing.length === 0 && clientMissing.length === 0 && staleClient.length === 0 && clientNotAdvertised.length === 0
      ? 'PASS' : 'FAIL'
  );
  return {
    schemaVersion: 1,
    status,
    versions: {
      runtime: typeof catalog.version === 'string' ? catalog.version : null,
      actionSchema: Number.isInteger(catalog.actionSchemaVersion) ? catalog.actionSchemaVersion : null
    },
    counts: {
      advertised: declared.names.length,
      chatgptAttached: attached.length,
      rawMcp: mcp === null ? null : mcp.length,
      serverRegistered: registered === null ? null : registered.length,
      advertisedNotRegistered: advertisedNotRegistered === null ? null : advertisedNotRegistered.length,
      advertisedNotClient: advertisedNotClient.length,
      advertisedNotMcp: serverMissing === null ? null : serverMissing.length,
      rawMcpNotClient: clientMissing === null ? null : clientMissing.length
    },
    evidence: {
      advertisedNotClient,
      clientNotAdvertised,
      advertisedNotRegistered,
      registeredNotClient: registeredNotAttached,
      advertisedNotMcp: serverMissing,
      rawMcpNotClient: clientMissing,
      clientNotRawMcp: staleClient,
      groups: groupedMissing(declared.groups, attached)
    },
    diagnosis: mcp === null
      ? (advertisedNotRegistered?.length
        ? 'Server registration ledger is missing advertised names; verify the registration actor and extension filtering. Raw authenticated MCP tools/list is still required.'
        : 'Raw authenticated MCP tools/list not supplied: do not attribute missing actions to server or ChatGPT.')
      : serverMissing.length > 0
        ? 'Some advertised tools are absent from MCP tools/list: investigate server registration/filtering first.'
        : clientMissing.length > 0 || staleClient.length > 0
          ? 'MCP tools/list and ChatGPT attachment differ: investigate client connector/schema attachment.'
          : 'All three tool-name surfaces agree.'
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [catalog, client, mcp] = await Promise.all([
    load(args['--catalog']),
    load(args['--client']),
    args['--mcp'] ? load(args['--mcp']) : Promise.resolve(undefined)
  ]);
  const report = reconcile(catalog, client, mcp);
  const serialized = JSON.stringify(report, null, 2) + '\n';
  if (args['--output']) {
    await writeFile(args['--output'], serialized, { flag: 'wx' });
  }
  process.stdout.write(serialized);
  process.exitCode = report.status === 'PASS' ? 0 : report.status === 'UNVERIFIED_RAW_MCP' ? 3 : 2;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/audit-mcp-tool-attachment.mjs')) {
  main().catch(error => {
    process.stderr.write('MCP tool audit failed: ' + (error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  });
}
