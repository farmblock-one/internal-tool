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
export function findColumn(rows: Row[], aliases: string[]): string {
  if (rows.length === 0) throw new Error('CSV rỗng, không xác định được cột.');
  const columns = Object.keys(rows[0]);
  const found = columns.find((c) => aliases.some((a) => a.toLowerCase() === c.toLowerCase()));
  if (!found) {
    throw new Error(`Không tìm thấy cột khớp với: ${aliases.join(', ')}. Cột hiện có: ${columns.join(', ')}`);
  }
  return found;
}

/**
 * Giữ lại đúng 2 cột email + RESULT, dùng cho file import ngược lại Apollo. Bỏ hẳn các dòng không
 * có email (Apollo không khớp được với contact nào) hoặc RESULT trống.
 */
export function onlyEmailAndResult(rows: Row[]): Row[] {
  const emailCol = findColumn(rows, ['email']);
  const resultCol = findColumn(rows, ['result']);
  // Bỏ cả dòng có RESULT trống (vd Debounce không trả kết quả cho email đó) — import lên Apollo sẽ
  // xoá mất giá trị DEBOUNCED đang có của contact đó.
  return rows
    .map((r) => ({ email: String(r[emailCol] ?? '').trim(), RESULT: String(r[resultCol] ?? '').trim() }))
    .filter((r) => r.email !== '' && r.RESULT !== '');
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
 * Xoá các row có giá trị 1 cột (so khớp alias, không phân biệt hoa/thường) nằm trong `exclude` —
 * dùng để bỏ các lead có "Email Status" = "Unavailable" TRƯỚC khi gửi qua Debounce (lead này
 * Apollo coi như không có email khả dụng, verify qua Debounce chỉ tốn request vô ích).
 */
export function dropRowsByColumnValue(rows: Row[], columnAliases: string[], exclude: string[]): Row[] {
  const column = findColumn(rows, columnAliases);
  const excludeLower = exclude.map((v) => v.toLowerCase());
  return rows.filter((r) => !excludeLower.includes((r[column] ?? '').toLowerCase()));
}

/**
 * Ghép thêm các cột MỚI từ `extraRows` (vd kết quả Debounce: RESULT/REASON/STATUS CODE/ROLE/
 * FREE/DOMAIN) vào đúng row tương ứng trong `baseRows` (vd file Apollo gốc, đầy đủ cột) theo
 * EMAIL — không theo thứ tự dòng, vì Debounce có thể trả về khác thứ tự với file gửi lên. Cột
 * trùng tên hiếm khi xảy ra (vd lỡ cả 2 bên đều có cột DOMAIN) sẽ bị GHI ĐÈ bởi giá trị từ
 * `extraRows` (coi là thông tin mới hơn). Row bên `baseRows` không tìm được dòng khớp bên
 * `extraRows` vẫn giữ nguyên, không bị loại bỏ (merge, không phải inner join).
 */
export function mergeByEmail(baseRows: Row[], extraRows: Row[]): Row[] {
  if (baseRows.length === 0 || extraRows.length === 0) return baseRows;
  const baseEmailCol = findColumn(baseRows, ['email']);
  const extraEmailCol = findColumn(extraRows, ['email']);
  const extraByEmail = new Map<string, Row>();
  for (const row of extraRows) {
    const email = (row[extraEmailCol] ?? '').trim().toLowerCase();
    if (email) extraByEmail.set(email, row);
  }
  return baseRows.map((row) => {
    const email = (row[baseEmailCol] ?? '').trim().toLowerCase();
    const extra = extraByEmail.get(email);
    if (!extra) return row;
    const newColumns = { ...extra };
    delete newColumns[extraEmailCol]; // đã có cột email riêng từ baseRows, không cần nhân đôi
    return { ...row, ...newColumns };
  });
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

/**
 * File kết quả Debounce đôi khi có CÙNG 1 email ở 2 dòng liền nhau (Debounce tự kiểm tra lại),
 * có lúc 2 kết quả khác nhau (vd "Unknown" rồi "Safe to Send") — đã gặp thực tế: 11/6145 email.
 * Giữ 1 dòng mỗi email: ưu tiên kết quả RÕ RÀNG hơn "Unknown"; cùng mức rõ ràng thì giữ dòng sau.
 */
export function dedupeDebounceResults(rows: Row[]): { rows: Row[]; duplicates: { email: string; results: string[]; kept: string }[] } {
  if (rows.length === 0) return { rows, duplicates: [] };
  const emailCol = findColumn(rows, ['email']);
  const resultCol = findColumn(rows, ['result']);
  const isUnknown = (r: Row) => (r[resultCol] ?? '').trim().toLowerCase() === 'unknown';
  const byEmail = new Map<string, Row>();
  const seen = new Map<string, string[]>();
  const order: string[] = [];
  for (const row of rows) {
    const email = (row[emailCol] ?? '').trim().toLowerCase();
    if (!email) continue;
    const prev = byEmail.get(email);
    seen.set(email, [...(seen.get(email) ?? []), (row[resultCol] ?? '').trim()]);
    if (!prev) {
      order.push(email);
      byEmail.set(email, row);
    } else if (!(isUnknown(row) && !isUnknown(prev))) {
      byEmail.set(email, row);
    }
  }
  const duplicates = [...seen]
    .filter(([, results]) => results.length > 1)
    .map(([email, results]) => ({ email, results, kept: (byEmail.get(email)![resultCol] ?? '').trim() }));
  return { rows: order.map((e) => byEmail.get(e)!), duplicates };
}
