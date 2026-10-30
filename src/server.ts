import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runFlow, type FlowResult } from './pipeline.js';
import { runRiskyFlow, type RiskyFlowResult } from './risky-pipeline.js';
import { openPersistentChrome } from './browser.js';
import {
  startTelegramWatcher,
  getTelegramWatchStatus,
  getJobTelegramStatus,
  dismissPendingEntry,
  setOnMergeComplete,
} from './telegram-watcher.js';
import { runApolloReimport } from './apollo-reimport.js';
import { jobContext } from './job-context.js';
import { JobCancelledError } from './cancel.js';
import { logger } from './logger.js';
import { config } from './config.js';
import { BRAND_NAME, escapeHtml, pageLayout } from './web-layout.js';

const PROCESSED_DIR = path.resolve('data/processed');
const ASSETS_DIR = path.resolve('assets');

type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

interface MainJob {
  kind: 'main';
  id: string;
  listUrl: string;
  // Không còn do người dùng tự nhập — tự lấy theo đúng tên list Apollo thật (dò được lúc export,
  // xem sanitizeToFileName/pipeline.ts), nên CHƯA biết được cho tới khi job chạy xong bước export.
  // undefined trong lúc job còn "queued"/"running".
  outputFileName?: string;
  status: JobStatus;
  logs: string[];
  createdAt: number;
  finishedAt?: number;
  error?: string;
  result?: FlowResult;
  // Gắn ngay khi job Apollo/Debounce này chạy xong thành công và tự động đẩy job Risky tiếp theo
  // vào HÀNG ĐỢI RIÊNG (xem RiskyJob) — để trang trạng thái của job này có thể dẫn sang theo dõi
  // tiếp tiến trình Risky (vẫn 1 luồng liền mạch, không cần bấm nút nào thêm).
  riskyJobId?: string;
  // Thời điểm có người bấm huỷ (để hiện "Đang dừng..." trong lúc chờ luồng dừng hẳn).
  cancelRequestedAt?: number;
}

interface RiskyJob {
  kind: 'risky';
  id: string;
  riskyPath: string;
  // File Excel gốc (đã ghép đủ cột Apollo + Debounce) của job Apollo/Debounce sinh ra file Risky
  // này — khi nhận đủ kết quả thật Team/Google từ Telegram, tự động cập nhật lại cột RESULT ngay
  // trong file này (xem registerRiskyJobMeta/mergeRiskyResultsIntoMaster).
  masterXlsxPath: string;
  // Tên file output của job Apollo/Debounce sinh ra file Risky này — chỉ để hiển thị cho dễ nhận biết.
  sourceLabel: string;
  status: JobStatus;
  logs: string[];
  createdAt: number;
  finishedAt?: number;
  error?: string;
  // "12/60" — cập nhật realtime khi từng lượt upload song song lên meetscript.io hoàn tất.
  progress?: string;
  // undefined = chưa chạy xong; null = chạy xong nhưng file Risky không có lead nào.
  result?: RiskyFlowResult | null;
}

interface ReimportJob {
  kind: 'reimport';
  id: string;
  // File Excel gốc (đã ghép đủ kết quả Risky thật) sẽ bị rút gọn còn email + RESULT rồi import
  // ngược lại Apollo — xem `apollo-reimport.ts`.
  masterXlsxPath: string;
  status: JobStatus;
  logs: string[];
  createdAt: number;
  finishedAt?: number;
  error?: string;
}

type Job = MainJob | RiskyJob | ReimportJob;

const jobs = new Map<string, Job>();

// ---------- Lưu lịch sử job xuống đĩa ----------
// Trước đây danh sách job chỉ nằm trong bộ nhớ, restart server là mất hết lịch sử trên web. Giờ ghi
// ra 1 file JSON (ghi gộp, tối đa ~1 lần/giây) và đọc lại khi khởi động. Job đang chạy dở lúc tắt
// server được đánh dấu "Lỗi" vì tiến trình Chrome/upload của nó đã mất theo.
const HISTORY_FILE = path.join(PROCESSED_DIR, 'jobs-history.json');
const MAX_SAVED_LOG_LINES = 3000;
let saveTimer: NodeJS.Timeout | undefined;

