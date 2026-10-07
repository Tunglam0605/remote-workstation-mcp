import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import { setupConfigDir } from '../../setup/settings.js';
import type { WindowsUiControlType, WindowsUiLocator } from '../../adapters/windows-semantic-ui.js';

const profileId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const appVersion = z.string().min(1).max(64).regex(/^[0-9]+(?:\.[0-9A-Za-z-]+){1,5}$/);
const controlType = z.enum([
  'button','calendar','checkbox','combobox','custom','dataitem','document','edit','group',
  'header','headeritem','hyperlink','image','list','listitem','menu','menubar','menuitem',
  'pane','progressbar','radiobutton','scrollbar','separator','slider','spinner','splitbutton',
  'statusbar','tab','tabitem','table','text','thumb','titlebar','toolbar','tree','treeitem','window'
]);

const baseLocator = z.object({
  automationId: z.string().min(1).max(256).optional(),
  names: z.array(z.string().min(1).max(256)).min(1).max(8).optional(),
  controlType: controlType.optional(),
  className: z.string().min(1).max(256).optional()
}).strict();

const staticLocator = baseLocator.superRefine((value, ctx) => {
  if (!value.automationId && !value.names?.length) {
    ctx.addIssue({ code: 'custom', message: 'semantic locator requires automationId or exact names' });
  }
});

const dynamicProjectLocator = z.object({
  automationId: z.string().min(1).max(256).optional(),
  controlType: controlType.default('text'),
  className: z.string().min(1).max(256).optional()
}).strict();

const blocker = z.object({
  stage: z.enum(['editor', 'dialog']),
  code: z.enum([
    'login-required',
    'subscription-required',
    'permission-required',
    'update-required',
    'unsupported-dialog'
  ]),
  locator: staticLocator
}).strict();

const fullPathOutput = z.object({
  mode: z.literal('full-path'),
  pathField: staticLocator
}).strict();

const splitOutput = z.object({
  mode: z.literal('directory-and-name'),
  directoryField: staticLocator,
  nameField: staticLocator
}).strict();

const profileSchema = z.object({
  id: profileId,
  label: z.string().min(1).max(128).optional(),
  appVersion,
  locale: z.string().min(2).max(32).optional(),
  activeProject: dynamicProjectLocator,
  editorExportButton: staticLocator,
  output: z.discriminatedUnion('mode', [fullPathOutput, splitOutput]),
  confirmExportButton: staticLocator,
  cancelExportButton: staticLocator,
  blockers: z.array(blocker).max(16).default([])
}).strict();

const configSchema = z.object({
  version: z.literal(1),
  profiles: z.array(profileSchema).max(16)
}).strict();

export type CapCutExportProfile = z.infer<typeof profileSchema>;

export function capcutExportProfilesPath(): string {
  return path.join(setupConfigDir(), 'capcut-export-profiles.json');
}

function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeLocator(locator: z.infer<typeof baseLocator>): WindowsUiLocator {
  return {
    ...(locator.automationId ? { automationId: locator.automationId.trim() } : {}),
    ...(locator.names ? { names: locator.names.map(name => name.trim()) } : {}),
    ...(locator.controlType ? { controlType: locator.controlType as WindowsUiControlType } : {}),
    ...(locator.className ? { className: locator.className.trim() } : {})
  };
}

function normalizeProfile(profile: CapCutExportProfile): CapCutExportProfile {
  const output = profile.output.mode === 'full-path'
    ? { mode: 'full-path' as const, pathField: normalizeLocator(profile.output.pathField) }
    : {
        mode: 'directory-and-name' as const,
        directoryField: normalizeLocator(profile.output.directoryField),
        nameField: normalizeLocator(profile.output.nameField)
      };
  return {
    ...profile,
    id: profile.id.trim(),
    ...(profile.label ? { label: profile.label.trim() } : {}),
    appVersion: profile.appVersion.trim(),
    ...(profile.locale ? { locale: profile.locale.trim() } : {}),
    activeProject: {
      ...(profile.activeProject.automationId ? { automationId: profile.activeProject.automationId.trim() } : {}),
      controlType: profile.activeProject.controlType as WindowsUiControlType,
      ...(profile.activeProject.className ? { className: profile.activeProject.className.trim() } : {})
    },
    editorExportButton: normalizeLocator(profile.editorExportButton),
    output,
    confirmExportButton: normalizeLocator(profile.confirmExportButton),
    cancelExportButton: normalizeLocator(profile.cancelExportButton),
    blockers: profile.blockers.map(item => ({
      stage: item.stage,
      code: item.code,
      locator: normalizeLocator(item.locator)
    }))
  } as CapCutExportProfile;
}

export class CapCutExportProfileStore {
  constructor(private readonly filename = capcutExportProfilesPath()) {}

  async list(): Promise<CapCutExportProfile[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (Buffer.byteLength(raw, 'utf8') > 256 * 1024) throw new Error('CapCut export profile manifest exceeds 256 KiB.');
    const parsed = configSchema.parse(JSON.parse(raw));
    const seen = new Set<string>();
    return parsed.profiles.map(profile => {
      const normalized = normalizeProfile(profile);
      if (seen.has(normalized.id)) throw new Error(`Duplicate CapCut export profile id '${normalized.id}'.`);
      seen.add(normalized.id);
      return normalized;
    });
  }

  async get(id: string): Promise<CapCutExportProfile> {
    const selected = profileId.parse(id);
    const profile = (await this.list()).find(item => item.id === selected);
    if (!profile) throw new Error(`CapCut export profile '${selected}' is not configured.`);
    return profile;
  }

  digest(profile: CapCutExportProfile): string {
    return sha256Text(JSON.stringify(normalizeProfile(profile)));
  }

  publicProfile(profile: CapCutExportProfile) {
    return {
      id: profile.id,
      label: profile.label,
      appVersion: profile.appVersion,
      locale: profile.locale,
      outputMode: profile.output.mode,
      blockerCodes: [...new Set(profile.blockers.map(item => item.code))]
    };
  }

  async publicList() {
    return (await this.list()).map(profile => this.publicProfile(profile));
  }
}
