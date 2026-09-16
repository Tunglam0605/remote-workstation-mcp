export interface FaultRegisterSet {
  cfsr: number;
  hfsr: number;
  dfsr?: number;
  mmfar?: number;
  bfar?: number;
  afsr?: number;
  shcsr?: number;
}

const CFSR_FLAGS: Array<[number, string]> = [
  [0, 'IACCVIOL: instruction access violation'],
  [1, 'DACCVIOL: data access violation'],
  [3, 'MUNSTKERR: MemManage fault on exception return'],
  [4, 'MSTKERR: MemManage fault on exception entry'],
  [5, 'MLSPERR: MemManage lazy FP state preservation fault'],
  [7, 'MMARVALID: MMFAR contains a valid fault address'],
  [8, 'IBUSERR: instruction bus error'],
  [9, 'PRECISERR: precise data bus error'],
  [10, 'IMPRECISERR: imprecise data bus error'],
  [11, 'UNSTKERR: BusFault on exception return'],
  [12, 'STKERR: BusFault on exception entry'],
  [13, 'LSPERR: BusFault lazy FP state preservation fault'],
  [15, 'BFARVALID: BFAR contains a valid fault address'],
  [16, 'UNDEFINSTR: undefined instruction'],
  [17, 'INVSTATE: invalid execution state'],
  [18, 'INVPC: invalid EXC_RETURN'],
  [19, 'NOCP: coprocessor access fault'],
  [24, 'UNALIGNED: unaligned access'],
  [25, 'DIVBYZERO: divide by zero']
];

const HFSR_FLAGS: Array<[number, string]> = [
  [1, 'VECTTBL: vector table read fault'],
  [30, 'FORCED: configurable fault escalated to HardFault'],
  [31, 'DEBUGEVT: debug event caused HardFault']
];

function flags(value: number, table: Array<[number, string]>): string[] {
  return table.filter(([bit]) => (value & (1 << bit)) !== 0).map(([, text]) => text);
}

export function decodeCortexMFault(registers: FaultRegisterSet) {
  const cfsr = registers.cfsr >>> 0;
  const hfsr = registers.hfsr >>> 0;
  const details = [...flags(cfsr, CFSR_FLAGS), ...flags(hfsr, HFSR_FLAGS)];
  const memoryManage = (cfsr & 0xff) !== 0;
  const busFault = (cfsr & 0xff00) !== 0;
  const usageFault = (cfsr & 0xffff0000) !== 0;
  const hardFault = hfsr !== 0;
  return {
    summary: {
      hardFault,
      memoryManage,
      busFault,
      usageFault,
      forcedEscalation: (hfsr & (1 << 30)) !== 0
    },
    registers: {
      ...registers,
      cfsr: cfsr >>> 0,
      hfsr: hfsr >>> 0
    },
    details,
    faultAddresses: {
      mmfar: (cfsr & (1 << 7)) !== 0 ? registers.mmfar : undefined,
      bfar: (cfsr & (1 << 15)) !== 0 ? registers.bfar : undefined
    }
  };
}
