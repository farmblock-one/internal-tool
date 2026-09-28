import * as XLSX from 'xlsx';

/**
 * Tạo file Excel đúng định dạng meetscript.io yêu cầu để upload file Risky:
 *   - Sheet đầu tiên (tên gì cũng được, không được trùng "Sheet1"/"Sheet2") chỉ có ĐÚNG 1 cột
 *     "email", không kèm cột nào khác.
 *   - Thêm 2 sheet trống tên chính xác "Sheet1" và "Sheet2" theo sau.
 */
export function writeRiskyExcel(filePath: string, emails: string[], dataSheetName = 'Risky'): void {
  const worksheet = XLSX.utils.json_to_sheet(emails.map((email) => ({ email })));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, dataSheetName);
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), 'Sheet1');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), 'Sheet2');
  XLSX.writeFile(workbook, filePath);
}
