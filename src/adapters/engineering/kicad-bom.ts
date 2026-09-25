export interface KicadBomRow {
  refs: string;
  value: string;
  footprint: string;
  quantity?: number;
  dnp: boolean;
}

export interface KicadBomReport {
  headers: string[];
  rowCount: number;
  totalQuantity: number;
  dnpRows: number;
  rows: KicadBomRow[];
  rowsTruncated: boolean;
}

function parseCsvRows(text: string, maxRows: number): string[][] {
  if (Buffer.byteLength(text, 'utf8') > 4 * 1024 * 1024) throw new Error('KiCad BOM CSV exceeds the 4 MiB parse limit.');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const pushCell = () => {
    if (cell.length > 4096) throw new Error('KiCad BOM cell exceeds the 4096-character limit.');
    row.push(cell);
    if (row.length > 128) throw new Error('KiCad BOM exceeds the 128-column limit.');
    cell = '';
  };
  const pushRow = () => {
    pushCell();
    if (row.some(value => value.length > 0)) rows.push(row);
    row = [];
    if (rows.length > maxRows + 1) return true;
    return false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index += 1; }
        else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"' && cell.length === 0) { quoted = true; continue; }
    if (char === ',') { pushCell(); continue; }
    if (char === '\n') { if (pushRow()) break; continue; }
    if (char === '\r') { if (text[index + 1] === '\n') continue; if (pushRow()) break; continue; }
    cell += char;
  }
  if (quoted) throw new Error('KiCad BOM CSV ended inside a quoted field.');
  if (cell.length || row.length) pushRow();
  return rows;
}

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function truthyDnp(value: string): boolean {
  const normalizedValue = value.trim().toLowerCase();
  return !['', '0', 'false', 'no', 'n'].includes(normalizedValue);
}

export function parseKicadBomCsv(text: string, maxRows = 500): KicadBomReport {
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 5000) throw new Error('KiCad BOM maxRows must be in range 1..5000.');
  const parsed = parseCsvRows(text, maxRows);
  if (parsed.length === 0) return { headers: [], rowCount: 0, totalQuantity: 0, dnpRows: 0, rows: [], rowsTruncated: false };
  const headers = parsed[0]!.map(value => value.trim().slice(0, 128));
  const headerMap = new Map(headers.map((header, index) => [normalized(header), index]));
  const refIndex = headerMap.get('refs') ?? headerMap.get('reference') ?? 0;
  const valueIndex = headerMap.get('value') ?? 1;
  const footprintIndex = headerMap.get('footprint') ?? 2;
  const quantityIndex = headerMap.get('qty') ?? headerMap.get('quantity') ?? 3;
  const dnpIndex = headerMap.get('dnp') ?? 4;
  const sourceRows = parsed.slice(1);
  const rows = sourceRows.slice(0, maxRows).map(columns => {
    const qtyRaw = columns[quantityIndex]?.trim() ?? '';
    const quantity = /^\d+$/.test(qtyRaw) ? Number(qtyRaw) : undefined;
    return {
      refs: (columns[refIndex] ?? '').trim().slice(0, 2048),
      value: (columns[valueIndex] ?? '').trim().slice(0, 2048),
      footprint: (columns[footprintIndex] ?? '').trim().slice(0, 2048),
      ...(Number.isSafeInteger(quantity) ? { quantity } : {}),
      dnp: truthyDnp(columns[dnpIndex] ?? '')
    };
  });
  return {
    headers,
    rowCount: sourceRows.length,
    totalQuantity: rows.reduce((sum, item) => sum + (item.quantity ?? 1), 0),
    dnpRows: rows.filter(item => item.dnp).length,
    rows,
    rowsTruncated: sourceRows.length > rows.length
  };
}
