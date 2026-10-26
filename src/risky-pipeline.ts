import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { openPersistentChrome } from './browser.js';
import { readCsv, extractEmails } from './csv-utils.js';
import { writeRiskyExcel } from './xlsx-utils.js';
import { fetchTeamsSearchCurl } from './teams.js';
import { fetchGmailLookupCurl } from './gmail.js';
import { uploadRiskyToMeetscript, MeetscriptUploadError } from './meetscript.js';
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
  // Các lượt ĐÃ BẤM Upload nhưng không thấy popup. Không upload lại (tránh kết quả trùng), vẫn chờ
  // kết quả qua Telegram như lượt thành công.
  unconfirmedLots?: string[];
}

// Lượt upload KHÔNG thấy popup xác nhận (= thất bại) thì thử lại, nghỉ tăng dần giữa các lần.
const UPLOAD_MAX_ATTEMPTS = 3;
const UPLOAD_RETRY_DELAYS_MS = [60_000, 180_000];
// Khoảng nghỉ NGẪU NHIÊN giữa 2 phần liên tiếp của CÙNG 1 bên (TEAM hoặc GOOGLE).
const LANE_GAP_MIN_MS = 60_000;
const LANE_GAP_MAX_MS = 300_000;
const randomBetween = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type UploadOutcome =
  | { status: 'ok'; screenshotPath: string }
  | { status: 'unconfirmed' } // đã bấm Upload nhưng không thấy popup — có thể vẫn đã gửi thành công
  | { status: 'failed' };

/**
 * Upload 1 lượt. CHỈ thử lại khi lỗi xảy ra TRƯỚC lúc bấm "Upload Data" (chưa có gì được gửi đi,
 * thử lại an toàn). Đã bấm rồi mà không thấy popup thì KHÔNG thử lại: thực tế meetscript.io vẫn xử
 * lý và gửi kết quả qua Telegram, upload lại chỉ sinh file trùng. Trước mỗi lần thử lại gọi
 * `beforeRetry` (mở lại Chrome nếu đã chết + bắt cURL mới).
 */
async function uploadWithRetry(
  upload: () => Promise<string>,
  label: string,
  beforeRetry: () => Promise<void>,
): Promise<UploadOutcome> {
  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        logger.warn(`Thử upload lại lượt ${label} — lần ${attempt}/${UPLOAD_MAX_ATTEMPTS}, bắt cURL mới trước...`);
        await beforeRetry();
      }
      return { status: 'ok', screenshotPath: await upload() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof MeetscriptUploadError && err.submitted) {
        logger.warn(
          `Lượt ${label}: đã bấm Upload Data nhưng không xác nhận được (${msg}). KHÔNG upload lại để tránh ` +
            `kết quả trùng — vẫn chờ kết quả qua Telegram như bình thường.`,
        );
        return { status: 'unconfirmed' };
      }
      if (attempt < UPLOAD_MAX_ATTEMPTS) {
        const delay = UPLOAD_RETRY_DELAYS_MS[attempt - 1] ?? UPLOAD_RETRY_DELAYS_MS[UPLOAD_RETRY_DELAYS_MS.length - 1];
        logger.warn(`Upload lượt ${label} lỗi trước khi gửi được (${msg}) — đợi ${Math.round(delay / 1000)}s rồi thử lại.`);
        await sleep(delay);
      } else {
        logger.error(`Upload lượt ${label} thất bại sau ${UPLOAD_MAX_ATTEMPTS} lần thử: ${msg}`);
      }
    }
  }
  return { status: 'failed' };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}


