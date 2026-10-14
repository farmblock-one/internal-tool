import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runFlow } from './pipeline.js';
import { runRiskyFlow } from './risky-pipeline.js';
import { jobContext } from './job-context.js';
import { logger } from './logger.js';
import { config } from './config.js';
import { isValidOutputFileName } from './filename-utils.js';

const PROCESSED_DIR = path.resolve('data/processed');
const ASSETS_DIR = path.resolve('assets');

interface JobBase {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  logs: string[];
  createdAt: number;
  finishedAt?: number;
  error?: string;
}

interface MainJob extends JobBase {
  kind: 'main';
  listUrl: string;
  outputFileName: string;
  result?: { masterXlsxPath: string; riskyPath: string };
  // ID của job Risky đã được tạo ra từ job này (nếu có) — để không cho bấm tạo thêm lần nữa,
  // tránh upload trùng cùng 1 danh sách Risky lên meetscript.io nhiều lần không cần thiết.
  riskyJobId?: string;
}

interface RiskyJob extends JobBase {
  kind: 'risky';
  label: string;
  riskyCsvPath: string;
  sourceJobId?: string;
  // File Risky rỗng (không có lead nào) -> coi là "done" nhưng không có gì để tải/xem.
  empty?: boolean;
  result?: { excelPath: string; teamResultScreenshot: string; googleResultScreenshot: string };
}

type Job = MainJob | RiskyJob;

function jobLabel(job: Job): string {
  return job.kind === 'main' ? job.outputFileName || job.id : job.label || job.id;
}

const jobs = new Map<string, Job>();
const queue: string[] = [];
let processing = false;

function enqueueMainJob(listUrl: string, outputFileName: string): MainJob {
  const id = crypto.randomBytes(6).toString('hex');
  const job: MainJob = { id, kind: 'main', listUrl, outputFileName, status: 'queued', logs: [], createdAt: Date.now() };
  jobs.set(id, job);
  queue.push(id);
  void processQueue();
  return job;
}

function enqueueRiskyJob(riskyCsvPath: string, label: string, sourceJobId?: string): RiskyJob {
  const id = crypto.randomBytes(6).toString('hex');
  const job: RiskyJob = { id, kind: 'risky', label, riskyCsvPath, sourceJobId, status: 'queued', logs: [], createdAt: Date.now() };
  jobs.set(id, job);
  queue.push(id);
  void processQueue();
  return job;
}

// Chạy ĐÚNG 1 job tại 1 thời điểm — toàn bộ automation dùng chung 1 Chrome profile đã đăng nhập
// (xem browser.ts), chạy 2 job song song sẽ tranh nhau cùng 1 profile và làm nhau crash.
async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const id = queue.shift();
      const job = id ? jobs.get(id) : undefined;
      if (!job) continue;
      job.status = 'running';
      await jobContext.run({ append: (line) => job.logs.push(line) }, async () => {
        try {
          if (job.kind === 'main') {
            const result = await runFlow(job.listUrl, job.outputFileName);
            job.result = { masterXlsxPath: result.masterXlsxPath, riskyPath: result.riskyPath };
          } else {
            const result = await runRiskyFlow(job.riskyCsvPath);
            if (result === null) {
              job.empty = true;
            } else {
              job.result = result;
            }
          }
          job.status = 'done';
        } catch (err) {
          job.status = 'error';
          job.error = err instanceof Error ? err.message : String(err);
          logger.error('Job lỗi:', err);
        } finally {
          job.finishedAt = Date.now();
        }
      });
    }
  } finally {
    processing = false;
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

function renderHome(errorMessage?: string): string {
  const allJobs = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  // "running" chỉ có tối đa 1 job (processQueue chạy tuần tự), nhưng "queued" có thể nhiều người
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
                  `<li><a href="/jobs/${j.id}">${escapeHtml(jobLabel(j))}</a> — ` +
                  `<span class="status status-${j.status}">${j.status}</span> ` +
                  `(bắt đầu lúc ${new Date(j.createdAt).toLocaleString('vi-VN')})</li>`,
              )
              .join('')}
          </ul>
          <p>Mỗi lần chỉ chạy 1 luồng — nếu bạn bấm "Bắt đầu chạy" bây giờ, luồng của bạn sẽ tự xếp hàng chờ (các) luồng trên chạy xong trước, không chạy song song được.</p>
        </div>`
      : '';

  const rows = recentJobs
    .map(
      (j) => `<tr>
        <td><a href="/jobs/${j.id}">${escapeHtml(jobLabel(j))}</a></td>
        <td>${j.kind === 'main' ? 'Apollo → Debounce' : 'Risky → Teams/Gmail'}</td>
        <td><span class="status status-${j.status}">${j.status}</span></td>
        <td>${new Date(j.createdAt).toLocaleString('vi-VN')}</td>
      </tr>`,
    )
    .join('');

  const body = `
