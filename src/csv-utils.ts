import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

export type Row = Record<string, string>;

export function readCsv(filePath: string): Row[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  // Nhiều dịch vụ (vd Debounce) xuất CSV có BOM ở đầu file — nếu không xử lý, tên cột đầu tiên
  // sẽ dính thêm 1 ký tự vô hình (vd "﻿EMAIL" thay vì "EMAIL"), khiến so khớp tên cột thất
  // bại dù nhìn ra màn hình thấy giống hệt nhau. `bom: true` tự bóc ký tự đó trước khi parse.
  return parse(content, { columns: true, skip_empty_lines: true, bom: true }) as Row[];
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

/** Lấy ra danh sách email (chỉ giá trị, không kèm cột nào khác) — dùng cho file Excel upload Risky. */
export function extractEmails(rows: Row[]): string[] {
  if (rows.length === 0) return [];
  const emailCol = findColumn(rows, ['email']);
  return rows.map((r) => r[emailCol]);
}

/** Chỉ giữ lại các row có RESULT nằm trong danh sách `keep` (so sánh không phân biệt hoa/thường). */
export function filterByResult(rows: Row[], keep: string[]): Row[] {
  const resultCol = findColumn(rows, ['result']);
  const keepLower = keep.map((k) => k.toLowerCase());
  return rows.filter((r) => keepLower.includes((r[resultCol] ?? '').toLowerCase()));
}

/**
 * Xoá hẳn 1 số cột khỏi toàn bộ rows (so tên không phân biệt hoa/thường) — dùng để bỏ các cột
 * không cần gửi qua Debounce (vd "Contact Owner", "Account Owner"). Cột nào không có trong file
 * thì bỏ qua, không báo lỗi (không phải mọi export đều chắc chắn có đủ các cột này).
 */
export function dropColumns(rows: Row[], columnNames: string[]): Row[] {
  if (rows.length === 0) return rows;
  const toDropLower = new Set(columnNames.map((c) => c.toLowerCase()));
  return rows.map((row) => {
    const cleaned: Row = {};
    for (const [key, value] of Object.entries(row)) {
      if (!toDropLower.has(key.toLowerCase())) cleaned[key] = value;
    }
    return cleaned;
  });
}
