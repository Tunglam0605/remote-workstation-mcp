import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FirmwareAdapter } from '../src/adapters/engineering/firmware.js';
import { EngineeringResourceManager } from '../src/adapters/engineering/resource-manager.js';
import type { EngineeringCommandResult } from '../src/engineering/types.js';
import type { PolicyConfig } from '../src/model.js';
import { PolicyEngine } from '../src/policy.js';
import { PathGuard } from '../src/security/path-guard.js';

function policy(root: string): PolicyConfig {
  return {
    version: 1,
    mode: 'workspace',
    workspaces: [{ id: 'w', root, readOnly: false }],
    filesystem: { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 },
    process: { allowExecutables: [], inheritEnv: ['PATH', 'HOME', 'TEMP', 'TMP'], maxOutputBytes: 65536, maxRuntimeMs: 60000 },
    engineering: { enabled: true, maxCommandRuntimeMs: 60000, allowHardwareMutationInWorkspace: false, allowSerialWriteInWorkspace: false }
  };
}

test('Keil build returns structured target/toolchain/license/diagnostic/artifact summary', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-keil-summary-'));
  const oldOverride = process.env.RWMCP_KEIL_UVISION_EXECUTABLE;
  try {
    const uv4 = path.join(root, 'UV4.exe');
    await fs.writeFile(uv4, 'fake');
    process.env.RWMCP_KEIL_UVISION_EXECUTABLE = uv4;

    await fs.writeFile(path.join(root, 'Main.uvprojx'), `<?xml version="1.0"?>
<Project><Targets><Target><TargetName>Main</TargetName><TargetOption><TargetCommonOption>
<Device>STM32F407ZETx</Device><OutputDirectory>.\\Objects\\</OutputDirectory><OutputName>Main</OutputName><CreateHexFile>1</CreateHexFile>
</TargetCommonOption></TargetOption></Target></Targets></Project>`);
    await fs.mkdir(path.join(root, 'Objects'), { recursive: true });
    await fs.writeFile(path.join(root, 'Objects', 'Main.axf'), 'AXF');

    const log = [
      "*** Using Compiler 'V6.21', folder: 'C:\\Keil_v5\\ARM\\ARMCLANG\\Bin'",
      'License checkout successful',
      '..\\Src\\main.c(42): warning:  #177-D: variable "temp" was declared but never referenced',
      '0 Error(s), 1 Warning(s)'
    ].join('\n');

    const runner = {
      async run(program: string, args: string[], cwd: string): Promise<EngineeringCommandResult> {
        const logArg = args.find(arg => arg.startsWith('-o'));
        if (logArg) await fs.writeFile(logArg.slice(2), log, 'utf8');
        return { program, args: [...args], cwd, exitCode: 1, stdout: '', stderr: '', timedOut: false, durationMs: 5 };
      }
    };

    const engine = new PolicyEngine(policy(root));
    const firmware = new FirmwareAdapter(
      engine,
      new PathGuard(engine),
      runner as never,
      new EngineeringResourceManager('owner'),
      { async list() { return []; } } as never
    );

    const status = await firmware.providerStatus('keil');
    assert.equal(status.available, true);
    assert.equal(status.licenseStatus, 'unknown');

    const built = await firmware.build('w', '.', 'keil', 'Objects', 'Main.uvprojx', 'Main');
    assert.equal(built.provider, 'keil');
    assert.equal(built.keil?.target.projectFile, 'Main.uvprojx');
    assert.equal(built.keil?.target.targetName, 'Main');
    assert.equal(built.keil?.target.device, 'STM32F407ZETx');
    assert.equal(built.keil?.toolchain.family, 'armclang');
    assert.equal(built.keil?.toolchain.version, '6.21');
    assert.equal(built.keil?.license.status, 'ok');
    assert.equal(built.keil?.counts.errors, 0);
    assert.equal(built.keil?.counts.warnings, 1);
    assert.equal(built.keil?.diagnostics[0]?.code, '#177-D');
    assert.equal(built.keil?.artifact.expectedPath, 'Objects/Main.axf');
    assert.equal(built.keil?.artifact.expectedHexPath, 'Objects/Main.hex');
    assert.equal(built.keil?.artifact.exists, true);
    assert.equal(built.keil?.artifact.size, 3);
  } finally {
    if (oldOverride === undefined) delete process.env.RWMCP_KEIL_UVISION_EXECUTABLE;
    else process.env.RWMCP_KEIL_UVISION_EXECUTABLE = oldOverride;
    await fs.rm(root, { recursive: true, force: true });
  }
});
