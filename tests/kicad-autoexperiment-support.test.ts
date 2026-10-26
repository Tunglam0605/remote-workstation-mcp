import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyKicadProjectSupport } from '../src/adapters/engineering/kicad-autoexperiment-support.js';

test('experiment makes an independent copy of project-local footprint and symbol libraries', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-support-'));
  try {
    const src = path.join(temp, 'project');
    const dst = path.join(temp, 'copy');
    await fs.mkdir(src); await fs.mkdir(dst);
    await fs.mkdir(path.join(src, 'JSTShield.pretty'));
    await fs.writeFile(path.join(src, 'fp-lib-table'), '(fp_lib_table)', 'utf8');
    await fs.writeFile(path.join(src, 'sym-lib-table'), '(sym_lib_table)', 'utf8');
    await fs.writeFile(path.join(src, 'Local.kicad_sym'), '(symbol)', 'utf8');
    await fs.writeFile(path.join(src, 'JSTShield.pretty', 'JST_XH.kicad_mod'), '(footprint "XH")', 'utf8');
    await fs.writeFile(path.join(src, 'secrets.txt'), 'NEVER_COPY', 'utf8');
    const result = await copyKicadProjectSupport(src, dst);
    assert.equal(result.fileCount, 4);
    assert.equal(await fs.readFile(path.join(dst, 'JSTShield.pretty','JST_XH.kicad_mod'), 'utf8'), '(footprint "XH")');
    assert.equal(await fs.readFile(path.join(dst, 'Local.kicad_sym'), 'utf8'), '(symbol)');
    await assert.rejects(fs.stat(path.join(dst, 'secrets.txt')), { code: 'ENOENT' });
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('unsupported library-file volume fails closed', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-kicad-copylimit-'));
  try {
    const src = path.join(temp, 'project'), dst = path.join(temp,'copy');
    await fs.mkdir(src); await fs.mkdir(dst);
    await fs.writeFile(path.join(src, 'Oversize.kicad_sym'), 'x'.repeat(17*1024*1024), 'utf8');
    await assert.rejects(copyKicadProjectSupport(src,dst), /bounded experiment-copy limit/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