/**
 * Xử lý 1 file Risky: đổi sang Excel (tự tách thành nhiều phần nếu vượt quá 1000 lead/phần —
 * giới hạn của meetscript.io), bắt cURL Teams + Gmail, rồi upload từng phần lên 2 tab TEAM/GOOGLE
 * của meetscript.io: 2 bên chạy song song, các phần của cùng 1 bên chạy lần lượt (nghỉ ngẫu nhiên
 * 60–300s + bắt cURL mới giữa 2 phần). Trả về `null` nếu file Risky rỗng (không có lead nào).
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

  // Chrome có thể bị đóng/crash giữa chừng. Theo dõi Chrome đang dùng; khi thử lại mà nó đã chết thì
  // mở Chrome MỚI (cùng profile Risky), không thử lại trên Chrome đã chết. Chrome mở thêm ở đây
  // được tự đóng ở cuối hàm; Chrome ban đầu vẫn do nơi gọi tự đóng như cũ.
  let liveContext = context;
  let liveClosed = false;
  const watchClose = (ctx: BrowserContext) => ctx.once('close', () => { if (ctx === liveContext) liveClosed = true; });
  watchClose(context);
  const extraContexts: BrowserContext[] = [];
  let reopening: Promise<void> | undefined;
  const ensureLiveContext = async (): Promise<void> => {
    if (!liveClosed) return;
    if (!reopening) {
      reopening = (async () => {
        logger.warn('Chrome của hàng đợi Risky đã bị đóng — mở lại Chrome mới (cùng profile Risky) để thử tiếp...');
        const fresh = await openPersistentChrome(config.riskyChromeUserDataDir);
        extraContexts.push(fresh);
        liveContext = fresh;
        liveClosed = false;
        watchClose(fresh);
      })().finally(() => {
        reopening = undefined;
      });
    }
    await reopening;
  };

  try {
    return await runRiskyFlowInner();
  } finally {
    for (const ctx of extraContexts) await ctx.close().catch(() => {});
  }

  async function runRiskyFlowInner(): Promise<RiskyFlowResult | null> {
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
        `tự động tách thành ${emailChunks.length} file nhỏ. TEAM và GOOGLE chạy song song; các phần của ` +
        `cùng 1 bên chạy lần lượt, nghỉ ngẫu nhiên 60–300s và bắt cURL mới giữa 2 phần.`,
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

  // cURL hiện hành của mỗi bên (dùng chung cho mọi lượt). Khi 1 lượt upload thất bại, bắt cURL MỚI
  // cho đúng bên đó rồi mới thử lại — các lượt sau cũng dùng luôn cURL mới này. Nhiều lượt cùng
  // hỏng 1 lúc thì chỉ bắt lại 1 lần (dùng chung lần bắt đang chạy, hoặc bản đã mới hơn lúc hỏng).
  type Kind = 'TEAM' | 'GOOGLE';
  const curls: Record<Kind, { value: string; version: number; refreshing?: Promise<void> }> = {
    TEAM: { value: teamsCurl, version: 1 },
    GOOGLE: { value: gmailCurl, version: 1 },
  };
  const refreshCurl = async (kind: Kind, usedVersion: number): Promise<void> => {
    const entry = curls[kind];
    if (entry.version > usedVersion) return; // lượt khác đã bắt cURL mới sau khi mình dùng bản cũ
    if (!entry.refreshing) {
      entry.refreshing = (async () => {
        try {
          const fresh =
            kind === 'TEAM' ? await fetchTeamsSearchCurl(liveContext, DOWNLOAD_DIR) : await fetchGmailLookupCurl(liveContext, DOWNLOAD_DIR);
          entry.value = fresh;
          entry.version++;
          const freshPath = path.join(PROCESSED_DIR, `${kind === 'TEAM' ? 'teams' : 'gmail'}-curl-${ts}-v${entry.version}.txt`);
          fs.writeFileSync(freshPath, fresh);
          logger.info(`Đã bắt cURL ${kind === 'TEAM' ? 'Teams' : 'Gmail'} mới (bản ${entry.version}): ${freshPath}`);
        } catch (err) {
          // Không bắt được cURL mới thì vẫn thử lại với bản cũ, không dừng cả lượt.
          logger.error(`Không bắt được cURL ${kind} mới, thử lại bằng cURL cũ:`, err);
        } finally {
          entry.refreshing = undefined;
        }
      })();
    }
    await entry.refreshing;
  };

  const excelPaths = emailChunks.map((chunkEmails, index) => {
    const suffix = emailChunks.length > 1 ? `-part${index + 1}` : '';
    const excelPath = path.join(PROCESSED_DIR, `risky-${ts}${suffix}.xlsx`);
    writeRiskyExcel(excelPath, chunkEmails);
    logger.info(`Đã đổi phần ${index + 1}/${emailChunks.length} (${chunkEmails.length} lead) sang Excel: ${excelPath}`);
    return excelPath;
  });

  // 2 lượt (TEAM + GOOGLE) cho mỗi phần đã tách — xem `runLane` bên dưới.
  const totalLots = excelPaths.length * 2;

  // Đăng ký TRƯỚC khi upload (không phải sau) — để dù kết quả Telegram đầu tiên về nhanh tới mấy,
  // `maybeMergeJob` trong telegram-watcher.ts luôn biết tổng số cần đợi + file Excel nào cần cập
  // nhật, tránh race condition (nhận đủ kết quả trước khi biết tổng số cần đợi).
  if (jobId && masterXlsxPath) {
    registerRiskyJobMeta(jobId, masterXlsxPath, totalLots);
  }

  // Mỗi bên (TEAM, GOOGLE) là 1 "làn" chạy LẦN LƯỢT từng phần; 2 làn chạy song song với nhau.
  // Đã xác nhận thực tế: upload liền 2 phần của CÙNG 1 bên là phần sau hỏng. Giữa 2 phần của cùng
  // 1 bên phải nghỉ ngẫu nhiên 60–300 giây rồi bắt cURL MỚI mới upload phần tiếp theo.
  let doneLots = 0;
  const runLane = async (kind: Kind) => {
    const results: Array<{ chunkIndex: number; kind: Kind; outcome: UploadOutcome }> = [];
    for (let chunkIndex = 0; chunkIndex < excelPaths.length; chunkIndex++) {
      const label = `${kind} phần ${chunkIndex + 1}/${excelPaths.length}`;
      if (chunkIndex > 0) {
        const waitMs = randomBetween(LANE_GAP_MIN_MS, LANE_GAP_MAX_MS);
        logger.info(`Lượt ${label}: nghỉ ${Math.round(waitMs / 1000)}s sau phần trước, rồi bắt cURL ${kind} mới...`);
        await sleep(waitMs);
        await ensureLiveContext();
        await refreshCurl(kind, curls[kind].version);
      }
      const excelPath = excelPaths[chunkIndex];
      let usedVersion = 0;
      const outcome = await uploadWithRetry(
        () => {
          const current = curls[kind];
          usedVersion = current.version;
          return uploadRiskyToMeetscript(liveContext, current.value, excelPath, DOWNLOAD_DIR, kind);
        },
        label,
        async () => {
          await ensureLiveContext();
          await refreshCurl(kind, usedVersion);
        },
      );
      // Đăng ký "sổ chờ" khi đã gửi được (có popup, hoặc đã bấm Upload mà chưa xác nhận) — bộ phận
      // theo dõi Telegram sẽ tự nhận diện + tải file kết quả thật khi bot meetscript.io gửi về.
      if (outcome.status !== 'failed') registerExpectedTelegramFile(excelPath, kind, jobId);
      results.push({ chunkIndex, kind, outcome });
      doneLots++;
      logger.info(`Đã xong lượt ${doneLots}/${totalLots} upload meetscript.io (${label}).`);
      onProgress?.(doneLots, totalLots);
    }
    return results;
  };
  const [teamResults, googleResults] = await Promise.all([runLane('TEAM'), runLane('GOOGLE')]);
  const screenshots = [...teamResults, ...googleResults];

  const lotLabel = (s: { kind: string; chunkIndex: number }) => `${s.kind} phần ${s.chunkIndex + 1}/${excelPaths.length}`;
  const failedLots = screenshots.filter((s) => s.outcome.status === 'failed').map(lotLabel);
  const unconfirmedLots = screenshots.filter((s) => s.outcome.status === 'unconfirmed').map(lotLabel);
  if (unconfirmedLots.length > 0) {
    logger.warn(`${unconfirmedLots.length} lượt đã gửi nhưng không thấy popup: ${unconfirmedLots.join(', ')} — vẫn chờ kết quả qua Telegram.`);
  }
  const successfulLots = totalLots - failedLots.length;
  if (successfulLots === 0) {
    throw new Error(`Cả ${totalLots} lượt upload meetscript.io đều thất bại (lỗi trước khi gửi được, sau ${UPLOAD_MAX_ATTEMPTS} lần thử).`);
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
    const shot = (s?: { outcome: UploadOutcome }) => (s?.outcome.status === 'ok' ? s.outcome.screenshotPath : undefined);
    return { excelPath, teamResultScreenshot: shot(team), googleResultScreenshot: shot(google) };
  });

  logger.info(`Hoàn tất xử lý file Risky (${totalLots} lượt upload).`);
  return { chunks, successfulLots, failedLots, unconfirmedLots };
  }
}
