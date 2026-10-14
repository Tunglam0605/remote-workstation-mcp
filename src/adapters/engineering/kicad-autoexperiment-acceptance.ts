/** Copy and independently revalidate the exact byte-image accepted by the DRC-gated solver. */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { KicadExperimentDrc } from './kicad-autoexperiment.js';
import { copyKicadProjectSupport } from './kicad-autoexperiment-support.js';

export async function stageVerifiedKiCadCandidate(input: {
  targetFolder: string;
  sourceProjectFolder: string;
  pcbFileName: string;
  candidateSource: string;
  projectFile?: string;
  schematicFile?: string;
  expectedDrc: KicadExperimentDrc;
  validate: () => Promise<KicadExperimentDrc>;
}): Promise<void> {
  await fs.mkdir(input.targetFolder, { recursive: false });
  await fs.writeFile(path.join(input.targetFolder, input.pcbFileName), input.candidateSource, 'utf8');
  if (input.projectFile) {
    await fs.copyFile(input.projectFile, path.join(input.targetFolder, path.basename(input.projectFile)));
  }
  if (input.schematicFile) {
    await fs.copyFile(input.schematicFile, path.join(input.targetFolder, path.basename(input.schematicFile)));
  }
  await copyKicadProjectSupport(input.sourceProjectFolder, input.targetFolder);
  const current = await input.validate();
  const expected = input.expectedDrc;
  if (current.violations !== expected.violations ||
    current.unconnected !== expected.unconnected ||
    current.schematicParity !== expected.schematicParity ||
    current.errors !== expected.errors) {
    throw new Error('Isolated KiCad experiment final-board DRC disagrees with the accepted candidate; refusing result.');
  }
  const actualText = await fs.readFile(path.join(input.targetFolder, input.pcbFileName), 'utf8');
  if (actualText !== input.candidateSource) {
    throw new Error('KiCad experiment final-board source bytes changed while being validated.');
  }
}
