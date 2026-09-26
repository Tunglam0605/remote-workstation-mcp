import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCortexMExceptionFrame, planCortexMExceptionFrame } from '../src/adapters/engineering/cortexm-exception.js';

function wordsHex(words: number[]): string {
  const buffer = Buffer.alloc(words.length * 4);
  words.forEach((value, index) => buffer.writeUInt32LE(value >>> 0, index * 4));
  return buffer.toString('hex');
}

test('Cortex-M exception frame planner selects PSP and basic frame from EXC_RETURN', () => {
  const plan = planCortexMExceptionFrame({
    lr: '0xfffffffd',
    msp: '0x20001000',
    psp: '0x20002000'
  });
  assert.equal(plan.stack, 'psp');
  assert.equal(plan.stackPointer, 0x20002000);
  assert.equal(plan.coreFrameAddress, 0x20002000);
  assert.equal(plan.basicFrame, true);
  assert.equal(plan.floatingPointExtendedFrame, false);
  assert.equal(plan.returnMode, 'thread');
});

test('Cortex-M exception frame planner skips architectural FP prefix for extended frame', () => {
  const plan = planCortexMExceptionFrame({
    lr: '0xffffffe9',
    msp: '0x20000100',
    psp: '0x20000200'
  });
  assert.equal(plan.stack, 'msp');
  assert.equal(plan.basicFrame, false);
  assert.equal(plan.floatingPointExtendedFrame, true);
  assert.equal(plan.coreFrameAddress, 0x20000100 + 72);
});

test('Cortex-M exception frame decoder reads stacked core registers little-endian', () => {
  const frame = decodeCortexMExceptionFrame(wordsHex([
    0x00000001, 0x00000002, 0x00000003, 0x00000004,
    0x12121212, 0xeeeeeeee, 0x08001235, 0x21000200
  ]));
  assert.deepEqual(frame, {
    r0: 1,
    r1: 2,
    r2: 3,
    r3: 4,
    r12: 0x12121212,
    lr: 0xeeeeeeee,
    pc: 0x08001235,
    xpsr: 0x21000200,
    stackAlignmentPadding: true
  });
});

test('Cortex-M exception frame planner fails closed when LR is not EXC_RETURN', () => {
  assert.throws(() => planCortexMExceptionFrame({
    lr: '0x08001235',
    msp: '0x20001000',
    psp: '0x20002000'
  }), /not a recognized Cortex-M EXC_RETURN/);
});
