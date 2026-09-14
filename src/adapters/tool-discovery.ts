import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PolicyEngine } from '../policy.js';

const KNOWN_TOOLS = [
  'git', 'node', 'npm', 'npx', 'python3', 'python', 'cmake', 'ninja', 'make',
  'docker', 'podman', 'ssh', 'scp', 'rsync', 'openocd', 'gdb', 'arm-none-eabi-gdb',
  'STM32_Programmer_CLI', 'JLinkExe', 'pio', 'idf.py', 'ros2', 'colcon'
];

export interface DiscoveredTool {
  name: string;
  available: boolean;
  resolvedPath?: string;
  policyAllowed: boolean;
}

export class ToolDiscoveryAdapter {
  constructor(private readonly policy: PolicyEngine) {}

  private async resolve(command: string): Promise<string | undefined> {
    if (path.isAbsolute(command) || command.includes(path.sep)) {
      try {
        await fs.access(command, fs.constants.X_OK);
        return command;
      } catch {
        return undefined;
      }
    }

    const directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    const extensions = os.platform() === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];

    for (const directory of directories) {
      for (const extension of extensions) {
        const candidate = path.join(directory, os.platform() === 'win32' ? `${command}${extension}` : command);
        try {
          await fs.access(candidate, fs.constants.X_OK);
          return candidate;
        } catch {
          // Continue searching PATH.
        }
      }
    }
    return undefined;
  }

  async discover(extra: string[] = []): Promise<DiscoveredTool[]> {
    const configured = this.policy.config.process.allowExecutables;
    const candidates = [...new Set([...configured, ...KNOWN_TOOLS, ...extra])].sort((a, b) => a.localeCompare(b));
    const allowedNames = new Set(configured.map(item => path.basename(item).toLowerCase()));
    const results: DiscoveredTool[] = [];
    for (const candidate of candidates) {
      const resolvedPath = await this.resolve(candidate);
      results.push({
        name: candidate,
        available: Boolean(resolvedPath),
        resolvedPath,
        policyAllowed: allowedNames.has(path.basename(candidate).toLowerCase())
      });
    }
    return results;
  }
}
