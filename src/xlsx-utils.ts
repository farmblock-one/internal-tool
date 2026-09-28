import * as XLSX from 'xlsx';
import type { Row } from './csv-utils.js';

/** Đổi danh sách row (đã đọc từ CSV) thành 1 file Excel (.xlsx), 1 sheet duy nhất. */
export function writeXlsx(filePath: string, rows: Row[]): void {
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
  XLSX.writeFile(workbook, filePath);
}
