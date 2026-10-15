import fs from 'node:fs';
import path from 'node:path';
import { openPersistentChrome } from './browser.js';
import { exportListEmails } from './apollo.js';
import { verifyListViaApi } from './debounce.js';
import { readCsv, writeCsv, filterByResult, dropColumns, dropRowsByColumnValue } from './csv-utils.js';
import { writeRowsAsXlsx } from './xlsx-utils.js';
import { buildOutputXlsxPath } from './filename-utils.js';
import { runRiskyFlow, type RiskyFlowResult } from './risky-pipeline.js';
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
  // null = file Risky không có lead nào, tự bỏ qua bước Teams/Gmail/meetscript.io.
  riskyResult: RiskyFlowResult | null;
  // Có giá trị nếu bước xử lý Risky bị lỗi — KHÔNG làm cả luồng thất bại (file Excel/Risky CSV ở
  // trên vẫn dùng được bình thường), chỉ ghi lại để biết cần xử lý lại riêng phần Risky.
  riskyError?: string;
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

  // 4. TẠM DỪNG bước import ngược lại Apollo (theo yêu cầu) — sẽ làm ở 1 giai đoạn sau, với 1 file
  // khác đã qua thêm vài bước xử lý nữa, không phải ngay tại đây. `importCsv` trong apollo.ts vẫn
  // còn nguyên, chỉ là chưa gọi tới trong luồng tự động này.

  // 5. Giữ nguyên "file gốc" sau Debounce (TẤT CẢ row, mọi cột + cột RESULT) dạng Excel, đặt tên
  // theo `outputFileName` team nhập — để team tự chỉnh sửa tiếp bằng tay sau này (không còn tách
  // riêng file Safe to Send như trước).
  const masterXlsxPath = buildOutputXlsxPath(PROCESSED_DIR, outputFileName);
  writeRowsAsXlsx(masterXlsxPath, debounceRows, 'Leads');
  logger.info(`Đã lưu file gốc sau Debounce dạng Excel: ${masterXlsxPath}`);

  // 6. Tách riêng các lead Risky ra 1 file CSV riêng.
  const riskyRows = filterByResult(debounceRows, ['Risky']);
  const riskyPath = path.join(PROCESSED_DIR, `risky-${Date.now()}.csv`);
  writeCsv(riskyPath, riskyRows);
  logger.info(`Đã lưu file Risky: ${riskyPath}`);

  // 7. Luồng liền mạch — xử lý tiếp Risky NGAY (bắt cURL Teams/Gmail -> upload meetscript.io),
  // không cần người khác bấm nút riêng. Lỗi ở bước này KHÔNG huỷ cả job: file Excel/Risky CSV ở
  // trên vẫn dùng được bình thường dù bước Risky có trục trặc, chỉ ghi log lại để xử lý lại riêng.
  let riskyResult: RiskyFlowResult | null = null;
  let riskyError: string | undefined;
  try {
    riskyResult = await runRiskyFlow(riskyPath);
  } catch (err) {
    riskyError = err instanceof Error ? err.message : String(err);
    logger.error('Lỗi khi xử lý tiếp Risky (Teams/Gmail/meetscript.io):', err);
  }

  logger.info(`Hoàn tất luồng. File Excel: ${masterXlsxPath}.`);
  return { rawExportPath, debounceResultPath, masterXlsxPath, riskyPath, riskyResult, riskyError };
}
