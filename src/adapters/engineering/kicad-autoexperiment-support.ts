import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_COPY_FILES = 96;
const MAX_COPY_BYTES = 16 * 1024 * 1024;

/**
 * Copy KiCad's project-local library definitions into an isolated experiment.
 * Never follow junctions/symlinks or copy arbitrary paths from library tables.
 */
export async function copyKicadProjectSupport(from: string, to: string) {
  let files = 0;
  let bytes = 0;
  const copyFile = async (source: string, destination: string) => {
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('KiCad library support has a nonregular/symlink file.');
    files += 1; bytes += stat.size;
    if (files > MAX_COPY_FILES || bytes > MAX_COPY_BYTES) throw new Error('KiCad project support files exceed bounded experiment-copy limit.');
    await fs.copyFile(source, destination);
  };
  const allowedFile = (name: string) =>
    name === 'fp-lib-table' || name === 'sym-lib-table' ||
    /\.(?:kicad_sym|kicad_dru|kicad_wks)$/.test(name);
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const name = entry.name;
    if (entry.isSymbolicLink() && (allowedFile(name) || name.endsWith('.pretty'))) {
      throw new Error('KiCad local library support cannot contain symlinks or junctions: ' + name);
    }
    if (entry.isFile() && allowedFile(name)) {
      await copyFile(path.join(from, name), path.join(to, name));
    } else if (entry.isDirectory() && name.endsWith('.pretty')) {
      if (!/^[A-Za-z0-9_.+-]{1,72}\.pretty$/.test(name)) throw new Error('Invalid KiCad project-local library directory.');
      const contents = await fs.readdir(path.join(from, name), { withFileTypes: true });
      const eligible = contents.filter(item => item.name.endsWith('.kicad_mod'));
      if (eligible.some(item => !item.isFile() || item.isSymbolicLink())) {
        throw new Error('KiCad footprint library contains an unsafe/symlink entry.');
      }
      await fs.mkdir(path.join(to, name));
      for (const footprint of eligible) {
        if (!/^[A-Za-z0-9_.+-]{1,128}\.kicad_mod$/.test(footprint.name)) throw new Error('Invalid footprint library filename.');
        await copyFile(path.join(from, name, footprint.name), path.join(to, name, footprint.name));
      }
    }
  }
  return { fileCount: files, totalBytes: bytes };
}
