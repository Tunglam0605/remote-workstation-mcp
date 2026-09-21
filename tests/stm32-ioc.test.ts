import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Stm32IocAdapter, parseStm32IocText } from '../src/adapters/engineering/stm32-ioc.js';
import type { PathGuard } from '../src/security/path-guard.js';

const sample = [
  '#MicroXplorer Configuration settings - do not modify',
  'File.Version=6',
  'Mcu.CPN=STM32H743ZIT6',
  'Mcu.Family=STM32H7',
  'Mcu.Name=STM32H743ZITx',
  'Mcu.Package=LQFP144',
  'Mcu.PinsNb=3',
  'Mcu.Pin0=PA0',
  'Mcu.Pin1=PB6',
  'Mcu.Pin2=VP_SYS_VS_Systick',
  'Mcu.IPNb=3',
  'Mcu.IP0=RCC',
  'Mcu.IP1=USART1',
  'Mcu.IP2=FREERTOS',
  'Board=custom_board',
  'ProjectManager.ProjectName=B300-Main-Custom',
  'ProjectManager.ToolChain=MDK-ARM V5',
  'ProjectManager.TargetToolchain=MDK-ARM V5',
  'ProjectManager.FirmwarePackage=STM32Cube FW_H7 V1.11.2',
  'PA0.Signal=ADC1_INP16',
  'PA0.GPIO_Label=BATTERY_ADC',
  'PA0.GPIO_PuPd=GPIO_NOPULL',
  'PB6.Signal=USART1_TX',
  'PB6.GPIO_Label=DEBUG_TX',
  'PB6.Locked=true',
  'VP_SYS_VS_Systick.Mode=SysTick',
  'VP_SYS_VS_Systick.Signal=SYS_VS_Systick',
  'RCC.IPParameters=SYSCLKFreq_VALUE,HCLKFreq_Value',
  'RCC.SYSCLKFreq_VALUE=480000000',
  'RCC.HCLKFreq_Value=240000000',
  'USART1.IPParameters=BaudRate,WordLength',
  'USART1.BaudRate=115200',
  'USART1.WordLength=WORDLENGTH_8B',
  'FREERTOS.IPParameters=Tasks01',
  'FREERTOS.Tasks01=defaultTask,24,128,StartDefaultTask,Default,NULL,Dynamic,NULL,NULL'
].join('\n');

test('STM32 IOC parser returns bounded typed project, clock, pin and peripheral metadata', () => {
  const result = parseStm32IocText('B300.ioc', Buffer.byteLength(sample), sample);

  assert.equal(result.file, 'B300.ioc');
  assert.equal(result.formatVersion, '6');
  assert.deepEqual(result.mcu, {
    name: 'STM32H743ZITx',
    family: 'STM32H7',
    package: 'LQFP144',
    partNumber: 'STM32H743ZIT6'
  });
  assert.equal(result.board, 'custom_board');
  assert.equal(result.project.name, 'B300-Main-Custom');
  assert.equal(result.project.toolchain, 'MDK-ARM V5');
  assert.equal(result.clocks.frequenciesHz.SYSCLKFreq_VALUE, 480000000);
  assert.equal(result.clocks.frequenciesHz.HCLKFreq_Value, 240000000);
  assert.equal(result.counts.parsedPins, 3);
  assert.equal(result.counts.parsedPeripherals, 3);

  const pa0 = result.pins.find(pin => pin.pin === 'PA0');
  assert.deepEqual(pa0, {
    pin: 'PA0',
    kind: 'physical',
    signal: 'ADC1_INP16',
    label: 'BATTERY_ADC',
    pull: 'GPIO_NOPULL'
  });
  const virtual = result.pins.find(pin => pin.pin === 'VP_SYS_VS_Systick');
  assert.equal(virtual?.kind, 'virtual');

  const usart = result.peripherals.find(item => item.instance === 'USART1');
  assert.deepEqual(usart, {
    instance: 'USART1',
    parameterCount: 2,
    parameters: {
      BaudRate: '115200',
      WordLength: 'WORDLENGTH_8B'
    },
    parametersTruncated: false
  });
  assert.deepEqual(result.warnings, []);
});

test('STM32 IOC parser reports declared-count mismatches instead of silently trusting corrupt metadata', () => {
  const result = parseStm32IocText(
    'broken.ioc',
    64,
    ['Mcu.Name=STM32F407VETx', 'Mcu.PinsNb=2', 'Mcu.Pin0=PA0', 'Mcu.IPNb=1'].join('\n')
  );
  assert.equal(result.counts.parsedPins, 1);
  assert.equal(result.counts.parsedPeripherals, 0);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0] ?? '', /declares 2 pins/);
  assert.match(result.warnings[1] ?? '', /declares 1 peripherals/);
});

test('STM32 IOC adapter fails closed on ambiguous project-root IOC selection', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-ioc-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'A.ioc'), 'Mcu.Name=STM32F407VETx\n', 'utf8');
  await fs.writeFile(path.join(root, 'B.ioc'), 'Mcu.Name=STM32H743ZITx\n', 'utf8');
  const guard = {
    async resolveExisting(_workspace: string, relative = '.') {
      return path.resolve(root, relative);
    }
  } as unknown as PathGuard;
  const adapter = new Stm32IocAdapter(guard);

  await assert.rejects(adapter.inspect('stm32', '.'), /Multiple STM32 CubeMX \.ioc files/);
  const selected = await adapter.inspect('stm32', '.', 'B.ioc');
  assert.equal(selected.file, 'B.ioc');
  assert.equal(selected.mcu.name, 'STM32H743ZITx');
  await assert.rejects(adapter.inspect('stm32', '.', '../B.ioc'), /project-root \.ioc basename/);
});

