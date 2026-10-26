import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { readCsv, extractEmails } from './csv-utils.js';
import { writeRiskyExcel } from './xlsx-utils.js';
import { fetchTeamsSearchCurl } from './teams.js';
import { fetchGmailLookupCurl } from './gmail.js';
import { uploadRiskyToMeetscript } from './meetscript.js';
import { registerExpectedTelegramFile, registerRiskyJobMeta, setRiskyJobExpectedTotal } from './telegram-watcher.js';
import { config } from './config.js';
import { logger } from './logger.js';

const DOWNLOAD_DIR = path.resolve('data/downloads');
const PROCESSED_DIR = path.resolve('data/processed');

// meetscript.io chỉ nhận tối đa 1000 dòng (lead) cho 1 lần chạy — vượt quá phải tách thành nhiều
// file nhỏ, chạy song song (xem `runWithConcurrency` bên dưới) thay vì lần lượt từng file.
const MAX_ROWS_PER_RUN = 1000;

export interface RiskyChunkResult {
  excelPath: string;
  // Không có = lượt upload đó thất bại (không thấy popup xác nhận sau mọi lần thử).
  teamResultScreenshot?: string;
  googleResultScreenshot?: string;
}

export interface RiskyFlowResult {
  chunks: RiskyChunkResult[];
  // Số lượt upload thành công = số file kết quả bot Telegram sẽ gửi về.
  successfulLots: number;
  // Các lượt thất bại, vd "GOOGLE phần 2/2" — lead của phần đó giữ nguyên nhãn "Risky".
  failedLots: string[];
}

// Lượt upload KHÔNG thấy popup xác nhận (= thất bại) thì thử lại, nghỉ tăng dần giữa các lần.
const UPLOAD_MAX_ATTEMPTS = 3;
const UPLOAD_RETRY_DELAYS_MS = [60_000, 180_000];
// Các lượt đầu bắt đầu cách nhau chừng này, không bấm Upload dồn vào cùng 1 lúc.
const UPLOAD_START_STAGGER_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Trả về đường dẫn ảnh xác nhận nếu thành công, `null` nếu thất bại sau mọi lần thử. */
async function uploadWithRetry(upload: () => Promise<string>, label: string): Promise<string | null> {
  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) logger.warn(`Thử upload lại lượt ${label} — lần ${attempt}/${UPLOAD_MAX_ATTEMPTS}...`);
      return await upload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < UPLOAD_MAX_ATTEMPTS) {
        const delay = UPLOAD_RETRY_DELAYS_MS[attempt - 1] ?? UPLOAD_RETRY_DELAYS_MS[UPLOAD_RETRY_DELAYS_MS.length - 1];
        logger.warn(`Upload lượt ${label} thất bại (${msg}) — đợi ${Math.round(delay / 1000)}s rồi thử lại.`);
        await sleep(delay);
      } else {
        logger.error(`Upload lượt ${label} thất bại sau ${UPLOAD_MAX_ATTEMPTS} lần thử: ${msg}`);
      }
    }
  }
  return null;
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

  const screenshots: Array<{ chunkIndex: number; kind: 'TEAM' | 'GOOGLE'; screenshotPath: string | null }> =
    await runWithConcurrency(
      uploadTasks.map((task, taskIndex) => async () => {
        // Chỉ giãn các lượt ĐẦU TIÊN (khởi động cùng lúc); các lượt sau tự giãn theo lượt trước.
        if (taskIndex > 0 && taskIndex < config.riskyConcurrency) await sleep(taskIndex * UPLOAD_START_STAGGER_MS);
        const excelPath = excelPaths[task.chunkIndex];
        const curl = task.kind === 'TEAM' ? teamsCurl : gmailCurl;
        const label = `${task.kind} phần ${task.chunkIndex + 1}/${excelPaths.length}`;
        const screenshotPath = await uploadWithRetry(
          () => uploadRiskyToMeetscript(context, curl, excelPath, DOWNLOAD_DIR, task.kind),
          label,
        );
        // Đăng ký "sổ chờ" CHỈ khi upload thành công (có popup xác nhận) — bộ phận theo dõi Telegram
        // sẽ tự nhận diện + tải file kết quả thật khi bot meetscript.io gửi vào group.
        if (screenshotPath) registerExpectedTelegramFile(excelPath, task.kind, jobId);
        return { chunkIndex: task.chunkIndex, kind: task.kind, screenshotPath };
      }),
      config.riskyConcurrency,
      (done, total) => {
        logger.info(`Đã xong lượt ${done}/${total} upload meetscript.io.`);
        onProgress?.(done, total);
      },
    );

  const failedLots = screenshots
    .filter((s) => !s.screenshotPath)
    .map((s) => `${s.kind} phần ${s.chunkIndex + 1}/${excelPaths.length}`);
  const successfulLots = totalLots - failedLots.length;
  if (successfulLots === 0) {
    throw new Error(`Cả ${totalLots} lượt upload meetscript.io đều thất bại (không thấy popup xác nhận sau ${UPLOAD_MAX_ATTEMPTS} lần thử).`);
  }
  if (failedLots.length > 0) {
    // 1 lượt hỏng KHÔNG làm hỏng cả job: chỉ chờ đúng số file của các lượt thành công rồi ghép như
    // bình thường. Lead thuộc lượt hỏng không có kết quả bên đó, giữ theo kết quả bên còn lại hoặc
    // giữ nguyên "Risky" (xem mergeRiskyResultsIntoMaster).
    logger.warn(
      `${failedLots.length}/${totalLots} lượt upload thất bại: ${failedLots.join(', ')}. ` +
        `Vẫn chờ ${successfulLots} kết quả của các lượt thành công rồi tự ghép như bình thường.`,
    );
    if (jobId) setRiskyJobExpectedTotal(jobId, successfulLots);
  }

  const chunks: RiskyChunkResult[] = excelPaths.map((excelPath, chunkIndex) => {
    const team = screenshots.find((s) => s.chunkIndex === chunkIndex && s.kind === 'TEAM');
    const google = screenshots.find((s) => s.chunkIndex === chunkIndex && s.kind === 'GOOGLE');
    return {
      excelPath,
      teamResultScreenshot: team?.screenshotPath ?? undefined,
      googleResultScreenshot: google?.screenshotPath ?? undefined,
    };
  });

  logger.info(`Hoàn tất xử lý file Risky (${totalLots} lượt upload).`);
  return { chunks, successfulLots, failedLots };
}
