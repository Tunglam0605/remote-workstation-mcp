import path from 'node:path';
import { PolicyEngine } from '../policy.js';
import { resolveExecutablePath } from './executable-resolver.js';

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

  async discover(extra: string[] = []): Promise<DiscoveredTool[]> {
    const configured = this.policy.config.process.allowExecutables;
    const candidates = [...new Set([...configured, ...KNOWN_TOOLS, ...extra])].sort((a, b) => a.localeCompare(b));
    const allowedNames = new Set(configured.map(item => path.basename(item).toLowerCase()));
    const results: DiscoveredTool[] = [];
    for (const candidate of candidates) {
      const resolvedPath = await resolveExecutablePath(candidate);
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
