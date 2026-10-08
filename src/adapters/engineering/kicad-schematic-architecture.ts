import type {
  KicadDevicePinPlan,
  KicadElectronicDesignIntent
} from './kicad-design-intent.js';

export type KicadSchematicArchitectureRequirementKind =
  | 'power-source'
  | 'bulk-decoupling'
  | 'local-decoupling'
  | 'clock-network'
  | 'reset-network'
  | 'debug-connector'
  | 'interface-protection'
  | 'interface-termination'
  | 'interface-isolation';

export interface KicadSchematicArchitectureRequirement {
  id: string;
  kind: KicadSchematicArchitectureRequirementKind;
  subject: string;
  required: boolean;
  rationale: string;
  nets: string[];
  deviceRefs: string[];
  placement?: 'near-device-pins' | 'power-entry' | 'connector-edge' | 'functional-block';
}

export interface KicadSchematicArchitectureFinding {
  severity: 'error' | 'review' | 'info';
  code: string;
  subject: string;
  message: string;
}

function normalize(value: string): string {
  return value.trim().replace(/^\/+/, '').toUpperCase();
}

export function planKicadSchematicArchitecture(
  intent: KicadElectronicDesignIntent,
  pinPlans: KicadDevicePinPlan[] = []
) {
  const requirements: KicadSchematicArchitectureRequirement[] = [];
  const findings: KicadSchematicArchitectureFinding[] = [];
  const groundRails = new Set(intent.rails.filter(rail => rail.isGround).map(rail => normalize(rail.name)));
  const pinPlanByDevice = new Map(pinPlans.map(plan => [normalize(plan.deviceRef), plan]));

  for (const rail of intent.rails) {
    if (rail.isGround) continue;
    requirements.push({
      id: `rail:${rail.name}:bulk`,
      kind: 'bulk-decoupling',
      subject: rail.name,
      required: true,
      rationale: 'Each non-ground rail needs explicit bulk/local energy storage sized for its source, load step and stability requirements.',
      nets: [rail.name, ...intent.rails.filter(item => item.isGround).map(item => item.name)],
      deviceRefs: intent.devices.filter(device => (device.supplyRails ?? []).some(name => normalize(name) === normalize(rail.name))).map(device => device.reference),
      placement: rail.source === 'external' ? 'power-entry' : 'functional-block'
    });
    requirements.push({
      id: `rail:${rail.name}:source`,
      kind: 'power-source',
      subject: rail.name,
      required: true,
      rationale: `Rail ${rail.name} must have an explicit source/protection/regulation path matching the declared '${rail.source}' source type.`,
      nets: [rail.name],
      deviceRefs: intent.devices.filter(device => device.role === 'power').map(device => device.reference),
      placement: rail.source === 'external' ? 'power-entry' : 'functional-block'
    });
  }

  for (const device of intent.devices) {
    const nonGroundRails = (device.supplyRails ?? []).filter(name => !groundRails.has(normalize(name)));
    if (device.role === 'mcu' || device.role === 'processor') {
      const plan = pinPlanByDevice.get(normalize(device.reference));
      for (const rail of nonGroundRails) {
        requirements.push({
          id: `device:${device.reference}:decoupling:${rail}`,
          kind: 'local-decoupling',
          subject: device.reference,
          required: true,
          rationale: `Programmable device ${device.reference} requires local high-frequency decoupling at each relevant supply pin plus local bulk support for rail ${rail}.`,
          nets: [rail, ...intent.rails.filter(item => item.isGround).map(item => item.name)],
          deviceRefs: [device.reference],
          placement: 'near-device-pins'
        });
      }
      requirements.push({
        id: `device:${device.reference}:reset`,
        kind: 'reset-network',
        subject: device.reference,
        required: true,
        rationale: 'Reset/boot behavior must be deterministic during power-up, programming and brownout conditions.',
        nets: device.debug?.resetSignal ? [device.debug.resetSignal] : [],
        deviceRefs: [device.reference],
        placement: 'near-device-pins'
      });
      if (device.debug?.connectorRequired) {
        requirements.push({
          id: `device:${device.reference}:debug`,
          kind: 'debug-connector',
          subject: device.reference,
          required: true,
          rationale: `${device.debug.interface.toUpperCase()} programming/debug access must remain electrically and mechanically accessible.`,
          nets: plan?.assignments.filter(item => /(?:SWD|JTAG|JTCK|JTMS|SWCLK|SWDIO)/i.test(item.peripheralSignal ?? item.logicalSignal)).map(item => item.logicalSignal) ?? [],
          deviceRefs: [device.reference],
          placement: 'connector-edge'
        });
      }
      for (const clock of device.clocks ?? []) {
        if (clock.source === 'internal') continue;
        requirements.push({
          id: `device:${device.reference}:clock:${clock.name}`,
          kind: 'clock-network',
          subject: device.reference,
          required: true,
          rationale: `${clock.source} clock ${clock.name} at ${clock.frequencyHz} Hz needs a complete source/load/return-path network and tight placement near the package clock pins.`,
          nets: [clock.name],
          deviceRefs: [device.reference],
          placement: 'near-device-pins'
        });
      }
      if (!plan) {
        findings.push({
          severity: 'error',
          code: 'architecture-pin-plan-missing',
          subject: device.reference,
          message: `Schematic architecture for ${device.reference} cannot bind clock/debug/reset/supply intent to package pins without a pin plan.`
        });
      }
    }
  }

  for (const item of intent.interfaces ?? []) {
    if (item.external) {
      requirements.push({
        id: `interface:${item.id}:protection`,
        kind: 'interface-protection',
        subject: item.id,
        required: item.protectionRequired !== false,
        rationale: `External ${item.kind.toUpperCase()} signals require connector-side ESD/transient/current-limiting protection appropriate to the interface and environment.`,
        nets: [...item.signals],
        deviceRefs: [...(item.deviceRefs ?? [])],
        placement: 'connector-edge'
      });
    }
    if (item.terminationRequired) {
      requirements.push({
        id: `interface:${item.id}:termination`,
        kind: 'interface-termination',
        subject: item.id,
        required: true,
        rationale: `${item.kind.toUpperCase()} interface termination/bias must be explicit and placed relative to the bus endpoint/topology.`,
        nets: [...item.signals],
        deviceRefs: [...(item.deviceRefs ?? [])],
        placement: 'connector-edge'
      });
    }
    if (item.isolated) {
      requirements.push({
        id: `interface:${item.id}:isolation`,
        kind: 'interface-isolation',
        subject: item.id,
        required: true,
        rationale: `Isolated ${item.kind.toUpperCase()} interface requires explicit isolation barrier, isolated power and clearance/creepage intent.`,
        nets: [...item.signals],
        deviceRefs: [...(item.deviceRefs ?? [])],
        placement: 'functional-block'
      });
    }
  }

  const counts = requirements.reduce<Record<string, number>>((acc, item) => {
    acc[item.kind] = (acc[item.kind] ?? 0) + 1;
    return acc;
  }, {});

  return {
    schemaVersion: 1 as const,
    requirements,
    counts,
    findings,
    ready: !findings.some(item => item.severity === 'error')
  };
}

