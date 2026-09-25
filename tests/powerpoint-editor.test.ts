import assert from 'node:assert/strict';
import test from 'node:test';
import { editPowerPointPptx } from '../src/office/powerpoint/editor.js';
import { inspectPowerPointPresentation } from '../src/office/powerpoint/inspector.js';
import { readOoxmlPackage } from '../src/office/backends/ooxml/package-reader.js';
import { writeOoxmlPackage } from '../src/office/backends/ooxml/package-writer.js';
import { pptx } from './powerpoint-inspector.test.js';

test('PowerPoint editor changes simple existing title/shape text without altering relationships or run formatting',()=>{const before=readOoxmlPackage(pptx());const beforeRels=new TextDecoder().decode(before.entries.get('ppt/slides/_rels/slide1.xml.rels')!);const edited=editPowerPointPptx(pptx(),[{type:'set_slide_title',slideIndex:1,text:'New Robot Title'},{type:'set_shape_text',slideIndex:1,shapeId:3,text:'Updated body'}]);const inspected=inspectPowerPointPresentation({canonicalPath:'deck.pptx',bytes:edited.bytes});assert.equal(inspected.slides[0]?.title,'New Robot Title');assert.equal(inspected.slides[0]?.shapes.find(x=>x.id===3)?.text,'Updated body');assert.equal(edited.applied.length,2);const after=readOoxmlPackage(edited.bytes);assert.equal(new TextDecoder().decode(after.entries.get('ppt/slides/_rels/slide1.xml.rels')!),beforeRels);const slide=new TextDecoder().decode(after.entries.get('ppt/slides/slide1.xml')!);assert.match(slide,/a:rPr[^>]*b="1"/);});

test('PowerPoint editor fails closed for unknown slide/shape and title ambiguity',()=>{assert.throws(()=>editPowerPointPptx(pptx(),[{type:'set_shape_text',slideIndex:3,shapeId:2,text:'x'}]),/POWERPOINT_SLIDE_NOT_FOUND/);assert.throws(()=>editPowerPointPptx(pptx(),[{type:'set_shape_text',slideIndex:1,shapeId:99,text:'x'}]),/POWERPOINT_SHAPE_NOT_FOUND/);});

test('PowerPoint editor bounds operation batches and text payloads',()=>{assert.throws(()=>editPowerPointPptx(pptx(),Array.from({length:101},()=>({type:'set_slide_title' as const,slideIndex:1,text:'x'}))),/operation count/);assert.throws(()=>editPowerPointPptx(pptx(),[{type:'set_slide_title',slideIndex:1,text:'x'.repeat(1_000_001)}]),/mutation limits/);});


test('PowerPoint editor preserves paragraph properties, bullets and run properties for simple formatted text', () => {
  const pkg = readOoxmlPackage(pptx());
  const original = new TextDecoder().decode(pkg.entries.get('ppt/slides/slide1.xml')!);
  const formatted = original.replace(
    '<a:p><a:r><a:t>Old body</a:t></a:r></a:p>',
    '<a:p><a:pPr algn="ctr"><a:buChar char="?"/></a:pPr><a:r><a:rPr i="1" lang="en-US"/><a:t>Old body</a:t></a:r><a:endParaRPr lang="en-US"/></a:p>'
  );
  const bytes = writeOoxmlPackage(pkg, new Map([['ppt/slides/slide1.xml', new TextEncoder().encode(formatted)]]));
  const edited = editPowerPointPptx(bytes, [{ type: 'set_shape_text', slideIndex: 1, shapeId: 3, text: 'New body' }]);
  const slide = new TextDecoder().decode(readOoxmlPackage(edited.bytes).entries.get('ppt/slides/slide1.xml')!);
  assert.match(slide, /a:pPr[^>]*algn="ctr"/);
  assert.match(slide, /a:buChar[^>]*char="?"/);
  assert.match(slide, /a:rPr[^>]*i="1"[^>]*lang="en-US"/);
  assert.match(slide, /a:endParaRPr[^>]*lang="en-US"/);
  assert.match(slide, /<a:t>New body<\/a:t>/);
});

test('PowerPoint editor refuses paragraph reshaping, mixed-run formatting and hyperlinks instead of flattening them', () => {
  assert.throws(
    () => editPowerPointPptx(pptx(), [{ type: 'set_shape_text', slideIndex: 1, shapeId: 3, text: 'Line one\nLine two' }]),
    /POWERPOINT_FORMAT_COMPLEX.*paragraph count/
  );
  const base = readOoxmlPackage(pptx());
  const slideText = new TextDecoder().decode(base.entries.get('ppt/slides/slide1.xml')!);
  const mixed = slideText.replace('<a:r><a:t>Old body</a:t></a:r>', '<a:r><a:t>Old </a:t></a:r><a:r><a:rPr b="1"/><a:t>body</a:t></a:r>');
  const mixedBytes = writeOoxmlPackage(base, new Map([['ppt/slides/slide1.xml', new TextEncoder().encode(mixed)]]));
  assert.throws(() => editPowerPointPptx(mixedBytes, [{ type: 'set_shape_text', slideIndex: 1, shapeId: 3, text: 'New body' }]), /mixed-run formatting/);

  const hyperlink = slideText.replace('<a:r><a:t>Old body</a:t></a:r>', '<a:r><a:rPr><a:hlinkClick r:id="rIdLink"/></a:rPr><a:t>Old body</a:t></a:r>');
  const hyperlinkBytes = writeOoxmlPackage(base, new Map([['ppt/slides/slide1.xml', new TextEncoder().encode(hyperlink)]]));
  assert.throws(() => editPowerPointPptx(hyperlinkBytes, [{ type: 'set_shape_text', slideIndex: 1, shapeId: 3, text: 'New body' }]), /hyperlink/i);
});
