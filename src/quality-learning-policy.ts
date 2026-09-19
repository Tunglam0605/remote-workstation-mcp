import fs from 'node:fs/promises';
import path from 'node:path';
import { setupConfigDir } from './setup/settings.js';

export interface QualityLearningSettings {
  version: 1;
  enabled: boolean;
  retentionDays: number;
  maxObservations: number;
  minApprovedSamples: number;
  minScore: number;
}

export interface QualityLearningSettingsStoreOptions {
  file?: string;
}

export const DEFAULT_QUALITY_LEARNING_SETTINGS: QualityLearningSettings = {
  version: 1,
  enabled: true,
  retentionDays: 30,
  maxObservations: 2000,
  minApprovedSamples: 3,
  minScore: 0.75
};

function boundedSettings(value: Partial<QualityLearningSettings>): QualityLearningSettings {
  const retentionDays = Number(value.retentionDays ?? DEFAULT_QUALITY_LEARNING_SETTINGS.retentionDays);
  const maxObservations = Number(value.maxObservations ?? DEFAULT_QUALITY_LEARNING_SETTINGS.maxObservations);
  const minApprovedSamples = Number(value.minApprovedSamples ?? DEFAULT_QUALITY_LEARNING_SETTINGS.minApprovedSamples);
  const minScore = Number(value.minScore ?? DEFAULT_QUALITY_LEARNING_SETTINGS.minScore);

  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error('retentionDays must be an integer from 1 to 3650.');
  }
  if (!Number.isInteger(maxObservations) || maxObservations < 100 || maxObservations > 10_000) {
    throw new Error('maxObservations must be an integer from 100 to 10000.');
  }
  if (!Number.isInteger(minApprovedSamples) || minApprovedSamples < 1 || minApprovedSamples > 100) {
    throw new Error('minApprovedSamples must be an integer from 1 to 100.');
  }
  if (!Number.isFinite(minScore) || minScore < 0.5 || minScore > 1) {
    throw new Error('minScore must be from 0.5 to 1.0.');
  }

  return {
    version: 1,
    enabled: value.enabled !== false,
    retentionDays,
    maxObservations,
    minApprovedSamples,
    minScore
  };
}

export class QualityLearningSettingsStore {
  private readonly file: string;

  constructor(options: QualityLearningSettingsStoreOptions = {}) {
    this.file = options.file ?? path.join(setupConfigDir(), 'quality-learning-settings.json');
  }

  async load(): Promise<QualityLearningSettings> {
    try {
      const parsed = JSON.parse((await fs.readFile(this.file, 'utf8')).replace(/^\uFEFF/, '')) as Partial<QualityLearningSettings>;
      if (parsed.version !== 1) throw new Error(`Invalid quality learning settings at '${this.file}'.`);
      return boundedSettings(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return structuredClone(DEFAULT_QUALITY_LEARNING_SETTINGS);
      }
      throw error;
    }
  }

  async update(patch: Partial<Omit<QualityLearningSettings, 'version'>>): Promise<QualityLearningSettings> {
    const current = await this.load();
    const next = boundedSettings({ ...current, ...patch, version: 1 });
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, this.file);
    if (process.platform !== 'win32') await fs.chmod(this.file, 0o600);
    return structuredClone(next);
  }
}
