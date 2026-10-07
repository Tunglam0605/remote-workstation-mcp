import assert from 'node:assert/strict';
import test from 'node:test';
import { synthesizeKicadBoard } from '../src/adapters/engineering/kicad-board-synthesis.js';
import { analyzeKicadElectrical } from '../src/adapters/engineering/kicad-electrical-review.js';
import type { KicadResolvedFootprint, KicadResolvedSymbol } from '../src/adapters/engineering/kicad-library.js';
import { applyKicadRouteBatch } from '../src/adapters/engineering/kicad-route-batch.js';
import { planKicadRoutes } from '../src/adapters/engineering/kicad-route-plan.js';
import { planKicadSemanticPlacement } from '../src/adapters/engineering/kicad-semantic-placement.js';

function symbol(
  id: string,
  pins: Array<{ number: string; name: string; electricalType?: string }>
): KicadResolvedSymbol {
  return {
    kind: 'symbol',
    id,
    library: id.split(':')[0] ?? 'Synthetic',
    name: id.split(':')[1] ?? id,
    sourcePath: '<synthetic>',
    extendsChain: [],
    properties: {},
    footprintFilters: [],
    pins: pins.map((pin, index) => ({
      number: pin.number,
      name: pin.name,
      electricalType: pin.electricalType ?? 'passive',
      shape: 'line',
      xMm: index,
      yMm: 0,
      rotationDeg: 0,
      lengthMm: 2.54,
      unit: 1,
      bodyStyle: 1,
      alternates: []
    })),
    embeddedDefinition: '(symbol "Synthetic")'
  };
}

function footprint(
  id: string,
  pads: Array<{ number: string; xMm: number; yMm: number; widthMm: number; heightMm: number }>
): KicadResolvedFootprint {
  const source = [
    `(footprint "${id}"`,
    '  (version 20241229)',
    '  (generator "rwmcp-acceptance")',
    '  (layer "F.Cu")',
    '  (property "Reference" "REF**" (at 0 -9 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))',
    '  (property "Value" "VALUE" (at 0 9 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))',
    ...pads.map(pad =>
      `  (pad "${pad.number}" smd rect (at ${pad.xMm} ${pad.yMm}) (size ${pad.widthMm} ${pad.heightMm}) (layers "F.Cu" "F.Paste" "F.Mask"))`
    ),
    ')'
  ].join('\n');
  return {
    kind: 'footprint',
    id,
    library: id.split(':')[0] ?? 'Synthetic',
    name: id.split(':')[1] ?? id,
    sourcePath: '<synthetic>',
    attributes: ['smd'],
    pads: pads.map(pad => ({
      number: pad.number,
      type: 'smd',
      shape: 'rect',
      xMm: pad.xMm,
      yMm: pad.yMm,
      rotationDeg: 0,
      widthMm: pad.widthMm,
      heightMm: pad.heightMm,
      layers: ['F.Cu', 'F.Paste', 'F.Mask']
    })),
    modelPaths: [],
    source
  };
}

