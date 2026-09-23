import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

export type Row = Record<string, string>;

export function readCsv(filePath: string): Row[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  return parse(content, { columns: true, skip_empty_lines: true }) as Row[];
}

export function writeCsv(filePath: string, rows: Row[]): void {
  const csv = stringify(rows, { header: true });
  fs.writeFileSync(filePath, csv);
}

/** Tìm tên cột thực tế (không phân biệt hoa/thường) khớp với 1 trong các alias cho trước. */
function findColumn(rows: Row[], aliases: string[]): string {
  if (rows.length === 0) throw new Error('CSV rỗng, không xác định được cột.');
  const columns = Object.keys(rows[0]);
  const found = columns.find((c) => aliases.some((a) => a.toLowerCase() === c.toLowerCase()));
  if (!found) {
    throw new Error(`Không tìm thấy cột khớp với: ${aliases.join(', ')}. Cột hiện có: ${columns.join(', ')}`);
  }
  return found;
}

/** Giữ lại đúng 2 cột email + RESULT, dùng cho file import ngược lại Apollo. */
export function onlyEmailAndResult(rows: Row[]): Row[] {
  const emailCol = findColumn(rows, ['email']);
  const resultCol = findColumn(rows, ['result']);
  return rows.map((r) => ({ email: r[emailCol], RESULT: r[resultCol] }));
}

/** Chỉ giữ lại các row có RESULT nằm trong danh sách `keep` (so sánh không phân biệt hoa/thường). */
export function filterByResult(rows: Row[], keep: string[]): Row[] {
  const resultCol = findColumn(rows, ['result']);
  const keepLower = keep.map((k) => k.toLowerCase());
  return rows.filter((r) => keepLower.includes((r[resultCol] ?? '').toLowerCase()));
}
