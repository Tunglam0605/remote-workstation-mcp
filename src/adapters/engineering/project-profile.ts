import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import * as z from 'zod/v4';
import { PolicyEngine } from '../../policy.js';
import { PathGuard } from '../../security/path-guard.js';

export type EngineeringProjectKind = 'stm32' | 'esp-idf' | 'ros2' | 'mixed' | 'generic';

export interface EngineeringFirmwareProfile {
  buildProvider?: 'auto' | 'esp-idf' | 'cmake' | 'make';
  buildDir?: string;
  flashProvider?: 'auto' | 'openocd' | 'esp-idf';
  artifact?: string;
  port?: string;
  probeSerial?: string;
  targetConfig?: string;
  adapterSpeedKhz?: number;
  monitor?: {
    port?: string;
    baudRate?: number;
  };
}

export interface EngineeringRos2Profile {
  distro?: string;
  cwd?: string;
  workspaceSetup?: string;
  domainId?: number;
}

export interface EngineeringProjectProfile {
  version: 1;
  id: string;
  name?: string;
  kind: EngineeringProjectKind;
  firmware?: EngineeringFirmwareProfile;
  ros2?: EngineeringRos2Profile;
}

const relativePath = z.string().min(1).max(512);

const profileSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().min(1).max(160).optional(),
  kind: z.enum(['stm32', 'esp-idf', 'ros2', 'mixed', 'generic']).default('generic'),
  firmware: z.object({
    buildProvider: z.enum(['auto', 'esp-idf', 'cmake', 'make']).default('auto'),
    buildDir: relativePath.default('build'),
    flashProvider: z.enum(['auto', 'openocd', 'esp-idf']).default('auto'),
    artifact: relativePath.optional(),
    port: z.string().min(1).max(256).optional(),
    probeSerial: z.string().min(1).max(256).optional(),
    targetConfig: z.string().min(1).max(256).optional(),
    adapterSpeedKhz: z.number().int().min(50).max(24000).optional(),
    monitor: z.object({
      port: z.string().min(1).max(256).optional(),
      baudRate: z.number().int().min(300).max(12_000_000).default(115200)
    }).optional()
  }).optional(),
  ros2: z.object({
    distro: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),
    cwd: relativePath.default('.'),
    workspaceSetup: relativePath.optional(),
    domainId: z.number().int().min(0).max(232).optional()
  }).optional()
});

function assertRelative(value: string | undefined, label: string): void {
  if (!value) return;
  if (path.isAbsolute(value)) throw new Error(`${label} must be relative to the selected project root.`);
  const segments = value.split(/[\\/]+/);
  if (segments.includes('..')) throw new Error(`${label} must not escape the selected project root.`);
}

function validatePaths(profile: EngineeringProjectProfile): void {
  assertRelative(profile.firmware?.buildDir, 'firmware.buildDir');
  assertRelative(profile.firmware?.artifact, 'firmware.artifact');
  assertRelative(profile.ros2?.cwd, 'ros2.cwd');
  assertRelative(profile.ros2?.workspaceSetup, 'ros2.workspaceSetup');
}

function manifestRelative(projectPath: string): string {
  return path.join(projectPath, '.rwmcp', 'project.yaml');
}

export class EngineeringProjectProfileStore {
  constructor(private readonly policy: PolicyEngine, private readonly paths: PathGuard) {}

  parse(raw: string): EngineeringProjectProfile {
    const parsed = profileSchema.parse(YAML.parse(raw)) as EngineeringProjectProfile;
    validatePaths(parsed);
    return parsed;
  }

  async load(workspace: string, projectPath = '.'): Promise<{
    found: boolean;
    manifestPath: string;
    profile?: EngineeringProjectProfile;
  }> {
    await this.paths.resolveExisting(workspace, projectPath);
    const relative = manifestRelative(projectPath);
    try {
      const manifest = await this.paths.resolveExisting(workspace, relative);
      const raw = await fs.readFile(manifest, 'utf8');
      return { found: true, manifestPath: relative, profile: this.parse(raw) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { found: false, manifestPath: manifestRelative(projectPath) };
      }
      throw error;
    }
  }

  async write(workspace: string, projectPath: string, profile: EngineeringProjectProfile, overwrite = false): Promise<{
    manifestPath: string;
    profile: EngineeringProjectProfile;
  }> {
    this.policy.assertWrite(workspace);
    const normalized = profileSchema.parse(profile) as EngineeringProjectProfile;
    validatePaths(normalized);
    const projectRoot = await this.paths.resolveExisting(workspace, projectPath);
    const metadataDir = path.join(projectRoot, '.rwmcp');
    await fs.mkdir(metadataDir, { recursive: true });
    const relative = manifestRelative(projectPath);
    const target = await this.paths.resolveForWrite(workspace, relative);
    if (!overwrite) {
      try {
        await fs.access(target);
        throw new Error(`Engineering project profile already exists at '${relative}'. Use overwrite=true to replace it.`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const serialized = YAML.stringify(normalized, { lineWidth: 120 });
    await fs.writeFile(target, serialized, 'utf8');
    return { manifestPath: relative, profile: normalized };
  }
}
