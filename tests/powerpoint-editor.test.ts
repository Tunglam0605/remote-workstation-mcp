import assert from 'node:assert/strict';
import test from 'node:test';
import { editPowerPointPptx } from '../src/office/powerpoint/editor.js';
import { inspectPowerPointPresentation } from '../src/office/powerpoint/inspector.js';
import { readOoxmlPackage } from '../src/office/backends/ooxml/package-reader.js';
import { pptx } from './powerpoint-inspector.test.js';

test('PowerPoint editor changes existing title/shape text without altering slide relationships',()=>{const before=readOoxmlPackage(pptx());const beforeRels=new TextDecoder().decode(before.entries.get('ppt/slides/_rels/slide1.xml.rels')!);const edited=editPowerPointPptx(pptx(),[{type:'set_slide_title',slideIndex:1,text:'New Robot Title'},{type:'set_shape_text',slideIndex:1,shapeId:3,text:'Line one\nLine two'}]);const inspected=inspectPowerPointPresentation({canonicalPath:'deck.pptx',bytes:edited.bytes});assert.equal(inspected.slides[0]?.title,'New Robot Title');assert.match(inspected.slides[0]?.shapes.find(x=>x.id===3)?.text??'',/Line one/);assert.match(inspected.slides[0]?.shapes.find(x=>x.id===3)?.text??'',/Line two/);assert.equal(edited.applied.length,2);const after=readOoxmlPackage(edited.bytes);assert.equal(new TextDecoder().decode(after.entries.get('ppt/slides/_rels/slide1.xml.rels')!),beforeRels);const slide=new TextDecoder().decode(after.entries.get('ppt/slides/slide1.xml')!);assert.match(slide,/a:rPr[^>]*b="1"/);});

test('PowerPoint editor fails closed for unknown slide/shape and title ambiguity',()=>{assert.throws(()=>editPowerPointPptx(pptx(),[{type:'set_shape_text',slideIndex:3,shapeId:2,text:'x'}]),/POWERPOINT_SLIDE_NOT_FOUND/);assert.throws(()=>editPowerPointPptx(pptx(),[{type:'set_shape_text',slideIndex:1,shapeId:99,text:'x'}]),/POWERPOINT_SHAPE_NOT_FOUND/);});

test('PowerPoint editor bounds operation batches and text payloads',()=>{assert.throws(()=>editPowerPointPptx(pptx(),Array.from({length:101},()=>({type:'set_slide_title' as const,slideIndex:1,text:'x'}))),/operation count/);assert.throws(()=>editPowerPointPptx(pptx(),[{type:'set_slide_title',slideIndex:1,text:'x'.repeat(1_000_001)}]),/mutation limits/);});