function saveJobsNow(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  try {
    const data = [...jobs.values()].map((j) => ({ ...j, logs: j.logs.slice(-MAX_SAVED_LOG_LINES) }));
    fs.mkdirSync(PROCESSED_DIR, { recursive: true });
    const tmp = `${HISTORY_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, HISTORY_FILE);
  } catch (err) {
    logger.warn(`Không lưu được lịch sử job: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function scheduleSave(): void {
  if (!saveTimer) saveTimer = setTimeout(saveJobsNow, 1000);
}

const requeueAfterRestart: Job[] = [];

function loadJobs(): void {
  if (!fs.existsSync(HISTORY_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')) as Job[];
    for (const job of data) {
      if (!job || typeof job.id !== 'string' || !Array.isArray(job.logs)) continue;
      if (job.status === 'running') {
        job.status = 'error';
        job.error = 'Server đã khởi động lại khi job này đang chạy. Hãy chạy lại nếu cần.';
        job.finishedAt = job.finishedAt ?? Date.now();
      }
      jobs.set(job.id, job);
      // Job còn đang CHỜ (chưa chạy, chưa tốn gì) thì xếp lại vào hàng đợi như cũ, không bỏ.
      if (job.status === 'queued') requeueAfterRestart.push(job);
    }
    logger.info(`Đã nạp ${jobs.size} job từ lịch sử: ${HISTORY_FILE}`);
  } catch (err) {
    logger.warn(`Không đọc được lịch sử job (${HISTORY_FILE}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Xoá 1 job khỏi lịch sử (chỉ job đã xong/lỗi — job đang chạy/chờ không được xoá). */
function deleteJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status === 'queued' || job.status === 'running') return false;
  jobs.delete(id);
  saveJobsNow();
  return true;
}

/** Xoá toàn bộ job đã xong/lỗi khỏi lịch sử. File kết quả trên đĩa giữ nguyên. */
function clearFinishedJobs(): number {
  let removed = 0;
  for (const [id, job] of jobs) {
    if (job.status !== 'queued' && job.status !== 'running') {
      jobs.delete(id);
      removed++;
    }
  }
  saveJobsNow();
  return removed;
}

// 2 HÀNG ĐỢI RIÊNG BIỆT, chạy ĐỘC LẬP (mỗi hàng đợi 1 Chrome profile riêng — xem config.ts):
//   - mainQueue: Apollo export -> Debounce verify, dùng profile Apollo (CHROME_USER_DATA_DIR).
//   - riskyQueue: Teams/Gmail -> meetscript.io, dùng profile Risky (RISKY_CHROME_USER_DATA_DIR).
// Tách riêng để list lớn (xử lý Risky có thể mất hàng giờ) không còn chặn người khác chạy job
// Apollo mới — 2 hàng đợi chạy song song được vì dùng 2 Chrome profile khác nhau.
const mainQueue: string[] = [];
let mainProcessing = false;
const riskyQueue: string[] = [];
let riskyProcessing = false;

// Tối đa chừng này list Apollo ĐANG CHỜ (không tính list đang chạy). Nhập thêm khi đầy thì báo lỗi.
const MAX_QUEUED_MAIN_JOBS = 10;
// AbortController của job Apollo/Debounce đang chạy — dùng để huỷ từ web UI. Không lưu xuống đĩa.
const runningControllers = new Map<string, AbortController>();

function queuedMainCount(): number {
  return [...jobs.values()].filter((j) => j.kind === 'main' && j.status === 'queued').length;
}

/** Vị trí (1, 2, 3...) của job trong hàng đợi Apollo, hoặc 0 nếu không đang chờ. */
function queuePosition(job: Job): number {
  if (job.status !== 'queued') return 0;
  if (job.kind === 'risky') return riskyQueue.indexOf(job.id) + 1;
  return mainQueue.indexOf(job.id) + 1;
}

/**
 * Huỷ 1 job Apollo/Debounce: đang chờ thì bỏ khỏi hàng đợi; đang chạy (bước export Apollo hoặc
 * chờ Debounce) thì gửi tín hiệu dừng — luồng tự dừng ở điểm an toàn gần nhất (vài giây).
 */
function cancelMainJob(id: string): { ok: boolean; message: string } {
  const job = jobs.get(id);
  if (!job || job.kind !== 'main') return { ok: false, message: 'Không tìm thấy job Apollo này.' };
  if (job.status === 'queued') {
    const idx = mainQueue.indexOf(id);
    if (idx !== -1) mainQueue.splice(idx, 1);
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    job.logs.push(`[${new Date().toISOString()}] Đã huỷ khi đang chờ trong hàng đợi (chưa chạy gì).`);
    saveJobsNow();
    return { ok: true, message: 'Đã huỷ list đang chờ' };
  }
  if (job.status === 'running') {
    const controller = runningControllers.get(id);
    if (!controller) return { ok: false, message: 'Job đã qua bước lọc Debounce, không huỷ được nữa.' };
    if (!controller.signal.aborted) {
      job.cancelRequestedAt = Date.now();
      job.logs.push(`[${new Date().toISOString()}] Có yêu cầu huỷ — đang dừng...`);
      controller.abort();
      scheduleSave();
    }
    return { ok: true, message: 'Đang dừng list, vài giây nữa sẽ xong' };
  }
  return { ok: false, message: 'Job này đã kết thúc, không cần huỷ.' };
}

function isRiskyJob(job: Job): job is RiskyJob {
  return job.kind === 'risky';
}

function enqueueMainJob(listUrl: string): MainJob {
  const id = crypto.randomBytes(6).toString('hex');
  const job: MainJob = { kind: 'main', id, listUrl, status: 'queued', logs: [], createdAt: Date.now() };
  jobs.set(id, job);
  scheduleSave();
  mainQueue.push(id);
  void processMainQueue();
  return job;
}

/**
 * Xếp job import ngược lại Apollo vào CHUNG hàng đợi `mainQueue` (không phải hàng đợi riêng) —
 * BẮT BUỘC, vì job này dùng ĐÚNG profile Chrome Apollo (CHROME_USER_DATA_DIR) giống job export ở
 * trên, 2 Chrome cùng 1 profile chạy song song sẽ tranh khoá/crash nhau. Gọi tự động ngay sau khi
 * ghép xong kết quả Risky (xem `setOnMergeComplete` ở cuối file).
 */
function enqueueReimportJob(masterXlsxPath: string): ReimportJob {
  const id = crypto.randomBytes(6).toString('hex');
  const job: ReimportJob = { kind: 'reimport', id, masterXlsxPath, status: 'queued', logs: [], createdAt: Date.now() };
  jobs.set(id, job);
  scheduleSave();
  mainQueue.push(id);
  void processMainQueue();
  return job;
}

function enqueueRiskyJob(riskyPath: string, masterXlsxPath: string, sourceLabel: string): RiskyJob {
  const id = crypto.randomBytes(6).toString('hex');
  const job: RiskyJob = {
    kind: 'risky',
    id,
    riskyPath,
    masterXlsxPath,
    sourceLabel,
    status: 'queued',
    logs: [],
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  scheduleSave();
  riskyQueue.push(id);
  void processRiskyQueue();
  return job;
}

// Chạy ĐÚNG 1 job tại 1 thời điểm trong hàng đợi này ('main' HOẶC 'reimport') — cả 2 loại đều dùng
// chung 1 Chrome profile Apollo đã đăng nhập, chạy song song (kể cả khác loại với nhau) sẽ tranh
// nhau cùng 1 profile và làm nhau crash.
async function processMainQueue(): Promise<void> {
  if (mainProcessing) return;
  mainProcessing = true;
  try {
    while (mainQueue.length > 0) {
      const id = mainQueue.shift();
      const job = id ? jobs.get(id) : undefined;
      if (!job || (job.kind !== 'main' && job.kind !== 'reimport')) continue;
      job.status = 'running';
      scheduleSave();
      await jobContext.run({ append: (line) => { job.logs.push(line); scheduleSave(); } }, async () => {
        try {
          if (job.kind === 'main') {
            const controller = new AbortController();
            runningControllers.set(job.id, controller);
            try {
              job.result = await runFlow(job.listUrl, undefined, controller.signal);
            } finally {
              // Qua khỏi bước Debounce là hết huỷ được — các bước sau chỉ vài giây.
              runningControllers.delete(job.id);
            }
            if (controller.signal.aborted) {
              logger.warn('Yêu cầu huỷ tới lúc job đã lọc xong Debounce — vẫn hoàn tất bình thường.');
            }
            // Tên file (và tên hiển thị trên web UI) giờ lấy từ chính tên file Excel thật đã tạo
            // (tự đặt theo tên list Apollo — xem runFlow/sanitizeToFileName), không còn do người
            // dùng tự gõ nữa, nên chỉ biết được SAU KHI export xong.
            job.outputFileName = path.basename(job.result.masterXlsxPath, '.xlsx');
            // Tự động đẩy tiếp bước xử lý Risky (Teams/Gmail -> meetscript.io) vào hàng đợi RIÊNG —
            // vẫn là 1 luồng liền mạch, không cần bấm nút nào thêm, nhưng không còn chặn job
            // Apollo/Debounce tiếp theo của người khác nữa.
            const riskyJob = enqueueRiskyJob(job.result.riskyPath, job.result.masterXlsxPath, job.outputFileName);
            job.riskyJobId = riskyJob.id;
          } else {
            await runApolloReimport(job.masterXlsxPath);
          }
          job.status = 'done';
        } catch (err) {
          if (err instanceof JobCancelledError) {
            job.status = 'cancelled';
            logger.warn('Đã huỷ list theo yêu cầu. Lưu ý: nếu đã gửi lên Debounce thì Debounce vẫn xử lý xong phía họ.');
          } else {
            job.status = 'error';
            job.error = err instanceof Error ? err.message : String(err);
            logger.error(`Job ${job.kind === 'main' ? 'Apollo/Debounce' : 'import lại Apollo'} lỗi:`, err);
          }
        } finally {
          job.finishedAt = Date.now();
          scheduleSave();
        }
      });
    }
  } finally {
    mainProcessing = false;
  }
}

// Chạy ĐÚNG 1 job Risky tại 1 thời điểm (nhưng BÊN TRONG 1 job, nhiều lượt upload chạy SONG SONG
// — xem risky-pipeline.ts) — dùng chung 1 Chrome profile Risky riêng, tách biệt hoàn toàn với
// profile Apollo nên chạy đồng thời được với mainQueue ở trên.
async function processRiskyQueue(): Promise<void> {
  if (riskyProcessing) return;
  riskyProcessing = true;
  try {
    while (riskyQueue.length > 0) {
      const id = riskyQueue.shift();
      const job = id ? jobs.get(id) : undefined;
      if (!job || job.kind !== 'risky') continue;
      job.status = 'running';
      scheduleSave();
      await jobContext.run({ append: (line) => { job.logs.push(line); scheduleSave(); } }, async () => {
        let context: Awaited<ReturnType<typeof openPersistentChrome>> | undefined;
        try {
          context = await openPersistentChrome(config.riskyChromeUserDataDir);
          job.result = await runRiskyFlow(
            job.riskyPath,
            context,
            (done, total) => {
              job.progress = `${done}/${total}`;
              scheduleSave();
            },
            job.id,
            job.masterXlsxPath,
          );
          job.status = 'done';
        } catch (err) {
          job.status = 'error';
          job.error = err instanceof Error ? err.message : String(err);
          logger.error('Job Risky lỗi:', err);
        } finally {
          await context?.close().catch(() => {});
          job.finishedAt = Date.now();
          scheduleSave();
        }
      });
    }
  } finally {
    riskyProcessing = false;
  }
}

function isAuthorized(req: http.IncomingMessage): boolean {
  if (!config.webuiPassword) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf-8');
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  return pass === config.webuiPassword;
}

function requireAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (isAuthorized(req)) return true;
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="internal-tool"',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('Cần đăng nhập đúng mật khẩu để dùng công cụ này.');
  return false;
}

const TZ = 'Asia/Ho_Chi_Minh';

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} giờ ${m} phút`;
  if (m > 0) return `${m} phút ${s % 60}s`;
  return `${s}s`;
}

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'Đang chờ',
  running: 'Đang chạy',
  done: 'Hoàn tất',
  error: 'Lỗi',
  cancelled: 'Đã huỷ',
};

/** Chữ phụ cạnh trạng thái: vị trí trong hàng đợi, "đang dừng", tiến trình upload Risky. */
function jobChipExtra(job: Job): string {
  const pos = queuePosition(job);
  if (pos > 0) return `#${pos} trong hàng chờ`;
  if (job.kind === 'main' && job.status === 'running' && job.cancelRequestedAt) return 'đang dừng...';
  if (isRiskyJob(job) && job.status === 'running' && job.progress) return `${job.progress} lượt`;
  return '';
}

function statusChip(status: JobStatus, extra = ''): string {
  return `<span class="chip chip-${status}"><i></i>${STATUS_LABEL[status]}${extra ? ` · ${escapeHtml(extra)}` : ''}</span>`;
}

const ICONS = {
  stop: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>',
  apollo: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
  verify: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>',
  risky: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  sync: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/></svg>',
  trash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
  download: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
  back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
  arrowRight: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>',
  mail: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
  alert: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
};

function jobLabel(job: Job): string {
  if (job.kind === 'main') return job.outputFileName || `List Apollo #${job.id}`;
  if (job.kind === 'reimport') return `Import lại Apollo — ${path.basename(job.masterXlsxPath)}`;
  return `Risky — ${job.sourceLabel}`;
}

function jobTagClass(job: Job): string {
  if (job.kind === 'main') return 'tag-main';
  if (job.kind === 'reimport') return 'tag-reimport';
  return 'tag-risky';
}

function jobTagLabel(job: Job): string {
  if (job.kind === 'main') return 'Apollo';
  if (job.kind === 'reimport') return 'Import lại';
  return 'Risky';
}

function jobIcon(job: Job): string {
  if (job.kind === 'main') return `<span class="job-ico">${ICONS.apollo}</span>`;
  if (job.kind === 'reimport') return `<span class="job-ico reimport">${ICONS.sync}</span>`;
  return `<span class="job-ico risky">${ICONS.risky}</span>`;
}

function isActive(job: Job): boolean {
  return job.status === 'queued' || job.status === 'running';
}

function renderTelegramBanner(): string {
  const status = getTelegramWatchStatus();
  if (status.pending.length === 0) return '';

  const overdueBlock =
    status.overdue.length > 0
      ? `<p style="color:#a85b00"><strong>${status.overdue.length} file chờ quá lâu chưa thấy bot trả về</strong> (vẫn tiếp tục tự động chờ, nhưng nếu lâu quá nên vào group Telegram kiểm tra thủ công):</p>
         <ul>
           ${status.overdue
             .map(
               (e) => `<li>
                 ${escapeHtml(path.basename(e.excelPath))} (${e.kind}) — đã chờ ${Math.round((Date.now() - e.registeredAt) / 60_000)} phút
                 <form method="POST" action="/telegram-pending/dismiss" style="display:inline" onsubmit="return confirm('Bỏ theo dõi file này? Dùng khi đã tự tải tay trong group Telegram rồi.')">
                   <input type="hidden" name="excelPath" value="${escapeHtml(e.excelPath)}" />
                   <input type="hidden" name="kind" value="${escapeHtml(e.kind)}" />
                   <button type="submit" class="mini-btn">Bỏ qua</button>
                 </form>
               </li>`,
             )
             .join('')}
         </ul>`
      : '';

  return `<div class="banner banner-info">
      <span class="b-ico" style="color:var(--nsc-dark)">${ICONS.mail}</span>
      <div>
        <strong>Đang chờ bot meetscript.io trả kết quả qua Telegram cho ${status.pending.length} file.</strong>
        <p>Tool tự tải về ngay khi bot gửi vào group, bạn không cần làm gì thêm.</p>
        ${overdueBlock}
      </div>
    </div>`;
}

function renderHistoryRow(j: Job): string {
  const progress = jobChipExtra(j);
  const del = isActive(j)
    ? '<span style="width:32px"></span>'
    : `<button class="icon-btn" type="button" title="Xoá khỏi lịch sử"
         data-title="Xoá job này?" data-confirm="Job “${escapeHtml(jobLabel(j))}” sẽ bị xoá khỏi lịch sử. File kết quả trên server vẫn được giữ nguyên."
         data-action="/jobs/${j.id}/delete">${ICONS.trash}</button>`;
  return `<div class="job-row" data-kind="${j.kind}">
      <a class="job-main" href="/jobs/${j.id}">
        ${jobIcon(j)}
        <span style="min-width:0">
          <span class="job-name">${escapeHtml(jobLabel(j))}</span>
          <span class="job-meta"><span class="tag ${jobTagClass(j)}">${jobTagLabel(j)}</span>${j.finishedAt ? `<span>${fmtDuration(j.finishedAt - j.createdAt)}</span>` : ''}</span>
        </span>
      </a>
      ${statusChip(j.status, progress)}
      <span class="job-time">${fmtTime(j.createdAt)}</span>
      ${del}
    </div>`;
}

function renderHome(errorMessage?: string): string {
  const allJobs = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  const activeJobs = allJobs.filter(isActive);
  const doneCount = allJobs.filter((j) => j.status === 'done').length;
  const errorCount = allJobs.filter((j) => j.status === 'error').length;
  const finishedCount = allJobs.length - activeJobs.length;

  const errorBanner = errorMessage
    ? `<div class="banner banner-err reveal"><span class="b-ico" style="color:var(--err)">${ICONS.alert}</span><div><strong>${escapeHtml(errorMessage)}</strong></div></div>`
    : '';

  const activeBanner =
    activeJobs.length > 0
      ? `<div class="banner banner-warn">
          <span class="b-ico" style="color:#b57a00">${ICONS.sync}</span>
          <div>
            <strong>Đang có ${activeJobs.length} luồng chạy hoặc chờ chạy</strong>
            <ul>
              ${activeJobs
                .map(
                  (j) =>
                    `<li><a href="/jobs/${j.id}">${escapeHtml(jobLabel(j))}</a> <span class="tag ${jobTagClass(j)}">${jobTagLabel(j)}</span> ${statusChip(j.status, jobChipExtra(j))}</li>`,
                )
                .join('')}
            </ul>
            <p>Các list Apollo chạy lần lượt từng list một. Hàng chờ đang có <b>${queuedMainCount()}/${MAX_QUEUED_MAIN_JOBS}</b> list. Phần Risky chạy song song ở hàng đợi riêng.</p>
          </div>
        </div>`
      : '';

  const telegramBanner = renderTelegramBanner();
  const refreshSeconds = activeJobs.length > 0 ? 4 : telegramBanner ? 15 : 0;

  const flowStep = (icon: string, label: string) => `<div class="flow-step"><span class="flow-ico">${icon}</span><b>${label}</b></div>`;
  const flowLine = '<svg class="flow-line" viewBox="0 0 48 2"><line x1="0" y1="1" x2="48" y2="1"/></svg>';

  const hero = `
<section class="hero">
  <span class="hero-orb a"></span><span class="hero-orb b"></span>
  <div class="hero-rings"><span></span><span></span><span></span><span></span><span></span></div>
  <img class="hero-mark" src="/assets/nsc-logo-white.png" alt="" />
  <span class="hero-badge reveal"><i></i>Tự động hoá toàn bộ pipeline</span>
  <h1 class="reveal d1">Lọc &amp; xác minh leads,<br/><em>chạy hoàn toàn tự động</em></h1>
  <p class="hero-sub reveal d2">Dán link List Apollo. Tool tự export, xác minh email qua Debounce, xử lý Risky qua Teams/Google rồi cập nhật kết quả ngược lại Apollo.</p>
  <form method="POST" action="/jobs" class="hero-form reveal d3">
    <div class="hero-form-inner">
      <svg class="link" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>
      <input type="url" name="listUrl" placeholder="https://app.apollo.io/#/lists/..." required autocomplete="off" />
      <button type="submit" class="btn-go"><span class="lbl">Bắt đầu</span><span class="arrow">${ICONS.arrowRight}</span><span class="spinner"></span></button>
    </div>
  </form>
  <p class="hero-hint reveal d4">Tên file output tự lấy theo tên list Apollo, không cần nhập tay.</p>
  <div class="flow reveal d5">
    ${flowStep(ICONS.apollo, 'Export Apollo')}${flowLine}
    ${flowStep(ICONS.verify, 'Verify Debounce')}${flowLine}
    ${flowStep(ICONS.risky, 'Xử lý Risky')}${flowLine}
    ${flowStep(ICONS.sync, 'Cập nhật Apollo')}
  </div>
</section>`;

  const stat = (cls: string, label: string, value: number) =>
    `<div class="card stat ${cls}"><small>${label}</small><strong data-count="${value}">0</strong></div>`;

  const history =
    allJobs.length === 0
      ? `<div class="empty">
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg>
          <b>Chưa có lần chạy nào</b>
          Dán link List Apollo ở trên để bắt đầu.
        </div>`
      : allJobs.map(renderHistoryRow).join('');

  const clearBtn =
    finishedCount > 0
      ? `<button class="btn btn-danger" type="button" data-title="Xoá toàn bộ lịch sử?"
           data-confirm="Xoá ${finishedCount} job đã chạy xong khỏi lịch sử. Job đang chạy/đang chờ vẫn giữ nguyên, file kết quả trên server không bị xoá."
           data-action="/jobs/clear">${ICONS.trash} Xoá lịch sử</button>`
      : '';

  const body = `
${hero}
${errorBanner}
<div data-live="banners">${activeBanner}${telegramBanner}</div>
<div class="stats reveal d2" data-live="stats">
  ${stat('', 'Tổng số job', allJobs.length)}
  ${stat('run', 'Đang chạy / chờ', activeJobs.length)}
  ${stat('ok', 'Hoàn tất', doneCount)}
  ${stat('err', 'Lỗi', errorCount)}
</div>
<div class="section-head reveal d3" id="history-head" style="scroll-margin-top:84px">
  <h2>Lịch sử chạy</h2>
  <span class="spacer"></span>
  <div class="tabs">
    <button type="button" data-f="all" class="on">Tất cả</button>
    <button type="button" data-f="main">Apollo</button>
    <button type="button" data-f="risky">Risky</button>
    <button type="button" data-f="reimport">Import lại</button>
  </div>
  <span data-live="clear">${clearBtn}</span>
</div>
<div class="card jobs reveal d4" data-live="history">${history}</div>
<nav class="pager reveal d5" id="pager" aria-label="Phân trang lịch sử"></nav>
`;
  return pageLayout(BRAND_NAME, body, refreshSeconds);
}

type StepState = 'done' | 'active' | 'pending' | 'failed';

function renderStepper(steps: { label: string; state: StepState }[]): string {
  return `<div class="stepper">${steps
    .map(
      (s, i) =>
        `<div class="step ${s.state}"><span class="dot">${s.state === 'done' ? '✓' : s.state === 'failed' ? '!' : i + 1}</span><b>${s.label}</b></div>`,
    )
    .join('')}</div>`;
}

function renderLog(job: Job): string {
  return `<div class="section-head"><h2>Log</h2><span class="count" data-live="logcount">${job.logs.length} dòng</span></div>
<div class="terminal">
  <div class="term-bar"><i></i><i></i><i></i><span>${escapeHtml(jobLabel(job))}</span><button type="button" data-copy-log>Copy</button></div>
  <pre data-live="log">${escapeHtml(job.logs.join('\n') || '(chưa có log)')}</pre>
</div>`;
}

function renderMeta(items: [string, string][]): string {
  return `<div class="meta-grid">${items
    .map(([k, v]) => `<div class="meta"><small>${k}</small><span title="${escapeHtml(v)}">${escapeHtml(v)}</span></div>`)
    .join('')}</div>`;
}

function timingMeta(job: Job): [string, string][] {
  const items: [string, string][] = [['Bắt đầu', fmtTime(job.createdAt)]];
  if (job.finishedAt) {
    items.push(['Kết thúc', fmtTime(job.finishedAt)], ['Thời lượng', fmtDuration(job.finishedAt - job.createdAt)]);
  } else if (job.status === 'running') {
    items.push(['Đã chạy', fmtDuration(Date.now() - job.createdAt)]);
  }
  return items;
}

/** Nút huỷ cho job Apollo/Debounce đang chờ hoặc đang chạy (chưa qua bước Debounce). Cần xác nhận 2 lần. */
function cancelButton(job: Job): string {
  if (job.kind !== 'main') return '';
  const canCancel = job.status === 'queued' || (job.status === 'running' && runningControllers.has(job.id) && !job.cancelRequestedAt);
  if (!canCancel) return '';
  const label = escapeHtml(jobLabel(job));
  const first =
    job.status === 'queued'
      ? `List “${label}” đang chờ trong hàng đợi. Huỷ thì list sẽ bị bỏ khỏi hàng chờ.`
      : `List “${label}” đang chạy (export Apollo / lọc Debounce). Huỷ thì tool dừng ngay, không tạo file kết quả.`;
  const second =
    job.status === 'queued'
      ? 'Xác nhận lần 2: huỷ list này? Muốn chạy lại thì phải nhập lại link từ đầu.'
      : 'Xác nhận lần 2: huỷ list này? Nếu list đã gửi lên Debounce thì credit Debounce vẫn bị tính, và phải chạy lại từ đầu.';
  return `<button class="btn btn-danger" type="button" data-title="Huỷ list này?" data-confirm="${escapeHtml(first)}"
      data-ok-label="Huỷ list" data-title2="Bạn chắc chắn muốn huỷ?" data-confirm2="${escapeHtml(second)}" data-ok2-label="Chắc chắn, huỷ list"
      data-action="/jobs/${job.id}/cancel">${ICONS.stop} Huỷ list</button>`;
}

function detailHead(job: Job, extraChip = ''): string {
  const del = isActive(job)
    ? cancelButton(job)
    : `<button class="btn btn-danger" type="button" data-title="Xoá job này?"
         data-confirm="Job sẽ bị xoá khỏi lịch sử. File kết quả trên server vẫn được giữ nguyên."
         data-action="/jobs/${job.id}/delete">${ICONS.trash} Xoá</button>`;
  return `<div class="detail-head">
    ${jobIcon(job)}
    <div class="grow">
      <h1>${escapeHtml(jobLabel(job))}</h1>
      <div class="sub"><span class="tag ${jobTagClass(job)}">${jobTagLabel(job)}</span>${statusChip(job.status, extraChip || jobChipExtra(job))}</div>
    </div>
    ${del}
  </div>`;
}

function errorBlockFor(job: Job): string {
  if (job.status === 'cancelled') {
    return `<div class="banner banner-warn" style="margin:20px 0 0"><span class="b-ico" style="color:#5b6878">${ICONS.stop}</span><div><strong>List đã bị huỷ</strong><p>Không tạo file kết quả. Muốn chạy lại thì nhập lại link List Apollo ở trang chủ.</p></div></div>`;
  }
  return job.status === 'error'
    ? `<div class="banner banner-err" style="margin:20px 0 0"><span class="b-ico" style="color:var(--err)">${ICONS.alert}</span><div><strong>Lỗi</strong><p style="color:inherit">${escapeHtml(job.error ?? '')}</p></div></div>`
    : '';
}

function backLink(): string {
  return `<a class="back reveal" href="/">${ICONS.back} Quay lại danh sách</a>`;
}

function mainJobSteps(job: MainJob): { label: string; state: StepState }[] {
  const logText = job.logs.join('\n');
  const riskyJob = job.riskyJobId ? jobs.get(job.riskyJobId) : undefined;
  const risky = riskyJob && isRiskyJob(riskyJob) ? riskyJob : undefined;
  const tg = risky ? getJobTelegramStatus(risky.id) : undefined;
  const reimport = job.result
    ? [...jobs.values()].find((j): j is ReimportJob => j.kind === 'reimport' && j.masterXlsxPath === job.result?.masterXlsxPath)
    : undefined;

  let mainIdx = 0; // bước 0-2 thuộc job này
  if (job.status === 'done') mainIdx = 3;
  else if (logText.includes('Đã lưu file gốc sau Debounce')) mainIdx = 2;
  else if (logText.includes('Đã xoá cột Contact Owner')) mainIdx = 1;

  const s = (i: number): StepState => {
    if (i < mainIdx) return 'done';
    if (i === mainIdx) return job.status === 'error' || job.status === 'cancelled' ? 'failed' : job.status === 'running' ? 'active' : 'pending';
    return 'pending';
  };
  const riskyState: StepState = !risky ? 'pending' : risky.status === 'done' ? 'done' : risky.status === 'error' ? 'failed' : risky.status === 'running' ? 'active' : 'pending';
  const expected = risky?.result ? expectedLots(risky.result) : 0;
  const tgState: StepState =
    risky?.status === 'done' && risky.result === null
      ? 'done'
      : tg?.mergeStatus === 'done'
        ? 'done'
        : tg?.mergeStatus === 'error'
          ? 'failed'
          : expected > 0
            ? 'active'
            : 'pending';
  const reState: StepState = !reimport ? 'pending' : reimport.status === 'done' ? 'done' : reimport.status === 'error' ? 'failed' : 'active';

  return [
    { label: 'Export Apollo', state: s(0) },
    { label: 'Verify Debounce', state: s(1) },
    { label: 'Excel & tách Risky', state: s(2) },
    { label: 'Teams / Google', state: riskyState },
    { label: 'Kết quả Telegram', state: tgState },
    { label: 'Import lại Apollo', state: reState },
  ];
}

function renderMainJob(job: MainJob): string {
  const active = isActive(job);

  let resultBlock = '';
  if (job.status === 'done' && job.result) {
    const { result } = job;
    let riskyLinkBlock = '';
    if (job.riskyJobId) {
      const riskyJob = jobs.get(job.riskyJobId);
      if (riskyJob && isRiskyJob(riskyJob)) {
        const mergeStatus = getJobTelegramStatus(riskyJob.id).mergeStatus;
        const mergeNote =
          mergeStatus === 'done'
            ? '<br/><span style="color:var(--ok)">Đã tự động cập nhật cột RESULT trong file Excel.</span>'
            : mergeStatus === 'error'
              ? '<br/><span style="color:var(--err)">Lỗi khi tự động cập nhật, xem chi tiết ở trang Risky.</span>'
              : '';
        riskyLinkBlock = `<p class="note">Bước xử lý Risky (Teams/Gmail → meetscript.io): ${statusChip(riskyJob.status, riskyJob.status === 'running' && riskyJob.progress ? riskyJob.progress : '')}
            <a href="/jobs/${riskyJob.id}" style="margin-left:6px">Xem tiến trình →</a>${mergeNote}</p>`;
      }
    }
    resultBlock = `
      <div class="actions">
        <a class="btn btn-primary" href="/jobs/${job.id}/download/xlsx">${ICONS.download} File Excel · ${escapeHtml(path.basename(result.masterXlsxPath))}</a>
        <a class="btn" href="/jobs/${job.id}/download/risky">${ICONS.download} File Risky CSV</a>
      </div>
      ${riskyLinkBlock}`;
  }

  const riskyJob = job.riskyJobId ? jobs.get(job.riskyJobId) : undefined;
  const pipelineActive = active || (riskyJob ? isActive(riskyJob) : false);

  const body = `
${backLink()}
<div class="card detail reveal d1" data-live="detail">
  ${detailHead(job)}
  ${renderMeta([['List Apollo', job.listUrl], ...timingMeta(job)])}
  ${renderStepper(mainJobSteps(job))}
  ${active ? '<div class="progress"></div>' : ''}
  ${resultBlock}
  ${errorBlockFor(job)}
</div>
<div class="reveal d2">${renderLog(job)}</div>
`;
  return pageLayout(`${jobLabel(job)} — ${BRAND_NAME}`, body, active ? 3 : pipelineActive ? 8 : 0);
}

// Kết quả cũ (lưu trong lịch sử trước khi có successfulLots/failedLots) coi như mọi lượt thành công.
function expectedLots(result: RiskyFlowResult): number {
  return result.successfulLots ?? result.chunks.length * 2;
}

function failedLots(result: RiskyFlowResult): string[] {
  return result.failedLots ?? [];
}

function renderRiskyJob(job: RiskyJob): string {
  // Tổng số kết quả MONG ĐỢI từ Telegram = 2 (TEAM + GOOGLE) cho mỗi phần đã tách.
  const telegramStatus = getJobTelegramStatus(job.id);
  const expectedTelegramTotal = job.result ? expectedLots(job.result) : 0;
  const receivedCount = telegramStatus.received.length;
  const telegramAllReceived = expectedTelegramTotal > 0 && receivedCount >= expectedTelegramTotal;

  // Vẫn tự cập nhật khi job đã "done" (upload xong) nếu CHƯA nhận đủ kết quả thật từ Telegram.
  const active = isActive(job);
  const waitingTelegram = expectedTelegramTotal > 0 && !telegramAllReceived;

  let progressBlock = active ? '<div class="progress"></div>' : '';
  if (job.status === 'running' && job.progress) {
    const [done, total] = job.progress.split('/').map(Number);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    progressBlock = `<p class="note">Upload meetscript.io: <strong>${escapeHtml(job.progress)}</strong> lượt (${pct}%)</p>
      <div class="progress det" style="margin-top:8px"><span class="bar" style="width:${pct}%"></span></div>`;
  }

  let resultBlock = '';
  if (job.status === 'done') {
    if (job.result === null) {
      resultBlock = `<p class="note ok">File Risky không có lead nào, không cần xử lý thêm.</p>`;
    } else if (job.result) {
      const { chunks } = job.result;
      resultBlock = `
        <p class="note"><strong>Đã upload xong Risky${chunks.length > 1 ? ` (${chunks.length} phần, chạy song song do giới hạn 1000 lead/lần của meetscript.io)` : ''}.</strong> Kết quả thật (file Excel Team/Google) sẽ do bot Telegram gửi về.</p>
        ${chunks
          .map(
            (chunk, i) => `
          ${chunks.length > 1 ? `<p class="note" style="margin-bottom:0"><strong>Phần ${i + 1}/${chunks.length}</strong> · ${escapeHtml(path.basename(chunk.excelPath))}</p>` : ''}
          <div class="shots">
            ${chunk.teamResultScreenshot ? `<div class="shot"><p>Xác nhận upload · TEAM</p><img loading="lazy" src="/jobs/${job.id}/screenshot/${i}/team" alt="Kết quả TEAM" /></div>` : `<div class="shot"><p>TEAM · không có ảnh popup</p></div>`}
            ${chunk.googleResultScreenshot ? `<div class="shot"><p>Xác nhận upload · GOOGLE</p><img loading="lazy" src="/jobs/${job.id}/screenshot/${i}/google" alt="Kết quả GOOGLE" /></div>` : `<div class="shot"><p>GOOGLE · không có ảnh popup</p></div>`}
          </div>`,
          )
          .join('')}
        ${(job.result.unconfirmedLots ?? []).length > 0 ? `<div class="banner banner-info" style="margin-top:16px"><span class="b-ico" style="color:var(--nsc-dark)">${ICONS.mail}</span><div><strong>Đã gửi nhưng không thấy popup: ${escapeHtml((job.result.unconfirmedLots ?? []).join(', '))}</strong><p>Tool không upload lại để tránh kết quả trùng, vẫn chờ kết quả qua Telegram như bình thường. Nếu quá lâu không thấy, bấm "Bỏ qua" ở trang chủ để tool ghép với các kết quả đã có.</p></div></div>` : ''}
        ${failedLots(job.result).length > 0 ? `<div class="banner banner-warn" style="margin-top:16px"><span class="b-ico" style="color:#b57a00">${ICONS.alert}</span><div><strong>${failedLots(job.result).length} lượt lượt không gửi được sau 3 lần thử: ${escapeHtml(failedLots(job.result).join(', '))}</strong><p>Tool vẫn tự ghép kết quả của các lượt thành công. Lead chỉ thuộc lượt thất bại sẽ giữ nhãn Risky.</p></div></div>` : ''}`;
    }
  }

  let telegramBlock = '';
  if (expectedTelegramTotal > 0) {
    const pct = Math.round((Math.min(receivedCount, expectedTelegramTotal) / expectedTelegramTotal) * 100);
    telegramBlock = `<p class="note${telegramAllReceived ? ' ok' : ''}"><strong>Kết quả Telegram: ${receivedCount}/${expectedTelegramTotal}</strong>${
      telegramAllReceived ? ' · đã nhận đủ.' : ' · đang chờ phần còn lại (bot meetscript.io có thể mất 1-2 tiếng).'
    }</p>
    <div class="progress det" style="margin-top:8px"><span class="bar" style="width:${pct}%"></span></div>`;
    if (telegramStatus.received.length > 0) {
      telegramBlock += `<div class="note"><ul>${telegramStatus.received
        .map((r) => `<li>${escapeHtml(r.fileName)} (${r.kind}) · ${fmtTime(r.receivedAt)}</li>`)
        .join('')}</ul></div>`;
    }
    if (telegramStatus.mergeStatus === 'done') {
      telegramBlock += `<p class="note ok"><strong>Đã tự động cập nhật cột RESULT (Safe to Send/Do not Send) trong file Excel gốc.</strong> Tải lại file ở trang job Apollo để xem bản mới nhất.</p>`;
    } else if (telegramStatus.mergeStatus === 'error') {
      telegramBlock += `<div class="banner banner-err" style="margin-top:14px"><span class="b-ico" style="color:var(--err)">${ICONS.alert}</span><div><strong>Lỗi khi tự động cập nhật file Excel gốc</strong><p style="color:inherit">${escapeHtml(telegramStatus.mergeError ?? '')}<br/>Cần ghép tay. Các file kết quả Team/Google vẫn tải về bình thường.</p></div></div>`;
    }
  }

  const body = `
${backLink()}
<div class="card detail reveal d1" data-live="detail">
  ${detailHead(job)}
  ${renderMeta([['File nguồn', job.sourceLabel], ...timingMeta(job)])}
  ${progressBlock}
  ${resultBlock}
  ${telegramBlock}
  ${errorBlockFor(job)}
</div>
<div class="reveal d2">${renderLog(job)}</div>
`;
  return pageLayout(`${jobLabel(job)} — ${BRAND_NAME}`, body, active ? 3 : waitingTelegram ? 10 : 0);
}

function renderReimportJob(job: ReimportJob): string {
  const active = isActive(job);
  const doneBlock =
    job.status === 'done' ? `<p class="note ok"><strong>Đã import xong (cột email + RESULT) ngược lại Apollo.</strong></p>` : '';

  const body = `
${backLink()}
<div class="card detail reveal d1" data-live="detail">
  ${detailHead(job)}
  ${renderMeta([['File Excel', path.basename(job.masterXlsxPath)], ...timingMeta(job)])}
  <p class="note">Dùng chung hàng đợi và Chrome với job export Apollo, chạy ngay sau khi job Apollo đang chạy (nếu có) xong.</p>
  ${active ? '<div class="progress"></div>' : ''}
  ${doneBlock}
  ${errorBlockFor(job)}
</div>
<div class="reveal d2">${renderLog(job)}</div>
`;
  return pageLayout(`Import lại Apollo — ${BRAND_NAME}`, body, active ? 3 : 0);
}

function renderJob(job: Job): string {
  if (job.kind === 'main') return renderMainJob(job);
  if (job.kind === 'reimport') return renderReimportJob(job);
  return renderRiskyJob(job);
}

function serveDownload(res: http.ServerResponse, filePath: string): void {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Không tìm thấy file (có thể server đã khởi động lại và mất thông tin job).');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`,
  });
  fs.createReadStream(filePath).pipe(res);
}

function sendJson(res: http.ServerResponse, data: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (!requireAuth(req, res)) return;

    // Chỉ phục vụ đúng tên file khớp mẫu (không nhận path tuỳ ý) — tránh path traversal dù chỉ
    // phục vụ vài file logo/favicon tĩnh của chính mình, không phải nội dung do người dùng đưa vào.
    const assetMatch = url.pathname.match(/^\/assets\/([a-z0-9_-]+\.png)$/i);
    if (req.method === 'GET' && assetMatch) {
      const filePath = path.join(ASSETS_DIR, assetMatch[1]);
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(renderHome(url.searchParams.get('error') ?? undefined));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/jobs') {
      const body = await readRequestBody(req);
      const params = new URLSearchParams(body);
      const listUrl = (params.get('listUrl') ?? '').trim();
      // Tên file output không còn nhập tay nữa — tự lấy theo tên list Apollo thật lúc export (xem
      // runFlow trong pipeline.ts), nên ở đây chỉ còn cần kiểm tra có link hay không.
      if (!listUrl) {
        res.writeHead(303, { Location: `/?error=${encodeURIComponent('Thiếu link List Apollo.')}` });
        res.end();
        return;
      }
      if (queuedMainCount() >= MAX_QUEUED_MAIN_JOBS) {
        const msg = `Hàng chờ đã đầy (${MAX_QUEUED_MAIN_JOBS} list đang chờ). Vui lòng đợi bớt list rồi thử lại.`;
        res.writeHead(303, { Location: `/?error=${encodeURIComponent(msg)}` });
        res.end();
        return;
      }
      const job = enqueueMainJob(listUrl);
      res.writeHead(303, { Location: `/jobs/${job.id}` });
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/jobs/clear') {
      const removed = clearFinishedJobs();
      sendJson(res, { ok: true, message: `Đã xoá ${removed} job khỏi lịch sử` });
      return;
    }

    const cancelMatch = url.pathname.match(/^\/jobs\/([a-f0-9]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      const result = cancelMainJob(cancelMatch[1]);
      res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result));
      return;
    }

    const deleteMatch = url.pathname.match(/^\/jobs\/([a-f0-9]+)\/delete$/);
    if (req.method === 'POST' && deleteMatch) {
      if (!deleteJob(deleteMatch[1])) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: 'Không xoá được job đang chạy hoặc không tồn tại.' }));
        return;
      }
      const fromDetail = (req.headers.referer ?? '').includes(`/jobs/${deleteMatch[1]}`);
      sendJson(res, { ok: true, message: 'Đã xoá job khỏi lịch sử', ...(fromDetail ? { redirect: '/' } : {}) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/telegram-pending/dismiss') {
      const body = await readRequestBody(req);
      const params = new URLSearchParams(body);
      const excelPath = params.get('excelPath') ?? '';
      const kind = params.get('kind');
      if (excelPath && (kind === 'TEAM' || kind === 'GOOGLE')) {
        dismissPendingEntry(excelPath, kind);
      }
      res.writeHead(303, { Location: '/' });
      res.end();
      return;
    }

    const jobMatch = url.pathname.match(/^\/jobs\/([a-f0-9]+)$/);
    if (req.method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Không tìm thấy job này (có thể đã bị xoá khỏi lịch sử).');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(renderJob(job));
      return;
    }

    const downloadMatch = url.pathname.match(/^\/jobs\/([a-f0-9]+)\/download\/(xlsx|risky)$/);
    if (req.method === 'GET' && downloadMatch) {
      const job = jobs.get(downloadMatch[1]);
      if (!job || job.kind !== 'main' || !job.result) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Không tìm thấy file để tải.');
        return;
      }
      const filePath = downloadMatch[2] === 'xlsx' ? job.result.masterXlsxPath : job.result.riskyPath;
      serveDownload(res, filePath);
      return;
    }

    const screenshotMatch = url.pathname.match(/^\/jobs\/([a-f0-9]+)\/screenshot\/(\d+)\/(team|google)$/);
    if (req.method === 'GET' && screenshotMatch) {
      const job = jobs.get(screenshotMatch[1]);
      const chunk = job && job.kind === 'risky' && job.result ? job.result.chunks[Number(screenshotMatch[2])] : undefined;
      if (!chunk) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Không tìm thấy ảnh kết quả.');
        return;
      }
      const filePath = screenshotMatch[3] === 'team' ? chunk.teamResultScreenshot : chunk.googleResultScreenshot;
      if (!filePath || !fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Không tìm thấy ảnh kết quả (lượt upload này thất bại, hoặc ảnh đã bị xoá).');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Không tìm thấy trang.');
  })().catch((err) => {
    logger.error('Lỗi xử lý request web UI:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('Lỗi server.');
  });
});

