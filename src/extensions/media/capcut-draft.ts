import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EngineeringCommandRunner } from '../../adapters/engineering/command-runner.js';
import { resolveExecutable } from '../../adapters/engineering/executable-resolver.js';
import type { EngineeringResourceManager } from '../../adapters/engineering/resource-manager.js';

const MAX_DRAFT_BYTES = 32 * 1024 * 1024;
const MAX_SEGMENTS = 1000;
const MAX_PROJECTS = 256;
const DAY_MS = 86_400_000;
const MAX_TIME_MS = 7 * DAY_MS;

export type CapCutSpeedPreserve = 'source' | 'timeline';

export type CapCutEditOperation =
  | { op: 'trim'; segmentId: string; sourceStartMs: number; sourceDurationMs: number }
  | { op: 'split'; segmentId: string; offsetMs: number }
  | { op: 'remove_segment'; segmentId: string }
  | { op: 'move'; segmentId: string; targetStartMs: number }
  | { op: 'set_speed'; segmentId: string; speed: number; preserve?: CapCutSpeedPreserve }
  | { op: 'set_volume'; segmentId: string; volume: number }
  | { op: 'set_opacity'; segmentId: string; opacity: number }
  | { op: 'set_visibility'; segmentId: string; visible: boolean }
  | { op: 'set_transform'; segmentId: string; x?: number; y?: number; scale?: number; rotationDeg?: number }
  | { op: 'set_flip'; segmentId: string; horizontal?: boolean; vertical?: boolean }
  | { op: 'set_text'; segmentId: string; text: string }
  | { op: 'add_text_from_template'; segmentId: string; text: string; startMs: number; durationMs: number }
  | { op: 'set_text_timing'; segmentId: string; startMs: number; durationMs: number };

interface CapCutAdapterOptions {
  platform?: NodeJS.Platform;
  draftsRoot?: string;
  appsRoot?: string;
  backupRoot?: string;
  appRunningProbe?: () => Promise<{ running: boolean; evidence: string }>;
}

