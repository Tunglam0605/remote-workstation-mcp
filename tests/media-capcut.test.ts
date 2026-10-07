import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EngineeringResourceManager } from '../src/adapters/engineering/resource-manager.js';
import { ACTION_SCHEMA_VERSION, CAPABILITIES } from '../src/capabilities.js';
import { CapCutDraftAdapter } from '../src/extensions/media/capcut-draft.js';

function draftFixture() {
  return {
    id: 'DRAFT-1',
    version: 360000,
    new_version: '187.0.0',
    duration: 4_000_000,
    create_time: 1,
    update_time: 1,
    fps: 30,
    canvas_config: { ratio: 'original', width: 1080, height: 1920, background: null },
    platform: { os: 'windows', app_version: '9.5.0', app_source: 'cc' },
    tracks: [
      {
        type: 'video',
        segments: [{
          id: 'VIDEO-1',
          source_timerange: { start: 0, duration: 4_000_000 },
          target_timerange: { start: 0, duration: 4_000_000 },
          render_timerange: { start: 0, duration: 0 },
          speed: 1,
          volume: 1,
          last_nonzero_volume: 1,
          visible: true,
          clip: {
            scale: { x: 1, y: 1 },
            rotation: 0,
            transform: { x: 0, y: 0 },
            flip: { vertical: false, horizontal: false },
            alpha: 1
          },
          material_id: 'VIDEO-MAT',
          extra_material_refs: ['SPEED-1']
        }]
      },
      {
        type: 'text',
        segments: [{
          id: 'TEXT-1',
          source_timerange: null,
          target_timerange: { start: 0, duration: 4_000_000 },
          render_timerange: { start: 0, duration: 0 },
          speed: 1,
          volume: 1,
          visible: true,
          clip: {
            scale: { x: 1, y: 1 },
            rotation: 0,
            transform: { x: 0, y: 0 },
            flip: { vertical: false, horizontal: false },
            alpha: 1
          },
          material_id: 'TEXT-MAT',
          extra_material_refs: []
        }]
      }
    ],
    materials: {
      videos: [{
        id: 'VIDEO-MAT',
        type: 'video',
        duration: 10_000_000,
        path: 'C:/media/sample.mp4',
        width: 720,
        height: 1280
      }],
      texts: [{
        id: 'TEXT-MAT',
        type: 'text',
        content: JSON.stringify({ styles: [{ range: [0, 5], size: 15 }], text: 'Hello' }),
        base_content: ''
      }],
      speeds: [{ id: 'SPEED-1', type: 'speed', mode: 0, speed: 1, curve_speed: null }]
    }
  };
}

