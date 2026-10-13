import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runFlow } from './pipeline.js';
import { jobContext } from './job-context.js';
import { logger } from './logger.js';
import { config } from './config.js';

const PROCESSED_DIR = path.resolve('data/processed');

interface Job {
  id: string;
  listUrl: string;
  outputFileName: string;
  status: 'queued' | 'running' | 'done' | 'error';
  logs: string[];
  createdAt: number;
  finishedAt?: number;
  error?: string;
  result?: { masterXlsxPath: string; riskyPath: string };
}

const jobs = new Map<string, Job>();
const queue: string[] = [];
let processing = false;

function enqueueJob(listUrl: string, outputFileName: string): Job {
  const id = crypto.randomBytes(6).toString('hex');
  const job: Job = { id, listUrl, outputFileName, status: 'queued', logs: [], createdAt: Date.now() };
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
          const result = await runFlow(job.listUrl, job.outputFileName);
          job.result = { masterXlsxPath: result.masterXlsxPath, riskyPath: result.riskyPath };
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

function pageLayout(title: string, body: string): string {
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 720px; margin: 24px auto; padding: 0 16px; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  label { display: block; margin-top: 12px; font-weight: 600; }
  input[type=text], input[type=url] { width: 100%; padding: 8px; font-size: 1rem; box-sizing: border-box; margin-top: 4px; }
  button { margin-top: 16px; padding: 10px 20px; font-size: 1rem; cursor: pointer; }
  table { border-collapse: collapse; width: 100%; margin-top: 16px; }
  td, th { border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 0.9rem; }
  .status { padding: 2px 8px; border-radius: 4px; font-size: 0.85rem; color: #fff; display: inline-block; }
  .status-queued { background: #888; }
  .status-running { background: #e3a008; }
  .status-done { background: #16a34a; }
  .status-error { background: #dc2626; }
  pre { background: #111; color: #eee; padding: 12px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; font-size: 0.82rem; max-height: 60vh; overflow-y: auto; }
  a { color: #2563eb; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function renderHome(): string {
  const recentJobs = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
  const rows = recentJobs
    .map(
      (j) => `<tr>
        <td><a href="/jobs/${j.id}">${escapeHtml(j.outputFileName || j.id)}</a></td>
        <td><span class="status status-${j.status}">${j.status}</span></td>
        <td>${new Date(j.createdAt).toLocaleString('vi-VN')}</td>
      </tr>`,
    )
    .join('');

  const body = `
<h1>Chạy luồng Apollo → Debounce</h1>
<form method="POST" action="/jobs">
  <label for="listUrl">Link List Apollo</label>
  <input type="url" id="listUrl" name="listUrl" placeholder="https://app.apollo.io/#/lists/..." required />

  <label for="outputFileName">Tên file output mong muốn</label>
  <input type="text" id="outputFileName" name="outputFileName" placeholder="VD: Leads-Thang10" required />

  <button type="submit">Bắt đầu chạy</button>
</form>

<h2>Các lần chạy gần đây</h2>
${recentJobs.length === 0 ? '<p>Chưa có lần chạy nào.</p>' : `<table><tr><th>Tên file</th><th>Trạng thái</th><th>Bắt đầu lúc</th></tr>${rows}</table>`}
`;
  return pageLayout('Internal Tool — Apollo Automation', body);
}

function renderJob(job: Job): string {
  const shouldAutoRefresh = job.status === 'queued' || job.status === 'running';
  const downloads =
    job.status === 'done' && job.result
      ? `<p>
          <a href="/jobs/${job.id}/download/xlsx">Tải file Excel (${escapeHtml(path.basename(job.result.masterXlsxPath))})</a><br/>
          <a href="/jobs/${job.id}/download/risky">Tải file Risky CSV (${escapeHtml(path.basename(job.result.riskyPath))})</a>
        </p>`
      : '';
  const errorBlock = job.status === 'error' ? `<p style="color:#dc2626"><strong>Lỗi:</strong> ${escapeHtml(job.error ?? '')}</p>` : '';

  const body = `
${shouldAutoRefresh ? '<meta http-equiv="refresh" content="4" />' : ''}
<p><a href="/">&larr; Quay lại</a></p>
<h1>${escapeHtml(job.outputFileName || job.id)}</h1>
<p>Trạng thái: <span class="status status-${job.status}">${job.status}</span></p>
<p>List Apollo: ${escapeHtml(job.listUrl)}</p>
${downloads}
${errorBlock}
<h2>Log</h2>
<pre>${escapeHtml(job.logs.join('\n') || '(chưa có log)')}</pre>
`;
  return pageLayout(`Job: ${job.outputFileName || job.id}`, body);
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

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderHome());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/jobs') {
      const body = await readRequestBody(req);
      const params = new URLSearchParams(body);
      const listUrl = (params.get('listUrl') ?? '').trim();
      const outputFileName = (params.get('outputFileName') ?? '').trim();
      if (!listUrl || !outputFileName) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Thiếu link List Apollo hoặc tên file output.');
        return;
      }
      const job = enqueueJob(listUrl, outputFileName);
      res.writeHead(303, { Location: `/jobs/${job.id}` });
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
      if (!job?.result) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Không tìm thấy file để tải.');
        return;
      }
      const filePath = downloadMatch[2] === 'xlsx' ? job.result.masterXlsxPath : job.result.riskyPath;
      serveDownload(res, filePath);
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

server.listen(config.webuiPort, '0.0.0.0', () => {
  logger.info(`Web UI đang chạy tại http://0.0.0.0:${config.webuiPort}/` + (config.webuiPassword ? ' (yêu cầu mật khẩu)' : ' (KHÔNG có mật khẩu — ai cũng vào được)'));
});
