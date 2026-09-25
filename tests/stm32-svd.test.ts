import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Stm32SvdAdapter, parseStm32SvdText } from '../src/adapters/engineering/stm32-svd.js';
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

test('STM32 SVD parser rejects DTD/entity declarations instead of expanding external XML', () => {
  assert.throws(
    () => parseStm32SvdText('unsafe.svd', 128, '<!DOCTYPE device [<!ENTITY x SYSTEM "file:///etc/passwd">]><device><name>&x;</name></device>'),
    /SVD_XML_UNSAFE/
  );
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
