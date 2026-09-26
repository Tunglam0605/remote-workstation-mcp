import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Stm32SvdAdapter, decodeStm32SvdRegisterHex, parseStm32SvdText, resolveStm32SvdRegister } from '../src/adapters/engineering/stm32-svd.js';
import type { PathGuard } from '../src/security/path-guard.js';

const sample = `<?xml version="1.0" encoding="utf-8"?>
<device>
  <name>STM32H743</name>
  <version>1.0</version>
  <description>STM32H743 reduced fixture</description>
  <addressUnitBits>8</addressUnitBits>
  <width>32</width>
  <cpu>
    <name>CM7</name>
    <revision>r1p1</revision>
    <endian>little</endian>
    <mpuPresent>true</mpuPresent>
    <fpuPresent>true</fpuPresent>
    <nvicPrioBits>4</nvicPrioBits>
  </cpu>
  <peripherals>
    <peripheral>
      <name>GPIOA</name>
      <description>GPIO port A</description>
      <groupName>GPIO</groupName>
      <baseAddress>0x58020000</baseAddress>
      <size>32</size>
      <access>read-write</access>
      <registers>
        <register>
          <name>MODER</name>
          <description>mode register</description>
          <addressOffset>0x0</addressOffset>
          <resetValue>0xABCD</resetValue>
          <fields>
            <field>
              <name>MODER0</name>
              <bitOffset>0</bitOffset>
              <bitWidth>2</bitWidth>
              <access>read-write</access>
            </field>
            <field>
              <name>MODER1</name>
              <bitRange>[3:2]</bitRange>
            </field>
          </fields>
        </register>
        <register>
          <name>CCR%s</name>
          <addressOffset>0x10</addressOffset>
          <dim>4</dim>
          <dimIncrement>0x4</dimIncrement>
          <dimIndex>0,1,2,3</dimIndex>
        </register>
        <cluster>
          <name>BANK</name>
          <addressOffset>0x100</addressOffset>
          <register>
            <name>CR</name>
            <addressOffset>0x4</addressOffset>
            <fields>
              <field>
                <name>EN</name>
                <lsb>0</lsb>
                <msb>0</msb>
              </field>
            </fields>
          </register>
        </cluster>
      </registers>
    </peripheral>
  </peripherals>
</device>`;

test('STM32 SVD parser returns bounded device, peripheral, register, cluster and field metadata', () => {
  const result = parseStm32SvdText('STM32H743.svd', Buffer.byteLength(sample), sample);
  assert.equal(result.device.name, 'STM32H743');
  assert.equal(result.device.cpu?.name, 'CM7');
  assert.equal(result.device.cpu?.fpuPresent, true);
  assert.equal(result.counts.peripherals, 1);
  assert.equal(result.counts.registers, 3);
  assert.equal(result.counts.fields, 3);
  assert.equal(result.inheritance.derivedFromPresent, false);
  assert.equal(result.inheritance.resolved, true);

  const gpio = result.peripherals[0]!;
  assert.equal(gpio.baseAddress, 0x58020000);
  assert.equal(gpio.groupName, 'GPIO');

  const moder = gpio.registers.find(item => item.name === 'MODER')!;
  assert.equal(moder.absoluteAddress, 0x58020000);
  assert.equal(moder.resetValue, 0xabcd);
  assert.deepEqual(moder.fields.map(field => [field.name, field.bitOffset, field.bitWidth]), [
    ['MODER0', 0, 2],
    ['MODER1', 2, 2]
  ]);

  const array = gpio.registers.find(item => item.name === 'CCR%s')!;
  assert.deepEqual(array.array, { count: 4, increment: 4, indexes: ['0', '1', '2', '3'] });

  const cluster = gpio.registers.find(item => item.name === 'CR')!;
  assert.equal(cluster.clusterPath, 'BANK');
  assert.equal(cluster.addressOffset, 0x104);
  assert.equal(cluster.absoluteAddress, 0x58020104);
  assert.equal(cluster.fields[0]?.name, 'EN');
});

test('STM32 SVD parser exposes unresolved derivedFrom inheritance instead of overclaiming completeness', () => {
  const inherited = `<device><name>STM32X</name><peripherals>
    <peripheral><name>GPIOA</name><baseAddress>0x40000000</baseAddress><registers>
      <register><name>BASE</name><addressOffset>0</addressOffset></register>
    </registers></peripheral>
    <peripheral derivedFrom="GPIOA"><name>GPIOB</name><baseAddress>0x40000400</baseAddress></peripheral>
  </peripherals></device>`;
  const result = parseStm32SvdText('derived.svd', Buffer.byteLength(inherited), inherited);
  assert.equal(result.inheritance.derivedFromPresent, true);
  assert.equal(result.inheritance.resolved, false);
  assert.match(result.inheritance.note ?? '', /not materialized/i);
  assert.ok(result.warnings.some(item => /derivedFrom inheritance/i.test(item)));
});

