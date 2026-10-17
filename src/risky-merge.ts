import { logger } from './logger.js';
import { findColumn } from './csv-utils.js';
import { readXlsxRows, overwriteXlsxSheet, readMeetscriptResultSheet } from './xlsx-utils.js';

const MASTER_SHEET_NAME = 'Leads';

export interface MergeFileRef {
  kind: 'TEAM' | 'GOOGLE';
  filePath: string;
}

export interface MergeStats {
  updatedCount: number;
  noMatchCount: number;
}

/**
 * Sau khi đã nhận ĐỦ kết quả thật (cả Team lẫn Google, đủ mọi phần đã tách) từ meetscript.io qua
 * Telegram cho 1 job Risky — cập nhật lại cột RESULT trong file Excel GỐC (file team đã đặt tên
 * lúc chạy job Apollo/Debounce), theo đúng quy tắc đã xác nhận:
 *   - Email có kết quả TRUE ở ÍT NHẤT 1 trong 2 bên (Team hoặc Google, hoặc cả 2) -> "Safe to Send".
 *   - Email mà CẢ 2 bên đều FALSE -> "Do not Send".
 *   - Chỉ áp dụng cho row đang có RESULT = "Risky" — không đụng tới các row Safe to Send/Invalid
 *     sẵn có (những row đó chưa từng được upload lên meetscript.io, không có kết quả gì để ghép).
 */
export function mergeRiskyResultsIntoMaster(masterXlsxPath: string, resultFiles: MergeFileRef[]): MergeStats {
  const teamResults = new Map<string, boolean>();
  const googleResults = new Map<string, boolean>();
  for (const file of resultFiles) {
    let sheetResults: Map<string, boolean>;
    try {
      sheetResults = readMeetscriptResultSheet(file.filePath);
    } catch (err) {
      logger.error(`Không đọc được file kết quả "${file.filePath}" — bỏ qua file này khi cập nhật: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const target = file.kind === 'TEAM' ? teamResults : googleResults;
    for (const [email, value] of sheetResults) target.set(email, value);
  }

  const masterRows = readXlsxRows(masterXlsxPath, MASTER_SHEET_NAME);
  if (masterRows.length === 0) {
    logger.warn(`File Excel gốc "${masterXlsxPath}" rỗng — bỏ qua bước cập nhật kết quả Risky.`);
    return { updatedCount: 0, noMatchCount: 0 };
  }
  const emailCol = findColumn(masterRows, ['email']);
  const resultCol = findColumn(masterRows, ['result']);

  let updatedCount = 0;
  let noMatchCount = 0;
  const updatedRows = masterRows.map((row) => {
    if ((row[resultCol] ?? '').trim().toLowerCase() !== 'risky') return row;
    const email = (row[emailCol] ?? '').trim().toLowerCase();
    const teamOk = teamResults.get(email);
    const googleOk = googleResults.get(email);
    if (teamOk === undefined && googleOk === undefined) {
      noMatchCount++;
      return row; // không thấy email này trong cả 2 file kết quả — giữ nguyên "Risky", cần kiểm tra lại tay
    }
    const decision = teamOk === true || googleOk === true ? 'Safe to Send' : 'Do not Send';
    updatedCount++;
    return { ...row, [resultCol]: decision };
  });

  overwriteXlsxSheet(masterXlsxPath, MASTER_SHEET_NAME, updatedRows);
  logger.info(
    `Đã cập nhật ${updatedCount} lead Risky trong file Excel gốc thành "Safe to Send"/"Do not Send" ` +
      `dựa theo kết quả thật Team/Google từ Telegram: ${masterXlsxPath}` +
      (noMatchCount > 0 ? ` (${noMatchCount} lead Risky không khớp được với file kết quả nào, vẫn giữ "Risky", cần kiểm tra tay).` : '.'),
  );
  return { updatedCount, noMatchCount };
}
