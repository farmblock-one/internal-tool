import fs from 'node:fs';
import path from 'node:path';
import { openPersistentChrome } from './browser.js';
import { exportListEmails, importCsv } from './apollo.js';
import { verifyListViaApi } from './debounce.js';
import { readCsv, writeCsv, onlyEmailAndResult, filterByResult, dropColumns, dropRowsByColumnValue } from './csv-utils.js';
import { writeRowsAsXlsx } from './xlsx-utils.js';
import { buildOutputXlsxPath } from './filename-utils.js';
import { logger } from './logger.js';
import { captureCrashDiagnostics } from './diagnostics.js';

const DOWNLOAD_DIR = path.resolve('data/downloads');
const PROCESSED_DIR = path.resolve('data/processed');

for (const dir of [DOWNLOAD_DIR, PROCESSED_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

export interface FlowResult {
  rawExportPath: string;
  debounceResultPath: string;
  reimportPath: string;
  masterXlsxPath: string;
  riskyPath: string;
}

/**
 * Chrome đôi khi tự đóng/crash không rõ nguyên nhân giữa lúc Apollo đang xử lý export (lỗi
 * không ổn định, không phải lúc nào cũng xảy ra). Thay vì để cả luồng dừng hẳn, thử lại từ đầu
 * bước export (mở context mới) tối đa `maxAttempts` lần trước khi thật sự báo lỗi.
 */
async function exportWithRetry(listUrl: string, downloadDir: string, maxAttempts = 3): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const context = await openPersistentChrome();
    try {
      if (attempt > 1) logger.warn(`Thử lại export Apollo — lần ${attempt}/${maxAttempts}...`);
      return await exportListEmails(context, listUrl, downloadDir);
    } catch (err) {
      lastErr = err;
      logger.warn(`Export Apollo lần ${attempt} thất bại: ${err instanceof Error ? err.message : String(err)}`);
      try {
        const diagPath = captureCrashDiagnostics(`export-attempt${attempt}`);
        logger.warn(`Đã lưu thông tin chẩn đoán (RAM, log OOM, chrome_debug.log...) tại: ${diagPath}`);
      } catch (diagErr) {
        logger.warn(`Không chụp được thông tin chẩn đoán: ${diagErr instanceof Error ? diagErr.message : String(diagErr)}`);
      }
    } finally {
      await context.close().catch(() => {});
    }
  }
  throw lastErr;
}

export async function runFlow(apolloListUrl: string, outputFileName?: string): Promise<FlowResult> {
  // 1-2. Apollo: xoá filter, chọn tất cả, export email -> tải file CSV thô (tự thử lại nếu Chrome crash)
  const rawExportPath = await exportWithRetry(apolloListUrl, DOWNLOAD_DIR);

  // 2.5a. Trước khi gửi qua Debounce, bỏ hẳn các lead có "Email Status" = "Unavailable" — Apollo
  // coi như các lead này không có email khả dụng, gửi qua Debounce verify chỉ tốn request vô ích.
  const rawRows = readCsv(rawExportPath);
  const availableRows = dropRowsByColumnValue(rawRows, ['Email Status'], ['Unavailable']);
  logger.info(
    `Đã bỏ ${rawRows.length - availableRows.length} lead có Email Status = Unavailable ` +
      `(còn lại ${availableRows.length}/${rawRows.length}).`,
  );

  // 2.5b. Bỏ 2 cột "Contact Owner" và "Account Owner" khỏi file export.
  const cleanedRows = dropColumns(availableRows, ['Contact Owner', 'Account Owner']);
  const cleanedExportPath = path.join(PROCESSED_DIR, `apollo-export-cleaned-${Date.now()}.csv`);
  writeCsv(cleanedExportPath, cleanedRows);
  logger.info(`Đã xoá cột Contact Owner/Account Owner: ${cleanedExportPath}`);

  // 3. Verify email qua Debounce -> file có thêm cột RESULT
  const debounceResultPath = await verifyListViaApi(cleanedExportPath, PROCESSED_DIR);

  return runFromDebounceResult(debounceResultPath, rawExportPath, outputFileName);
}

/**
 * Chạy phần còn lại của luồng (bước 4 trở đi) từ 1 file kết quả Debounce ĐÃ CÓ SẴN trên đĩa —
 * dùng để chạy lại/test riêng phần sau mà không phải export Apollo + verify Debounce lại từ đầu
 * (2 bước đó tốn nhiều phút, không cần lặp lại mỗi lần chỉ sửa lỗi ở các bước sau).
 */
export async function runFromDebounceResult(
  debounceResultPath: string,
  rawExportPath = debounceResultPath,
  outputFileName?: string,
): Promise<FlowResult> {
  const debounceRows = readCsv(debounceResultPath);

  // 4. File để import ngược lại Apollo: chỉ giữ cột email + RESULT, TẤT CẢ các row
  const reimportRows = onlyEmailAndResult(debounceRows);
  const reimportPath = path.join(PROCESSED_DIR, `apollo-reimport-${Date.now()}.csv`);
  writeCsv(reimportPath, reimportRows);

  const importContext = await openPersistentChrome();
  try {
    await importCsv(importContext, reimportPath, DOWNLOAD_DIR);
  } finally {
    await importContext.close();
  }

  // 5. Giữ nguyên "file gốc" sau Debounce (TẤT CẢ row, mọi cột + cột RESULT) dạng Excel, đặt tên
  // theo `outputFileName` team nhập — để team tự chỉnh sửa tiếp bằng tay sau này (không còn tách
  // riêng file Safe to Send như trước).
  const masterXlsxPath = buildOutputXlsxPath(PROCESSED_DIR, outputFileName);
  writeRowsAsXlsx(masterXlsxPath, debounceRows, 'Leads');
  logger.info(`Đã lưu file gốc sau Debounce dạng Excel: ${masterXlsxPath}`);

  // 6. Vẫn tách riêng các lead Risky ra 1 file CSV riêng để xử lý tiếp (luồng Teams/Gmail/meetscript.io).
  const riskyRows = filterByResult(debounceRows, ['Risky']);
  const riskyPath = path.join(PROCESSED_DIR, `risky-${Date.now()}.csv`);
  writeCsv(riskyPath, riskyRows);

  logger.info(`Hoàn tất luồng. File Excel: ${masterXlsxPath}. File Risky chờ xử lý tiếp (luồng nội bộ khác): ${riskyPath}`);
  return { rawExportPath, debounceResultPath, reimportPath, masterXlsxPath, riskyPath };
}
