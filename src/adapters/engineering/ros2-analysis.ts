export interface Ros2TopicRateSample {
  averageHz?: number;
  minPeriodSeconds?: number;
  maxPeriodSeconds?: number;
  stdDevSeconds?: number;
  window?: number;
  raw: string;
}

export interface Ros2TopicBandwidthSample {
  bytesPerSecond?: number;
  messageCount?: number;
  meanMessageBytes?: number;
  minMessageBytes?: number;
  maxMessageBytes?: number;
  raw: string;
}

export interface Ros2TransformSample {
  translation: { x: number; y: number; z: number };
  rotationQuaternion: { x: number; y: number; z: number; w: number };
  time?: string;
}

function finite(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function unitBytes(value: number, unit: string): number {
  const normalized = unit.toLowerCase();
  const multiplier = normalized === 'b' ? 1
    : normalized === 'kb' ? 1_000
      : normalized === 'mb' ? 1_000_000
        : normalized === 'gb' ? 1_000_000_000
          : normalized === 'kib' ? 1024
            : normalized === 'mib' ? 1024 * 1024
              : normalized === 'gib' ? 1024 * 1024 * 1024
                : 1;
  return value * multiplier;
}

export function parseRos2TopicHz(text: string): Ros2TopicRateSample {
  const raw = text.slice(-16_384);
  const rates = [...raw.matchAll(/average rate:\s*([0-9.+-eE]+)/g)];
  const rate = rates.at(-1)?.[1];
  const stats = [...raw.matchAll(/min:\s*([0-9.+-eE]+)s\s+max:\s*([0-9.+-eE]+)s\s+std dev:\s*([0-9.+-eE]+)s\s+window:\s*(\d+)/g)].at(-1);
  const averageHz = finite(rate);
  const minPeriodSeconds = finite(stats?.[1]);
  const maxPeriodSeconds = finite(stats?.[2]);
  const stdDevSeconds = finite(stats?.[3]);
  const window = stats?.[4] ? Number(stats[4]) : undefined;
  return {
    ...(averageHz !== undefined ? { averageHz } : {}),
    ...(minPeriodSeconds !== undefined ? { minPeriodSeconds } : {}),
    ...(maxPeriodSeconds !== undefined ? { maxPeriodSeconds } : {}),
    ...(stdDevSeconds !== undefined ? { stdDevSeconds } : {}),
    ...(Number.isInteger(window) ? { window } : {}),
    raw
  };
}

export function parseRos2TopicBandwidth(text: string): Ros2TopicBandwidthSample {
  const raw = text.slice(-16_384);
  const throughputMatches = [...raw.matchAll(/([0-9.]+)\s*(B|KB|MB|GB|KiB|MiB|GiB)\/s\s+from\s+(\d+)\s+messages?/gi)];
  const throughput = throughputMatches.at(-1);
  const messageMatches = [...raw.matchAll(/Message size mean:\s*([0-9.]+)\s*(B|KB|MB|GB|KiB|MiB|GiB)\s+min:\s*([0-9.]+)\s*(B|KB|MB|GB|KiB|MiB|GiB)\s+max:\s*([0-9.]+)\s*(B|KB|MB|GB|KiB|MiB|GiB)/gi)];
  const sizes = messageMatches.at(-1);
  const bytesPerSecond = throughput ? unitBytes(Number(throughput[1]), throughput[2]!) : undefined;
  const messageCount = throughput?.[3] ? Number(throughput[3]) : undefined;
  const meanMessageBytes = sizes ? unitBytes(Number(sizes[1]), sizes[2]!) : undefined;
  const minMessageBytes = sizes ? unitBytes(Number(sizes[3]), sizes[4]!) : undefined;
  const maxMessageBytes = sizes ? unitBytes(Number(sizes[5]), sizes[6]!) : undefined;
  return {
    ...(bytesPerSecond !== undefined ? { bytesPerSecond } : {}),
    ...(Number.isInteger(messageCount) ? { messageCount } : {}),
    ...(meanMessageBytes !== undefined ? { meanMessageBytes } : {}),
    ...(minMessageBytes !== undefined ? { minMessageBytes } : {}),
    ...(maxMessageBytes !== undefined ? { maxMessageBytes } : {}),
    raw
  };
}

export function parseTf2Echo(text: string): Ros2TransformSample | undefined {
  const raw = text.slice(-32_768);
  const blocks = [...raw.matchAll(/(?:At time\s+([^\r\n]+)[\r\n]+)?- Translation:\s*\[\s*([-+0-9.eE]+),\s*([-+0-9.eE]+),\s*([-+0-9.eE]+)\s*\][\s\S]*?- Rotation:\s*in Quaternion\s*\[\s*([-+0-9.eE]+),\s*([-+0-9.eE]+),\s*([-+0-9.eE]+),\s*([-+0-9.eE]+)\s*\]/g)];
  const match = blocks.at(-1);
  if (!match) return undefined;
  const values = match.slice(2, 9).map(value => Number(value));
  if (values.some(value => !Number.isFinite(value))) return undefined;
  return {
    translation: { x: values[0]!, y: values[1]!, z: values[2]! },
    rotationQuaternion: { x: values[3]!, y: values[4]!, z: values[5]!, w: values[6]! },
    ...(match[1]?.trim() ? { time: match[1].trim().slice(0, 128) } : {})
  };
}

export function parseRos2LifecycleState(text: string): { label?: string; id?: number; raw: string } {
  const raw = text.trim().slice(-4096);
  const match = /^(.+?)\s*\[([0-9]+)\]\s*$/m.exec(raw);
  if (!match) return { raw };
  const id = Number(match[2]);
  return { label: match[1]!.trim().slice(0, 128), ...(Number.isInteger(id) ? { id } : {}), raw };
}