${activeJobs.length > 0 ? '<meta http-equiv="refresh" content="5" />' : ''}
${errorBanner}
${banner}
<div class="nsc-card">
  <form method="POST" action="/jobs">
    <label for="listUrl">Link List Apollo</label>
    <input type="url" id="listUrl" name="listUrl" placeholder="https://app.apollo.io/#/lists/..." required />

    <label for="outputFileName">Tên file output mong muốn</label>
    <input
      type="text" id="outputFileName" name="outputFileName" placeholder="VD: Leads-Thang10"
      pattern="[A-Za-z0-9-]+"
      title="Chỉ chữ cái (không dấu), số và dấu gạch ngang (-) — không dấu cách, không ký tự đặc biệt khác"
      required
    />
    <p style="margin:6px 0 0;font-size:0.78rem;color:var(--nsc-gray-600)">
      Chỉ dùng chữ cái (không dấu), số và dấu gạch ngang (-) — không dấu cách, không ký tự đặc biệt khác.
    </p>

    <button type="submit">Bắt đầu chạy</button>
  </form>
</div>

<h2>Các lần chạy gần đây</h2>
${recentJobs.length === 0 ? '<p>Chưa có lần chạy nào.</p>' : `<div class="nsc-card"><table><tr><th>Tên</th><th>Loại</th><th>Trạng thái</th><th>Bắt đầu lúc</th></tr>${rows}</table></div>`}
`;
  return pageLayout(BRAND_NAME, body);
}

function renderJob(job: Job): string {
  const shouldAutoRefresh = job.status === 'queued' || job.status === 'running';
  const errorBlock = job.status === 'error' ? `<div class="nsc-error"><strong>Lỗi:</strong> ${escapeHtml(job.error ?? '')}</div>` : '';

  let detailLines = '';
  let resultBlock = '';

  if (job.kind === 'main') {
    detailLines = `<p>List Apollo: ${escapeHtml(job.listUrl)}</p>`;
    if (job.status === 'done' && job.result) {
      // Chỉ cho bấm "Xử lý tiếp Risky" 1 lần — bấm thêm lần nữa sẽ upload trùng cùng 1 danh sách
      // lên meetscript.io, không cần thiết. Nếu đã làm rồi thì dẫn thẳng tới job Risky đó.
      const riskyAction = job.riskyJobId
        ? `<p><a href="/jobs/${job.riskyJobId}">Xem kết quả xử lý Risky &rarr;</a></p>`
        : `<form method="POST" action="/jobs/${job.id}/risky" style="margin-top:4px">
             <button type="submit">Xử lý tiếp Risky (Teams/Gmail &rarr; meetscript.io)</button>
           </form>`;
      resultBlock = `
        <p>
          <a href="/jobs/${job.id}/download/xlsx">Tải file Excel (${escapeHtml(path.basename(job.result.masterXlsxPath))})</a><br/>
          <a href="/jobs/${job.id}/download/risky">Tải file Risky CSV (${escapeHtml(path.basename(job.result.riskyPath))})</a>
        </p>
        ${riskyAction}
      `;
    }
  } else {
    detailLines = `<p>File Risky nguồn: ${escapeHtml(path.basename(job.riskyCsvPath))}</p>`;
    if (job.status === 'done' && job.empty) {
      resultBlock = `<p>File Risky này không có lead nào — không cần xử lý gì thêm.</p>`;
    } else if (job.status === 'done' && job.result) {
      resultBlock = `
        <p><strong>Kết quả tab TEAM:</strong></p>
        <img src="/jobs/${job.id}/screenshot/team" alt="Kết quả TEAM" style="max-width:100%;border:1px solid var(--nsc-gray-200);border-radius:8px;display:block" />
        <p style="margin-top:16px"><strong>Kết quả tab GOOGLE:</strong></p>
        <img src="/jobs/${job.id}/screenshot/google" alt="Kết quả GOOGLE" style="max-width:100%;border:1px solid var(--nsc-gray-200);border-radius:8px;display:block" />
      `;
    }
  }

  const body = `