export function validateKicadSchematicArchitectureCoverage(input: {
  intent: KicadElectronicDesignIntent;
  pinPlans?: KicadDevicePinPlan[];
  componentReferences: string[];
  netNames: string[];
}) {
  const plan = planKicadSchematicArchitecture(input.intent, input.pinPlans ?? []);
  const components = new Set(input.componentReferences.map(normalize));
  const nets = new Set(input.netNames.map(normalize));
  const findings: KicadSchematicArchitectureFinding[] = [...plan.findings];

  for (const device of input.intent.devices) {
    if (!components.has(normalize(device.reference))) {
      findings.push({
        severity: 'error',
        code: 'architecture-device-missing-from-schematic',
        subject: device.reference,
        message: `Design-intent device ${device.reference} is missing from the typed schematic component list.`
      });
    }
    for (const signal of device.requiredSignals ?? []) {
      if (!nets.has(normalize(signal))) {
        findings.push({
          severity: 'error',
          code: 'architecture-required-signal-net-missing',
          subject: device.reference,
          message: `Required signal ${signal} for ${device.reference} has no typed schematic net.`
        });
      }
    }
    for (const rail of device.supplyRails ?? []) {
      if (!nets.has(normalize(rail))) {
        findings.push({
          severity: 'error',
          code: 'architecture-supply-net-missing',
          subject: device.reference,
          message: `Supply rail ${rail} for ${device.reference} has no typed schematic net.`
        });
      }
    }
  }

  for (const item of input.intent.interfaces ?? []) {
    for (const signal of item.signals) {
      if (!nets.has(normalize(signal))) {
        findings.push({
          severity: 'error',
          code: 'architecture-interface-net-missing',
          subject: item.id,
          message: `Interface signal ${signal} for ${item.id} has no typed schematic net.`
        });
      }
    }
  }

  const counts = { error: 0, review: 0, info: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return {
    schemaVersion: 1 as const,
    valid: counts.error === 0,
    counts,
    findings,
    plan
  };
}
