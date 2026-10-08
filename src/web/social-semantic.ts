import type { SemanticRole } from './browser-provider.js';
import type { SocialPlatform } from './domain-policy.js';

export interface SocialSemanticElement {
  elementId: string;
  role: SemanticRole;
  name: string;
  visible: boolean;
  enabled: boolean;
  value?: string;
}

export type SocialSemanticField = 'title' | 'description' | 'playlist' | 'schedule-time';

const FIELD_ALIASES: Record<SocialPlatform, Record<Exclude<SocialSemanticField, 'schedule-time'>, string[]>> = {
  youtube: {
    title: ['title (required)', 'tiêu đề (bắt buộc)', 'title', 'tiêu đề'],
    description: ['description', 'mô tả'],
    playlist: ['playlist', 'danh sách phát']
  },
  tiktok: {
    title: ['title', 'tiêu đề'],
    description: ['caption', 'description', 'mô tả', 'chú thích'],
    playlist: ['playlist', 'collection', 'danh sách phát', 'bộ sưu tập']
  }
};

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('vi-VN').replace(/\s+/g, ' ');
}

function aliasScore(name: string, aliases: string[]): number {
  const normalized = normalize(name);
  let best = 0;
  for (const alias of aliases) {
    const target = normalize(alias);
    if (normalized === target) best = Math.max(best, 1000 + target.length);
    else if (normalized.includes(target)) best = Math.max(best, 500 + target.length);
    else if (target.includes(normalized) && normalized.length >= 4) best = Math.max(best, 100 + normalized.length);
  }
  return best;
}

export function findSocialSemanticField(
  platform: SocialPlatform,
  elements: SocialSemanticElement[],
  field: SocialSemanticField
): { element?: SocialSemanticElement; ambiguous: boolean; candidates: SocialSemanticElement[] } {
  const visible = elements.filter(item => item.visible && item.enabled);
  if (field === 'schedule-time') {
    const candidates = visible.filter(item =>
      (item.role === 'textbox' || item.role === 'combobox') &&
      typeof item.value === 'string' &&
      /^\d{1,2}:\d{2}$/.test(item.value.trim())
    );
    return { element: candidates.length === 1 ? candidates[0] : undefined, ambiguous: candidates.length > 1, candidates };
  }

  const allowedRoles: SemanticRole[] = field === 'playlist'
    ? ['combobox', 'button']
    : ['textbox', 'combobox'];
  const aliases = FIELD_ALIASES[platform][field];
  const scored = visible
    .filter(item => allowedRoles.includes(item.role))
    .map(item => ({ item, score: aliasScore(item.name, aliases) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  if (!scored.length) return { ambiguous: false, candidates: [] };
  const topScore = scored[0]!.score;
  const top = scored.filter(item => item.score === topScore).map(item => item.item);
  return {
    element: top.length === 1 ? top[0] : undefined,
    ambiguous: top.length > 1,
    candidates: scored.map(item => item.item)
  };
}

function localScheduleParts(scheduleAt: string, timezone: string) {
  const instant = new Date(scheduleAt);
  if (!Number.isFinite(instant.getTime())) throw new Error('scheduleAt must be a valid offset-aware timestamp.');
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(instant);
  } catch {
    throw new Error(`Unsupported schedule timezone '${timezone}'.`);
  }
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value;
  const year = get('year'), month = get('month'), day = get('day'), hour = get('hour'), minute = get('minute');
  if (!year || !month || !day || hour === undefined || minute === undefined) throw new Error('Unable to format schedule timestamp.');
  return { year, month, day, date: `${year}-${month}-${day}`, time: `${hour}:${minute}`, instant };
}

function dateCandidates(scheduleAt: string, timezone: string): string[] {
  const local = localScheduleParts(scheduleAt, timezone);
  const vi = new Intl.DateTimeFormat('vi-VN', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric' }).format(local.instant);
  const enShort = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: 'short', day: 'numeric' }).format(local.instant);
  const enLong = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: 'long', day: 'numeric' }).format(local.instant);
  return [
    local.date,
    `${local.day}/${local.month}/${local.year}`,
    `${Number(local.day)}/${Number(local.month)}/${local.year}`,
    vi,
    enShort,
    enLong,
    `${Number(local.day)} thg ${Number(local.month)}, ${local.year}`,
    `${Number(local.day)} tháng ${Number(local.month)}, ${local.year}`
  ].map(normalize);
}