test('STM32F407 0.5 mm USB lane survives pin-aware placement, synthesis and routing with only impedance review remaining', () => {
  const mcuPads = [
    { number: '1', xMm: -7.75, yMm: -6, widthMm: 1.5, heightMm: 0.3 },
    { number: '25', xMm: -6, yMm: 7.75, widthMm: 0.3, heightMm: 1.5 },
    { number: '50', xMm: 7.75, yMm: -6, widthMm: 1.5, heightMm: 0.3 },
    { number: '70', xMm: 7.75, yMm: 0, widthMm: 1.5, heightMm: 0.3 },
    { number: '71', xMm: 7.75, yMm: 0.5, widthMm: 1.5, heightMm: 0.3 },
    { number: '75', xMm: 6, yMm: 7.75, widthMm: 0.3, heightMm: 1.5 },
    { number: '100', xMm: -7.75, yMm: 6, widthMm: 1.5, heightMm: 0.3 }
  ];
  const resistorPads = [
    { number: '1', xMm: -0.8, yMm: 0, widthMm: 0.9, heightMm: 0.95 },
    { number: '2', xMm: 0.8, yMm: 0, widthMm: 0.9, heightMm: 0.95 }
  ];
  const manifest = {
    schemaVersion: 1,
    projectName: 'stm32f407-usb-acceptance',
    components: [
      {
        reference: 'U1',
        symbolId: 'MCU_ST_STM32F4:STM32F407VETx',
        value: 'STM32F407VET6',
        footprintId: 'Package_QFP:LQFP-100_14x14mm_P0.5mm',
        footprintPadCount: 100,
        footprintPads: mcuPads,
        onBoard: true
      },
      {
        reference: 'R1',
        symbolId: 'Device:R',
        value: '22R',
        footprintId: 'Resistor_SMD:R_0603_1608Metric',
        footprintPads: resistorPads,
        onBoard: true
      },
      {
        reference: 'R2',
        symbolId: 'Device:R',
        value: '22R',
        footprintId: 'Resistor_SMD:R_0603_1608Metric',
        footprintPads: resistorPads,
        onBoard: true
      }
    ],
    nets: [
      { name: 'USB_DM', endpoints: [{ reference: 'U1', pinNumber: '70' }, { reference: 'R1', pinNumber: '1' }] },
      { name: 'USB_DP', endpoints: [{ reference: 'U1', pinNumber: '71' }, { reference: 'R2', pinNumber: '1' }] }
    ]
  };

  const placement = planKicadSemanticPlacement(manifest, {
    widthMm: 80,
    heightMm: 60,
    originXmm: 20,
    originYmm: 20,
    gridMm: 0.25,
    minSpacingMm: 2,
    edgeInsetMm: 4
  });
  const byRef = new Map(placement.placements.map(item => [item.reference, item]));
  const u1 = byRef.get('U1')!;
  const r1 = byRef.get('R1')!;
  const r2 = byRef.get('R2')!;

  assert.equal(u1.role, 'mcu');
  assert.ok(r1.rationale.some(item => item.includes('Pin-aware placement follows U1.70')));
  assert.ok(r2.rationale.some(item => item.includes('Pin-aware placement follows U1.71')));
  assert.ok(r1.xMm > u1.xMm && r2.xMm > u1.xMm, 'USB series resistors should escape from the MCU USB-pin side');

  const mcuSymbol = symbol('MCU_ST_STM32F4:STM32F407VETx', [
    { number: '70', name: 'PA11/USB_OTG_FS_DM', electricalType: 'bidirectional' },
    { number: '71', name: 'PA12/USB_OTG_FS_DP', electricalType: 'bidirectional' }
  ]);
  const resistorSymbol = symbol('Device:R', [
    { number: '1', name: '~', electricalType: 'passive' },
    { number: '2', name: '~', electricalType: 'passive' }
  ]);
  const mcuFootprint = footprint('Package_QFP:LQFP-100_14x14mm_P0.5mm', mcuPads);
  const resistorFootprint = footprint('Resistor_SMD:R_0603_1608Metric', resistorPads);

  const board = synthesizeKicadBoard([
    {
      reference: 'U1',
      value: 'STM32F407VET6',
      footprint: mcuFootprint,
      symbol: mcuSymbol,
      symbolUuid: '00000000-0000-4000-8000-000000000001',
      xMm: u1.xMm,
      yMm: u1.yMm,
      rotationDeg: u1.rotationDeg
    },
    {
      reference: 'R1',
      value: '22R',
      footprint: resistorFootprint,
      symbol: resistorSymbol,
      symbolUuid: '00000000-0000-4000-8000-000000000002',
      xMm: r1.xMm,
      yMm: r1.yMm,
      rotationDeg: r1.rotationDeg
    },
    {
      reference: 'R2',
      value: '22R',
      footprint: resistorFootprint,
      symbol: resistorSymbol,
      symbolUuid: '00000000-0000-4000-8000-000000000003',
      xMm: r2.xMm,
      yMm: r2.yMm,
      rotationDeg: r2.rotationDeg
    }
  ], manifest.nets, {
    projectName: manifest.projectName,
    widthMm: 80,
    heightMm: 60,
    originXmm: 20,
    originYmm: 20,
    copperLayers: 2
  });

  const routing = planKicadRoutes(board.source, {
    gridMm: 0.25,
    edgeInsetMm: 1,
    defaultWidthMm: 0.2,
    defaultClearanceMm: 0.2,
    viaDiameterMm: 0.6,
    viaDrillMm: 0.3,
    styles: [
      { netName: 'USB_DM', priority: 500, widthMm: 0.2, clearanceMm: 0.2, preferredLayer: 'F.Cu' },
      { netName: 'USB_DP', priority: 500, widthMm: 0.2, clearanceMm: 0.2, preferredLayer: 'F.Cu' }
    ],
    selectedNets: ['USB_DM', 'USB_DP']
  });

  assert.equal(routing.complete, true);
  assert.deepEqual(routing.routed.map(item => item.netName).sort(), ['/USB_DM', '/USB_DP']);
  assert.equal(routing.skipped.length, 0);
  assert.ok(routing.operations.length > 0);

  const routedBoard = applyKicadRouteBatch(board.source, routing.operations);
  const electrical = analyzeKicadElectrical(routedBoard.source, [
    { netName: 'USB_DM', kind: 'differential', pairWith: 'USB_DP', targetImpedanceOhm: 90, maxSkewMm: 5 },
    { netName: 'USB_DP', kind: 'differential', pairWith: 'USB_DM', targetImpedanceOhm: 90, maxSkewMm: 5 }
  ]);

  assert.equal(electrical.findings.high, 0);
  assert.equal(electrical.findings.review, 0);
  assert.equal(electrical.findings.info, 2);
  for (const net of electrical.nets) {
    assert.ok(net.route.segments > 0);
    assert.equal(net.route.vias, 0);
    assert.deepEqual(net.findings.map(item => item.code), ['impedance-solver-required']);
  }
});