interface LoadedDraft {
  projectId: string;
  projectDir: string;
  canonicalPath: string;
  raw: string;
  sha256: string;
  draft: any;
  mirrors: Array<{ path: string; relative: string; raw: string; sha256: string }>;
  mirrorConsistent: boolean;
  mainTimelineId?: string;
}

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function deterministicUuid(seed: string, label: string): string {
  const hex = sha256Text(`${seed}:${label}`);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${(['8', '9', 'a', 'b'] as const)[Number.parseInt(hex[16]!, 16) % 4]}${hex.slice(17, 20)}`,
    hex.slice(20, 32)
  ].join('-').toUpperCase();
}

function msToUs(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_TIME_MS) {
    throw new Error(`${label} must be a finite value between 0 and ${MAX_TIME_MS} ms.`);
  }
  return Math.round(value * 1000);
}

function usToMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value / 1000 : undefined;
}

function ensureFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}

function ensureProjectId(projectId: string): string {
  const value = projectId.trim();
  if (!value || value.length > 160 || value === '.' || value === '..' || value.startsWith('.') ||
      value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error('CapCut projectId must be one immediate non-hidden draft-folder name.');
  }
  return value;
}

function ensureSegmentId(segmentId: string): string {
  const value = segmentId.trim();
  if (!value || value.length > 160 || /[\\/\0]/.test(value)) throw new Error('CapCut segmentId is invalid.');
  return value;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function readBounded(file: string): Promise<string> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`CapCut draft path is not a file: ${file}`);
  if (stat.size <= 0 || stat.size > MAX_DRAFT_BYTES) {
    throw new Error(`CapCut draft file size must be 1..${MAX_DRAFT_BYTES} bytes.`);
  }
  return await fs.readFile(file, 'utf8');
}

function parseJsonObject(raw: string, label: string): any {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

function materialArrays(draft: any): any[][] {
  if (!draft.materials || typeof draft.materials !== 'object') return [];
  return Object.values(draft.materials).filter(Array.isArray) as any[][];
}

function materialById(draft: any, id: string): any | undefined {
  for (const list of materialArrays(draft)) {
    const found = list.find(item => item && typeof item === 'object' && item.id === id);
    if (found) return found;
  }
  return undefined;
}

function textFromMaterial(material: any): string | undefined {
  if (!material || typeof material.content !== 'string') return undefined;
  try {
    const rich = JSON.parse(material.content);
    return typeof rich?.text === 'string' ? rich.text : undefined;
  } catch {
    return undefined;
  }
}

function segmentRows(draft: any) {
  const rows: Array<{ track: any; trackType: string; trackIndex: number; segment: any; segmentIndex: number }> = [];
  const tracks = Array.isArray(draft.tracks) ? draft.tracks : [];
  tracks.forEach((track: any, trackIndex: number) => {
    const segments = Array.isArray(track?.segments) ? track.segments : [];
    segments.forEach((segment: any, segmentIndex: number) => {
      if (rows.length < MAX_SEGMENTS) rows.push({ track, trackType: String(track?.type ?? 'unknown'), trackIndex, segment, segmentIndex });
    });
  });
  return rows;
}

function requireSegment(draft: any, id: string) {
  const wanted = ensureSegmentId(id);
  const rows = segmentRows(draft);
  const matches = rows.filter(row => row.segment?.id === wanted);
  if (matches.length !== 1) throw new Error(`CapCut segment '${wanted}' was ${matches.length ? 'duplicated' : 'not found'}.`);
  return matches[0]!;
}

function ensureTimerange(value: any, label: string): { start: number; duration: number } {
  if (!value || typeof value !== 'object') throw new Error(`${label} is missing.`);
  const start = ensureFinite(value.start, `${label}.start`);
  const duration = ensureFinite(value.duration, `${label}.duration`);
  if (start < 0 || duration < 0) throw new Error(`${label} cannot be negative.`);
  return { start, duration };
}

function lintDraft(draft: any): string[] {
  const warnings: string[] = [];
  if (!Array.isArray(draft.tracks)) throw new Error('CapCut draft.tracks must be an array.');
  if (!draft.materials || typeof draft.materials !== 'object' || Array.isArray(draft.materials)) {
    throw new Error('CapCut draft.materials must be an object.');
  }
  if (typeof draft.version !== 'number' || !Number.isFinite(draft.version)) warnings.push('draft.version is not a finite number');
  if (draft.platform?.app_source && !['cc', 'lv'].includes(String(draft.platform.app_source))) {
    warnings.push(`unrecognized platform.app_source '${String(draft.platform.app_source).slice(0, 32)}'`);
  }

  const ids = new Set<string>();
  for (const row of segmentRows(draft)) {
    const segment = row.segment;
    if (!segment || typeof segment !== 'object') throw new Error('CapCut track contains a non-object segment.');
    const id = typeof segment.id === 'string' ? segment.id : '';
    if (!id) throw new Error('CapCut segment is missing id.');
    if (ids.has(id)) throw new Error(`Duplicate CapCut segment id '${id}'.`);
    ids.add(id);
    const target = ensureTimerange(segment.target_timerange, `segment ${id} target_timerange`);
    if (target.start + target.duration > MAX_TIME_MS * 1000) throw new Error(`Segment '${id}' exceeds the supported timeline bound.`);

    const materialId = typeof segment.material_id === 'string' ? segment.material_id : '';
    if (materialId && !materialById(draft, materialId)) throw new Error(`Segment '${id}' references missing material '${materialId}'.`);

    if (segment.source_timerange != null) {
      const source = ensureTimerange(segment.source_timerange, `segment ${id} source_timerange`);
      const speed = ensureFinite(segment.speed ?? 1, `segment ${id} speed`);
      if (speed <= 0 || speed > 100) throw new Error(`Segment '${id}' has unsupported speed ${speed}.`);
      const expectedTarget = source.duration / speed;
      if (Math.abs(expectedTarget - target.duration) > 2) {
        throw new Error(`Segment '${id}' violates sourceDuration = targetDuration * speed.`);
      }
      const material = materialId ? materialById(draft, materialId) : undefined;
      if (material && typeof material.duration === 'number' && source.start + source.duration > material.duration + 2) {
        throw new Error(`Segment '${id}' source range exceeds material duration.`);
      }
    }
  }
  if (segmentRows(draft).length >= MAX_SEGMENTS) warnings.push(`segment inspection is bounded to ${MAX_SEGMENTS} entries`);
  return warnings;
}

function recomputeDuration(draft: any): number {
  let end = 0;
  for (const { segment } of segmentRows(draft)) {
    const target = ensureTimerange(segment.target_timerange, `segment ${segment.id} target_timerange`);
    end = Math.max(end, target.start + target.duration);
  }
  draft.duration = Math.round(end);
  if (typeof draft.update_time === 'number' && Number.isFinite(draft.update_time)) draft.update_time = Math.floor(draft.update_time) + 1;
  return draft.duration;
}

function replacePlainTextMaterial(material: any, segmentId: string, text: string): void {
  if (!material || material.type !== 'text' || typeof material.content !== 'string') {
    throw new Error(`Segment '${segmentId}' is not a supported text segment.`);
  }
  if (text.length > 10_000) throw new Error('text is limited to 10000 UTF-16 code units.');
  let rich: any;
  try { rich = JSON.parse(material.content); } catch { throw new Error(`Text material for '${segmentId}' has unsupported content JSON.`); }
  if (!rich || typeof rich !== 'object' || typeof rich.text !== 'string') {
    throw new Error(`Text material for '${segmentId}' has unsupported content shape.`);
  }
  if (Array.isArray(rich.styles) && rich.styles.length > 1) {
    throw new Error(`Text segment '${segmentId}' uses multiple rich-text styles; fail-closed to avoid style-range corruption.`);
  }
  rich.text = text;
  if (Array.isArray(rich.styles) && rich.styles.length === 1 && Array.isArray(rich.styles[0]?.range)) {
    rich.styles[0].range = [0, text.length];
  }
  material.content = JSON.stringify(rich);
  if (typeof material.base_content === 'string' && material.base_content) material.base_content = text;
}

function cloneExtraMaterials(draft: any, refs: unknown, seed: string, label: string): string[] {
  if (!Array.isArray(refs)) return [];
  const result: string[] = [];
  for (let index = 0; index < refs.length; index += 1) {
    const ref = String(refs[index] ?? '');
    if (!ref) continue;
    let cloned = false;
    if (draft.materials && typeof draft.materials === 'object') {
      for (const [collection, items] of Object.entries(draft.materials)) {
        if (!Array.isArray(items)) continue;
        const original = items.find((item: any) => item && String(item.id) === ref);
        if (!original) continue;
        const copy = JSON.parse(JSON.stringify(original));
        copy.id = deterministicUuid(seed, `${label}:extra:${collection}:${index}:${ref}`);
        items.push(copy);
        result.push(copy.id);
        cloned = true;
        break;
      }
    }
    if (!cloned) throw new Error(`Referenced CapCut extra material '${ref}' is missing; clone is refused.`);
  }
  return result;
}

function assertSimpleSplitSegment(segment: any, segmentId: string): void {
  if (!segment.source_timerange) throw new Error(`Segment '${segmentId}' has no source range and cannot be split.`);
  if (segment.reverse || segment.is_loop || segment.responsive_layout?.enable || segment.caption_info != null ||
      (typeof segment.group_id === 'string' && segment.group_id) ||
      (Array.isArray(segment.keyframe_refs) && segment.keyframe_refs.length > 0) ||
      (Array.isArray(segment.common_keyframes) && segment.common_keyframes.length > 0) ||
      (Array.isArray(segment.lyric_keyframes) && segment.lyric_keyframes.length > 0)) {
    throw new Error(`Segment '${segmentId}' uses advanced timeline state; split is fail-closed.`);
  }
}

function applyOperation(draft: any, operation: CapCutEditOperation, deterministicSeed: string, operationIndex: number): string[] {
  const row = requireSegment(draft, operation.segmentId);
  const segment = row.segment;
  const segmentId = String(segment.id);

  switch (operation.op) {
    case 'trim': {
      if (!segment.source_timerange) throw new Error(`Segment '${segmentId}' has no source range and cannot be trimmed.`);
      const start = msToUs(operation.sourceStartMs, 'sourceStartMs');
      const duration = msToUs(operation.sourceDurationMs, 'sourceDurationMs');
      if (duration <= 0) throw new Error('sourceDurationMs must be greater than zero.');
      const speed = ensureFinite(segment.speed ?? 1, 'segment speed');
      const material = materialById(draft, String(segment.material_id ?? ''));
      if (material && typeof material.duration === 'number' && start + duration > material.duration + 2) {
        throw new Error(`Trim for segment '${segmentId}' exceeds source material duration.`);
      }
      segment.source_timerange = { ...segment.source_timerange, start, duration };
      segment.target_timerange.duration = Math.round(duration / speed);
      return [segmentId];
    }
    case 'split': {
      assertSimpleSplitSegment(segment, segmentId);
      const source = ensureTimerange(segment.source_timerange, 'source_timerange');
      const target = ensureTimerange(segment.target_timerange, 'target_timerange');
      const offset = msToUs(operation.offsetMs, 'offsetMs');
      if (offset <= 0 || offset >= target.duration) throw new Error('split offsetMs must be strictly inside the segment target duration.');
      const speed = ensureFinite(segment.speed ?? 1, 'segment speed');
      const sourceOffset = Math.round(offset * speed);
      if (sourceOffset <= 0 || sourceOffset >= source.duration) throw new Error('split point maps outside the source range.');

      const clone = JSON.parse(JSON.stringify(segment));
      const newSegmentId = deterministicUuid(deterministicSeed, `split:${operationIndex}:${segmentId}`);
      clone.id = newSegmentId;
      clone.source_timerange.start = source.start + sourceOffset;
      clone.source_timerange.duration = source.duration - sourceOffset;
      clone.target_timerange.start = target.start + offset;
      clone.target_timerange.duration = target.duration - offset;
      clone.extra_material_refs = cloneExtraMaterials(
        draft,
        segment.extra_material_refs,
        deterministicSeed,
        `split:${operationIndex}:${segmentId}`
      );

      segment.source_timerange.duration = sourceOffset;
      segment.target_timerange.duration = offset;
      row.track.segments.splice(row.segmentIndex + 1, 0, clone);
      return [segmentId, newSegmentId];
    }
    case 'remove_segment':
      if (typeof segment.group_id === 'string' && segment.group_id) throw new Error(`Grouped segment '${segmentId}' cannot be removed by the bounded editor.`);
      row.track.segments.splice(row.segmentIndex, 1);
      return [segmentId];
    case 'move':
      segment.target_timerange.start = msToUs(operation.targetStartMs, 'targetStartMs');
      return [segmentId];
    case 'set_speed': {
      if (!segment.source_timerange) throw new Error(`Segment '${segmentId}' has no source range and cannot change speed safely.`);
      const speed = ensureFinite(operation.speed, 'speed');
      if (speed < 0.05 || speed > 20) throw new Error('speed must be between 0.05 and 20.');
      const source = ensureTimerange(segment.source_timerange, 'source_timerange');
      const target = ensureTimerange(segment.target_timerange, 'target_timerange');
      const preserve = operation.preserve ?? 'source';
      if (preserve === 'source') {
        segment.target_timerange.duration = Math.max(1, Math.round(source.duration / speed));
      } else {
        const nextSourceDuration = Math.max(1, Math.round(target.duration * speed));
        const material = materialById(draft, String(segment.material_id ?? ''));
        if (material && typeof material.duration === 'number' && source.start + nextSourceDuration > material.duration + 2) {
          throw new Error(`Speed change for segment '${segmentId}' would exceed source material duration.`);
        }
        segment.source_timerange.duration = nextSourceDuration;
      }
      segment.speed = speed;
      const refs = Array.isArray(segment.extra_material_refs) ? new Set(segment.extra_material_refs.map(String)) : new Set<string>();
      const speeds = Array.isArray(draft.materials?.speeds) ? draft.materials.speeds : [];
      const speedMaterial = speeds.find((item: any) => item && refs.has(String(item.id)));
      if (speedMaterial) {
        if (speedMaterial.curve_speed != null) throw new Error(`Segment '${segmentId}' uses curve speed; scalar speed edit is refused.`);
        speedMaterial.speed = speed;
      }
      return [segmentId];
    }
    case 'set_volume': {
      const volume = ensureFinite(operation.volume, 'volume');
      if (volume < 0 || volume > 1) throw new Error('volume must be between 0 and 1.');
      segment.volume = volume;
      if (volume > 0) segment.last_nonzero_volume = volume;
      return [segmentId];
    }
    case 'set_opacity': {
      const opacity = ensureFinite(operation.opacity, 'opacity');
      if (opacity < 0 || opacity > 1) throw new Error('opacity must be between 0 and 1.');
      if (!segment.clip || typeof segment.clip !== 'object') throw new Error(`Segment '${segmentId}' has no clip transform.`);
      segment.clip.alpha = opacity;
      return [segmentId];
    }
    case 'set_visibility':
      segment.visible = operation.visible;
      return [segmentId];
    case 'set_transform': {
      if (!segment.clip || typeof segment.clip !== 'object') throw new Error(`Segment '${segmentId}' has no clip transform.`);
      if (!segment.clip.transform || typeof segment.clip.transform !== 'object') segment.clip.transform = { x: 0, y: 0 };
      if (!segment.clip.scale || typeof segment.clip.scale !== 'object') segment.clip.scale = { x: 1, y: 1 };
      if (operation.x !== undefined) {
        const x = ensureFinite(operation.x, 'x');
        if (x < -10 || x > 10) throw new Error('x must be between -10 and 10.');
        segment.clip.transform.x = x;
      }
      if (operation.y !== undefined) {
        const y = ensureFinite(operation.y, 'y');
        if (y < -10 || y > 10) throw new Error('y must be between -10 and 10.');
        segment.clip.transform.y = y;
      }
      if (operation.scale !== undefined) {
        const scale = ensureFinite(operation.scale, 'scale');
        if (scale < 0.01 || scale > 20) throw new Error('scale must be between 0.01 and 20.');
        segment.clip.scale.x = scale;
        segment.clip.scale.y = scale;
      }
      if (operation.rotationDeg !== undefined) {
        const rotation = ensureFinite(operation.rotationDeg, 'rotationDeg');
        if (rotation < -3600 || rotation > 3600) throw new Error('rotationDeg must be between -3600 and 3600.');
        segment.clip.rotation = rotation;
      }
      return [segmentId];
    }
    case 'set_flip': {
      if (!segment.clip || typeof segment.clip !== 'object') throw new Error(`Segment '${segmentId}' has no clip transform.`);
      if (!segment.clip.flip || typeof segment.clip.flip !== 'object') segment.clip.flip = { horizontal: false, vertical: false };
      if (operation.horizontal !== undefined) segment.clip.flip.horizontal = operation.horizontal;
      if (operation.vertical !== undefined) segment.clip.flip.vertical = operation.vertical;
      return [segmentId];
    }
    case 'set_text': {
      const material = materialById(draft, String(segment.material_id ?? ''));
      replacePlainTextMaterial(material, segmentId, operation.text);
      return [segmentId];
    }
    case 'add_text_from_template': {
      if (row.trackType !== 'text' || segment.source_timerange != null) {
        throw new Error(`Segment '${segmentId}' is not a supported text template.`);
      }
      if ((Array.isArray(segment.keyframe_refs) && segment.keyframe_refs.length > 0) ||
          (Array.isArray(segment.common_keyframes) && segment.common_keyframes.length > 0) ||
          (typeof segment.group_id === 'string' && segment.group_id)) {
        throw new Error(`Text template '${segmentId}' uses advanced state and cannot be cloned safely.`);
      }
      const material = materialById(draft, String(segment.material_id ?? ''));
      if (!material || material.type !== 'text') throw new Error(`Segment '${segmentId}' is not a text template.`);

      const newMaterial = JSON.parse(JSON.stringify(material));
      const newMaterialId = deterministicUuid(deterministicSeed, `text-material:${operationIndex}:${segmentId}`);
      const newSegmentId = deterministicUuid(deterministicSeed, `text-segment:${operationIndex}:${segmentId}`);
      newMaterial.id = newMaterialId;
      replacePlainTextMaterial(newMaterial, segmentId, operation.text);
      if (!Array.isArray(draft.materials.texts)) throw new Error('CapCut draft has no text material collection.');
      draft.materials.texts.push(newMaterial);

      const clone = JSON.parse(JSON.stringify(segment));
      clone.id = newSegmentId;
      clone.material_id = newMaterialId;
      clone.target_timerange.start = msToUs(operation.startMs, 'startMs');
      clone.target_timerange.duration = msToUs(operation.durationMs, 'durationMs');
      if (clone.target_timerange.duration <= 0) throw new Error('durationMs must be greater than zero.');
      clone.extra_material_refs = cloneExtraMaterials(
        draft,
        segment.extra_material_refs,
        deterministicSeed,
        `text:${operationIndex}:${segmentId}`
      );
      const renderIndexes = segmentRows(draft)
        .filter(item => item.trackType === 'text')
        .map(item => item.segment?.render_index)
        .filter((value: unknown): value is number => typeof value === 'number' && Number.isFinite(value));
      if (typeof clone.render_index === 'number') clone.render_index = Math.max(clone.render_index, ...renderIndexes, 0) + 1000;
      row.track.segments.push(clone);
      return [newSegmentId];
    }
    case 'set_text_timing': {
      if (segment.source_timerange != null) throw new Error(`Segment '${segmentId}' has a source range; set_text_timing is only for generated/text overlays.`);
      const material = materialById(draft, String(segment.material_id ?? ''));
      if (!material || material.type !== 'text') throw new Error(`Segment '${segmentId}' is not a text segment.`);
      const start = msToUs(operation.startMs, 'startMs');
      const duration = msToUs(operation.durationMs, 'durationMs');
      if (duration <= 0) throw new Error('durationMs must be greater than zero.');
      segment.target_timerange.start = start;
      segment.target_timerange.duration = duration;
      return [segmentId];
    }
  }
}

function applyOperations(draft: any, operations: CapCutEditOperation[], deterministicSeed: string) {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 64) {
    throw new Error('CapCut edit requires 1..64 typed operations.');
  }
  const changed = new Set<string>();
  operations.forEach((operation, index) => {
    for (const segmentId of applyOperation(draft, operation, deterministicSeed, index)) changed.add(segmentId);
  });
  const duration = recomputeDuration(draft);
  const warnings = lintDraft(draft);
  return { changedSegmentIds: [...changed], duration, warnings };
}

function summarize(draft: any) {
  const rows = segmentRows(draft);
  return {
    schema: {
      version: typeof draft.version === 'number' ? draft.version : undefined,
      newVersion: typeof draft.new_version === 'string' ? draft.new_version.slice(0, 64) : undefined,
      appVersion: typeof draft.platform?.app_version === 'string' ? draft.platform.app_version.slice(0, 64) : undefined,
      appSource: typeof draft.platform?.app_source === 'string' ? draft.platform.app_source.slice(0, 32) : undefined
    },
    durationMs: usToMs(draft.duration),
    fps: typeof draft.fps === 'number' ? draft.fps : undefined,
    canvas: draft.canvas_config && typeof draft.canvas_config === 'object' ? {
      width: draft.canvas_config.width,
      height: draft.canvas_config.height,
      ratio: draft.canvas_config.ratio
    } : undefined,
    trackCount: Array.isArray(draft.tracks) ? draft.tracks.length : 0,
    segmentCount: rows.length,
    segments: rows.map(row => {
      const segment = row.segment;
      const material = materialById(draft, String(segment.material_id ?? ''));
      const sourcePath = typeof material?.path === 'string' ? material.path : undefined;
      return {
        id: String(segment.id),
        trackType: row.trackType,
        trackIndex: row.trackIndex,
        segmentIndex: row.segmentIndex,
        materialId: typeof segment.material_id === 'string' ? segment.material_id : undefined,
        materialType: typeof material?.type === 'string' ? material.type : undefined,
        sourceName: sourcePath ? path.basename(sourcePath) : undefined,
        text: textFromMaterial(material)?.slice(0, 500),
        targetStartMs: usToMs(segment.target_timerange?.start),
        targetDurationMs: usToMs(segment.target_timerange?.duration),
        sourceStartMs: usToMs(segment.source_timerange?.start),
        sourceDurationMs: usToMs(segment.source_timerange?.duration),
        speed: typeof segment.speed === 'number' ? segment.speed : undefined,
        volume: typeof segment.volume === 'number' ? segment.volume : undefined,
        visible: typeof segment.visible === 'boolean' ? segment.visible : undefined,
        opacity: typeof segment.clip?.alpha === 'number' ? segment.clip.alpha : undefined,
        transform: segment.clip ? {
          x: segment.clip.transform?.x,
          y: segment.clip.transform?.y,
          scaleX: segment.clip.scale?.x,
          scaleY: segment.clip.scale?.y,
          rotationDeg: segment.clip.rotation
        } : undefined
      };
    })
  };
}

async function existingFile(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export class CapCutDraftAdapter {
  private readonly platform: NodeJS.Platform;
  private readonly draftsRootOverride?: string;
  private readonly appsRootOverride?: string;
  private readonly backupRootOverride?: string;
  private readonly appRunningProbeOverride?: () => Promise<{ running: boolean; evidence: string }>;

  constructor(
    private readonly runner: EngineeringCommandRunner,
    private readonly resources: EngineeringResourceManager,
    options: CapCutAdapterOptions = {}
  ) {
    this.platform = options.platform ?? process.platform;
    this.draftsRootOverride = options.draftsRoot;
    this.appsRootOverride = options.appsRoot;
    this.backupRootOverride = options.backupRoot;
    this.appRunningProbeOverride = options.appRunningProbe;
  }

  private draftsRoot(): string | undefined {
    if (this.draftsRootOverride) return path.resolve(this.draftsRootOverride);
    if (this.platform === 'win32') {
      const local = process.env.LOCALAPPDATA?.trim();
      return local ? path.join(local, 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft') : undefined;
    }
    if (this.platform === 'darwin') return path.join(os.homedir(), 'Movies', 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft');
    return undefined;
  }

  private appsRoot(): string | undefined {
    if (this.appsRootOverride) return path.resolve(this.appsRootOverride);
    if (this.platform === 'win32') {
      const local = process.env.LOCALAPPDATA?.trim();
      return local ? path.join(local, 'CapCut', 'Apps') : undefined;
    }
    if (this.platform === 'darwin') return '/Applications/CapCut.app';
    return undefined;
  }

  private backupRoot(): string {
    if (this.backupRootOverride) return path.resolve(this.backupRootOverride);
    if (this.platform === 'win32' && process.env.LOCALAPPDATA?.trim()) {
      return path.join(process.env.LOCALAPPDATA.trim(), 'RemoteWorkstationMCP', 'backups', 'capcut');
    }
    return path.join(os.homedir(), '.remote-workstation-mcp', 'backups', 'capcut');
  }

  private async appRunning(): Promise<{ running: boolean; evidence: string }> {
    if (this.appRunningProbeOverride) return await this.appRunningProbeOverride();
    if (this.platform === 'win32') {
      const executable = await resolveExecutable('tasklist');
      if (!executable) throw new Error('Cannot prove CapCut is closed because tasklist is unavailable.');
      const result = await this.runner.run(executable, ['/FI', 'IMAGENAME eq CapCut.exe', '/FO', 'CSV', '/NH'], os.tmpdir(), 5_000);
      if (result.timedOut || result.exitCode !== 0) throw new Error('Cannot prove CapCut is closed because process inspection failed.');
      return { running: /CapCut\.exe/i.test(result.stdout), evidence: 'tasklist:CapCut.exe' };
    }
    if (this.platform === 'darwin') {
      const executable = await resolveExecutable('pgrep');
      if (!executable) throw new Error('Cannot prove CapCut is closed because pgrep is unavailable.');
      const result = await this.runner.run(executable, ['-x', 'CapCut'], os.tmpdir(), 5_000);
      return { running: result.exitCode === 0 && result.stdout.trim().length > 0, evidence: 'pgrep:CapCut' };
    }
    throw new Error('CapCut local draft mutation is supported only on Windows and macOS.');
  }

  async providerStatus() {
    const root = this.draftsRoot();
    const apps = this.appsRoot();
    const draftStoreAvailable = root ? await fs.stat(root).then(s => s.isDirectory()).catch(() => false) : false;
    let executable: string | undefined;
    let version: string | undefined;
    if (this.platform === 'win32' && apps) {
      const candidate = path.join(apps, 'CapCut.exe');
      if (await existingFile(candidate)) executable = candidate;
      const productInfo = path.join(apps, 'ProductInfo.xml');
      if (await existingFile(productInfo)) {
        const raw = await readBounded(productInfo);
        version = raw.match(/<full_appver\s+value="([^"]+)"/i)?.[1] ?? raw.match(/<appver\s+value="([^"]+)"/i)?.[1];
      }
    } else if (this.platform === 'darwin' && apps) {
      executable = await fs.stat(apps).then(s => s.isDirectory() ? apps : undefined).catch(() => undefined);
    }
    let running: boolean | undefined;
    let runningEvidence: string | undefined;
    try {
      const state = await this.appRunning();
      running = state.running;
      runningEvidence = state.evidence;
    } catch {
      running = undefined;
    }
    return {
      platform: this.platform,
      supported: this.platform === 'win32' || this.platform === 'darwin',
      installed: Boolean(executable),
      version,
      draftStoreAvailable,
      running,
      runningEvidence,
      capabilities: ['inspect', 'trim', 'split', 'remove-segment', 'move', 'speed', 'volume', 'opacity', 'visibility', 'transform', 'flip', 'text', 'text-from-template', 'text-timing'],
      safety: {
        mutationRequiresClosedApp: true,
        optimisticSha256: true,
        mirrorConsistency: true,
        resourceLease: true,
        externalBackup: true,
        rawJsonPatch: false
      }
    };
  }

  private async resolveProjectDir(projectId: string): Promise<{ root: string; projectDir: string }> {
    const id = ensureProjectId(projectId);
    const configuredRoot = this.draftsRoot();
    if (!configuredRoot) throw new Error('CapCut draft root is unavailable on this platform.');
    const root = await fs.realpath(configuredRoot);
    const candidate = path.join(root, id);
    const projectDir = await fs.realpath(candidate);
    if (!inside(root, projectDir) || path.dirname(projectDir) !== root) throw new Error('CapCut project escaped the draft root.');
    if (!(await fs.stat(projectDir)).isDirectory()) throw new Error('CapCut project is not a directory.');
    return { root, projectDir };
  }

  async listProjects() {
    const configuredRoot = this.draftsRoot();
    if (!configuredRoot) return { available: false, projects: [] };
    const root = await fs.realpath(configuredRoot).catch(() => undefined);
    if (!root) return { available: false, projects: [] };
    const entries = (await fs.readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .slice(0, MAX_PROJECTS);
    const projects: any[] = [];
    for (const entry of entries) {
      const file = path.join(root, entry.name, 'draft_content.json');
      if (!(await existingFile(file))) continue;
      try {
        const raw = await readBounded(file);
        const draft = parseJsonObject(raw, 'draft_content.json');
        projects.push({
          projectId: entry.name,
          sha256: sha256Text(raw),
          durationMs: usToMs(draft.duration),
          fps: typeof draft.fps === 'number' ? draft.fps : undefined,
          appVersion: typeof draft.platform?.app_version === 'string' ? draft.platform.app_version.slice(0, 64) : undefined,
          canvas: draft.canvas_config && typeof draft.canvas_config === 'object'
            ? { width: draft.canvas_config.width, height: draft.canvas_config.height, ratio: draft.canvas_config.ratio }
            : undefined
        });
      } catch (error) {
        projects.push({ projectId: entry.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { available: true, truncated: entries.length >= MAX_PROJECTS, projects };
  }

  private async load(projectId: string): Promise<LoadedDraft> {
    const { projectDir } = await this.resolveProjectDir(projectId);
    const canonicalPath = path.join(projectDir, 'draft_content.json');
    const raw = await readBounded(canonicalPath);
    const draft = parseJsonObject(raw, 'draft_content.json');
    lintDraft(draft);
    const sha256 = sha256Text(raw);
    const mirrors: LoadedDraft['mirrors'] = [{
      path: canonicalPath,
      relative: 'draft_content.json',
      raw,
      sha256
    }];

    const rootTemplate = path.join(projectDir, 'template-2.tmp');
    if (await existingFile(rootTemplate)) {
      const mirrorRaw = await readBounded(rootTemplate);
      mirrors.push({ path: rootTemplate, relative: 'template-2.tmp', raw: mirrorRaw, sha256: sha256Text(mirrorRaw) });
    }

    let mainTimelineId: string | undefined;
    const timelineProject = path.join(projectDir, 'Timelines', 'project.json');
    if (await existingFile(timelineProject)) {
      const timelineProjectRaw = await readBounded(timelineProject);
      const timelineProjectJson = parseJsonObject(timelineProjectRaw, 'Timelines/project.json');
      if (typeof timelineProjectJson.main_timeline_id === 'string' && timelineProjectJson.main_timeline_id.length <= 160 &&
          !/[\\/\0]/.test(timelineProjectJson.main_timeline_id)) {
        const timelineId = timelineProjectJson.main_timeline_id as string;
        mainTimelineId = timelineId;
        const timelineDir = path.join(projectDir, 'Timelines', timelineId);
        for (const filename of ['draft_content.json', 'template-2.tmp']) {
          const mirrorPath = path.join(timelineDir, filename);
          if (await existingFile(mirrorPath)) {
            const mirrorReal = await fs.realpath(mirrorPath);
            if (!inside(projectDir, mirrorReal)) throw new Error('CapCut timeline mirror escaped the project directory.');
            const mirrorRaw = await readBounded(mirrorReal);
            mirrors.push({
              path: mirrorReal,
              relative: path.relative(projectDir, mirrorReal),
              raw: mirrorRaw,
              sha256: sha256Text(mirrorRaw)
            });
          }
        }
      }
    }

    const mirrorConsistent = mirrors.every(item => item.sha256 === sha256);
    return {
      projectId: ensureProjectId(projectId),
      projectDir,
      canonicalPath,
      raw,
      sha256,
      draft,
      mirrors,
      mirrorConsistent,
      mainTimelineId
    };
  }

  async inspect(projectId: string) {
    const loaded = await this.load(projectId);
    return {
      projectId: loaded.projectId,
      sha256: loaded.sha256,
      bytes: Buffer.byteLength(loaded.raw, 'utf8'),
      mainTimelineId: loaded.mainTimelineId,
      mirrorConsistent: loaded.mirrorConsistent,
      mirrors: loaded.mirrors.map(item => ({ relative: item.relative, sha256: item.sha256, bytes: Buffer.byteLength(item.raw, 'utf8') })),
      ...summarize(loaded.draft),
      warnings: lintDraft(loaded.draft)
    };
  }

  async editPlan(projectId: string, expectedSha256: string, operations: CapCutEditOperation[]) {
    if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new Error('expectedSha256 must be a SHA-256 hex digest.');
    const loaded = await this.load(projectId);
    const blockers: string[] = [];
    if (loaded.sha256 !== expectedSha256.toLowerCase()) blockers.push('draft SHA-256 no longer matches expectedSha256');
    if (!loaded.mirrorConsistent) blockers.push('CapCut draft mirrors diverge; refusing to guess the authoritative timeline');
    let running: boolean | undefined;
    try {
      running = (await this.appRunning()).running;
      if (running) blockers.push('CapCut is running; close CapCut before mutation');
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }

    const clone = JSON.parse(JSON.stringify(loaded.draft));
    const applied = applyOperations(clone, operations, loaded.sha256);
    const output = JSON.stringify(clone);
    return {
      ready: blockers.length === 0,
      blockers,
      projectId: loaded.projectId,
      expectedSha256: expectedSha256.toLowerCase(),
      currentSha256: loaded.sha256,
      resultSha256: sha256Text(output),
      mirrorCount: loaded.mirrors.length,
      running,
      operations: operations.map(operation => ({ op: operation.op, segmentId: operation.segmentId })),
      changedSegmentIds: applied.changedSegmentIds,
      result: summarize(clone),
      warnings: applied.warnings
    };
  }

  async edit(projectId: string, expectedSha256: string, expectedResultSha256: string, operations: CapCutEditOperation[]) {
    if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new Error('expectedSha256 must be a SHA-256 hex digest.');
    if (!/^[a-f0-9]{64}$/i.test(expectedResultSha256)) throw new Error('expectedResultSha256 must be a SHA-256 hex digest.');
    const resourceId = `capcut-draft:${ensureProjectId(projectId)}`;
    return await this.resources.withLease(resourceId, 'orchestrating', async () => {
      const processState = await this.appRunning();
      if (processState.running) throw new Error('RESOURCE_BUSY: CapCut is running. Close CapCut before editing a local draft.');

      const loaded = await this.load(projectId);
      if (loaded.sha256 !== expectedSha256.toLowerCase()) throw new Error('CONFLICT: CapCut draft SHA-256 changed since inspection.');
      if (!loaded.mirrorConsistent) throw new Error('CONFLICT: CapCut draft mirrors are not identical.');

      const clone = JSON.parse(JSON.stringify(loaded.draft));
      const applied = applyOperations(clone, operations, loaded.sha256);
      const output = JSON.stringify(clone);
      const resultSha256 = sha256Text(output);
      if (resultSha256 === loaded.sha256) throw new Error('CapCut edit produced no content change.');
      if (resultSha256 !== expectedResultSha256.toLowerCase()) {
        throw new Error('CONFLICT: CapCut planned result SHA-256 does not match the requested typed edit operations.');
      }

      for (const mirror of loaded.mirrors) {
        const current = await readBounded(mirror.path);
        if (sha256Text(current) !== mirror.sha256) throw new Error(`CONFLICT: CapCut mirror changed during edit: ${mirror.relative}`);
      }

      const backupId = `${loaded.projectId}-${Date.now()}-${loaded.sha256.slice(0, 12)}`;
      const backupDir = path.join(this.backupRoot(), backupId);
      await fs.mkdir(backupDir, { recursive: true });
      const manifest = {
        version: 1,
        provider: 'capcut',
        projectId: loaded.projectId,
        sourceSha256: loaded.sha256,
        createdAt: new Date().toISOString(),
        files: [] as Array<{ relative: string; backup: string; sha256: string }>
      };
      for (const mirror of loaded.mirrors) {
        const backupName = mirror.relative.replace(/[\\/]/g, '__');
        const backupFile = path.join(backupDir, backupName);
        await fs.writeFile(backupFile, mirror.raw, { encoding: 'utf8', flag: 'wx' });
        manifest.files.push({ relative: mirror.relative, backup: backupName, sha256: mirror.sha256 });
      }
      await fs.writeFile(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx' });

      const temps: Array<{ target: string; temp: string }> = [];
      try {
        for (const mirror of loaded.mirrors) {
          const temp = `${mirror.path}.rwmcp-${crypto.randomUUID()}.tmp`;
          await fs.writeFile(temp, output, { encoding: 'utf8', flag: 'wx' });
          const check = parseJsonObject(await readBounded(temp), 'CapCut temporary draft');
          lintDraft(check);
          temps.push({ target: mirror.path, temp });
        }
        for (const item of temps) await fs.rename(item.temp, item.target);

        const accepted = await this.load(projectId);
        if (!accepted.mirrorConsistent || accepted.sha256 !== resultSha256) {
          throw new Error('CapCut post-write acceptance failed: draft mirrors did not converge to the planned SHA-256.');
        }
        return {
          projectId: loaded.projectId,
          previousSha256: loaded.sha256,
          sha256: accepted.sha256,
          backupId,
          mirrorCount: accepted.mirrors.length,
          changedSegmentIds: applied.changedSegmentIds,
          operations: operations.map(operation => ({ op: operation.op, segmentId: operation.segmentId })),
          result: summarize(accepted.draft),
          acceptance: {
            schemaValid: true,
            mirrorConsistent: true,
            exactPlannedSha256: accepted.sha256 === expectedResultSha256.toLowerCase(),
            capcutWasClosed: true
          }
        };
      } catch (error) {
        for (const item of temps) await fs.rm(item.temp, { force: true }).catch(() => undefined);
        const rollbackFailures: string[] = [];
        for (const mirror of loaded.mirrors) {
          const rollbackTemp = `${mirror.path}.rwmcp-rollback-${crypto.randomUUID()}.tmp`;
          try {
            await fs.writeFile(rollbackTemp, mirror.raw, { encoding: 'utf8', flag: 'wx' });
            try {
              await fs.rename(rollbackTemp, mirror.path);
            } catch {
              await fs.rm(rollbackTemp, { force: true }).catch(() => undefined);
              await fs.writeFile(mirror.path, mirror.raw, { encoding: 'utf8' });
            }
            const restored = await readBounded(mirror.path);
            if (sha256Text(restored) !== mirror.sha256) rollbackFailures.push(mirror.relative);
          } catch {
            rollbackFailures.push(mirror.relative);
            await fs.rm(rollbackTemp, { force: true }).catch(() => undefined);
          }
        }
        if (rollbackFailures.length > 0) {
          const original = error instanceof Error ? error.message : String(error);
          throw new Error(`${original} ROLLBACK_INCOMPLETE: ${rollbackFailures.join(', ')}. Backup '${backupId}' is retained.`);
        }
        throw error;
      }
    });
  }
}
