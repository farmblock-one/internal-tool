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
import { logger } from './logger.js';
import { config } from './config.js';
import { isValidOutputFileName } from './filename-utils.js';

const PROCESSED_DIR = path.resolve('data/processed');
const ASSETS_DIR = path.resolve('assets');

type JobStatus = 'queued' | 'running' | 'done' | 'error';

interface MainJob {
  kind: 'main';
  id: string;
  listUrl: string;
  outputFileName: string;
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

// 2 HÀNG ĐỢI RIÊNG BIỆT, chạy ĐỘC LẬP (mỗi hàng đợi 1 Chrome profile riêng — xem config.ts):
//   - mainQueue: Apollo export -> Debounce verify, dùng profile Apollo (CHROME_USER_DATA_DIR).
//   - riskyQueue: Teams/Gmail -> meetscript.io, dùng profile Risky (RISKY_CHROME_USER_DATA_DIR).
// Tách riêng để list lớn (xử lý Risky có thể mất hàng giờ) không còn chặn người khác chạy job
// Apollo mới — 2 hàng đợi chạy song song được vì dùng 2 Chrome profile khác nhau.
const mainQueue: string[] = [];
let mainProcessing = false;
const riskyQueue: string[] = [];
let riskyProcessing = false;

function isRiskyJob(job: Job): job is RiskyJob {
  return job.kind === 'risky';
}

function enqueueMainJob(listUrl: string, outputFileName: string): MainJob {
  const id = crypto.randomBytes(6).toString('hex');
  const job: MainJob = { kind: 'main', id, listUrl, outputFileName, status: 'queued', logs: [], createdAt: Date.now() };
  jobs.set(id, job);
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
      await jobContext.run({ append: (line) => job.logs.push(line) }, async () => {
        try {
          if (job.kind === 'main') {
            job.result = await runFlow(job.listUrl, job.outputFileName);
            // Tự động đẩy tiếp bước xử lý Risky (Teams/Gmail -> meetscript.io) vào hàng đợi RIÊNG —
            // vẫn là 1 luồng liền mạch, không cần bấm nút nào thêm, nhưng không còn chặn job
            // Apollo/Debounce tiếp theo của người khác nữa.
            const riskyJob = enqueueRiskyJob(job.result.riskyPath, job.result.masterXlsxPath, job.outputFileName || job.id);
            job.riskyJobId = riskyJob.id;
          } else {
            await runApolloReimport(job.masterXlsxPath);
          }
          job.status = 'done';
        } catch (err) {
          job.status = 'error';
          job.error = err instanceof Error ? err.message : String(err);
          logger.error(`Job ${job.kind === 'main' ? 'Apollo/Debounce' : 'import lại Apollo'} lỗi:`, err);
        } finally {
          job.finishedAt = Date.now();
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
      await jobContext.run({ append: (line) => job.logs.push(line) }, async () => {
        let context: Awaited<ReturnType<typeof openPersistentChrome>> | undefined;
        try {
          context = await openPersistentChrome(config.riskyChromeUserDataDir);
          job.result = await runRiskyFlow(
            job.riskyPath,
            context,
            (done, total) => {
              job.progress = `${done}/${total}`;
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
        }
      });
    }
  } finally {
    riskyProcessing = false;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

const BRAND_NAME = 'Tool lọc leads tự động';

function pageLayout(title: string, body: string): string {
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<link rel="icon" type="image/png" href="/assets/nsc-favicon.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
  :root {
    --nsc-light: #36c3dc;
    --nsc-dark: #0081bb;
    --nsc-gray-900: #1a1a1a;
    --nsc-gray-600: #5a6472;
    --nsc-gray-200: #e4e9ee;
    --nsc-gray-050: #f4f8fa;
  }
  * { box-sizing: border-box; }
  body {
    font-family: 'Montserrat', -apple-system, Segoe UI, Roboto, sans-serif;
    margin: 0;
    padding: 0;
    color: var(--nsc-gray-900);
    background: var(--nsc-gray-050);
  }
  .nsc-header {
    background: linear-gradient(135deg, var(--nsc-dark) 0%, var(--nsc-light) 55%, var(--nsc-dark) 100%);
    padding: 28px 20px;
    color: #fff;
  }
  .nsc-header-inner { max-width: 760px; margin: 0 auto; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .nsc-header img { height: 32px; width: auto; display: block; }
  .nsc-header h1 { font-size: 1.25rem; font-weight: 700; margin: 0; letter-spacing: 0.01em; }
  .nsc-main { max-width: 760px; margin: 0 auto; padding: 28px 20px 48px; }
  h2 {
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--nsc-dark);
    margin: 28px 0 10px;
    padding-bottom: 8px;
    border-bottom: 2px solid var(--nsc-light);
  }
  label { display: block; margin-top: 14px; font-weight: 600; font-size: 0.9rem; color: var(--nsc-gray-900); }
  input[type=text], input[type=url] {
    width: 100%; padding: 10px 12px; font-size: 1rem; font-family: inherit;
    box-sizing: border-box; margin-top: 6px; border: 1.5px solid var(--nsc-gray-200);
    border-radius: 8px; background: #fff; color: var(--nsc-gray-900);
  }
  input[type=text]:focus, input[type=url]:focus {
    outline: none; border-color: var(--nsc-light); box-shadow: 0 0 0 3px rgba(54,195,220,0.2);
  }
  button {
    margin-top: 20px; padding: 11px 26px; font-size: 0.95rem; font-weight: 600; font-family: inherit;
    cursor: pointer; color: #fff; background: var(--nsc-dark); border: none; border-radius: 8px;
    transition: background 0.15s ease;
  }
  button:hover { background: var(--nsc-light); }
  .nsc-card {
    background: #fff; border: 1px solid var(--nsc-gray-200); border-radius: 12px;
    padding: 20px 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }
  table { border-collapse: collapse; width: 100%; margin-top: 4px; }
  th { background: var(--nsc-gray-050); color: var(--nsc-gray-600); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; }
  td, th { border-bottom: 1px solid var(--nsc-gray-200); padding: 10px 8px; text-align: left; font-size: 0.9rem; }
  tr:last-child td { border-bottom: none; }
  .status { padding: 3px 10px; border-radius: 20px; font-size: 0.78rem; font-weight: 600; color: #fff; display: inline-block; }
  .status-queued { background: #8a94a3; }
  .status-running { background: #e3a008; }
  .status-done { background: #1a9d6c; }
  .status-error { background: #d33a3a; }
  .tag { padding: 2px 8px; border-radius: 6px; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; display: inline-block; }
  .tag-main { background: #e4f3fb; color: var(--nsc-dark); }
  .tag-risky { background: #fdeedd; color: #a85b00; }
  .tag-reimport { background: #eef0fb; color: #4b3fae; }
  pre {
    background: #102330; color: #d9e8ef; padding: 14px; border-radius: 8px; overflow-x: auto;
    white-space: pre-wrap; word-break: break-word; font-size: 0.8rem; max-height: 60vh; overflow-y: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  a { color: var(--nsc-dark); font-weight: 600; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .nsc-banner {
    background: #fff6e0; border: 1px solid #e3a008; padding: 14px 18px; border-radius: 10px; margin-bottom: 20px;
  }
  .nsc-banner ul { margin: 8px 0 0; padding-left: 20px; }
  .nsc-banner p { margin: 8px 0 0; font-size: 0.88rem; color: var(--nsc-gray-600); }
  .nsc-error { color: #d33a3a; background: #fdeeee; border: 1px solid #d33a3a; border-radius: 10px; padding: 12px 16px; }
  .nsc-back { display: inline-block; margin-bottom: 16px; font-size: 0.88rem; }
</style>
</head>
<body>
<div class="nsc-header">
  <div class="nsc-header-inner">
    <img src="/assets/nsc-logo-white.png" alt="NSC Software" />
    <h1>${BRAND_NAME}</h1>
  </div>
</div>
<div class="nsc-main">
${body}
</div>
</body>
</html>`;
}

function jobLabel(job: Job): string {
  if (job.kind === 'main') return job.outputFileName || job.id;
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

function renderTelegramBanner(): string {
  const status = getTelegramWatchStatus();
  if (status.pending.length === 0) return '';

  const overdueBlock =
    status.overdue.length > 0
      ? `<p style="margin-top:10px;color:#a85b00"><strong>⚠️ ${status.overdue.length} file chờ quá lâu chưa thấy bot trả về</strong> (vẫn tiếp tục tự động chờ, nhưng nếu lâu quá nên vào group Telegram kiểm tra thủ công):</p>
         <ul>
           ${status.overdue
             .map(
               (e) => `<li>
                 ${escapeHtml(path.basename(e.excelPath))} (${e.kind}) — đã chờ ${Math.round((Date.now() - e.registeredAt) / 60_000)} phút
                 <form method="POST" action="/telegram-pending/dismiss" style="display:inline" onsubmit="return confirm('Bỏ theo dõi file này? Dùng khi đã tự tải tay trong group Telegram rồi.')">
                   <input type="hidden" name="excelPath" value="${escapeHtml(e.excelPath)}" />
                   <input type="hidden" name="kind" value="${escapeHtml(e.kind)}" />
                   <button type="submit" style="margin-left:6px;padding:2px 8px;font-size:0.76rem;font-weight:600;background:#fff;color:#a85b00;border:1px solid #a85b00;border-radius:6px;cursor:pointer">Bỏ qua</button>
                 </form>
               </li>`,
             )
             .join('')}
         </ul>`
      : '';

  return `<div class="nsc-banner" style="background:#eef6fb;border-color:var(--nsc-light)">
      <strong>📨 Đang chờ bot meetscript.io trả kết quả qua Telegram cho ${status.pending.length} file.</strong>
      <p>Tự động tải về ngay khi bot gửi vào group — không cần làm gì thêm, chỉ cần chờ.</p>
      ${overdueBlock}
    </div>`;
}

function renderHome(errorMessage?: string): string {
  const allJobs = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  // "running" tối đa 1 job/hàng đợi (mỗi hàng đợi chạy tuần tự), nhưng "queued" có thể nhiều người
  // cùng bấm — liệt kê hết để ai mở trang cũng thấy ngay đang có bao nhiêu người xếp hàng trước.
  const activeJobs = allJobs.filter((j) => j.status === 'queued' || j.status === 'running');
  const recentJobs = allJobs.slice(0, 20);

  const errorBanner = errorMessage ? `<div class="nsc-error" style="margin-bottom:20px">${escapeHtml(errorMessage)}</div>` : '';

  const banner =
    activeJobs.length > 0
      ? `<div class="nsc-banner">
          <strong>⚠️ Đang có ${activeJobs.length} luồng đang chạy hoặc chờ chạy:</strong>
          <ul>
            ${activeJobs
              .map(
                (j) =>
                  `<li><a href="/jobs/${j.id}">${escapeHtml(jobLabel(j))}</a> ` +
                  `<span class="tag ${jobTagClass(j)}">${jobTagLabel(j)}</span> — ` +
                  `<span class="status status-${j.status}">${j.status}</span>` +
                  `${isRiskyJob(j) && j.progress ? ` (${escapeHtml(j.progress)})` : ''} ` +
                  `(bắt đầu lúc ${new Date(j.createdAt).toLocaleString('vi-VN')})</li>`,
              )
              .join('')}
          </ul>
          <p>Mỗi loại luồng (Apollo/Debounce và Risky) chỉ chạy 1 job tại 1 thời điểm — nhưng 2 loại chạy ĐỒNG THỜI được với nhau (dùng 2 Chrome profile riêng), không cần đợi nhau.</p>
        </div>`
      : '';

  const rows = recentJobs
    .map(
      (j) => `<tr>
        <td><a href="/jobs/${j.id}">${escapeHtml(jobLabel(j))}</a></td>
        <td><span class="tag ${jobTagClass(j)}">${jobTagLabel(j)}</span></td>
        <td><span class="status status-${j.status}">${j.status}</span>${isRiskyJob(j) && j.status === 'running' && j.progress ? ` ${escapeHtml(j.progress)}` : ''}</td>
        <td>${new Date(j.createdAt).toLocaleString('vi-VN')}</td>
      </tr>`,
    )
    .join('');

  const telegramBanner = renderTelegramBanner();
  const refreshSeconds = activeJobs.length > 0 ? 5 : telegramBanner ? 15 : 0;
  const body = `
${refreshSeconds > 0 ? `<meta http-equiv="refresh" content="${refreshSeconds}" />` : ''}
${errorBanner}
${banner}
${telegramBanner}
<div class="nsc-card">
  <form method="POST" action="/jobs">
    <label for="listUrl">Link List Apollo</label>
    <input type="url" id="listUrl" name="listUrl" placeholder="https://app.apollo.io/#/lists/..." required />

    <label for="outputFileName">Tên file output mong muốn</label>
    <input
      type="text" id="outputFileName" name="outputFileName" placeholder="VD: Leads_Thang10"
      pattern="[A-Za-z0-9_]+"
      title="Chỉ chữ cái (không dấu), số và dấu gạch dưới (_) — không dấu cách, không ký tự đặc biệt khác"
      required
    />
    <p style="margin:6px 0 0;font-size:0.78rem;color:var(--nsc-gray-600)">
      Chỉ dùng chữ cái (không dấu), số và dấu gạch dưới (_) — không dấu cách, không ký tự đặc biệt khác.
    </p>

    <button type="submit">Bắt đầu chạy</button>
  </form>
</div>

<h2>Các lần chạy gần đây</h2>
${recentJobs.length === 0 ? '<p>Chưa có lần chạy nào.</p>' : `<div class="nsc-card"><table><tr><th>Tên file</th><th>Loại</th><th>Trạng thái</th><th>Bắt đầu lúc</th></tr>${rows}</table></div>`}
`;
  return pageLayout(BRAND_NAME, body);
}

function renderMainJob(job: MainJob): string {
  const shouldAutoRefresh = job.status === 'queued' || job.status === 'running';
  const errorBlock = job.status === 'error' ? `<div class="nsc-error"><strong>Lỗi:</strong> ${escapeHtml(job.error ?? '')}</div>` : '';

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
            ? ' — <span style="color:#1a9d6c">✅ đã tự động cập nhật cột RESULT trong file Excel ở trên</span>'
            : mergeStatus === 'error'
              ? ' — <span style="color:#d33a3a">⚠️ lỗi khi tự động cập nhật, xem chi tiết ở trang Risky</span>'
              : '';
        riskyLinkBlock = `
          <p style="margin-top:16px">
            Bước xử lý Risky (Teams/Gmail &rarr; meetscript.io):
            <a href="/jobs/${riskyJob.id}">xem tiến trình</a> —
            <span class="status status-${riskyJob.status}">${riskyJob.status}</span>
            ${riskyJob.status === 'running' && riskyJob.progress ? ` (${escapeHtml(riskyJob.progress)})` : ''}${mergeNote}
          </p>`;
      }
    }
    resultBlock = `
      <p>
        <a href="/jobs/${job.id}/download/xlsx">Tải file Excel (${escapeHtml(path.basename(result.masterXlsxPath))})</a><br/>
        <a href="/jobs/${job.id}/download/risky">Tải file Risky CSV (${escapeHtml(path.basename(result.riskyPath))})</a>
      </p>
      ${riskyLinkBlock}
    `;
  }

  const body = `
${shouldAutoRefresh ? '<meta http-equiv="refresh" content="4" />' : ''}
<a class="nsc-back" href="/">&larr; Quay lại</a>
<div class="nsc-card">
  <p style="margin-top:0"><strong>${escapeHtml(job.outputFileName || job.id)}</strong> <span class="tag tag-main">Apollo</span></p>
  <p>Trạng thái: <span class="status status-${job.status}">${job.status}</span></p>
  <p>List Apollo: ${escapeHtml(job.listUrl)}</p>
  ${resultBlock}
  ${errorBlock}
</div>

<h2>Log</h2>
<pre>${escapeHtml(job.logs.join('\n') || '(chưa có log)')}</pre>
`;
  return pageLayout(`${job.outputFileName || job.id} — ${BRAND_NAME}`, body);
}

function renderRiskyJob(job: RiskyJob): string {
  // Tổng số kết quả MONG ĐỢI từ Telegram = 2 (TEAM + GOOGLE) cho mỗi phần đã tách — chỉ biết được
  // sau khi upload xong (job.result khác null/undefined). File Risky rỗng (result === null) thì
  // không có gì để chờ Telegram cả.
  const telegramStatus = getJobTelegramStatus(job.id);
  const expectedTelegramTotal = job.result ? job.result.chunks.length * 2 : 0;
  const receivedCount = telegramStatus.received.length;
  const telegramAllReceived = expectedTelegramTotal > 0 && receivedCount >= expectedTelegramTotal;

  // Vẫn tự refresh trang dù job đã "done" (upload xong) nếu CHƯA nhận đủ kết quả thật từ Telegram
  // — 2 việc khác nhau: "done" chỉ nghĩa là đã upload xong lên meetscript.io, chưa chắc đã có kết
  // quả thật (bot có thể mất tới 1-2 tiếng mới trả lời).
  const shouldAutoRefresh = job.status === 'queued' || job.status === 'running' || (expectedTelegramTotal > 0 && !telegramAllReceived);
  const errorBlock = job.status === 'error' ? `<div class="nsc-error"><strong>Lỗi:</strong> ${escapeHtml(job.error ?? '')}</div>` : '';

  const progressBlock =
    job.status === 'running' && job.progress
      ? `<p>Tiến trình upload meetscript.io: <strong>${escapeHtml(job.progress)}</strong> lượt</p>`
      : '';

  let resultBlock = '';
  if (job.status === 'done') {
    if (job.result === null) {
      resultBlock = `<p style="margin-top:16px">File Risky không có lead nào — không cần xử lý gì thêm.</p>`;
    } else if (job.result) {
      const { chunks } = job.result;
      resultBlock = `
        <div style="margin-top:16px">
          <p><strong>Đã xử lý xong Risky${chunks.length > 1 ? ` (tách thành ${chunks.length} phần do vượt giới hạn 1000 lead/lần của meetscript.io, xử lý song song)` : ''} — kết quả thật (file Excel Team/Google) sẽ được bot Telegram gửi riêng.</strong></p>
          ${chunks
            .map(
              (chunk, i) => `
            <div style="margin-top:12px">
              ${chunks.length > 1 ? `<p><strong>Phần ${i + 1}/${chunks.length}</strong> (${escapeHtml(path.basename(chunk.excelPath))}):</p>` : ''}
              <p>Ảnh xác nhận upload tab TEAM:</p>
              <img src="/jobs/${job.id}/screenshot/${i}/team" alt="Kết quả TEAM" style="max-width:100%;border:1px solid var(--nsc-gray-200);border-radius:8px;display:block" />
              <p style="margin-top:12px">Ảnh xác nhận upload tab GOOGLE:</p>
              <img src="/jobs/${job.id}/screenshot/${i}/google" alt="Kết quả GOOGLE" style="max-width:100%;border:1px solid var(--nsc-gray-200);border-radius:8px;display:block" />
            </div>`,
            )
            .join('')}
        </div>`;
    }
  }

  let telegramBlock = '';
  if (expectedTelegramTotal > 0) {
    telegramBlock = telegramAllReceived
      ? `<p style="margin-top:16px;color:#1a9d6c"><strong>✅ Đã nhận đủ ${receivedCount}/${expectedTelegramTotal} kết quả thật từ Telegram.</strong></p>`
      : `<p style="margin-top:16px"><strong>📨 Đã nhận ${receivedCount}/${expectedTelegramTotal} kết quả thật từ Telegram</strong> — đang tiếp tục chờ phần còn lại (bot meetscript.io có thể mất tới 1-2 tiếng).</p>`;
    if (telegramStatus.received.length > 0) {
      telegramBlock += `<ul style="margin-top:6px;font-size:0.88rem">${telegramStatus.received
        .map(
          (r) =>
            `<li>${escapeHtml(r.fileName)} (${r.kind}) — lúc ${new Date(r.receivedAt).toLocaleString('vi-VN')}</li>`,
        )
        .join('')}</ul>`;
    }
    if (telegramStatus.mergeStatus === 'done') {
      telegramBlock += `<p style="margin-top:10px;color:#1a9d6c"><strong>✅ Đã tự động cập nhật cột RESULT (Safe to Send/Do not Send) ngay trong file Excel gốc</strong> — tải lại file ở trên để xem bản mới nhất.</p>`;
    } else if (telegramStatus.mergeStatus === 'error') {
      telegramBlock += `<div class="nsc-error" style="margin-top:10px"><strong>Lỗi khi tự động cập nhật file Excel gốc:</strong> ${escapeHtml(telegramStatus.mergeError ?? '')}<br/>(Cần tự ghép tay — các file kết quả Team/Google vẫn tải về bình thường, chỉ bước ghép tự động bị lỗi.)</div>`;
    }
  }

  const body = `
${shouldAutoRefresh ? '<meta http-equiv="refresh" content="4" />' : ''}
<a class="nsc-back" href="/">&larr; Quay lại</a>
<div class="nsc-card">
  <p style="margin-top:0"><strong>Risky — ${escapeHtml(job.sourceLabel)}</strong> <span class="tag tag-risky">Risky</span></p>
  <p>Trạng thái: <span class="status status-${job.status}">${job.status}</span></p>
  ${progressBlock}
  ${resultBlock}
  ${telegramBlock}
  ${errorBlock}
</div>

<h2>Log</h2>
<pre>${escapeHtml(job.logs.join('\n') || '(chưa có log)')}</pre>
`;
  return pageLayout(`Risky — ${job.sourceLabel} — ${BRAND_NAME}`, body);
}

function renderReimportJob(job: ReimportJob): string {
  const shouldAutoRefresh = job.status === 'queued' || job.status === 'running';
  const errorBlock = job.status === 'error' ? `<div class="nsc-error"><strong>Lỗi:</strong> ${escapeHtml(job.error ?? '')}</div>` : '';
  const doneBlock =
    job.status === 'done'
      ? `<p style="margin-top:16px;color:#1a9d6c">✅ Đã import xong (chỉ cột email + RESULT) ngược lại Apollo.</p>`
      : '';

  const body = `
${shouldAutoRefresh ? '<meta http-equiv="refresh" content="4" />' : ''}
<a class="nsc-back" href="/">&larr; Quay lại</a>
<div class="nsc-card">
  <p style="margin-top:0"><strong>Import lại Apollo — ${escapeHtml(path.basename(job.masterXlsxPath))}</strong> <span class="tag tag-reimport">Import lại</span></p>
  <p>Trạng thái: <span class="status status-${job.status}">${job.status}</span></p>
  <p>Dùng chung hàng đợi/Chrome với job Apollo export — chạy ngay sau khi job Apollo đang chạy (nếu có) xong.</p>
  ${doneBlock}
  ${errorBlock}
</div>

<h2>Log</h2>
<pre>${escapeHtml(job.logs.join('\n') || '(chưa có log)')}</pre>
`;
  return pageLayout(`Import lại Apollo — ${BRAND_NAME}`, body);
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderHome(url.searchParams.get('error') ?? undefined));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/jobs') {
      const body = await readRequestBody(req);
      const params = new URLSearchParams(body);
      const listUrl = (params.get('listUrl') ?? '').trim();
      const outputFileName = (params.get('outputFileName') ?? '').trim();
      let errorMessage: string | undefined;
      if (!listUrl || !outputFileName) {
        errorMessage = 'Thiếu link List Apollo hoặc tên file output.';
      } else if (!isValidOutputFileName(outputFileName)) {
        errorMessage = 'Tên file output không hợp lệ — chỉ được dùng chữ cái (không dấu), số và dấu gạch dưới (_), không dấu cách/ký tự đặc biệt khác.';
      }
      if (errorMessage) {
        res.writeHead(303, { Location: `/?error=${encodeURIComponent(errorMessage)}` });
        res.end();
        return;
      }
      const job = enqueueMainJob(listUrl, outputFileName);
      res.writeHead(303, { Location: `/jobs/${job.id}` });
      res.end();
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
        res.end('Không tìm thấy job này (có thể server đã khởi động lại).');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Không tìm thấy ảnh kết quả (có thể server đã khởi động lại).');
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
