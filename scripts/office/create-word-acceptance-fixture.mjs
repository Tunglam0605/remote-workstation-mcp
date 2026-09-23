import fs from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';

const dir = path.join(process.env.TEMP ?? process.cwd(), 'rwmcp-word-acceptance');
fs.mkdirSync(dir, { recursive: true });
const enc = strToU8;
const files = {
  '[Content_Types].xml': enc(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`),
  '_rels/.rels': enc(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
  'word/document.xml': enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body><w:p w14:paraId="00ABC123"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>RWMCP Office Acceptance</w:t></w:r></w:p><w:p w14:paraId="00ABC124"><w:r><w:t>Native equation: </w:t></w:r><m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`),
  'word/styles.xml': enc(`<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/></w:style></w:styles>`),
  'word/_rels/document.xml.rels': enc(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`)
};
const output = path.join(dir, 'acceptance.docx');
fs.writeFileSync(output, Buffer.from(zipSync(files, { level: 6 })));
console.log(output);
