import type { Stm32PinAssignment } from './stm32-cubemx-pin-db.js';

export type KicadInterfaceKind =
  | 'can'
  | 'rs485'
  | 'uart'
  | 'spi'
  | 'i2c'
  | 'usb'
  | 'ethernet'
  | 'pwm'
  | 'encoder'
  | 'analog'
  | 'digital'
  | 'debug'
  | 'custom';

export type KicadDeviceRole =
  | 'mcu'
  | 'processor'
  | 'power'
  | 'transceiver'
  | 'driver'
  | 'sensor'
  | 'memory'
  | 'connector'
  | 'protection'
  | 'clock'
  | 'other';

export interface KicadDesignRailIntent {
  name: string;
  nominalVoltageV: number;
  currentBudgetA?: number;
  source: 'external' | 'regulator' | 'reference' | 'battery' | 'derived';
  isGround?: boolean;
}

export interface KicadDesignClockIntent {
  name: string;
  frequencyHz: number;
  source: 'crystal' | 'oscillator' | 'external' | 'internal';
  tolerancePpm?: number;
  critical?: boolean;
}

export interface KicadDesignDebugIntent {
  interface: 'swd' | 'jtag' | 'c2' | 'custom';
  preservePins?: boolean;
  connectorRequired?: boolean;
  resetSignal?: string;
}

export interface KicadDesignDeviceIntent {
  reference: string;
  role: KicadDeviceRole;
  partNumber?: string;
  package?: string;
  supplyRails?: string[];
  requiredSignals?: string[];
  reservedPins?: string[];
  clocks?: KicadDesignClockIntent[];
  debug?: KicadDesignDebugIntent;
  notes?: string[];
}

export interface KicadDesignInterfaceIntent {
  id: string;
  kind: KicadInterfaceKind;
  signals: string[];
  deviceRefs?: string[];
  external?: boolean;
  nominalBitrate?: number;
  targetImpedanceOhm?: number;
  terminationRequired?: boolean;
  protectionRequired?: boolean;
  isolated?: boolean;
}

export interface KicadDesignFunctionalBlockIntent {
  id: string;
  deviceRefs: string[];
  preferredRegion?: 'edge' | 'center' | 'power-entry' | 'analog' | 'connector-edge';
  keepTogether?: boolean;
  notes?: string[];
}

export interface KicadBoardIntent {
  widthMm?: number;
  heightMm?: number;
  copperLayers?: 2 | 4 | 6 | 8;
  thicknessMm?: number;
  minimumClearanceMm?: number;
  preferredAssembly?: 'single-side' | 'double-side';
}

export interface KicadElectronicDesignIntent {
  schemaVersion: 1;
  name: string;
  board?: KicadBoardIntent;
  rails: KicadDesignRailIntent[];
  devices: KicadDesignDeviceIntent[];
  interfaces?: KicadDesignInterfaceIntent[];
  functionalBlocks?: KicadDesignFunctionalBlockIntent[];
}

export interface KicadGenericPinAssignment {
  logicalSignal: string;
  physicalPin: string;
  peripheralSignal?: string;
  packagePosition?: string;
  candidateCount?: number;
}

export interface KicadDevicePinPlan {
  deviceRef: string;
  partNumber?: string;
  package?: string;
  source: 'stm32-cubemx' | 'manual' | 'vendor-db' | 'other';
  assignments: KicadGenericPinAssignment[];
  reservedPins?: string[];
  evidence?: string[];
}

export type KicadDesignIntentSeverity = 'error' | 'review' | 'info';

export interface KicadDesignIntentFinding {
  severity: KicadDesignIntentSeverity;
  code: string;
  message: string;
  subject?: string;
}

function boundedId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9._:+/-]{0,127}$/.test(trimmed)) {
    throw new Error(`${label} must be 1..128 characters and use a bounded identifier format.`);
  }
  return trimmed;
}

