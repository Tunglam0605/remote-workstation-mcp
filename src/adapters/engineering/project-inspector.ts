import fs from 'node:fs/promises';
import path from 'node:path';
import type { FirmwareFramework, FirmwareProjectInfo } from '../../engineering/types.js';
import { PathGuard } from '../../security/path-guard.js';

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

async function firstBySuffix(root: string, suffix: string): Promise<string | undefined> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const match = entries.find(entry => entry.isFile() && entry.name.toLowerCase().endsWith(suffix));
  return match ? path.join(root, match.name) : undefined;
}

function parseStm32Ioc(text: string): { target?: string; board?: string } {
  const target = text.match(/^Mcu\.Name=(.+)$/m)?.[1]?.trim()
    ?? text.match(/^Mcu\.Family=(.+)$/m)?.[1]?.trim();
  const board = text.match(/^Board=(.+)$/m)?.[1]?.trim();
  return { target, board };
}

function parseEspTarget(text: string): string | undefined {
  return text.match(/^CONFIG_IDF_TARGET="?([^"\r\n]+)"?/m)?.[1]?.trim();
}

export class FirmwareProjectInspector {
  constructor(private readonly paths: PathGuard) {}

  async inspect(workspace: string, projectPath = '.'): Promise<FirmwareProjectInfo> {
    const root = await this.paths.resolveExisting(workspace, projectPath);
    const markers: string[] = [];
    let family: FirmwareProjectInfo['family'] = 'unknown';
    let framework: FirmwareFramework = 'unknown';
    let target: string | undefined;
    let board: string | undefined;
    let buildSystem: string | undefined;

    const cmake = path.join(root, 'CMakeLists.txt');
    const sdkconfig = path.join(root, 'sdkconfig');
    const idfYml = path.join(root, 'idf_component.yml');
    const makefile = path.join(root, 'Makefile');
    const packageXml = path.join(root, 'package.xml');
    const dockerfile = path.join(root, 'Dockerfile');
    const compose = path.join(root, 'docker-compose.yml');
    const composeYaml = path.join(root, 'compose.yaml');
    const ioc = await firstBySuffix(root, '.ioc');

    if (await exists(cmake)) {
      markers.push('CMakeLists.txt');
      buildSystem = 'cmake';
      framework = 'cmake';
      const text = await fs.readFile(cmake, 'utf8').catch(() => '');
      if (/IDF_PATH|project\.cmake|idf_component_register/i.test(text)) {
        family = 'esp32';
        framework = 'esp-idf';
      }
    }
    if (await exists(sdkconfig)) {
      markers.push('sdkconfig');
      const text = await fs.readFile(sdkconfig, 'utf8').catch(() => '');
      target = parseEspTarget(text) ?? target;
      family = 'esp32';
      framework = 'esp-idf';
      buildSystem = 'idf.py';
    }
    if (await exists(idfYml)) {
      markers.push('idf_component.yml');
      if (family === 'unknown') {
        family = 'esp32';
        framework = 'esp-idf';
        buildSystem = 'idf.py';
      }
    }
    if (ioc) {
      markers.push(path.basename(ioc));
      const text = await fs.readFile(ioc, 'utf8').catch(() => '');
      const parsed = parseStm32Ioc(text);
      target = parsed.target ?? target;
      board = parsed.board;
      family = 'stm32';
      framework = 'stm32-cube';
      buildSystem ??= (await exists(cmake)) ? 'cmake' : (await exists(makefile)) ? 'make' : undefined;
    }
    if (await exists(makefile)) {
      markers.push('Makefile');
      buildSystem ??= 'make';
      if (family === 'unknown') {
        family = 'generic-embedded';
        framework = 'make';
      }
    }
    const ros2 = await exists(packageXml);
    if (ros2) markers.push('package.xml');
    const docker = await exists(dockerfile) || await exists(compose) || await exists(composeYaml);
    if (docker) markers.push('docker');

    return { workspace, projectPath, family, framework, target, board, buildSystem, markers, ros2, docker };
  }
}

export function stm32OpenOcdTargetConfig(target?: string): string | undefined {
  const upper = (target ?? '').toUpperCase();
  if (/STM32F0/.test(upper)) return 'target/stm32f0x.cfg';
  if (/STM32F1/.test(upper)) return 'target/stm32f1x.cfg';
  if (/STM32F2/.test(upper)) return 'target/stm32f2x.cfg';
  if (/STM32F3/.test(upper)) return 'target/stm32f3x.cfg';
  if (/STM32F4/.test(upper)) return 'target/stm32f4x.cfg';
  if (/STM32F7/.test(upper)) return 'target/stm32f7x.cfg';
  if (/STM32H7/.test(upper)) return 'target/stm32h7x.cfg';
  if (/STM32G0/.test(upper)) return 'target/stm32g0x.cfg';
  if (/STM32G4/.test(upper)) return 'target/stm32g4x.cfg';
  if (/STM32L0/.test(upper)) return 'target/stm32l0.cfg';
  if (/STM32L1/.test(upper)) return 'target/stm32l1.cfg';
  if (/STM32L4/.test(upper)) return 'target/stm32l4x.cfg';
  if (/STM32U5/.test(upper)) return 'target/stm32u5x.cfg';
  if (/STM32WB/.test(upper)) return 'target/stm32wbx.cfg';
  return undefined;
}
