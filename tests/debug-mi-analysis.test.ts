import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDebugBreakpointNumber, parseDebugDisassembly, parseDebugLocals } from '../src/adapters/engineering/debug-mi-analysis.js';

test('debug locals parser returns bounded MI variables without evaluating expressions', () => {
  const payload = 'variables=[{name="error",arg="0",value="3"},{name="state",arg="0",value="IDLE"},{name="input",arg="1",value="0x20001000"}]';
  assert.deepEqual(parseDebugLocals(payload, 2), [
    { name: 'error', value: '3', argument: false },
    { name: 'state', value: 'IDLE', argument: false }
  ]);
});

test('debug disassembly parser extracts address, function, offset and instruction', () => {
  const payload = 'asm_insns=[{address="0x08001234",func-name="ControlMotion",offset="16",inst="ldr r3, [r0, #4]"},{address="0x08001236",func-name="ControlMotion",offset="18",inst="adds r3, #1"}]';
  assert.deepEqual(parseDebugDisassembly(payload), [
    { address: 0x08001234, addressHex: '0x08001234', function: 'ControlMotion', offset: 16, instruction: 'ldr r3, [r0, #4]' },
    { address: 0x08001236, addressHex: '0x08001236', function: 'ControlMotion', offset: 18, instruction: 'adds r3, #1' }
  ]);
});

test('debug breakpoint/watchpoint number parser accepts nested MI records and rejects missing numbers', () => {
  assert.equal(parseDebugBreakpointNumber('wpt={number="3",exp="state"}'), 3);
  assert.equal(parseDebugBreakpointNumber('bkpt={number="7",type="hw breakpoint"}'), 7);
  assert.throws(() => parseDebugBreakpointNumber('wpt={exp="state"}'), /valid breakpoint\/watchpoint number/);
});
