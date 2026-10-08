import type { KicadElectronicDesignIntent } from './kicad-design-intent.js';

export interface KicadRoutingNetClassPolicy {
  name: string;
  nets: string[];
  clearanceMm?: number;
  trackWidthMm?: number;
  viaDiameterMm?: number;
  viaDrillMm?: number;
  diffPairWidthMm?: number;
  diffPairGapMm?: number;
  rationale: string[];
  evidence: 'explicit-intent' | 'engineering-heuristic';
}

export interface KicadRoutingStylePolicy {
  netName: string;
  widthMm?: number;
  clearanceMm?: number;
  preferredLayer?: string;
  priority?: number;
  rationale: string[];
}

export interface KicadDifferentialRoutingPolicy {
  interfaceId: string;
  nets: [string, string];
  targetImpedanceOhm?: number;
  controlledImpedanceEvidenceRequired: boolean;
  lengthMatchReview: boolean;
  returnPathReview: boolean;
  rationale: string[];
}

export interface KicadRoutingPolicyFinding {
  severity: 'error' | 'review' | 'info';
  code: string;
  subject: string;
  message: string;
}

function boundedMm(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0.05 || resolved > 20) {
    throw new Error(`${label} must be between 0.05 and 20 mm.`);
  }
  return resolved;
}

function normalizedUnique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function powerWidthHeuristic(currentBudgetA: number | undefined): { widthMm: number; review: boolean; rationale: string } {
  if (currentBudgetA === undefined) {
    return {
      widthMm: 0.5,
      review: true,
      rationale: 'Power-rail width is a conservative placeholder because no rail current budget was supplied; ampacity is not certified.'
    };
  }
  if (!Number.isFinite(currentBudgetA) || currentBudgetA <= 0) {
    throw new Error('Power-rail current budget must be a finite positive number when present.');
  }
  if (currentBudgetA <= 0.2) return { widthMm: 0.25, review: false, rationale: 'Low-current power heuristic only; not an IPC-2152 ampacity claim.' };
  if (currentBudgetA <= 0.5) return { widthMm: 0.4, review: false, rationale: 'Moderate-current power heuristic only; not an IPC-2152 ampacity claim.' };
  if (currentBudgetA <= 1) return { widthMm: 0.6, review: true, rationale: 'Power width needs copper-weight/temperature-rise verification before release.' };
  if (currentBudgetA <= 2) return { widthMm: 1.0, review: true, rationale: 'High-current route needs copper-weight/temperature-rise verification and should prefer pours/planes where practical.' };
  return { widthMm: 1.5, review: true, rationale: 'Very high current requires explicit ampacity/thermal review and likely copper pours/planes; this width is not a release value.' };
}

function isDifferentialKind(kind: string): boolean {
  return kind === 'can' || kind === 'rs485' || kind === 'usb' || kind === 'ethernet';
}

function pairSignals(signals: string[]): [string, string] | undefined {
  const values = normalizedUnique(signals);
  if (values.length !== 2) return undefined;
  return [values[0]!, values[1]!];
}

function className(prefix: string, subject: string): string {
  return `${prefix}_${subject.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase().slice(0, 48) || 'NET'}`;
}

