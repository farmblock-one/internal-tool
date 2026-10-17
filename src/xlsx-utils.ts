import fs from 'node:fs';
import * as XLSX from 'xlsx';
import type { Row } from './csv-utils.js';

// ⚠️ `XLSX.readFile` (đọc thẳng từ đường dẫn) CHỈ có trên `default` export của gói này khi import
// kiểu ESM (`import * as XLSX from 'xlsx'`) — gọi `XLSX.readFile(...)` trực tiếp sẽ lỗi "is not a
// function" dù TypeScript không báo lỗi gì (type definition của gói không khớp thực tế lúc chạy).
// Dùng `XLSX.read()` (named export, CÓ hoạt động) kèm tự đọc buffer qua `fs` thay thế.
function readWorkbookFile(filePath: string): XLSX.WorkBook {
  return XLSX.read(fs.readFileSync(filePath));
}

/**
 * Chuyển nguyên 1 bộ row CSV (mọi cột, giữ nguyên tên cột) thành file Excel — dùng để lưu lại
 * "file gốc" sau khi verify Debounce (tất cả lead, mọi cột + cột RESULT) để team tự chỉnh sửa
 * tiếp bằng tay, thay vì tách ra file Safe to Send riêng như trước.
 */
export function writeRowsAsXlsx(filePath: string, rows: Row[], sheetName = 'Data'): void {
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  XLSX.writeFile(workbook, filePath);
}

/**
 * Tạo file Excel đúng định dạng meetscript.io yêu cầu để upload file Risky:
 *   - Sheet đầu tiên (tên gì cũng được, không được trùng "Sheet1"/"Sheet2") chỉ có ĐÚNG 1 cột
 *     "EMAIL" (viết hoa — thử "email" viết thường trước đó không ra kết quả), không kèm cột nào khác.
 *   - Thêm 2 sheet trống tên chính xác "Sheet1" và "Sheet2" theo sau.
 */
export function writeRiskyExcel(filePath: string, emails: string[], dataSheetName = 'Risky'): void {
  const worksheet = XLSX.utils.json_to_sheet(emails.map((email) => ({ EMAIL: email })));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, dataSheetName);
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), 'Sheet1');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), 'Sheet2');
  XLSX.writeFile(workbook, filePath);
}

/** Đọc 1 sheet (hàng đầu tiên = tên cột) thành mảng Row — ngược lại với `writeRowsAsXlsx`. */
export function readXlsxRows(filePath: string, sheetName: string): Row[] {
  const workbook = readWorkbookFile(filePath);
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`File Excel "${filePath}" không có sheet "${sheetName}".`);
  return XLSX.utils.sheet_to_json(sheet, { defval: '' }) as Row[];
}

/**
 * Ghi đè 1 sheet trong file Excel ĐÃ CÓ SẴN (giữ nguyên các sheet khác nếu có) — dùng để cập nhật
 * lại cột RESULT trong file Excel gốc sau khi có kết quả thật Team/Google từ meetscript.io.
 */
export function overwriteXlsxSheet(filePath: string, sheetName: string, rows: Row[]): void {
  const workbook = readWorkbookFile(filePath);
  const worksheet = XLSX.utils.json_to_sheet(rows);
  workbook.Sheets[sheetName] = worksheet;
  if (!workbook.SheetNames.includes(sheetName)) workbook.SheetNames.push(sheetName);
  XLSX.writeFile(workbook, filePath);
}

/**
 * Đọc kết quả thật Team/Google mà bot meetscript.io trả về qua Telegram — nằm ở sheet "Sheet2",
 * KHÔNG có hàng tiêu đề, 3 cột: [số thứ tự, email, "true"/"false" dạng chữ]. Trả về map email
 * (viết thường) -> true/false để tra cứu nhanh.
 */
export function readMeetscriptResultSheet(filePath: string): Map<string, boolean> {
  const workbook = readWorkbookFile(filePath);
  const sheet = workbook.Sheets['Sheet2'];
  if (!sheet) throw new Error(`File kết quả "${filePath}" không có sheet "Sheet2".`);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as unknown[][];
  const results = new Map<string, boolean>();
  for (const row of rows) {
    const email = String(row[1] ?? '').trim().toLowerCase();
    const value = String(row[2] ?? '').trim().toLowerCase();
    if (email) results.set(email, value === 'true');
  }
  return results;
}