${shouldAutoRefresh ? '<meta http-equiv="refresh" content="4" />' : ''}
<a class="nsc-back" href="/">&larr; Quay lại</a>
<div class="nsc-card">
  <p style="margin-top:0"><strong>${escapeHtml(jobLabel(job))}</strong></p>
  <p>Trạng thái: <span class="status status-${job.status}">${job.status}</span></p>
  ${detailLines}
  ${resultBlock}
  ${errorBlock}
</div>

<h2>Log</h2>
<pre>${escapeHtml(job.logs.join('\n') || '(chưa có log)')}</pre>
`;
  return pageLayout(`${jobLabel(job)} — ${BRAND_NAME}`, body);
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
    if (!requireAuth(req, res)) return;

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

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
        errorMessage = 'Tên file output không hợp lệ — chỉ được dùng chữ cái (không dấu), số và dấu gạch ngang (-), không dấu cách/ký tự đặc biệt khác.';
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

    const riskyTriggerMatch = url.pathname.match(/^\/jobs\/([a-f0-9]+)\/risky$/);
    if (req.method === 'POST' && riskyTriggerMatch) {
      const sourceJob = jobs.get(riskyTriggerMatch[1]);
      if (!sourceJob || sourceJob.kind !== 'main' || sourceJob.status !== 'done' || !sourceJob.result) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Không thể xử lý Risky — job nguồn chưa chạy xong hoặc không hợp lệ.');
        return;
      }
      if (sourceJob.riskyJobId) {
        res.writeHead(303, { Location: `/jobs/${sourceJob.riskyJobId}` });
        res.end();
        return;
      }
      const riskyJob = enqueueRiskyJob(sourceJob.result.riskyPath, `Risky — ${sourceJob.outputFileName}`, sourceJob.id);
      sourceJob.riskyJobId = riskyJob.id;
      res.writeHead(303, { Location: `/jobs/${riskyJob.id}` });
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
      if (job?.kind !== 'main' || !job.result) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Không tìm thấy file để tải.');
        return;
      }
      const filePath = downloadMatch[2] === 'xlsx' ? job.result.masterXlsxPath : job.result.riskyPath;
      serveDownload(res, filePath);
      return;
    }

    const screenshotMatch = url.pathname.match(/^\/jobs\/([a-f0-9]+)\/screenshot\/(team|google)$/);
    if (req.method === 'GET' && screenshotMatch) {
      const job = jobs.get(screenshotMatch[1]);
      if (job?.kind !== 'risky' || !job.result) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Không tìm thấy ảnh kết quả.');
        return;
      }
      const filePath = screenshotMatch[2] === 'team' ? job.result.teamResultScreenshot : job.result.googleResultScreenshot;
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

server.listen(config.webuiPort, config.webuiHost, () => {
  logger.info(
    `Web UI đang chạy tại http://${config.webuiHost}:${config.webuiPort}/ ` +
      `(${config.webuiHost === '127.0.0.1' ? 'chỉ localhost — truy cập thật qua Caddy (HTTPS)' : 'lắng nghe công khai'})` +
      (config.webuiPassword ? ', yêu cầu mật khẩu.' : ', KHÔNG có mật khẩu — ai cũng vào được.'),
  );
});
