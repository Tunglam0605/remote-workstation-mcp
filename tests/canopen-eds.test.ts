import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CanopenEds, enrichSemanticFrame, parseEds } from '../src/extensions/canopen/eds.js';
import { decodeCanopenFrame } from '../src/extensions/canopen/canopen-adapter.js';
import { PathGuard } from '../src/security/path-guard.js';
import { PolicyEngine } from '../src/policy.js';

const eds = `[2000]
ParameterName=Sensor
ObjectType=0x7
DataType=0x0006
AccessType=ro
DefaultValue=12
PDOMapping=1
LowLimit=0
HighLimit=100
Unit=V
[2001sub01]
ParameterName=Label
DataType=0x0009
[1A00sub00]
DefaultValue=1
[1A00sub01]
DefaultValue=0x20000010
`;

function frame(id: number, data: string[]) {
  return { timestamp: 1, interface: 'can0', id, idHex: id.toString(16), extended: false, fd: false,
    rtr: false, error: false, dlc: data.length, dataHex: data.join(''), data };
}

function semanticFrame(id: number, data: string[], dictionary: ReturnType<typeof parseEds>) {
  const raw = frame(id, data);
  const decoded = decodeCanopenFrame(raw);
  assert.ok(decoded);
  return enrichSemanticFrame(raw, decoded, dictionary);
}

test('EDS parses object metadata and exact sub-index lookup', () => {
  const dictionary = parseEds(eds);
  assert.equal(dictionary.lookup(0x2000, 0)?.parameterName, 'Sensor');
  assert.equal(dictionary.lookup(0x2000, 0)?.unit, 'V');
  assert.equal(dictionary.lookup(0x2001, 1)?.parameterName, 'Label');
  assert.equal(dictionary.lookup(0x2001, 0), undefined);
  assert.equal(dictionary.inspect(0x2000, 1).entries.length, 1);
});

test('EDS rejects excess lines and duplicate object sections', () => {
  assert.throws(() => parseEds('x\n'.repeat(30001)), /limit/i);
  assert.throws(() => parseEds('[2000]\nParameterName=A\n[2000]\nParameterName=B'), /duplicate/i);
});

test('project EDS loading rejects path escape and oversized source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopen-eds-'));
  try {
    await fs.writeFile(path.join(root, 'device.eds'), eds);
    await fs.writeFile(path.join(root, 'large.eds'), 'x'.repeat(2 * 1024 * 1024 + 1));
    const policy = new PolicyEngine({ mode: 'read_only', workspaces: [{ id: 'test', root, readOnly: true }] } as never);
    const loader = new CanopenEds(new PathGuard(policy));
    assert.equal((await loader.load('test', '.', 'device.eds')).lookup(0x2000, 0)?.parameterName, 'Sensor');
    await assert.rejects(loader.load('test', '.', '../outside.eds'));
    await assert.rejects(loader.load('test', '.', 'large.eds'), /limit/i);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('semantic SDO decode accepts expedited value and retains raw evidence for unsupported transfer', () => {
  const dictionary = parseEds(eds);
  const value = semanticFrame(0x605, ['2B', '00', '20', '00', '34', '12', '00', '00'], dictionary);
  assert.equal(value?.kind, 'sdo-request');
  assert.equal(value?.semantic?.value, 0x1234);
  const segmented = semanticFrame(0x605, ['21', '00', '20', '00', '34', '12', '00', '00'], dictionary);
  assert.equal(segmented?.semantic?.rawHex, '34120000');
  assert.equal(segmented?.semantic?.value, undefined);
});

test('default PDO mapping decodes aligned fields and leaves malformed mapping raw', () => {
  const dictionary = parseEds(eds);
  const value = semanticFrame(0x185, ['34', '12'], dictionary);
  assert.equal(value?.semantic?.mapped?.[0]?.value, 0x1234);
  const malformed = parseEds(eds.replace('0x20000010', '0x2000000F'));
  assert.equal(semanticFrame(0x185, ['34', '12'], malformed)?.semantic?.mapped, undefined);
});

test('standard EDS record keeps container metadata separate from explicit sub-index zero', () => {
  const dictionary = parseEds(`[1018]\nParameterName=Identity\nObjectType=0x9\nSubNumber=0x5\n[1018sub0]\nParameterName=Highest sub-index supported\nObjectType=0x7\nDataType=0x0005\nAccessType=ro\nDefaultValue=0x04\nPDOMapping=0\n[1018sub1]\nParameterName=Vendor-ID\nObjectType=0x7\nDataType=0x0007\nAccessType=ro\nDefaultValue=0\nPDOMapping=0\n`);
  assert.equal(dictionary.object(0x1018)?.parameterName, 'Identity');
  assert.equal(dictionary.object(0x1018)?.subNumber, 5);
  assert.equal(dictionary.lookup(0x1018, 0)?.parameterName, 'Highest sub-index supported');
  assert.equal(dictionary.lookup(0x1018, 0)?.parent?.objectType, '0x9');
  assert.equal(dictionary.lookup(0x1018, 1)?.parameterName, 'Vendor-ID');
});

test('EDS fields are case-insensitive and unknown fields become bounded warnings', () => {
  const dictionary = parseEds('[2002]\nparametername=Blob\ndatatype=0x000A\naccesstype=ro\nVendorPrivateThing=abc\n');
  assert.equal(dictionary.lookup(0x2002, 0)?.parameterName, 'Blob');
  assert.equal(dictionary.lookup(0x2002, 0)?.dataType, '0x000A');
  assert.match(dictionary.warnings[0] ?? '', /unsupported field/i);
});

test('semantic decode supports OCTET_STRING and wide integers without unsafe precision loss', () => {
  const octets = parseEds('[2002]\nDataType=0x000A\n');
  assert.equal(semanticFrame(0x605, ['23', '02', '20', '00', 'DE', 'AD', 'BE', 'EF'], octets).semantic?.value, '0xDEADBEEF');
  const wide = parseEds('[2003]\nDataType=0x001B\n');
  const decoded = semanticFrame(0x605, ['23', '03', '20', '00', 'FF', 'FF', 'FF', 'FF'], wide);
  assert.equal(decoded.semantic?.value, undefined, 'four-byte expedited payload must not be guessed as UNSIGNED64');
});

test('project EDS loading rejects non-EDS extensions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopen-eds-ext-'));
  try {
    await fs.writeFile(path.join(root, 'device.txt'), eds);
    const policy = new PolicyEngine({ mode: 'read_only', workspaces: [{ id: 'test', root, readOnly: true }] } as never);
    const loader = new CanopenEds(new PathGuard(policy));
    await assert.rejects(loader.load('test', '.', 'device.txt'), /\.eds or \.dcf/i);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
