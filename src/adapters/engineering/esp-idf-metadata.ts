import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_METADATA_BYTES = 2 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function scalar(record: JsonRecord, ...keys: string[]): string | number | boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  }
  return undefined;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function readJson(file: string, maxBytes = MAX_METADATA_BYTES): Promise<{ present: boolean; value?: unknown; warning?: string }> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return { present: false };
    if (stat.size > maxBytes) {
      return { present: true, warning: `${path.basename(file)} exceeds the ${maxBytes}-byte diagnostics limit.` };
    }
    const raw = await fs.readFile(file, 'utf8');
    try {
      return { present: true, value: JSON.parse(raw) as unknown };
    } catch {
      return { present: true, warning: `${path.basename(file)} is not valid JSON.` };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { present: false };
    return { present: false, warning: `Unable to read ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function summarizeProjectDescription(value: unknown) {
  const record = asRecord(value);
  const buildComponents = Array.isArray(record.build_components) ? record.build_components.length : undefined;
  return {
    name: scalar(record, 'project_name', 'projectName'),
    version: scalar(record, 'project_version', 'projectVersion'),
    target: scalar(record, 'target', 'idf_target', 'idfTarget'),
    idfVersion: scalar(record, 'idf_ver', 'idf_version', 'idfVersion'),
    appElf: scalar(record, 'app_elf', 'appElf'),
    sdkconfig: scalar(record, 'sdkconfig'),
    ...(buildComponents !== undefined ? { buildComponentCount: buildComponents } : {})
  };
}

function summarizeFlashArgs(value: unknown) {
  const record = asRecord(value);
  const settings = asRecord(record.flash_settings);
  const filesRecord = asRecord(record.flash_files);
  const files = Object.entries(filesRecord)
    .filter(([, file]) => typeof file === 'string')
    .slice(0, 64)
    .map(([offset, file]) => ({ offset, file: file as string }));
  return {
    settings: {
      mode: scalar(settings, 'flash_mode', 'mode'),
      size: scalar(settings, 'flash_size', 'size'),
      frequency: scalar(settings, 'flash_freq', 'frequency'),
      baud: scalar(record, 'baud')
    },
    files
  };
}

function summarizeSdkconfig(value: unknown) {
  const record = asRecord(value);
  return {
    entryCount: Object.keys(record).length,
    target: scalar(record, 'IDF_TARGET', 'CONFIG_IDF_TARGET'),
    flashMode: scalar(record, 'CONFIG_ESPTOOLPY_FLASHMODE'),
    flashSize: scalar(record, 'CONFIG_ESPTOOLPY_FLASHSIZE'),
    partitionTable: scalar(record, 'CONFIG_PARTITION_TABLE_FILENAME'),
    secureBootEnabled: Boolean(record.CONFIG_SECURE_BOOT || record.CONFIG_SECURE_BOOT_V2_ENABLED),
    flashEncryptionEnabled: Boolean(record.CONFIG_SECURE_FLASH_ENC_ENABLED || record.CONFIG_SECURE_FLASH_ENCRYPTION_MODE_RELEASE)
  };
}

export async function readEspIdfBuildMetadata(projectRoot: string, buildDir = 'build') {
  if (!buildDir.trim() || path.isAbsolute(buildDir) || /[\0\r\n]/.test(buildDir)) {
    throw new Error('ESP-IDF buildDir must be a non-empty relative project path.');
  }
  const candidate = path.resolve(projectRoot, buildDir);
  if (!isInside(projectRoot, candidate)) throw new Error('ESP-IDF buildDir cannot escape the selected project root.');

  let buildRoot: string;
  try {
    buildRoot = await fs.realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        available: false,
        buildDir,
        files: { projectDescription: false, flasherArgs: false, sdkconfig: false },
        warnings: [] as string[]
      };
    }
    throw error;
  }
  if (!isInside(projectRoot, buildRoot)) throw new Error('ESP-IDF buildDir resolves outside the selected project root.');

  const [description, flasher, sdkconfig] = await Promise.all([
    readJson(path.join(buildRoot, 'project_description.json')),
    readJson(path.join(buildRoot, 'flasher_args.json')),
    readJson(path.join(buildRoot, 'config', 'sdkconfig.json'))
  ]);
  const warnings = [description.warning, flasher.warning, sdkconfig.warning].filter((item): item is string => Boolean(item));

  return {
    available: description.present || flasher.present || sdkconfig.present,
    buildDir,
    files: {
      projectDescription: description.present,
      flasherArgs: flasher.present,
      sdkconfig: sdkconfig.present
    },
    ...(description.value !== undefined ? { project: summarizeProjectDescription(description.value) } : {}),
    ...(flasher.value !== undefined ? { flash: summarizeFlashArgs(flasher.value) } : {}),
    ...(sdkconfig.value !== undefined ? { config: summarizeSdkconfig(sdkconfig.value) } : {}),
    warnings
  };
}
