import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EngineeringCommandRunner } from '../../adapters/engineering/command-runner.js';
import { resolveExecutable } from '../../adapters/engineering/executable-resolver.js';
import { resolveExistingProjectPath } from '../../adapters/engineering/project-path.js';
import type { PathGuard } from '../../security/path-guard.js';
import { RemotionPresetStore, resolveRemotionParameters } from './remotion-store.js';

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function sha256File(filename: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filename);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function existingFile(filename: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filename);
    return stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function resolveLocalRemotion(projectRoot: string): Promise<string | undefined> {
  const candidate = path.join(
    projectRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'remotion.cmd' : 'remotion'
  );
  return await existingFile(candidate) ? candidate : undefined;
}

async function resolveBrowserExecutable(): Promise<string | undefined> {
  const override = process.env.RWMCP_REMOTION_BROWSER_EXECUTABLE?.trim();
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('RWMCP_REMOTION_BROWSER_EXECUTABLE must be an absolute path.');
    if (!await existingFile(override)) throw new Error('Configured RWMCP_REMOTION_BROWSER_EXECUTABLE was not found.');
    return override;
  }

  const candidates = process.platform === 'win32'
    ? [
        process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
        process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)']!, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
        process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Chromium', 'Application', 'chrome.exe') : undefined
      ].filter((value): value is string => Boolean(value))
    : [];

  for (const candidate of candidates) {
    if (await existingFile(candidate)) return candidate;
  }

  for (const name of process.platform === 'win32'
    ? ['chrome.exe']
    : ['google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
    const resolved = await resolveExecutable(name).catch(() => undefined);
    if (resolved) return resolved;
  }
  return undefined;
}

export class RemotionRenderAdapter {
  constructor(
    private readonly paths: PathGuard,
    private readonly runner: EngineeringCommandRunner,
    private readonly presets: RemotionPresetStore
  ) {}

  async listPresets() {
    return (await this.presets.list()).map(preset => this.presets.publicPreset(preset));
  }

  private async resolveOutput(workspace: string, projectPath: string, output: string) {
    if (path.isAbsolute(output)) throw new Error('Remotion output must be project-relative.');
    if (path.extname(output).toLowerCase() !== '.mp4') throw new Error('Remotion Phase 4 output must use the .mp4 extension.');
    const projectRoot = await this.paths.resolveExisting(workspace, projectPath);
    const outputAbsolute = await this.paths.resolveForWrite(workspace, path.join(projectPath, output));
    const parentReal = await fs.realpath(path.dirname(outputAbsolute));
    if (!inside(projectRoot, parentReal)) throw new Error('Remotion output parent cannot escape the selected project root.');
    if (await existingFile(outputAbsolute)) throw new Error('Remotion output already exists; render never overwrites an existing artifact.');
    return { projectRoot, outputAbsolute };
  }

  async plan(
    workspace: string,
    projectPath: string,
    presetId: string,
    parameters: Record<string, string | number | boolean>,
    output: string
  ) {
    const preset = await this.presets.get(presetId);
    const resolvedParameters = resolveRemotionParameters(preset, parameters);
    const { projectRoot, outputAbsolute } = await this.resolveOutput(workspace, projectPath, output);
    const entryPoint = await resolveExistingProjectPath(this.paths, workspace, projectPath, preset.entryPoint, 'Remotion entry point');
    const remotion = await resolveLocalRemotion(projectRoot);
    const browser = await resolveBrowserExecutable();

    return {
      preset: this.presets.publicPreset(preset),
      workspace,
      projectPath,
      output,
      entryPoint: path.relative(projectRoot, entryPoint),
      resolvedParameterKeys: Object.keys(resolvedParameters).sort(),
      localRemotionAvailable: Boolean(remotion),
      browserAvailable: Boolean(browser),
      overwritePolicy: 'fail-if-exists',
      outputAbsolute
    };
  }

  async render(
    workspace: string,
    projectPath: string,
    presetId: string,
    parameters: Record<string, string | number | boolean>,
    output: string,
    timeoutMs = 900_000
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 3_600_000) {
      throw new Error('Remotion render timeoutMs must be in range 5000..3600000.');
    }
    const preset = await this.presets.get(presetId);
    const props = resolveRemotionParameters(preset, parameters);
    const { projectRoot, outputAbsolute } = await this.resolveOutput(workspace, projectPath, output);
    const entryPoint = await resolveExistingProjectPath(this.paths, workspace, projectPath, preset.entryPoint, 'Remotion entry point');
    const executable = await resolveLocalRemotion(projectRoot);
    if (!executable) throw new Error('Project-local Remotion CLI is unavailable. Install @remotion/cli in the selected project.');
    const browser = await resolveBrowserExecutable();
    if (!browser) throw new Error('A local Chrome/Chromium executable is required; automatic browser download is not allowed.');

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-remotion-'));
    const propsFile = path.join(tempDir, `${crypto.randomUUID()}.json`);
    let accepted = false;
    try {
      await fs.writeFile(propsFile, JSON.stringify(props), { encoding: 'utf8', flag: 'wx' });
      const args = [
        'render',
        entryPoint,
        preset.compositionId,
        outputAbsolute,
        '--props', propsFile,
        '--codec=h264',
        `--crf=${preset.crf}`,
        `--x264-preset=${preset.x264Preset}`,
        `--concurrency=${preset.concurrency}`,
        '--overwrite=false',
        `--browser-executable=${browser}`,
        '--log=error'
      ];
      const result = await this.runner.run(executable, args, projectRoot, timeoutMs);
      if (result.timedOut) throw new Error('Remotion render timed out.');
      if (result.exitCode !== 0) {
        throw new Error(`Remotion render failed with exit code ${result.exitCode ?? 'null'}: ${result.stderr.slice(-1024)}`);
      }
      const stat = await fs.stat(outputAbsolute);
      if (!stat.isFile() || stat.size <= 0) throw new Error('Remotion reported success but did not create a non-empty MP4 output.');
      const sha256 = await sha256File(outputAbsolute);
      accepted = true;
      return {
        presetId: preset.id,
        compositionId: preset.compositionId,
        output,
        durationMs: result.durationMs,
        bytes: stat.size,
        sha256,
        backend: 'project-local-remotion'
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      if (!accepted) await fs.rm(outputAbsolute, { force: true }).catch(() => undefined);
    }
  }
}
