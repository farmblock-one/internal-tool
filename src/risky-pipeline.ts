import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { readCsv, extractEmails } from './csv-utils.js';
import { writeRiskyExcel } from './xlsx-utils.js';
import { fetchTeamsSearchCurl } from './teams.js';
import { fetchGmailLookupCurl } from './gmail.js';
import { uploadRiskyToMeetscript } from './meetscript.js';
import { registerExpectedTelegramFile, registerRiskyJobMeta } from './telegram-watcher.js';
import { config } from './config.js';
import { logger } from './logger.js';

const DOWNLOAD_DIR = path.resolve('data/downloads');
const PROCESSED_DIR = path.resolve('data/processed');

// meetscript.io chỉ nhận tối đa 1000 dòng (lead) cho 1 lần chạy — vượt quá phải tách thành nhiều
// file nhỏ, chạy song song (xem `runWithConcurrency` bên dưới) thay vì lần lượt từng file.
const MAX_ROWS_PER_RUN = 1000;

export interface RiskyChunkResult {
  excelPath: string;
  teamResultScreenshot: string;
  googleResultScreenshot: string;
}

export interface RiskyFlowResult {
  chunks: RiskyChunkResult[];
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Chạy tối đa `limit` task song song cùng lúc (worker-pool: mỗi "worker" tự lấy task tiếp theo
 * ngay khi xong task trước, không đợi cả đợt) — dùng để upload nhiều phần lên meetscript.io đồng
 * thời thay vì xếp hàng lần lượt, tận dụng việc meetscript.io/Teams/Gmail không giới hạn số
 * request đồng thời từ cùng 1 tài khoản (đã xác nhận thực tế).
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
  onTaskDone?: (done: number, total: number) => void,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;
  let done = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const current = nextIndex++;
      if (current >= tasks.length) return;
      results[current] = await tasks[current]();
      done++;
      onTaskDone?.(done, tasks.length);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Xử lý 1 file Risky: đổi sang Excel (tự tách thành nhiều phần nếu vượt quá 1000 lead/phần —
 * giới hạn của meetscript.io), bắt cURL Teams + Gmail 1 LẦN DUY NHẤT (phiên đăng nhập dùng chung
 * được cho mọi phần đã tách), rồi upload SONG SONG (tối đa `config.riskyConcurrency` lượt cùng
 * lúc, mỗi lượt 1 tab Chrome riêng trong cùng `context`) từng phần lên 2 tab TEAM/GOOGLE của
 * meetscript.io. Trả về `null` nếu file Risky rỗng (không có lead nào).
 *
 * `context` do nơi gọi (server.ts hàng đợi Risky riêng, hoặc process-risky.ts) tự mở — dùng
 * profile Chrome RIÊNG (CHROME_USER_DATA_DIR khác với Apollo) để chạy đồng thời với job
 * Apollo/Debounce khác mà không tranh nhau khoá profile.
 */
export async function runRiskyFlow(
  riskyCsvPath: string,
  context: BrowserContext,
  onProgress?: (done: number, total: number) => void,
  // ID của RiskyJob (server.ts) — truyền xuống để đăng ký vào sổ chờ Telegram kèm đúng job, cho
  // phép trang trạng thái job đó hiện "đã nhận X/Y kết quả". Không có khi chạy qua CLI (process-
  // risky.ts) — vẫn hoạt động bình thường, chỉ là không hiện được tiến trình theo job cụ thể.
  jobId?: string,
  // File Excel gốc (đã ghép đủ cột Apollo + Debounce, đặt tên theo yêu cầu) cần cập nhật lại cột
  // RESULT ("Risky" -> "Safe to Send"/"Do not Send") khi đã nhận đủ kết quả thật Team/Google từ
  // Telegram. Không có thì vẫn chạy, chỉ là không tự động ghép ngược — team phải tự ghép tay.
  masterXlsxPath?: string,
): Promise<RiskyFlowResult | null> {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.mkdirSync(PROCESSED_DIR, { recursive: true });

  const rows = readCsv(riskyCsvPath);
  const emails = extractEmails(rows);
  if (emails.length === 0) {
    logger.info('File Risky không có lead nào — bỏ qua bước bắt cURL/upload meetscript.io.');
    return null;
  }

  const emailChunks = chunkArray(emails, MAX_ROWS_PER_RUN);
  const ts = Date.now();
  if (emailChunks.length > 1) {
    logger.info(
      `File Risky có ${emails.length} lead, vượt giới hạn ${MAX_ROWS_PER_RUN}/lần của meetscript.io — ` +
        `tự động tách thành ${emailChunks.length} file nhỏ, xử lý song song tối đa ` +
        `${config.riskyConcurrency} lượt cùng lúc.`,
    );
  }

  // Bắt cURL Teams/Gmail CHỈ 1 LẦN rồi dùng chung cho mọi phần đã tách — phiên đăng nhập không
  // phụ thuộc nội dung file Excel đính kèm, tách nhỏ bao nhiêu phần cũng chỉ cần bắt 1 lần. 2 lệnh
  // cURL này không phụ thuộc nhau nên bắt song song luôn cho nhanh.
  const [teamsCurl, gmailCurl] = await Promise.all([
    fetchTeamsSearchCurl(context, DOWNLOAD_DIR),
    fetchGmailLookupCurl(context, DOWNLOAD_DIR),
  ]);
  const teamsCurlPath = path.join(PROCESSED_DIR, `teams-curl-${ts}.txt`);
  fs.writeFileSync(teamsCurlPath, teamsCurl);
  logger.info(`Đã lưu cURL Teams để kiểm tra: ${teamsCurlPath}`);
  const gmailCurlPath = path.join(PROCESSED_DIR, `gmail-curl-${ts}.txt`);
  fs.writeFileSync(gmailCurlPath, gmailCurl);
  logger.info(`Đã lưu cURL Gmail để kiểm tra: ${gmailCurlPath}`);

  const excelPaths = emailChunks.map((chunkEmails, index) => {
    const suffix = emailChunks.length > 1 ? `-part${index + 1}` : '';
    const excelPath = path.join(PROCESSED_DIR, `risky-${ts}${suffix}.xlsx`);
    writeRiskyExcel(excelPath, chunkEmails);
    logger.info(`Đã đổi phần ${index + 1}/${emailChunks.length} (${chunkEmails.length} lead) sang Excel: ${excelPath}`);
    return excelPath;
  });

  // 2 task (TEAM + GOOGLE) cho mỗi phần đã tách — chạy song song, worker-pool giới hạn
  // `config.riskyConcurrency` lượt cùng lúc (mỗi lượt = 1 tab Chrome riêng trong cùng context).
  type UploadTask = { chunkIndex: number; kind: 'TEAM' | 'GOOGLE' };
  const uploadTasks: UploadTask[] = excelPaths.flatMap((_, chunkIndex) => [
    { chunkIndex, kind: 'TEAM' as const },
    { chunkIndex, kind: 'GOOGLE' as const },
  ]);
  const totalLots = uploadTasks.length;

  // Đăng ký TRƯỚC khi upload (không phải sau) — để dù kết quả Telegram đầu tiên về nhanh tới mấy,
  // `maybeMergeJob` trong telegram-watcher.ts luôn biết tổng số cần đợi + file Excel nào cần cập
  // nhật, tránh race condition (nhận đủ kết quả trước khi biết tổng số cần đợi).
  if (jobId && masterXlsxPath) {
    registerRiskyJobMeta(jobId, masterXlsxPath, totalLots);
  }

  const screenshots: Array<{ chunkIndex: number; kind: 'TEAM' | 'GOOGLE'; screenshotPath: string }> =
    await runWithConcurrency(
      uploadTasks.map((task) => async () => {
        const excelPath = excelPaths[task.chunkIndex];
        const curl = task.kind === 'TEAM' ? teamsCurl : gmailCurl;
        const screenshotPath = await uploadRiskyToMeetscript(context, curl, excelPath, DOWNLOAD_DIR, task.kind);
        // Đăng ký "sổ chờ" ngay sau khi upload thành công — bộ phận theo dõi Telegram (chạy nền,
        // tách biệt) sẽ tự nhận diện + tải file kết quả thật khi bot meetscript.io gửi vào group.
        registerExpectedTelegramFile(excelPath, task.kind, jobId);
        return { chunkIndex: task.chunkIndex, kind: task.kind, screenshotPath };
      }),
      config.riskyConcurrency,
      (done, total) => {
        logger.info(`Đã xong lượt ${done}/${total} upload meetscript.io.`);
        onProgress?.(done, total);
      },
    );

  const chunks: RiskyChunkResult[] = excelPaths.map((excelPath, chunkIndex) => {
    const team = screenshots.find((s) => s.chunkIndex === chunkIndex && s.kind === 'TEAM');
    const google = screenshots.find((s) => s.chunkIndex === chunkIndex && s.kind === 'GOOGLE');
    if (!team || !google) {
      // Không thể xảy ra (mọi task trong uploadTasks đều được await trong runWithConcurrency trước
      // khi trả kết quả), chỉ throw rõ ràng thay vì để lỗi `undefined` khó hiểu nếu có gì bất thường.
      throw new Error(`Thiếu kết quả upload cho phần ${chunkIndex + 1} (team=${!!team}, google=${!!google}).`);
    }
    return { excelPath, teamResultScreenshot: team.screenshotPath, googleResultScreenshot: google.screenshotPath };
  });

  logger.info(`Hoàn tất xử lý file Risky (${totalLots} lượt upload).`);
  return { chunks };
}
