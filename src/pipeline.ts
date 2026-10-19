import fs from 'node:fs';
import path from 'node:path';
import { openPersistentChrome } from './browser.js';
import { exportListEmails } from './apollo.js';
import { verifyListViaApi } from './debounce.js';
import { readCsv, writeCsv, filterByResult, dropColumns, dropRowsByColumnValue, mergeByEmail } from './csv-utils.js';
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

  // 2.5a. Trước khi gửi qua Debounce, bỏ hẳn các lead có "Email Status" = "Unavailable" hoặc
  // "Email no longer valid" — Apollo coi như các lead này không có email khả dụng, gửi qua
  // Debounce verify chỉ tốn request vô ích.
  const rawRows = readCsv(rawExportPath);
  const availableRows = dropRowsByColumnValue(rawRows, ['Email Status'], ['Unavailable', 'Email no longer valid']);
  logger.info(
    `Đã bỏ ${rawRows.length - availableRows.length} lead có Email Status = Unavailable/Email no longer valid ` +
      `(còn lại ${availableRows.length}/${rawRows.length}).`,
  );

  // 2.5b. Bỏ 2 cột "Contact Owner" và "Account Owner" khỏi file export.
  const cleanedRows = dropColumns(availableRows, ['Contact Owner', 'Account Owner']);
  const cleanedExportPath = path.join(PROCESSED_DIR, `apollo-export-cleaned-${Date.now()}.csv`);
  writeCsv(cleanedExportPath, cleanedRows);
  logger.info(`Đã xoá cột Contact Owner/Account Owner: ${cleanedExportPath}`);

  // 3. Verify email qua Debounce -> file có thêm cột RESULT
  const debounceResultPath = await verifyListViaApi(cleanedExportPath, PROCESSED_DIR);

  // Truyền thêm `cleanedExportPath` (file Apollo ĐẦY ĐỦ cột đã gửi lên Debounce) để bước sau ghép
  // lại đúng theo email — nếu không có file này (vd chạy lại qua `npm run resume` chỉ với file kết
  // quả Debounce), file Excel cuối sẽ chỉ có các cột Debounce trả về, không có cột Apollo gốc.
  return runFromDebounceResult(debounceResultPath, rawExportPath, outputFileName, cleanedExportPath);
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
  // File Apollo đầy đủ cột (đã gửi lên Debounce) để ghép lại theo email — xem `mergeByEmail`.
  // Không có thì vẫn chạy được, chỉ là file Excel cuối sẽ THIẾU các cột gốc của Apollo (chỉ có
  // EMAIL + các cột Debounce trả về) — cảnh báo rõ bên dưới nếu rơi vào trường hợp này.
  apolloRowsPath?: string,
): Promise<FlowResult> {
  const debounceRows = readCsv(debounceResultPath);

  // 4. Bước import ngược lại Apollo (importCsv trong apollo.ts) KHÔNG chạy ở đây — chạy ở 1 giai
  // đoạn SAU, trên file Excel CUỐI (sau khi đã có đủ kết quả Risky thật, xem apollo-reimport.ts
  // + maybeMergeJob trong telegram-watcher.ts), không phải trên file ngay sau Debounce này.

  // 5. Ghép file Debounce (chỉ có EMAIL/RESULT/REASON/STATUS CODE/ROLE/FREE/DOMAIN) trở lại với
  // file Apollo đầy đủ cột (Name, Title, Company...) theo đúng EMAIL — để file Excel cuối có ĐỦ
  // thông tin như file Apollo gốc, cộng thêm các cột mới từ Debounce, thay vì chỉ có mỗi vài cột
  // của riêng Debounce như trước.
  let mergedRows = debounceRows;
  if (apolloRowsPath) {
    const apolloRows = readCsv(apolloRowsPath);
    mergedRows = mergeByEmail(apolloRows, debounceRows);
    logger.info(`Đã ghép ${mergedRows.length} dòng Apollo với kết quả Debounce (theo email): ${apolloRowsPath}`);
  } else {
    logger.warn(
      'Không có file Apollo gốc để ghép cột (chạy từ `npm run resume` mà không truyền file Apollo) — ' +
        'file Excel cuối sẽ CHỈ có các cột Debounce trả về (EMAIL/RESULT/REASON...), thiếu các cột gốc của Apollo.',
    );
  }

  // Giữ nguyên "file gốc" sau Debounce (TẤT CẢ row đã ghép, mọi cột Apollo + các cột mới từ
  // Debounce) dạng Excel, đặt tên theo `outputFileName` team nhập — để team tự chỉnh sửa tiếp bằng
  // tay sau này (không còn tách riêng file Safe to Send như trước).
  const masterXlsxPath = buildOutputXlsxPath(PROCESSED_DIR, outputFileName);
  writeRowsAsXlsx(masterXlsxPath, mergedRows, 'Leads');
  logger.info(`Đã lưu file gốc sau Debounce dạng Excel: ${masterXlsxPath}`);

  // 6. Tách riêng các lead Risky ra 1 file CSV riêng. Bước xử lý tiếp Risky (bắt cURL Teams/Gmail
  // -> upload meetscript.io) giờ chạy ở 1 hàng đợi RIÊNG, dùng 1 Chrome profile riêng (xem
  // server.ts) — không còn gọi trực tiếp ở đây nữa, để job Apollo/Debounce này không bị kẹt chờ
  // xử lý Risky (có thể mất hàng giờ với list lớn), chặn mất người khác chạy job Apollo mới.
  const riskyRows = filterByResult(mergedRows, ['Risky']);
  const riskyPath = path.join(PROCESSED_DIR, `risky-${Date.now()}.csv`);
  writeCsv(riskyPath, riskyRows);
  logger.info(
    `Đã lưu file Risky (${riskyRows.length}/${mergedRows.length} lead được Debounce phân loại Risky): ${riskyPath}`,
  );

  logger.info(`Hoàn tất luồng. File Excel: ${masterXlsxPath}.`);
  return { rawExportPath, debounceResultPath, masterXlsxPath, riskyPath };
}
