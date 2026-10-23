import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { AppContext } from '../src/context.js';
import { ExtensionRegistry } from '../src/extensions/registry.js';
import { initializeMediaExtension } from '../src/extensions/media/register.js';

function mediaContext() {
  const contributionIds = new Set<string>();
  let registrationCount = 0;
  const ctx = {
    actor: { clientType: 'openai-secure-mcp-tunnel' },
    paths: {},
    engineering: {
      runner: {},
      workflows: {
        registerContribution(contribution: { id: string }) {
          if (contributionIds.has(contribution.id)) {
            throw new Error('Duplicate engineering workflow contribution id: ' + contribution.id);
          }
          contributionIds.add(contribution.id);
          registrationCount += 1;
        }
      }
    }
  } as unknown as AppContext;
  return { ctx, contributionIds, registrations: () => registrationCount };
}

test('repeated MCP server creation never re-registers shared Media contributions', () => {
  const { ctx, contributionIds, registrations } = mediaContext();
  let createdServers = 0;
  for (let i = 0; i < 50; i += 1) {
    const registry = new ExtensionRegistry().add({
      id: 'domain.media', kind: 'domain', version: 1,
      initialize: initializeMediaExtension,
      register: () => { createdServers += 1; }
    });
    registry.registerAll({} as never, ctx, 'linux', 'full');
  }
  assert.ok(contributionIds.has('media.remotion.render_accept'));
  assert.ok(registrations() >= 2);
  assert.equal(registrations(), contributionIds.size);
  assert.equal(createdServers, 50);

  const second = mediaContext();
  const registry = new ExtensionRegistry().add({
    id: 'domain.media', kind: 'domain', version: 1,
    initialize: initializeMediaExtension,
    register: () => undefined
  });
  registry.registerAll({} as never, second.ctx, 'linux', 'full');
  assert.equal(second.registrations(), registrations(), 'a new context must initialize its own registry');
});

test('Ubuntu Direct Node systemd restart limits are in Unit section (not Service)', async () => {
  const script = await fs.readFile(path.resolve('scripts/setup-direct-node-linux.sh'), 'utf8');
  const template = script.split('cat > "$SERVICE" <<EOF')[1]?.split('\nEOF')[0] ?? '';
  assert.ok(template.includes('[Unit]'));
  const unit = template.split('[Unit]')[1]?.split('[Service]')[0] ?? '';
  const service = template.split('[Service]')[1]?.split('[Install]')[0] ?? '';
  assert.match(unit, /StartLimitIntervalSec=120/);
  assert.match(unit, /StartLimitBurst=20/);
  assert.doesNotMatch(service, /StartLimitIntervalSec|StartLimitBurst/);
});

test('Ubuntu recovery/doctor tolerate owner-local binaries and SSH user sessions', async () => {
  const doctor = await fs.readFile(path.resolve('scripts/doctor-user.mjs'), 'utf8');
  const rollback = await fs.readFile(path.resolve('scripts/rollback-user.sh'), 'utf8');
  assert.match(doctor, /managedEnv/);
  assert.match(doctor, /\.local\/bin/);
  assert.match(doctor, /DBUS_SESSION_BUS_ADDRESS/);
  assert.match(rollback, /DBUS_SESSION_BUS_ADDRESS/);
  assert.match(rollback, /AbortSignal\.timeout\(5000\)/);
});
