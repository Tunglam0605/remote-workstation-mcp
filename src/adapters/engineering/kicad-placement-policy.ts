import type { KicadPlacementHint, KicadPlacementRole } from './kicad-semantic-placement.js';
import type { KicadDesignFunctionalBlockIntent, KicadElectronicDesignIntent } from './kicad-design-intent.js';

export interface KicadPlacementPolicyFinding {
  severity: 'error' | 'review' | 'info';
  code: string;
  subject: string;
  message: string;
}

function normalize(value: string): string {
  return value.trim().toUpperCase();
}

function roleForDevice(role: KicadElectronicDesignIntent['devices'][number]['role']): KicadPlacementRole {
  switch (role) {
    case 'mcu':
    case 'processor':
      return 'mcu';
    case 'power':
      return 'power';
    case 'transceiver':
      return 'transceiver';
    case 'driver':
      return 'driver';
    case 'sensor':
      return 'sensor';
    case 'connector':
      return 'connector';
    case 'clock':
      return 'crystal';
    default:
      return 'generic';
  }
}

function edgeForRegion(region: KicadDesignFunctionalBlockIntent['preferredRegion']): KicadPlacementHint['edge'] | undefined {
  switch (region) {
    case 'power-entry': return 'left';
    case 'connector-edge': return 'right';
    case 'edge': return 'right';
    case 'analog': return 'bottom';
    default: return undefined;
  }
}

function anchorRank(role: KicadPlacementRole): number {
  switch (role) {
    case 'mcu': return 100;
    case 'connector':
    case 'debug': return 90;
    case 'power': return 80;
    case 'transceiver':
    case 'driver': return 70;
    case 'sensor': return 50;
    default: return 10;
  }
}

export function deriveKicadPlacementHints(intent: KicadElectronicDesignIntent) {
  const findings: KicadPlacementPolicyFinding[] = [];
  const deviceByRef = new Map(intent.devices.map(device => [normalize(device.reference), device]));
  const hints = new Map<string, KicadPlacementHint>();

  for (const device of intent.devices) {
    hints.set(normalize(device.reference), {
      reference: device.reference,
      role: roleForDevice(device.role)
    });
  }

  for (const iface of intent.interfaces ?? []) {
    if (iface.kind !== 'debug') continue;
    for (const ref of iface.deviceRefs ?? []) {
      const device = deviceByRef.get(normalize(ref));
      if (!device) continue;
      if (device.role === 'connector') {
        hints.set(normalize(ref), { ...hints.get(normalize(ref))!, reference: device.reference, role: 'debug' });
      }
    }
  }

  const seenBlockDevices = new Map<string, string>();
  for (const block of intent.functionalBlocks ?? []) {
    const members = block.deviceRefs
      .map(ref => deviceByRef.get(normalize(ref)))
      .filter((device): device is NonNullable<typeof device> => Boolean(device));

    for (const ref of block.deviceRefs) {
      if (!deviceByRef.has(normalize(ref))) {
        findings.push({
          severity: 'error',
          code: 'placement-block-device-missing',
          subject: block.id,
          message: `Functional block ${block.id} references unknown placement device ${ref}.`
        });
      }
      const previous = seenBlockDevices.get(normalize(ref));
      if (previous && previous !== block.id) {
        findings.push({
          severity: 'review',
          code: 'placement-device-multi-block',
          subject: ref,
          message: `Device ${ref} belongs to both functional blocks ${previous} and ${block.id}; anchor precedence uses the first block.`
        });
      } else if (!previous) {
        seenBlockDevices.set(normalize(ref), block.id);
      }
    }

    if (!members.length) continue;
    const edge = edgeForRegion(block.preferredRegion);
    const anchor = [...members]
      .sort((a, b) => anchorRank(roleForDevice(b.role)) - anchorRank(roleForDevice(a.role)) || a.reference.localeCompare(b.reference))[0]!;

    for (const device of members) {
      const key = normalize(device.reference);
      const existing = hints.get(key)!;
      const patch: KicadPlacementHint = {
        ...existing,
        reference: device.reference,
        ...(edge && (existing.role === 'connector' || existing.role === 'debug') ? { edge } : {})
      };
      if (block.keepTogether && normalize(device.reference) !== normalize(anchor.reference)) {
        patch.anchorRef = anchor.reference;
      }
      hints.set(key, patch);
    }

    if (block.keepTogether && members.length > 1) {
      findings.push({
        severity: 'info',
        code: 'placement-functional-block-anchor',
        subject: block.id,
        message: `Functional block ${block.id} is anchored around ${anchor.reference}; connectivity/pad-aware placement remains authoritative for exact coordinates.`
      });
    }
  }

  for (const iface of intent.interfaces ?? []) {
    const refs = (iface.deviceRefs ?? [])
      .map(ref => deviceByRef.get(normalize(ref)))
      .filter((device): device is NonNullable<typeof device> => Boolean(device));
    const connector = refs.find(device => device.role === 'connector');
    if (!connector) continue;
    for (const device of refs) {
      if (device.role !== 'transceiver' && device.role !== 'protection') continue;
      const key = normalize(device.reference);
      const existing = hints.get(key)!;
      if (!existing.anchorRef) hints.set(key, { ...existing, reference: device.reference, anchorRef: connector.reference });
    }
  }

  const counts = { error: 0, review: 0, info: 0 };
  for (const finding of findings) counts[finding.severity]++;

  return {
    schemaVersion: 1 as const,
    ready: counts.error === 0,
    hints: [...hints.values()].sort((a, b) => a.reference.localeCompare(b.reference, undefined, { numeric: true })),
    findings,
    counts,
    assumptions: {
      exactCoordinatesDelegatedToSemanticPlanner: true,
      pinAwarePadGeometryPreserved: true,
      heuristicFallbackPreserved: true
    }
  };
}
