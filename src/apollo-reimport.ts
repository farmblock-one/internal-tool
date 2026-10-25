import path from 'node:path';
import { openPersistentChrome } from './browser.js';
import { importCsv } from './apollo.js';
import { readXlsxRows } from './xlsx-utils.js';
import { onlyEmailAndResult, writeCsv } from './csv-utils.js';
import { logger } from './logger.js';

const PROCESSED_DIR = path.resolve('data/processed');
const DOWNLOAD_DIR = path.resolve('data/downloads');
// Phải khớp đúng tên sheet mà pipeline.ts (writeRowsAsXlsx) và risky-merge.ts dùng cho file Excel gốc.
const MASTER_SHEET_NAME = 'Leads';

/**
 * Từ file Excel CUỐI (đã ghép đủ kết quả Risky thật, cột RESULT đã là "Safe to Send"/"Do not
 * Send") — lược bỏ hết mọi cột, chỉ giữ lại "email" + "RESULT" (đúng 2 cột Apollo tự nhận diện
 * được khi import, xem `importCsvInner` trong apollo.ts), ghi ra 1 file CSV riêng.
 */
export function buildApolloReimportCsv(masterXlsxPath: string): string {
  const rows = readXlsxRows(masterXlsxPath, MASTER_SHEET_NAME);
  const reduced = onlyEmailAndResult(rows);
  const csvPath = path.join(PROCESSED_DIR, `apollo-reimport-${Date.now()}.csv`);
  writeCsv(csvPath, reduced);
  const dropped = rows.length - reduced.length;
  if (dropped > 0) logger.info(`Đã bỏ ${dropped} dòng không có email khỏi file import Apollo.`);
  if (reduced.length === 0) throw new Error('File Excel không có dòng nào có email — không có gì để import lên Apollo.');
  logger.info(`Đã tạo file CSV (chỉ email + RESULT) để import ngược lại Apollo: ${csvPath} (${reduced.length} dòng).`);
  return csvPath;
}

/**
 * Tạo file CSV rút gọn (xem `buildApolloReimportCsv`) rồi import thẳng lên Apollo — dùng ĐÚNG
 * profile Chrome Apollo đã đăng nhập (CHROME_USER_DATA_DIR, giống bước export list lúc đầu), nên
 * KHÔNG được chạy đồng thời với job export Apollo khác (2 Chrome cùng 1 profile sẽ tranh khoá).
 * Ở web UI, gọi qua `enqueueReimportJob` (server.ts) để tự xếp hàng chung với job Apollo export,
 * không bao giờ chạy chồng lên nhau.
 */
export async function runApolloReimport(masterXlsxPath: string): Promise<void> {
  const csvPath = buildApolloReimportCsv(masterXlsxPath);
  const context = await openPersistentChrome();
  try {
    await importCsv(context, csvPath, DOWNLOAD_DIR);
    logger.info(`Đã import xong kết quả Risky (email + RESULT) ngược lại Apollo: ${csvPath}`);
  } finally {
    await context.close().catch(() => {});
  }
}