async function fixture(options: { running?: boolean; divergentMirror?: boolean; richText?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-capcut-'));
  const draftsRoot = path.join(root, 'drafts');
  const appsRoot = path.join(root, 'apps');
  const backupRoot = path.join(root, 'backups');
  const project = path.join(draftsRoot, '1007');
  const timeline = path.join(project, 'Timelines', 'TL-1');
  await fs.mkdir(timeline, { recursive: true });
  await fs.mkdir(appsRoot, { recursive: true });
  await fs.writeFile(path.join(appsRoot, 'CapCut.exe'), 'fixture');
  await fs.writeFile(path.join(appsRoot, 'ProductInfo.xml'), '<packet><full_appver value="9.5.0.4050" /></packet>');

  const draft = draftFixture();
  if (options.richText) {
    draft.materials.texts[0]!.content = JSON.stringify({
      styles: [{ range: [0, 2] }, { range: [2, 5] }],
      text: 'Hello'
    });
  }
  const raw = JSON.stringify(draft);
  await fs.writeFile(path.join(project, 'draft_content.json'), raw);
  await fs.writeFile(path.join(project, 'template-2.tmp'), raw);
  await fs.writeFile(path.join(project, 'Timelines', 'project.json'), JSON.stringify({
    id: 'PROJECT-1',
    main_timeline_id: 'TL-1',
    timelines: [{ id: 'TL-1', name: 'Timeline 01' }]
  }));
  await fs.writeFile(path.join(timeline, 'draft_content.json'), options.divergentMirror ? JSON.stringify({ ...draft, fps: 60 }) : raw);
  await fs.writeFile(path.join(timeline, 'template-2.tmp'), raw);

  const adapter = new CapCutDraftAdapter(
    { run: async () => { throw new Error('runner should not execute when probe override is supplied'); } } as never,
    new EngineeringResourceManager('owner'),
    {
      platform: 'win32',
      draftsRoot,
      appsRoot,
      backupRoot,
      appRunningProbe: async () => ({ running: options.running ?? false, evidence: 'fixture' })
    }
  );

  return { root, draftsRoot, appsRoot, backupRoot, project, timeline, adapter };
}

test('CapCut tools are advertised through the media capability contract', () => {
  assert.equal(ACTION_SCHEMA_VERSION, 66);
  const media = CAPABILITIES.find(item => item.id === 'engineering.media');
  assert.ok(media);
  for (const tool of [
    'media_capcut_status',
    'media_capcut_project_list',
    'media_capcut_project_inspect',
    'media_capcut_edit_plan',
    'media_capcut_edit'
  ]) assert.ok(media.tools.includes(tool), `missing ${tool}`);
});

test('CapCut adapter inspects local 9.5-style draft mirrors without exposing source paths', async () => {
  const f = await fixture();
  try {
    const status = await f.adapter.providerStatus();
    assert.equal(status.installed, true);
    assert.equal(status.version, '9.5.0.4050');
    assert.equal(status.running, false);
    assert.equal(status.safety.rawJsonPatch, false);

    const listed = await f.adapter.listProjects();
    assert.equal(listed.available, true);
    assert.equal(listed.projects.length, 1);
    assert.equal(listed.projects[0]?.projectId, '1007');

    const inspected = await f.adapter.inspect('1007');
    assert.equal(inspected.mirrorConsistent, true);
    assert.equal(inspected.mirrors.length, 4);
    assert.equal(inspected.schema.version, 360000);
    assert.equal(inspected.schema.newVersion, '187.0.0');
    assert.equal(inspected.segments.length, 2);
    assert.equal(inspected.segments[0]?.sourceName, 'sample.mp4');
    assert.equal(inspected.segments[1]?.text, 'Hello');
    assert.equal(JSON.stringify(inspected).includes('C:/media/sample.mp4'), false);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('CapCut edit plan composes typed trim, speed, transform and text edits without writing', async () => {
  const f = await fixture();
  try {
    const before = await f.adapter.inspect('1007');
    const original = await fs.readFile(path.join(f.project, 'draft_content.json'), 'utf8');
    const plan = await f.adapter.editPlan('1007', before.sha256, [
      { op: 'trim', segmentId: 'VIDEO-1', sourceStartMs: 1000, sourceDurationMs: 2000 },
      { op: 'set_speed', segmentId: 'VIDEO-1', speed: 2, preserve: 'source' },
      { op: 'set_transform', segmentId: 'VIDEO-1', x: 0.25, y: -0.1, scale: 1.2, rotationDeg: 12 },
      { op: 'set_text', segmentId: 'TEXT-1', text: 'Tùng Lâm Automation' }
    ]);
    assert.equal(plan.ready, true);
    assert.notEqual(plan.resultSha256, before.sha256);
    assert.deepEqual(plan.changedSegmentIds.sort(), ['TEXT-1', 'VIDEO-1']);
    const video = plan.result.segments.find((item: any) => item.id === 'VIDEO-1');
    assert.equal(video?.sourceStartMs, 1000);
    assert.equal(video?.sourceDurationMs, 2000);
    assert.equal(video?.targetDurationMs, 1000);
    assert.equal(video?.speed, 2);
    assert.equal(video?.transform.scaleX, 1.2);
    const text = plan.result.segments.find((item: any) => item.id === 'TEXT-1');
    assert.equal(text?.text, 'Tùng Lâm Automation');
    assert.equal(await fs.readFile(path.join(f.project, 'draft_content.json'), 'utf8'), original);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('CapCut transaction edits all synchronized mirrors, creates external backup and passes acceptance', async () => {
  const f = await fixture();
  try {
    const before = await f.adapter.inspect('1007');
    const operations = [
      { op: 'set_speed' as const, segmentId: 'VIDEO-1', speed: 2, preserve: 'source' as const },
      { op: 'move' as const, segmentId: 'VIDEO-1', targetStartMs: 1000 },
      { op: 'set_volume' as const, segmentId: 'VIDEO-1', volume: 0.5 },
      { op: 'set_opacity' as const, segmentId: 'VIDEO-1', opacity: 0.8 },
      { op: 'set_transform' as const, segmentId: 'VIDEO-1', x: 0.2, y: -0.2, scale: 1.25, rotationDeg: 15 },
      { op: 'set_text' as const, segmentId: 'TEXT-1', text: 'CANopen cơ bản' },
      { op: 'set_text_timing' as const, segmentId: 'TEXT-1', startMs: 500, durationMs: 2000 }
    ];
    const plan = await f.adapter.editPlan('1007', before.sha256, operations);
    assert.equal(plan.ready, true);
    const edited = await f.adapter.edit('1007', before.sha256, plan.resultSha256, operations);

    assert.equal(edited.acceptance.schemaValid, true);
    assert.equal(edited.acceptance.mirrorConsistent, true);
    assert.equal(edited.acceptance.exactPlannedSha256, true);
    assert.notEqual(edited.sha256, before.sha256);
    assert.equal(edited.result.durationMs, 3000);

    const mirrorPaths = [
      path.join(f.project, 'draft_content.json'),
      path.join(f.project, 'template-2.tmp'),
      path.join(f.timeline, 'draft_content.json'),
      path.join(f.timeline, 'template-2.tmp')
    ];
    const contents = await Promise.all(mirrorPaths.map(file => fs.readFile(file, 'utf8')));
    assert.ok(contents.every(item => item === contents[0]));

    const stored = JSON.parse(contents[0]!);
    const video = stored.tracks[0].segments[0];
    assert.equal(video.speed, 2);
    assert.equal(video.target_timerange.start, 1_000_000);
    assert.equal(video.target_timerange.duration, 2_000_000);
    assert.equal(video.volume, 0.5);
    assert.equal(video.clip.alpha, 0.8);
    assert.equal(video.clip.scale.x, 1.25);
    assert.equal(stored.materials.speeds[0].speed, 2);

    const rich = JSON.parse(stored.materials.texts[0].content);
    assert.equal(rich.text, 'CANopen cơ bản');
    assert.deepEqual(rich.styles[0].range, [0, 'CANopen cơ bản'.length]);

    const manifest = JSON.parse(await fs.readFile(path.join(f.backupRoot, edited.backupId, 'manifest.json'), 'utf8'));
    assert.equal(manifest.sourceSha256, before.sha256);
    assert.equal(manifest.files.length, 4);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('CapCut split/remove/text-clone edits are deterministic from plan through apply', async () => {
  const f = await fixture();
  try {
    const before = await f.adapter.inspect('1007');
    const operations = [
      { op: 'split' as const, segmentId: 'VIDEO-1', offsetMs: 1500 },
      { op: 'set_flip' as const, segmentId: 'VIDEO-1', horizontal: true },
      { op: 'add_text_from_template' as const, segmentId: 'TEXT-1', text: 'Bài 1 · CAN Bus', startMs: 1500, durationMs: 1200 },
      { op: 'remove_segment' as const, segmentId: 'TEXT-1' }
    ];
    const plan = await f.adapter.editPlan('1007', before.sha256, operations);
    assert.equal(plan.ready, true);
    assert.equal(plan.result.segmentCount, 3);
    assert.equal(plan.result.segments.filter((item: any) => item.trackType === 'video').length, 2);
    assert.equal(plan.result.segments.filter((item: any) => item.trackType === 'text').length, 1);
    assert.equal(plan.result.segments.find((item: any) => item.trackType === 'text')?.text, 'Bài 1 · CAN Bus');

    const edited = await f.adapter.edit('1007', before.sha256, plan.resultSha256, operations);
    assert.equal(edited.sha256, plan.resultSha256);
    assert.equal(edited.result.segmentCount, 3);
    assert.equal(edited.result.segments.find((item: any) => item.id === 'VIDEO-1')?.targetDurationMs, 1500);

    const stored = JSON.parse(await fs.readFile(path.join(f.project, 'draft_content.json'), 'utf8'));
    const videos = stored.tracks[0].segments;
    assert.equal(videos.length, 2);
    assert.equal(videos[0].clip.flip.horizontal, true);
    assert.equal(videos[0].target_timerange.duration, 1_500_000);
    assert.equal(videos[1].target_timerange.start, 1_500_000);
    assert.equal(videos[1].target_timerange.duration, 2_500_000);
    assert.notEqual(videos[1].id, 'VIDEO-1');
    assert.notEqual(videos[1].extra_material_refs[0], videos[0].extra_material_refs[0]);
    assert.equal(stored.materials.speeds.length, 2);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('CapCut edit rejects a stale or mismatched planned-result SHA before writing', async () => {
  const f = await fixture();
  try {
    const before = await f.adapter.inspect('1007');
    const operations = [{ op: 'set_volume' as const, segmentId: 'VIDEO-1', volume: 0.33 }];
    const plan = await f.adapter.editPlan('1007', before.sha256, operations);
    assert.equal(plan.ready, true);
    const raw = await fs.readFile(path.join(f.project, 'draft_content.json'), 'utf8');
    const wrongResultSha = '0'.repeat(64) === plan.resultSha256 ? '1'.repeat(64) : '0'.repeat(64);
    await assert.rejects(
      () => f.adapter.edit('1007', before.sha256, wrongResultSha, operations),
      /planned result SHA-256/i
    );
    assert.equal(await fs.readFile(path.join(f.project, 'draft_content.json'), 'utf8'), raw);
    assert.equal((await fs.readdir(f.backupRoot).catch(() => [])).length, 0);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('CapCut mutation fails closed when application is running and preserves the draft', async () => {
  const f = await fixture({ running: true });
  try {
    const before = await f.adapter.inspect('1007');
    const raw = await fs.readFile(path.join(f.project, 'draft_content.json'), 'utf8');
    const plan = await f.adapter.editPlan('1007', before.sha256, [
      { op: 'set_volume', segmentId: 'VIDEO-1', volume: 0.25 }
    ]);
    assert.equal(plan.ready, false);
    assert.match(plan.blockers.join(' '), /CapCut is running/i);
    await assert.rejects(
      () => f.adapter.edit('1007', before.sha256, plan.resultSha256, [{ op: 'set_volume', segmentId: 'VIDEO-1', volume: 0.25 }]),
      /CapCut is running/i
    );
    assert.equal(await fs.readFile(path.join(f.project, 'draft_content.json'), 'utf8'), raw);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('CapCut edit refuses divergent timeline mirrors and multi-style text replacement', async () => {
  const divergent = await fixture({ divergentMirror: true });
  try {
    const inspected = await divergent.adapter.inspect('1007');
    assert.equal(inspected.mirrorConsistent, false);
    const plan = await divergent.adapter.editPlan('1007', inspected.sha256, [
      { op: 'set_volume', segmentId: 'VIDEO-1', volume: 0.2 }
    ]);
    assert.equal(plan.ready, false);
    assert.match(plan.blockers.join(' '), /mirrors diverge/i);
    await assert.rejects(
      () => divergent.adapter.edit('1007', inspected.sha256, plan.resultSha256, [{ op: 'set_volume', segmentId: 'VIDEO-1', volume: 0.2 }]),
      /mirrors are not identical/i
    );
  } finally {
    await fs.rm(divergent.root, { recursive: true, force: true });
  }

  const rich = await fixture({ richText: true });
  try {
    const inspected = await rich.adapter.inspect('1007');
    await assert.rejects(
      () => rich.adapter.editPlan('1007', inspected.sha256, [{ op: 'set_text', segmentId: 'TEXT-1', text: 'replacement' }]),
      /multiple rich-text styles/i
    );
  } finally {
    await fs.rm(rich.root, { recursive: true, force: true });
  }
});
