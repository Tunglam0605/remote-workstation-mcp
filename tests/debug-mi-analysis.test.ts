import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDebugBreakpointNumber, parseDebugDisassembly, parseDebugLocals, parseDebugThreads } from '../src/adapters/engineering/debug-mi-analysis.js';

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

test('debug thread parser returns bounded target-provided RTOS/thread metadata', () => {
  const payload = 'threads=[{id="2",target-id="Thread 2",name="ControlTask",details="FreeRTOS task",state="stopped",core="0",frame={level="0",addr="0x08001020",func="ControlTask",file="app.c",fullname="C:/src/app.c",line="42"}},{id="1",target-id="Thread 1",name="Idle",state="stopped"}],current-thread-id="2"';
  const parsed = parseDebugThreads(payload, 8);
  assert.equal(parsed.currentThreadId, '2');
  assert.equal(parsed.threads.length, 2);
  assert.deepEqual(parsed.threads[0], {
    id: '2', targetId: 'Thread 2', name: 'ControlTask', details: 'FreeRTOS task', state: 'stopped', core: 0, current: true,
    frame: { address: '0x08001020', function: 'ControlTask', file: 'app.c', fullname: 'C:/src/app.c', line: 42 }
  });
  assert.equal(parsed.threads[1]?.current, false);
});

test('debug breakpoint/watchpoint number parser accepts nested MI records and rejects missing numbers', () => {
  assert.equal(parseDebugBreakpointNumber('wpt={number="3",exp="state"}'), 3);
  assert.equal(parseDebugBreakpointNumber('bkpt={number="7",type="hw breakpoint"}'), 7);
  assert.throws(() => parseDebugBreakpointNumber('wpt={exp="state"}'), /valid breakpoint\/watchpoint number/);
});


test('debug MI parser handles nested tuples and escaped strings without regex truncation', () => {
  const payload = 'variables=[{name="msg",arg="0",type="char *",value="hello \\"robot\\" \\\\ path"},{name="nested",arg="0",value="{a={b=1}}"}]';
  assert.deepEqual(parseDebugLocals(payload), [
    { name: 'msg', value: 'hello "robot" \\ path', type: 'char *', argument: false },
    { name: 'nested', value: '{a={b=1}}', argument: false }
  ]);
});

test('debug MI parser fails closed on malformed and over-bounded payloads', () => {
  assert.throws(() => parseDebugLocals('variables=[{name="x",value="1"}'), /Unterminated MI list|Malformed MI/);
  const huge = 'variables=[' + 'x'.repeat(1024 * 1024) + ']';
  assert.throws(() => parseDebugLocals(huge), /exceeds 1 MiB/);
});