export function deriveKicadRoutingPolicy(intent: KicadElectronicDesignIntent) {
  const findings: KicadRoutingPolicyFinding[] = [];
  const netClasses: KicadRoutingNetClassPolicy[] = [];
  const styles: KicadRoutingStylePolicy[] = [];
  const differentialPairs: KicadDifferentialRoutingPolicy[] = [];
  const defaultClearanceMm = boundedMm(intent.board?.minimumClearanceMm, 0.2, 'Board minimum clearance');
  const copperLayers = intent.board?.copperLayers;

  for (const rail of intent.rails) {
    if (rail.isGround) continue;
    const width = powerWidthHeuristic(rail.currentBudgetA);
    netClasses.push({
      name: className('POWER', rail.name),
      nets: [rail.name],
      clearanceMm: defaultClearanceMm,
      trackWidthMm: width.widthMm,
      rationale: [width.rationale],
      evidence: 'engineering-heuristic'
    });
    styles.push({
      netName: rail.name,
      widthMm: width.widthMm,
      clearanceMm: defaultClearanceMm,
      priority: 500,
      rationale: [width.rationale, 'Route power before general signals and keep the source/load current loop compact.']
    });
    if (width.review) {
      findings.push({
        severity: 'review',
        code: 'power-ampacity-review-required',
        subject: rail.name,
        message: `Rail ${rail.name} requires copper-weight, temperature-rise, via-current and thermal verification before release.`
      });
    }
  }

  for (const device of intent.devices) {
    for (const clock of device.clocks ?? []) {
      if (clock.source === 'internal') continue;
      styles.push({
        netName: clock.name,
        widthMm: 0.25,
        clearanceMm: Math.max(defaultClearanceMm, 0.2),
        priority: 700,
        rationale: [
          'Clock routes should be short/direct, avoid unnecessary vias, and preserve a continuous nearby return path.',
          'Width is a routing default, not an impedance claim.'
        ]
      });
      findings.push({
        severity: 'review',
        code: 'clock-return-path-review',
        subject: clock.name,
        message: `Clock ${clock.name} requires package-pin-aware placement and return-path review.`
      });
    }
  }

  for (const item of intent.interfaces ?? []) {
    const signals = normalizedUnique(item.signals);
    const highSpeedKind = item.kind === 'usb' || item.kind === 'ethernet';
    const analogKind = item.kind === 'analog';
    const differential = isDifferentialKind(item.kind) ? pairSignals(signals) : undefined;
    const priority = highSpeedKind ? 650 : differential ? 550 : analogKind ? 600 : item.kind === 'debug' ? 250 : 200;
    const widthMm = analogKind ? 0.3 : 0.25;
    const clearanceMm = analogKind ? Math.max(defaultClearanceMm, 0.25) : defaultClearanceMm;

    if (signals.length) {
      netClasses.push({
        name: className(item.kind.toUpperCase(), item.id),
        nets: signals,
        clearanceMm,
        trackWidthMm: widthMm,
        rationale: [
          `${item.kind.toUpperCase()} routing policy derived from explicit design intent.`,
          highSpeedKind ? 'High-speed dimensions remain provisional until stackup/manufacturer evidence exists.' : 'Dimensions are generic routing defaults, not a signal-integrity certification.'
        ],
        evidence: item.targetImpedanceOhm !== undefined ? 'explicit-intent' : 'engineering-heuristic'
      });
      for (const netName of signals) {
        styles.push({
          netName,
          widthMm,
          clearanceMm,
          priority,
          rationale: analogKind
            ? ['Keep sensitive analog routes short, separated from fast switching nets, and reference a quiet continuous return path.']
            : highSpeedKind
              ? ['Keep the interface compact, minimize layer changes, and preserve continuous return geometry.']
              : differential
                ? ['Route the pair coherently and avoid asymmetric stubs/layer transitions where practical.']
                : ['General interface routing policy derived from design intent.']
        });
      }
    }

    if (differential) {
      const target = item.targetImpedanceOhm;
      differentialPairs.push({
        interfaceId: item.id,
        nets: differential,
        ...(target !== undefined ? { targetImpedanceOhm: target } : {}),
        controlledImpedanceEvidenceRequired: target !== undefined || highSpeedKind,
        lengthMatchReview: highSpeedKind,
        returnPathReview: true,
        rationale: [
          target !== undefined
            ? `Target impedance ${target} ohm is explicit intent; width/gap must come from the real stackup/field solver or board manufacturer, not a hard-coded formula.`
            : 'No controlled-impedance value is synthesized from memory.',
          'Pair routing must preserve coherent geometry and a continuous return path.'
        ]
      });

      if (target !== undefined) {
        if (!Number.isFinite(target) || target <= 0 || target > 1000) {
          findings.push({ severity: 'error', code: 'invalid-target-impedance', subject: item.id, message: `Interface ${item.id} has invalid target impedance ${target}.` });
        } else {
          findings.push({
            severity: 'review',
            code: 'controlled-impedance-evidence-required',
            subject: item.id,
            message: `Interface ${item.id} declares ${target} ohm; stackup/manufacturer or field-solver evidence is required before diff-pair width/gap is release-authoritative.`
          });
        }
      } else if (highSpeedKind) {
        findings.push({
          severity: 'review',
          code: 'high-speed-impedance-intent-missing',
          subject: item.id,
          message: `High-speed ${item.kind.toUpperCase()} interface ${item.id} has no explicit target impedance in design intent.`
        });
      }
      if ((copperLayers ?? 2) < 4 && highSpeedKind) {
        findings.push({
          severity: 'review',
          code: 'high-speed-two-layer-return-path-review',
          subject: item.id,
          message: `High-speed interface ${item.id} on a ${copperLayers ?? 2}-layer board needs explicit return-path/stackup review.`
        });
      }
    }

    if (item.isolated) {
      findings.push({
        severity: 'review',
        code: 'isolation-clearance-review',
        subject: item.id,
        message: `Isolated interface ${item.id} requires creepage/clearance rules derived from voltage, pollution degree, material group and applicable safety standard before release.`
      });
    }
  }

  const byNet = new Map<string, KicadRoutingStylePolicy>();
  for (const style of styles.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))) {
    const key = style.netName.toUpperCase();
    if (!byNet.has(key)) byNet.set(key, style);
  }

  const counts = { error: 0, review: 0, info: 0 };
  for (const finding of findings) counts[finding.severity]++;

  return {
    schemaVersion: 1 as const,
    ready: counts.error === 0,
    assumptions: {
      defaultClearanceMm,
      copperLayers: copperLayers ?? null,
      controlledImpedanceSynthesized: false,
      ampacityCertified: false
    },
    netClasses,
    routeStyles: [...byNet.values()],
    differentialPairs,
    findings,
    counts
  };
}
