import * as XLSX from 'xlsx';
import type { SheetLine } from './types';

/**
 * Header names we look for, best first. An xClear job report uses `description`;
 * the others cover hand-built spreadsheets and invoice exports.
 */
const DESCRIPTION_HEADERS = [
  'description',
  'goods description',
  'item description',
  'product description',
  'goods',
  'item',
  'product',
  'partno',
  'part no',
  'part number',
];

export class ParseError extends Error {}

/**
 * Read an uploaded .csv / .xlsx / .xls into one row per job line, in file order.
 * Line numbers are 1-based over the DATA rows, matching how a job report is read.
 */
export function parseSheet(buffer: ArrayBuffer): { lines: SheetLine[]; columnUsed: string } {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'array' });
  } catch {
    throw new ParseError('Could not read that file. Upload a .csv, .xlsx or .xls export.');
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new ParseError('That workbook has no sheets in it.');

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], {
    defval: '',
    raw: false,
  });
  if (!rows.length) throw new ParseError('That sheet has a header row but no data rows.');

  const headers = Object.keys(rows[0]);
  const column = pickColumn(headers, rows);
  if (!column) {
    throw new ParseError(
      `Could not find a goods description column. Columns found: ${headers.join(', ')}.`,
    );
  }

  const lines: SheetLine[] = [];
  rows.forEach((row, i) => {
    const value = String(row[column] ?? '').trim();
    if (value) lines.push({ line: i + 1, description: value });
  });

  if (!lines.length) throw new ParseError(`Column "${column}" is empty on every row.`);

  return { lines, columnUsed: column };
}

/**
 * Pick the description column by header name; if none of the known headers are
 * present, fall back to the text column with the most distinct values, which in
 * practice is always the goods description.
 */
function pickColumn(headers: string[], rows: Record<string, unknown>[]): string | null {
  const lower = new Map(headers.map((h) => [h.trim().toLowerCase(), h]));
  for (const candidate of DESCRIPTION_HEADERS) {
    const hit = lower.get(candidate);
    if (hit) return hit;
  }

  let best: string | null = null;
  let bestScore = 0;
  for (const h of headers) {
    const values = rows.map((r) => String(r[h] ?? '').trim()).filter(Boolean);
    if (values.length < rows.length * 0.5) continue;
    // Numeric columns (price, qty, duty) are never the description.
    if (values.every((v) => /^[\d.,\-]+$/.test(v))) continue;

    const avgLength = values.reduce((sum, v) => sum + v.length, 0) / values.length;
    const distinct = new Set(values).size;
    const score = avgLength * Math.log2(distinct + 1);
    if (score > bestScore) {
      best = h;
      bestScore = score;
    }
  }
  return best;
}