test('STM32 SVD parser rejects DTD/entity declarations instead of expanding external XML', () => {
  assert.throws(
    () => parseStm32SvdText('unsafe.svd', 128, '<!DOCTYPE device [<!ENTITY x SYSTEM "file:///etc/passwd">]><device><name>&x;</name></device>'),
    /SVD_XML_UNSAFE/
  );
});

test('STM32 SVD semantic resolver permits only explicit side-effect-free readable registers', () => {
  const xml = `<device><name>STM32X</name><peripherals><peripheral><name>USART3</name><baseAddress>0x40004800</baseAddress><size>32</size><access>read-write</access><registers>
    <register><name>ISR</name><addressOffset>0x1c</addressOffset><fields><field><name>RXNE</name><bitOffset>5</bitOffset><bitWidth>1</bitWidth></field></fields></register>
    <register><name>RDR</name><addressOffset>0x24</addressOffset><readAction>clear</readAction></register>
    <register><name>TDR</name><addressOffset>0x28</addressOffset><access>write-only</access></register>
    <register><name>SR</name><addressOffset>0x2c</addressOffset><fields><field><name>FLAG</name><bitOffset>0</bitOffset><bitWidth>1</bitWidth><readAction>clear</readAction></field></fields></register>
    <register><name>CCR%s</name><addressOffset>0x30</addressOffset><dim>2</dim><dimIncrement>4</dimIncrement></register>
  </registers></peripheral></peripherals></device>`;
  const inspection = parseStm32SvdText('safe.svd', Buffer.byteLength(xml), xml);

  const safe = resolveStm32SvdRegister(inspection, 'usart3', 'isr');
  assert.equal(safe.selector, 'USART3.ISR');
  assert.equal(safe.address, 0x4000481c);
  assert.equal(safe.safeToRead, true);
  assert.equal(safe.safetyCode, 'safe');
  const decoded = decodeStm32SvdRegisterHex(safe, '20000000');
  assert.equal(decoded.value, 0x20);
  assert.equal(decoded.fields.find(field => field.name === 'RXNE')?.value, 1);

  const registerSideEffect = resolveStm32SvdRegister(inspection, 'USART3', 'RDR');
  assert.equal(registerSideEffect.safeToRead, false);
  assert.equal(registerSideEffect.safetyCode, 'register-read-side-effect');
  const writeOnly = resolveStm32SvdRegister(inspection, 'USART3', 'TDR');
  assert.equal(writeOnly.safetyCode, 'access-not-readable');
  const fieldSideEffect = resolveStm32SvdRegister(inspection, 'USART3', 'SR');
  assert.equal(fieldSideEffect.safetyCode, 'field-read-side-effect');
  const array = resolveStm32SvdRegister(inspection, 'USART3', 'CCR%s');
  assert.equal(array.safetyCode, 'array-selector-required');
  assert.throws(() => decodeStm32SvdRegisterHex(registerSideEffect, '00000000'), /Unsafe SVD register read refused/);
});

test('STM32 SVD semantic resolver fails closed when derivedFrom inheritance is unresolved', () => {
  const inherited = `<device><name>STM32X</name><peripherals>
    <peripheral><name>RCC</name><baseAddress>0x58024400</baseAddress><size>32</size><access>read-write</access><registers><register><name>CR</name><addressOffset>0</addressOffset></register></registers></peripheral>
    <peripheral derivedFrom="RCC"><name>RCC2</name><baseAddress>0x58024800</baseAddress></peripheral>
  </peripherals></device>`;
  const inspection = parseStm32SvdText('derived.svd', Buffer.byteLength(inherited), inherited);
  const resolved = resolveStm32SvdRegister(inspection, 'RCC', 'CR');
  assert.equal(resolved.safeToRead, false);
  assert.equal(resolved.safetyCode, 'inheritance-unresolved');
});

test('STM32 SVD adapter stays project-scoped and rejects traversal/non-SVD paths', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-svd-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'svd'), { recursive: true });
  await fs.writeFile(path.join(root, 'svd', 'STM32H743.svd'), sample, 'utf8');
  const guard = {
    async resolveExisting(_workspace: string, relative = '.') {
      const resolved = path.resolve(root, relative);
      if (!resolved.startsWith(root + path.sep) && resolved !== root) throw new Error('outside workspace');
      return resolved;
    }
  } as unknown as PathGuard;
  const adapter = new Stm32SvdAdapter(guard);

  const inspected = await adapter.inspect('stm32', '.', 'svd/STM32H743.svd');
  assert.equal(inspected.device.name, 'STM32H743');
  await assert.rejects(adapter.inspect('stm32', '.', '../STM32H743.svd'), /project-relative \.svd/);
  await assert.rejects(adapter.inspect('stm32', '.', 'svd/STM32H743.xml'), /project-relative \.svd/);
});