fs.mkdirSync(PROCESSED_DIR, { recursive: true });
loadJobs();
for (const job of requeueAfterRestart.sort((a, b) => a.createdAt - b.createdAt)) {
  (job.kind === 'risky' ? riskyQueue : mainQueue).push(job.id);
}
if (requeueAfterRestart.length > 0) {
  logger.info(`Xếp lại ${requeueAfterRestart.length} job đang chờ từ trước khi khởi động lại vào hàng đợi.`);
  void processMainQueue();
  void processRiskyQueue();
}

// Ghi lịch sử lần cuối trước khi tắt (systemd restart gửi SIGTERM).
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    saveJobsNow();
    process.exit(0);
  });
}

// Ngay khi ghép xong kết quả Risky (telegram-watcher.ts, độc lập không cần Chrome) — xếp tiếp job
// import ngược lại Apollo vào hàng đợi DÙNG CHUNG Chrome profile Apollo (xem enqueueReimportJob).
setOnMergeComplete((masterXlsxPath) => {
  enqueueReimportJob(masterXlsxPath);
});

// Chạy độc lập hoàn toàn với 2 hàng đợi Chrome — chỉ gọi API Telegram thuần, không cần Chrome,
// không chặn/bị chặn bởi các job khác.
startTelegramWatcher();

server.listen(config.webuiPort, config.webuiHost, () => {
  logger.info(
    `Web UI đang chạy tại http://${config.webuiHost}:${config.webuiPort}/ ` +
      `(${config.webuiHost === '127.0.0.1' ? 'chỉ localhost — truy cập thật qua Caddy (HTTPS)' : 'lắng nghe công khai'})` +
      (config.webuiPassword ? ', yêu cầu mật khẩu.' : ', KHÔNG có mật khẩu — ai cũng vào được.'),
  );
});
