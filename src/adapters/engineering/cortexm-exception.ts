export interface CortexMExceptionFramePlan {
  excReturn: number;
  excReturnHex: string;
  stack: 'msp' | 'psp';
  stackPointer: number;
  stackPointerHex: string;
  returnMode: 'thread' | 'handler';
  basicFrame: boolean;
  floatingPointExtendedFrame: boolean;
  coreFrameAddress: number;
  coreFrameAddressHex: string;
  coreFrameBytes: 32;
}

export interface CortexMExceptionFrame {
  r0: number;
  r1: number;
  r2: number;
  r3: number;
  r12: number;
  lr: number;
  pc: number;
  xpsr: number;
  stackAlignmentPadding: boolean;
}

function u32(value: number): number {
  return value >>> 0;
}

function hex32(value: number): string {
  return `0x${u32(value).toString(16).padStart(8, '0')}`;
}

export function parseCortexMRegisterHex(value: string | undefined, name: string): number {
  if (!value || !/^0x[0-9a-f]{1,8}$/i.test(value)) {
    throw new Error(`Cortex-M register '${name}' is unavailable or not a 32-bit hexadecimal value.`);
  }
  return Number.parseInt(value.slice(2), 16) >>> 0;
}

export function planCortexMExceptionFrame(input: {
  lr: string | undefined;
  msp: string | undefined;
  psp: string | undefined;
}): CortexMExceptionFramePlan {
  const excReturn = parseCortexMRegisterHex(input.lr, 'lr');
  if (((excReturn & 0xff000001) >>> 0) !== 0xff000001) {
    throw new Error(`LR ${hex32(excReturn)} is not a recognized Cortex-M EXC_RETURN value.`);
  }

  const usePsp = (excReturn & (1 << 2)) !== 0;
  const basicFrame = (excReturn & (1 << 4)) !== 0;
  const stackPointer = parseCortexMRegisterHex(usePsp ? input.psp : input.msp, usePsp ? 'psp' : 'msp');
  const fpPrefixBytes = basicFrame ? 0 : 18 * 4;
  const coreFrameAddress = stackPointer + fpPrefixBytes;
  if (!Number.isSafeInteger(coreFrameAddress) || coreFrameAddress > 0xffffffff - 31) {
    throw new Error('Cortex-M exception frame address exceeds the 32-bit address space.');
  }

  return {
    excReturn,
    excReturnHex: hex32(excReturn),
    stack: usePsp ? 'psp' : 'msp',
    stackPointer,
    stackPointerHex: hex32(stackPointer),
    returnMode: (excReturn & (1 << 3)) !== 0 ? 'thread' : 'handler',
    basicFrame,
    floatingPointExtendedFrame: !basicFrame,
    coreFrameAddress,
    coreFrameAddressHex: hex32(coreFrameAddress),
    coreFrameBytes: 32
  };
}

export function decodeCortexMExceptionFrame(hex: string): CortexMExceptionFrame {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('Cortex-M basic exception frame must contain exactly 32 bytes.');
  }
  const bytes = Buffer.from(hex, 'hex');
  const at = (offset: number) => bytes.readUInt32LE(offset) >>> 0;
  const xpsr = at(28);
  return {
    r0: at(0),
    r1: at(4),
    r2: at(8),
    r3: at(12),
    r12: at(16),
    lr: at(20),
    pc: at(24),
    xpsr,
    stackAlignmentPadding: (xpsr & (1 << 9)) !== 0
  };
}
