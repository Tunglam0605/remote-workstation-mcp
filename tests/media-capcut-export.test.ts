import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EngineeringResourceManager } from '../src/adapters/engineering/resource-manager.js';
import { CapCutExportProfileStore } from '../src/extensions/media/capcut-export-profile.js';
import { CapCutNativeExportAdapter } from '../src/extensions/media/capcut-native-export.js';

function uiNode(overrides: Record<string, unknown> = {}) {
  return {
    depth: 1,
    processId: 77,
    name: '',
    automationId: '',
    className: '',
    controlType: 'Button',
    enabled: true,
    offscreen: false,
    keyboardFocusable: true,
    patterns: ['InvokePattern'],
    ...overrides
  };
}

async function fixture(options: {
  installedVersion?: string;
  blocker?: 'subscription-required' | 'login-required';
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-capcut-export-'));
  const projectRoot = path.join(root, 'project');
  const outputDir = path.join(projectRoot, 'exports');
  await fs.mkdir(outputDir, { recursive: true });
  const profileFile = path.join(root, 'capcut-export-profiles.json');
  const profile = {
    id: 'capcut-9.5-en',
    label: 'CapCut 9.5 English',
    appVersion: '9.5.0.4050',
    locale: 'en-US',
    activeProject: {
      automationId: 'project-title',
      controlType: 'text'
    },
    editorExportButton: {
      automationId: 'editor-export',
      names: ['Export'],
      controlType: 'button'
    },
    output: {
      mode: 'full-path',
      pathField: {
        automationId: 'output-path',
        controlType: 'edit'
      }
    },
    confirmExportButton: {
      automationId: 'confirm-export',
      names: ['Export'],
      controlType: 'button'
    },
    cancelExportButton: {
      automationId: 'cancel-export',
      names: ['Cancel'],
      controlType: 'button'
    },
    blockers: [
      {
        stage: 'editor',
        code: 'subscription-required',
        locator: { automationId: 'pro-banner', controlType: 'text' }
      },
      {
        stage: 'dialog',
        code: 'login-required',
        locator: { automationId: 'login-required', controlType: 'button' }
      }
    ]
  };
  await fs.writeFile(profileFile, JSON.stringify({ version: 1, profiles: [profile] }), 'utf8');

  const calls: Array<{ kind: string; locator?: any; value?: string }> = [];
  let outputAbsolute: string | undefined;

  const ui = {
    windows: async () => ({
      ok: true,
      provider: 'windows-uia',
      windowCount: 1,
      windows: [uiNode({
        depth: 0,
        processId: 77,
        name: 'CapCut',
        automationId: 'main',
        controlType: 'Window',
        patterns: ['WindowPattern']
      })]
    }),
    wait: async (_exe: string, _pid: number, locator: any) => {
      calls.push({ kind: 'wait', locator });
      if (locator.automationId === 'pro-banner') {
        if (options.blocker === 'subscription-required') return { element: uiNode({ automationId: 'pro-banner', controlType: 'Text' }) };
        throw new Error('WINDOWS_UIA_FAILED: UIA_ELEMENT_NOT_FOUND');
      }
      if (locator.automationId === 'login-required') {
        if (options.blocker === 'login-required') return { element: uiNode({ automationId: 'login-required' }) };
        throw new Error('WINDOWS_UIA_FAILED: UIA_ELEMENT_NOT_FOUND');
      }
      if (locator.automationId === 'project-title') {
        assert.deepEqual(locator.names, ['Demo Project']);
        return { element: uiNode({ automationId: 'project-title', name: 'Demo Project', controlType: 'Text', patterns: [] }) };
      }
      if (locator.automationId === 'editor-export') {
        return { element: uiNode({ automationId: 'editor-export', name: 'Export' }) };
      }
      if (locator.automationId === 'confirm-export') {
        return { element: uiNode({ automationId: 'confirm-export', name: 'Export' }) };
      }
      throw new Error('WINDOWS_UIA_FAILED: UIA_ELEMENT_NOT_FOUND');
    },
    setValue: async (_exe: string, _pid: number, locator: any, value: string) => {
      calls.push({ kind: 'setValue', locator, value });
      if (locator.automationId === 'output-path') outputAbsolute = value;
      return { element: uiNode({ automationId: locator.automationId, controlType: 'Edit', patterns: ['ValuePattern'] }) };
    },
    invoke: async (_exe: string, _pid: number, locator: any) => {
      calls.push({ kind: 'invoke', locator });
      if (locator.automationId === 'confirm-export') {
        assert.ok(outputAbsolute);
        await fs.writeFile(outputAbsolute!, Buffer.from('RWMCP_FAKE_MP4_ACCEPTANCE_BYTES'));
      }
      return { element: uiNode({ automationId: locator.automationId }) };
    }
  };

  const paths = {
    resolveExisting: async (_workspace: string, relative: string) => {
      assert.equal(relative, '.');
      return projectRoot;
    },
    resolveForWrite: async (_workspace: string, relative: string) => {
      return path.join(projectRoot, relative);
    }
  };

  const drafts = {
    installationInfo: async () => ({
      platform: 'win32',
      supported: true,
      installed: true,
      executable: 'C:/CapCut/CapCut.exe',
      version: options.installedVersion ?? '9.5.0.4050'
    }),
    projectIdentity: async () => ({
      projectId: '1007',
      draftName: 'Demo Project',
      draftId: 'DRAFT-ID',
      sha256: 'a'.repeat(64),
      mirrorConsistent: true,
      durationMs: 1500
    })
  };

  const media = {
    probeFile: async (_workspace: string, _projectPath: string, output: string) => {
      assert.equal(output, 'exports/final.mp4');
      return {
        input: output,
        backend: 'ffprobe',
        durationMs: 3,
        format: { name: 'mov,mp4', durationSeconds: 1.5, sizeBytes: 30, bitRate: 1000 },
        streams: [{ codecType: 'video', codecName: 'h264', width: 1080, height: 1920, avgFps: 30 }]
      };
    }
  };

  const profiles = new CapCutExportProfileStore(profileFile);
  const adapter = new CapCutNativeExportAdapter(
    paths as never,
    new EngineeringResourceManager('owner'),
    drafts as never,
    ui as never,
    profiles,
    media as never
  );

  return { root, projectRoot, outputDir, profileFile, profiles, adapter, calls, profile };
}

test('CapCut export profiles stay owner-local, version-bound and reject raw coordinate fields', async () => {
  const f = await fixture();
  try {
    const list = await f.profiles.publicList();
    assert.deepEqual(list, [{
      id: 'capcut-9.5-en',
      label: 'CapCut 9.5 English',
      appVersion: '9.5.0.4050',
      locale: 'en-US',
      outputMode: 'full-path',
      blockerCodes: ['subscription-required', 'login-required']
    }]);
    const raw = JSON.parse(await fs.readFile(f.profileFile, 'utf8'));
    raw.profiles[0].editorExportButton.x = 10;
    await fs.writeFile(f.profileFile, JSON.stringify(raw), 'utf8');
    await assert.rejects(() => f.profiles.list(), /unrecognized|invalid|expected|strict/i);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('CapCut native export plan binds exact active project, version, profile and blocker state into plan SHA', async () => {
  const ready = await fixture();
  const blocked = await fixture({ blocker: 'subscription-required' });
  try {
    const a = await ready.adapter.plan('w', '.', '1007', 'capcut-9.5-en', 'exports/final.mp4');
    const b = await ready.adapter.plan('w', '.', '1007', 'capcut-9.5-en', 'exports/final.mp4');
    assert.equal(a.ready, true);
    assert.equal(a.planSha256, b.planSha256);
    assert.equal(a.draftName, 'Demo Project');
    assert.equal(a.draftSha256, 'a'.repeat(64));
    assert.equal(a.profileId, 'capcut-9.5-en');
    assert.match(a.profileDigest, /^[a-f0-9]{64}$/);
    assert.match(a.planSha256, /^[a-f0-9]{64}$/);

    const c = await blocked.adapter.plan('w', '.', '1007', 'capcut-9.5-en', 'exports/final.mp4');
    assert.equal(c.ready, false);
    assert.ok(c.blockers.includes('subscription-required'));
    assert.notEqual(c.planSha256, a.planSha256);
  } finally {
    await fs.rm(ready.root, { recursive: true, force: true });
    await fs.rm(blocked.root, { recursive: true, force: true });
  }
});

test('CapCut export refuses profile version mismatch before semantic mutation', async () => {
  const f = await fixture({ installedVersion: '9.6.0.1000' });
  try {
    await assert.rejects(
      () => f.adapter.plan('w', '.', '1007', 'capcut-9.5-en', 'exports/final.mp4'),
      /PROFILE_MISMATCH/i
    );
    assert.equal(f.calls.some(call => call.kind === 'invoke'), false);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('CapCut export requires exact reviewed plan SHA before invoking export UI', async () => {
  const f = await fixture();
  try {
    const plan = await f.adapter.plan('w', '.', '1007', 'capcut-9.5-en', 'exports/final.mp4');
    assert.equal(plan.ready, true);
    const beforeInvoke = f.calls.filter(call => call.kind === 'invoke').length;
    const wrong = plan.planSha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    await assert.rejects(
      () => f.adapter.export('w', '.', '1007', 'capcut-9.5-en', 'exports/final.mp4', wrong, 10_000),
      /plan changed since review/i
    );
    assert.equal(f.calls.filter(call => call.kind === 'invoke').length, beforeInvoke);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('CapCut native export accepts only fail-if-exists MP4 with FFprobe and SHA-256 evidence', async () => {
  const f = await fixture();
  try {
    const plan = await f.adapter.plan('w', '.', '1007', 'capcut-9.5-en', 'exports/final.mp4');
    const result = await f.adapter.export(
      'w', '.', '1007', 'capcut-9.5-en', 'exports/final.mp4', plan.planSha256, 10_000
    );
    assert.equal(result.output, 'exports/final.mp4');
    assert.equal(result.acceptance.outputWasAbsentBeforeRun, true);
    assert.equal(result.acceptance.semanticProjectMatched, true);
    assert.equal(result.acceptance.profileVersionMatched, true);
    assert.equal(result.acceptance.ffprobeAccepted, true);
    assert.equal(result.acceptance.sha256Computed, true);
    const bytes = await fs.readFile(path.join(f.outputDir, 'final.mp4'));
    assert.equal(
      result.sha256,
      crypto.createHash('sha256').update(bytes).digest('hex')
    );
    assert.ok(f.calls.some(call => call.kind === 'invoke' && call.locator?.automationId === 'editor-export'));
    assert.ok(f.calls.some(call => call.kind === 'setValue' && call.locator?.automationId === 'output-path'));
    assert.ok(f.calls.some(call => call.kind === 'invoke' && call.locator?.automationId === 'confirm-export'));

    await assert.rejects(
      () => f.adapter.plan('w', '.', '1007', 'capcut-9.5-en', 'exports/final.mp4'),
      /already exists/i
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
