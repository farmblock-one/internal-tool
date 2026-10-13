import * as XLSX from 'xlsx';
import type { Row } from './csv-utils.js';

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
