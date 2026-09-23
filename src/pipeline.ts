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

export async function runFlow(apolloListUrl: string): Promise<FlowResult> {
  const context = await openPersistentChrome();
  try {
    // 1-2. Apollo: xoá filter, chọn tất cả, export email -> tải file CSV thô
    const rawExportPath = await exportListEmails(context, apolloListUrl, DOWNLOAD_DIR);

    // 3. Verify email qua Debounce -> file có thêm cột RESULT
    const debounceResultPath = await verifyListViaApi(rawExportPath, PROCESSED_DIR);
    const debounceRows = readCsv(debounceResultPath);

    // 4. File để import ngược lại Apollo: chỉ giữ cột email + RESULT, TẤT CẢ các row
    const reimportRows = onlyEmailAndResult(debounceRows);
    const reimportPath = path.join(PROCESSED_DIR, `apollo-reimport-${Date.now()}.csv`);
    writeCsv(reimportPath, reimportRows);
    await importCsv(context, reimportPath, DOWNLOAD_DIR);

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
  } finally {
    await context.close();
  }
}
