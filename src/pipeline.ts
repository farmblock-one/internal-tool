import fs from 'node:fs';
import path from 'node:path';
import { openPersistentChrome } from './browser.js';
import { exportListEmails, importCsv } from './apollo.js';
import { verifyListViaApi } from './debounce.js';
import { readCsv, writeCsv, onlyEmailAndResult, filterByResult } from './csv-utils.js';
import { uploadToDrive } from './drive.js';
import { config } from './config.js';
import { logger } from './logger.js';

const DOWNLOAD_DIR = path.resolve('data/downloads');
const PROCESSED_DIR = path.resolve('data/processed');

for (const dir of [DOWNLOAD_DIR, PROCESSED_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

export interface FlowResult {
  rawExportPath: string;
  debounceResultPath: string;
  reimportPath: string;
  safePath: string;
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
    } finally {
      await context.close().catch(() => {});
    }
  }
  throw lastErr;
}

export async function runFlow(apolloListUrl: string): Promise<FlowResult> {
  // 1-2. Apollo: xoá filter, chọn tất cả, export email -> tải file CSV thô (tự thử lại nếu Chrome crash)
  const rawExportPath = await exportWithRetry(apolloListUrl, DOWNLOAD_DIR);

  // 3. Verify email qua Debounce -> file có thêm cột RESULT
  const debounceResultPath = await verifyListViaApi(rawExportPath, PROCESSED_DIR);
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

  // 5. Từ file gốc: bỏ Invalid + Unknown, chỉ giữ Safe to Send + Risky
  const filteredRows = filterByResult(debounceRows, ['Safe to Send', 'Risky']);

  // 6. Tách thành 2 file riêng: chỉ Safe to Send / chỉ Risky
  const safeRows = filterByResult(filteredRows, ['Safe to Send']);
  const riskyRows = filterByResult(filteredRows, ['Risky']);

  const safePath = path.join(PROCESSED_DIR, `safe-to-send-${Date.now()}.csv`);
  const riskyPath = path.join(PROCESSED_DIR, `risky-${Date.now()}.csv`);
  writeCsv(safePath, safeRows);
  writeCsv(riskyPath, riskyRows);

  // 7. Upload file Safe to Send lên Google Drive
  await uploadToDrive(safePath, config.gdriveSafeToSendFolderId);

  logger.info(`Hoàn tất luồng. File Risky chờ xử lý tiếp (luồng nội bộ khác): ${riskyPath}`);
  return { rawExportPath, debounceResultPath, reimportPath, safePath, riskyPath };
}
