import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFirmwareBerkeleySize, parseFirmwareSections, parseFirmwareSymbols } from '../src/adapters/engineering/firmware-memory-analysis.js';

test('firmware memory parser derives conventional Flash and RAM totals from Berkeley size output', () => {
  const parsed = parseFirmwareBerkeleySize(`   text    data     bss     dec     hex filename\n  24576     512    4096   29184    7200 app.elf\n`);
  assert.deepEqual(parsed, {
    textBytes: 24576,
    dataBytes: 512,
    bssBytes: 4096,
    flashBytes: 25088,
    ramBytes: 4608,
    totalImageBytes: 29184
  });
});

test('firmware section parser returns bounded section sizes and addresses', () => {
  const parsed = parseFirmwareSections(`app.elf  :\nsection             size        addr\n.text              24576   134217728\n.data                512   536870912\n.bss                4096   536871424\n.debug_info        123456           0\n`, 3);
  assert.deepEqual(parsed, [
    { name: '.text', sizeBytes: 24576, address: 134217728 },
    { name: '.data', sizeBytes: 512, address: 536870912 },
    { name: '.bss', sizeBytes: 4096, address: 536871424 }
  ]);
});

test('firmware symbol parser sorts largest symbols first and ignores zero-size entries', () => {
  const parsed = parseFirmwareSymbols(`134217900 120 T ControlLoop\n134218100 2048 B rx_buffer\n134220200 0 T marker\n134221000 640 T FuzzyPidUpdate\n`, 2);
  assert.deepEqual(parsed, [
    { name: 'rx_buffer', sizeBytes: 2048, address: 134218100, type: 'B' },
    { name: 'FuzzyPidUpdate', sizeBytes: 640, address: 134221000, type: 'T' }
  ]);
});

test('firmware memory parser rejects malformed size output instead of inventing totals', () => {
  assert.throws(() => parseFirmwareBerkeleySize('not a size report'), /Unable to parse/);
});