function boundedRailName(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_+.-][A-Za-z0-9_:+./-]{0,127}$/.test(trimmed)) {
    throw new Error('Rail name must be 1..128 characters and use a bounded electrical-net format.');
  }
  return trimmed;
}

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a finite positive number.`);
  return value;
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    const key = value.toUpperCase();
    if (seen.has(key)) duplicate.add(value);
    else seen.add(key);
  }
  return [...duplicate];
}

export function validateKicadElectronicDesignIntent(
  intent: KicadElectronicDesignIntent,
  pinPlans: KicadDevicePinPlan[] = []
) {
  if (intent.schemaVersion !== 1) throw new Error('Unsupported KiCad electronic design-intent schema version.');
  if (!intent.name.trim() || intent.name.length > 160) throw new Error('Design intent name must contain 1..160 characters.');
  if (intent.rails.length < 1 || intent.rails.length > 64) throw new Error('Design intent requires 1..64 power/ground rails.');
  if (intent.devices.length < 1 || intent.devices.length > 256) throw new Error('Design intent requires 1..256 devices.');
  if ((intent.interfaces?.length ?? 0) > 256) throw new Error('Design intent supports at most 256 interfaces.');
  if ((intent.functionalBlocks?.length ?? 0) > 128) throw new Error('Design intent supports at most 128 functional blocks.');

  const findings: KicadDesignIntentFinding[] = [];
  const railNames = intent.rails.map(rail => boundedRailName(rail.name));
  const duplicateRails = duplicates(railNames);
  if (duplicateRails.length) throw new Error(`Duplicate design rails: ${duplicateRails.join(', ')}.`);

  for (const rail of intent.rails) {
    if (rail.isGround) {
      if (!Number.isFinite(rail.nominalVoltageV) || Math.abs(rail.nominalVoltageV) > 1e-9) throw new Error(`Ground rail ${rail.name} nominal voltage must be 0 V.`);
    } else finitePositive(rail.nominalVoltageV, `Rail ${rail.name} nominal voltage`);
    if (rail.currentBudgetA !== undefined) finitePositive(rail.currentBudgetA, `Rail ${rail.name} current budget`);
  }

  const deviceRefs = intent.devices.map(device => boundedId(device.reference, 'Device reference'));
  const duplicateDevices = duplicates(deviceRefs);
  if (duplicateDevices.length) throw new Error(`Duplicate device references: ${duplicateDevices.join(', ')}.`);
  const deviceSet = new Set(deviceRefs.map(value => value.toUpperCase()));
  const railSet = new Set(railNames.map(value => value.toUpperCase()));

  for (const device of intent.devices) {
    for (const rail of device.supplyRails ?? []) {
      if (!railSet.has(rail.toUpperCase())) {
        findings.push({ severity: 'error', code: 'unknown-device-rail', subject: device.reference, message: `Device ${device.reference} references undefined rail ${rail}.` });
      }
    }
    if ((device.role === 'mcu' || device.role === 'processor') && !device.partNumber) {
      findings.push({ severity: 'error', code: 'programmable-device-part-missing', subject: device.reference, message: `Programmable device ${device.reference} requires an explicit part number before pin planning.` });
    }
    if ((device.role === 'mcu' || device.role === 'processor') && !device.package) {
      findings.push({ severity: 'review', code: 'programmable-device-package-missing', subject: device.reference, message: `Programmable device ${device.reference} has no explicit package; pin planning and footprint validation are not yet authoritative.` });
    }
    for (const clock of device.clocks ?? []) {
      finitePositive(clock.frequencyHz, `Clock ${clock.name} frequency`);
      if (clock.tolerancePpm !== undefined) finitePositive(clock.tolerancePpm, `Clock ${clock.name} tolerance`);
      if ((clock.source === 'crystal' || clock.source === 'oscillator') && clock.critical !== false) {
        findings.push({ severity: 'review', code: 'clock-placement-review', subject: device.reference, message: `Clock ${clock.name} on ${device.reference} requires placement/routing review near the relevant package pins and reference return path.` });
      }
    }
    if (device.debug?.connectorRequired) {
      findings.push({ severity: 'info', code: 'debug-connector-required', subject: device.reference, message: `${device.debug.interface.toUpperCase()} access for ${device.reference} must remain reachable after placement.` });
    }
  }

  const interfaceIds = (intent.interfaces ?? []).map(item => boundedId(item.id, 'Interface id'));
  const duplicateInterfaces = duplicates(interfaceIds);
  if (duplicateInterfaces.length) throw new Error(`Duplicate interface ids: ${duplicateInterfaces.join(', ')}.`);

  const signalOwners = new Map<string, string[]>();
  for (const item of intent.interfaces ?? []) {
    if (item.signals.length < 1 || item.signals.length > 64) throw new Error(`Interface ${item.id} requires 1..64 signals.`);
    if (duplicates(item.signals).length) throw new Error(`Interface ${item.id} contains duplicate signal names.`);
    for (const ref of item.deviceRefs ?? []) {
      if (!deviceSet.has(ref.toUpperCase())) {
        findings.push({ severity: 'error', code: 'unknown-interface-device', subject: item.id, message: `Interface ${item.id} references undefined device ${ref}.` });
      }
    }
    for (const signal of item.signals) {
      const key = signal.trim().toUpperCase();
      const owners = signalOwners.get(key) ?? [];
      owners.push(item.id);
      signalOwners.set(key, owners);
    }
    if (item.external && item.protectionRequired !== false) {
      findings.push({ severity: 'review', code: 'external-interface-protection-review', subject: item.id, message: `External ${item.kind.toUpperCase()} interface ${item.id} requires explicit ESD/transient/protection architecture before schematic release.` });
    }
    if (item.terminationRequired) {
      findings.push({ severity: 'review', code: 'interface-termination-review', subject: item.id, message: `Interface ${item.id} requires termination/bias topology to be resolved in the schematic plan.` });
    }
    if (item.targetImpedanceOhm !== undefined) {
      finitePositive(item.targetImpedanceOhm, `Interface ${item.id} target impedance`);
      findings.push({ severity: 'review', code: 'controlled-impedance-review', subject: item.id, message: `Interface ${item.id} records a ${item.targetImpedanceOhm} ohm target; stackup and field-solver/manufacturer evidence are required before claiming controlled impedance.` });
    }
  }

  for (const [signal, owners] of signalOwners) {
    if (owners.length > 1) {
      findings.push({ severity: 'review', code: 'shared-interface-signal', subject: signal, message: `Signal ${signal} is shared by interfaces ${owners.join(', ')}; verify this is intentional rather than a naming collision.` });
    }
  }

  for (const block of intent.functionalBlocks ?? []) {
    boundedId(block.id, 'Functional block id');
    for (const ref of block.deviceRefs) {
      if (!deviceSet.has(ref.toUpperCase())) {
        findings.push({ severity: 'error', code: 'unknown-functional-block-device', subject: block.id, message: `Functional block ${block.id} references undefined device ${ref}.` });
      }
    }
  }

  const plansByDevice = new Map(pinPlans.map(plan => [plan.deviceRef.toUpperCase(), plan]));
  for (const device of intent.devices.filter(item => item.role === 'mcu' || item.role === 'processor')) {
    const plan = plansByDevice.get(device.reference.toUpperCase());
    if (!plan) {
      findings.push({ severity: 'error', code: 'pin-plan-missing', subject: device.reference, message: `Programmable device ${device.reference} has no pin plan; schematic synthesis must not guess package pins.` });
      continue;
    }
    const plannedSignals = new Set(plan.assignments.flatMap(item => [item.logicalSignal.toUpperCase(), item.peripheralSignal?.toUpperCase()].filter((value): value is string => Boolean(value))));
    for (const required of device.requiredSignals ?? []) {
      if (!plannedSignals.has(required.toUpperCase())) {
        findings.push({ severity: 'error', code: 'required-signal-unassigned', subject: device.reference, message: `Required signal ${required} on ${device.reference} is absent from the pin plan.` });
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
    normalized: {
      railNames,
      deviceRefs,
      interfaceIds,
      plannedDeviceRefs: [...plansByDevice.keys()].sort()
    },
    gates: {
      pinPlanReady: !findings.some(item => item.code === 'pin-plan-missing' || item.code === 'required-signal-unassigned' || item.code === 'programmable-device-part-missing'),
      schematicArchitectureReady: !findings.some(item => item.severity === 'error')
    }
  };
}

export function stm32AssignmentsToKicadPinPlan(
  device: Pick<KicadDesignDeviceIntent, 'reference' | 'partNumber' | 'package'>,
  assignments: Stm32PinAssignment[],
  reservedPins: string[] = []
): KicadDevicePinPlan {
  if (!device.partNumber) throw new Error(`STM32 device ${device.reference} requires partNumber before pin-plan conversion.`);
  return {
    deviceRef: boundedId(device.reference, 'Device reference'),
    partNumber: device.partNumber,
    ...(device.package ? { package: device.package } : {}),
    source: 'stm32-cubemx',
    assignments: assignments.map(item => ({
      logicalSignal: item.request,
      physicalPin: item.pinName,
      peripheralSignal: item.signal,
      packagePosition: item.position,
      candidateCount: item.candidateCount
    })),
    reservedPins: [...new Set(reservedPins.map(value => value.toUpperCase()))].sort(),
    evidence: ['Pin assignment derived from STM32CubeMX MCU/package database; final alternate-function condition validation remains required before release.']
  };
}