export function auditSocialSchedule(input: {
  platform: SocialPlatform;
  scheduleAt: string;
  timezone: string;
  text: string;
  elements: SocialSemanticElement[];
}) {
  const expected = localScheduleParts(input.scheduleAt, input.timezone);
  const timeField = findSocialSemanticField(input.platform, input.elements, 'schedule-time');
  const actualTime = timeField.element?.value?.trim();
  const timeStatus: 'match' | 'mismatch' | 'unknown' = actualTime === undefined
    ? 'unknown'
    : actualTime === expected.time
      ? 'match'
      : 'mismatch';

  const normalizedText = normalize(input.text);
  const candidates = dateCandidates(input.scheduleAt, input.timezone);
  const matchedDateText = candidates.find(candidate => candidate && normalizedText.includes(candidate));
  const dateStatus: 'match' | 'unknown' = matchedDateText ? 'match' : 'unknown';

  return {
    platform: input.platform,
    expected: { date: expected.date, time: expected.time, timezone: input.timezone },
    observed: {
      time: actualTime,
      timeElementId: timeField.element?.elementId,
      timeElementName: timeField.element?.name,
      matchedDateText
    },
    status: {
      time: timeStatus,
      date: dateStatus,
      verified: timeStatus === 'match' && dateStatus === 'match'
    },
    blockers: [
      ...(timeField.ambiguous ? ['schedule-time-control-ambiguous'] : []),
      ...(!timeField.element ? ['schedule-time-value-unavailable'] : []),
      ...(dateStatus === 'unknown' ? ['schedule-date-not-observed-in-visible-text'] : [])
    ]
  };
}


export function composeSocialDescription(platform: SocialPlatform, description: string | undefined, hashtags: string[] = []): string | undefined {
  const body = description?.trim() ?? '';
  const tags = [...new Set(hashtags.map(value => value.trim()).filter(Boolean).map(value => value.startsWith('#') ? value : `#${value}`))];
  const tagText = tags.join(' ');
  const combined = platform === 'youtube'
    ? [body, tagText].filter(Boolean).join(body && tagText ? '\n\n' : '')
    : [body, tagText].filter(Boolean).join(' ');
  if (!combined) return undefined;
  if (combined.length > 8_000) throw new Error('SOCIAL_METADATA_TOO_LONG: composed description/caption exceeds 8000 characters.');
  return combined;
}

export function auditSocialMetadata(input: {
  platform: SocialPlatform;
  expected: { title?: string; description?: string; playlist?: string };
  elements: SocialSemanticElement[];
}) {
  const checks: Array<{
    field: 'title' | 'description' | 'playlist';
    expected: string;
    actual?: string;
    status: 'match' | 'mismatch' | 'unknown';
    elementId?: string;
  }> = [];

  const inspectField = (field: 'title' | 'description' | 'playlist', expected: string) => {
    const found = findSocialSemanticField(input.platform, input.elements, field);
    const actual = found.element?.value?.trim();
    const normalizedExpected = normalize(expected);
    const normalizedActual = actual === undefined ? undefined : normalize(actual);
    const status: 'match' | 'mismatch' | 'unknown' = actual === undefined
      ? 'unknown'
      : normalizedActual === normalizedExpected
        ? 'match'
        : 'mismatch';
    checks.push({
      field,
      expected,
      ...(actual !== undefined ? { actual } : {}),
      status,
      ...(found.element ? { elementId: found.element.elementId } : {})
    });
    return {
      ambiguous: found.ambiguous,
      missing: !found.element,
      status
    };
  };

  const states = [
    ...(input.expected.title !== undefined ? [{ field: 'title' as const, state: inspectField('title', input.expected.title) }] : []),
    ...(input.expected.description !== undefined ? [{ field: 'description' as const, state: inspectField('description', input.expected.description) }] : []),
    ...(input.expected.playlist !== undefined ? [{ field: 'playlist' as const, state: inspectField('playlist', input.expected.playlist) }] : [])
  ];

  const blockers = states.flatMap(({ field, state }) => [
    ...(state.ambiguous ? [`${field}-control-ambiguous`] : []),
    ...(state.missing ? [`${field}-value-unavailable`] : [])
  ]);

  return {
    platform: input.platform,
    checks,
    verified: checks.length > 0 && checks.every(item => item.status === 'match'),
    blockers
  };
}
