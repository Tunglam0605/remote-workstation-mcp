import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ComfyUiPresetJobs } from '../src/extensions/media/comfyui-jobs.js';
import { MediaProfileStore } from '../src/extensions/media/profile-store.js';
import { ComfyUiPresetStore } from '../src/extensions/media/workflow-store.js';

async function fixture(port: number) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-comfy-preset-'));
  const profiles = path.join(root, 'media-profiles.json');
  const manifest = path.join(root, 'comfyui-presets.json');
  const workflows = path.join(root, 'workflows');
  await fs.mkdir(workflows, { recursive: true });

  await fs.writeFile(profiles, JSON.stringify({
    version: 1,
    profiles: [{ id: 'gpu', kind: 'comfyui', host: '127.0.0.1', port, scheme: 'http' }]
  }));

  await fs.writeFile(manifest, JSON.stringify({
    version: 1,
    presets: [{
      id: 'image-basic',
      label: 'Image basic',
      profileId: 'gpu',
      workflowFile: 'image-basic.json',
      bindings: {
        prompt: { type: 'string', nodeId: '1', input: 'text', required: true, maxLength: 200 },
        seed: { type: 'number', nodeId: '2', input: 'seed', default: 7, min: 0, max: 1000 },
        enabled: { type: 'boolean', nodeId: '3', input: 'enabled', default: true }
      }
    }]
  }));

  await fs.writeFile(path.join(workflows, 'image-basic.json'), JSON.stringify({
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'template' } },
    '2': { class_type: 'KSampler', inputs: { seed: 1 } },
    '3': { class_type: 'Fixture', inputs: { enabled: false } }
  }));

  return {
    root,
    profiles: new MediaProfileStore(profiles),
    presets: new ComfyUiPresetStore(manifest, workflows)
  };
}

test('ComfyUI preset list exposes typed bindings but not workflow filesystem paths', async () => {
  const fx = await fixture(8188);
  try {
    const jobs = new ComfyUiPresetJobs(fx.profiles, fx.presets);
    const list = await jobs.listPresets();
    assert.equal(list.presetCount, 1);
    assert.equal(list.presets[0]?.id, 'image-basic');
    assert.equal(list.presets[0]?.profileId, 'gpu');
    assert.equal((list.presets[0] as any).workflowFile, undefined);
    assert.equal((list.presets[0] as any).bindings.prompt.type, 'string');
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test('ComfyUI job plan accepts only manifest-whitelisted typed parameters', async () => {
  const fx = await fixture(8188);
  try {
    const jobs = new ComfyUiPresetJobs(fx.profiles, fx.presets);
    const plan = await jobs.plan('image-basic', { prompt: 'robot warehouse' });
    assert.equal(plan.workflowNodeCount, 3);
    assert.deepEqual(plan.resolvedParameters, {
      prompt: 'robot warehouse',
      seed: 7,
      enabled: true
    });
    assert.equal(plan.authority, 'owner-local-preset-only');

    await assert.rejects(() => jobs.plan('image-basic', { prompt: 'ok', unknown: 1 }), /does not expose parameter/i);
    await assert.rejects(() => jobs.plan('image-basic', { prompt: 'ok', seed: 1001 }), /maximum/i);
    await assert.rejects(() => jobs.plan('image-basic', { seed: 1 }), /requires parameter 'prompt'/i);
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test('ComfyUI preset submit posts only the resolved owner-local workflow and status returns bounded artifacts', async () => {
  let submitted: any;
  const requests: string[] = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.method + ' ' + req.url);
    res.setHeader('content-type', 'application/json');

    if (req.method === 'POST' && req.url === '/prompt') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      submitted = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.end(JSON.stringify({ prompt_id: 'job_123', number: 4 }));
      return;
    }

    if (req.method === 'GET' && req.url === '/history/job_123') {
      res.end(JSON.stringify({
        job_123: {
          status: { completed: true, status_str: 'success', messages: [['ignored', { large: 'ignored' }]] },
          prompt: { should: 'not be returned' },
          outputs: {
            '9': {
              images: [{ filename: 'frame.png', subfolder: 'run1', type: 'output' }]
            }
          }
        }
      }));
      return;
    }

    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const fx = await fixture(address.port);
  try {
    const jobs = new ComfyUiPresetJobs(fx.profiles, fx.presets);
    const submit = await jobs.submit('image-basic', { prompt: 'warehouse robot', seed: 9 }, 2_000);
    assert.equal(submit.promptId, 'job_123');
    assert.equal(submit.queueNumber, 4);
    assert.equal(submitted.prompt['1'].inputs.text, 'warehouse robot');
    assert.equal(submitted.prompt['2'].inputs.seed, 9);
    assert.equal(submitted.prompt['3'].inputs.enabled, true);
    assert.equal(submitted.workflow, undefined);

    const status = await jobs.status('gpu', 'job_123', 2_000);
    assert.equal(status.found, true);
    assert.equal(status.completed, true);
    assert.equal(status.status, 'success');
    assert.deepEqual(status.artifacts, [{
      nodeId: '9',
      kind: 'images',
      filename: 'frame.png',
      subfolder: 'run1',
      type: 'output'
    }]);
    assert.equal((status as any).prompt, undefined);
    assert.deepEqual(requests, ['POST /prompt', 'GET /history/job_123']);
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('ComfyUI workflow store rejects path escape and missing declared inputs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-comfy-preset-'));
  const manifest = path.join(root, 'manifest.json');
  const workflows = path.join(root, 'workflows');
  await fs.mkdir(workflows);

  await fs.writeFile(manifest, JSON.stringify({
    version: 1,
    presets: [{
      id: 'escape',
      profileId: 'gpu',
      workflowFile: '../outside.json',
      bindings: {}
    }]
  }));
  await assert.rejects(() => new ComfyUiPresetStore(manifest, workflows).list(), /cannot escape/i);

  await fs.writeFile(path.join(workflows, 'broken.json'), JSON.stringify({
    '1': { class_type: 'Fixture', inputs: { actual: 'x' } }
  }));
  await fs.writeFile(manifest, JSON.stringify({
    version: 1,
    presets: [{
      id: 'broken',
      profileId: 'gpu',
      workflowFile: 'broken.json',
      bindings: { prompt: { type: 'string', nodeId: '1', input: 'missing', required: true } }
    }]
  }));

  const store = new ComfyUiPresetStore(manifest, workflows);
  const preset = await store.get('broken');
  const workflow = await store.loadWorkflow(preset);
  assert.equal(Object.keys(workflow).length, 1);

  await fs.rm(root, { recursive: true, force: true });
});
