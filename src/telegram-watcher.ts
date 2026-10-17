import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

const RESULTS_DIR = path.resolve('data/processed/telegram-results');
const PENDING_FILE = path.resolve('data/processed/telegram-pending.json');
// Theo xác nhận thực tế: bot meetscript.io có thể mất tới 1h30 mới trả kết quả qua Telegram.
const MAX_WAIT_MS = 90 * 60_000;
// Long-poll Telegram getUpdates — nó tự giữ request mở tới khi có tin nhắn mới hoặc hết 30s,
// không cần tự ý chờ/sleep thêm giữa các lần gọi.
const POLL_TIMEOUT_SECONDS = 30;

type ResultKind = 'TEAM' | 'GOOGLE';

interface PendingEntry {
  excelPath: string;
  kind: ResultKind;
  registeredAt: number;
}

let pending: PendingEntry[] = [];
let updateOffset = 0;
let started = false;

function loadPending(): void {
  try {
    if (fs.existsSync(PENDING_FILE)) {
      pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8')) as PendingEntry[];
    }
  } catch (err) {
    logger.warn('Không đọc được sổ chờ Telegram cũ, bắt đầu lại từ đầu:', err);
    pending = [];
  }
}

function savePending(): void {
  fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
  fs.writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2));
}

/**
 * Gọi ngay sau khi upload lên meetscript.io thành công (tab TEAM hoặc GOOGLE) — ghi vào "sổ chờ"
 * (lưu trên đĩa, sống sót qua restart) để bộ phận theo dõi Telegram (chạy nền, độc lập hoàn toàn
 * với hàng đợi Chrome) biết cần đợi đúng file kết quả nào.
 */
export function registerExpectedTelegramFile(excelPath: string, kind: ResultKind): void {
  pending.push({ excelPath, kind, registeredAt: Date.now() });
  savePending();
  logger.info(`Đã ghi vào sổ chờ Telegram: đợi kết quả ${kind} cho ${path.basename(excelPath)}.`);
}

function expectedBaseName(entry: PendingEntry): string {
  return path.basename(entry.excelPath, '.xlsx').toLowerCase();
}

// Tên file bot trả về theo đúng quy ước đã xác nhận: "<tên_file_gốc>_TEAM" / "<tên_file_gốc>_GOOGLE".
// So khớp linh hoạt (bắt đầu bằng đúng tiền tố mong đợi) để không phụ thuộc đuôi file bot thêm vào
// là ".xlsx" hay gắn liền ngay sau hậu tố.
function matchesEntry(incomingFileName: string, entry: PendingEntry): boolean {
  const incomingBase = incomingFileName.replace(/\.xlsx$/i, '').toLowerCase();
  const expectedPrefix = `${expectedBaseName(entry)}_${entry.kind.toLowerCase()}`;
  return incomingBase === expectedPrefix || incomingBase.startsWith(expectedPrefix);
}

async function downloadTelegramFile(fileId: string, saveAsName: string): Promise<void> {
  const token = config.telegramBotToken;
  const fileInfoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const fileInfo = (await fileInfoRes.json()) as { ok: boolean; result?: { file_path: string } };
  if (!fileInfo.ok || !fileInfo.result) {
    throw new Error(`Telegram getFile thất bại: ${JSON.stringify(fileInfo)}`);
  }
  const downloadUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.result.file_path}`;
  const fileRes = await fetch(downloadUrl);
  if (!fileRes.ok) {
    throw new Error(`Tải file Telegram thất bại: HTTP ${fileRes.status}`);
  }
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  fs.writeFileSync(path.join(RESULTS_DIR, saveAsName), buffer);
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { username?: string };
    document?: { file_id: string; file_name?: string };
  };
}

// So username không phân biệt hoa/thường, tự bỏ dấu "@" nếu lỡ dán kèm trong .env.
function normalizeUsername(username: string): string {
  return username.replace(/^@/, '').toLowerCase();
}

async function pollOnce(): Promise<void> {
  const token = config.telegramBotToken;
  const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=${POLL_TIMEOUT_SECONDS}&offset=${updateOffset}`;
  const res = await fetch(url);
  const data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[]; description?: string };
  if (!data.ok || !data.result) {
    logger.warn('Telegram getUpdates trả về lỗi:', JSON.stringify(data));
    return;
  }

  for (const update of data.result) {
    updateOffset = update.update_id + 1;
    const message = update.message;
    const doc = message?.document;
    const chatId = message?.chat.id;
    if (!doc?.file_name || String(chatId) !== config.telegramChatId) continue;

    // Group có nhiều người, nhiều tin nhắn — PHẢI kiểm tra đúng người gửi là bot meetscript.io,
    // không chỉ dựa vào tên file khớp (ai gửi đúng tên file trùng ngẫu nhiên cũng sẽ bị nhận nhầm
    // nếu không kiểm tra người gửi). Nếu chưa cấu hình username thì vẫn chạy nhưng không an toàn —
    // đã cảnh báo rõ lúc khởi động.
    if (config.telegramResultBotUsername) {
      const senderUsername = message?.from?.username;
      if (!senderUsername || normalizeUsername(senderUsername) !== normalizeUsername(config.telegramResultBotUsername)) {
        continue;
      }
    }

    const matchIndex = pending.findIndex((entry) => matchesEntry(doc.file_name!, entry));
    if (matchIndex === -1) continue;

    const entry = pending[matchIndex];
    try {
      await downloadTelegramFile(doc.file_id, doc.file_name);
      logger.info(`Đã nhận + tải kết quả Telegram (${entry.kind}) cho ${path.basename(entry.excelPath)}: ${doc.file_name}`);
      pending.splice(matchIndex, 1);
      savePending();
    } catch (err) {
      logger.error(`Lỗi khi tải file Telegram "${doc.file_name}":`, err);
    }
  }
}

function checkTimeouts(): void {
  const now = Date.now();
  const stillPending = pending.filter((entry) => {
    const timedOut = now - entry.registeredAt > MAX_WAIT_MS;
    if (timedOut) {
      logger.warn(
        `Chờ quá ${Math.round(MAX_WAIT_MS / 60_000)} phút mà chưa thấy kết quả ${entry.kind} cho ` +
          `${path.basename(entry.excelPath)} từ Telegram — bỏ qua, cần kiểm tra lại tay.`,
      );
    }
    return !timedOut;
  });
  if (stillPending.length !== pending.length) {
    pending = stillPending;
    savePending();
  }
}

/**
 * Bắt đầu theo dõi group Telegram (chạy nền, vòng lặp vô hạn, tách biệt hoàn toàn với hàng đợi
 * Chrome) — gọi 1 lần lúc server khởi động. Tự bỏ qua (không làm gì) nếu chưa cấu hình đủ
 * TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID trong .env, không ảnh hưởng tới phần còn lại của web UI.
 */
export function startTelegramWatcher(): void {
  if (started) return;
  if (!config.telegramBotToken || !config.telegramChatId) {
    logger.info('Chưa cấu hình TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID — bỏ qua theo dõi kết quả Telegram.');
    return;
  }
  started = true;
  loadPending();
  logger.info(`Bắt đầu theo dõi kết quả Telegram (đang có ${pending.length} mục chờ từ trước, nếu có).`);
  if (config.telegramResultBotUsername) {
    logger.info(`Chỉ nhận file từ đúng người gửi: @${normalizeUsername(config.telegramResultBotUsername)}.`);
  } else {
    logger.warn(
      'CHƯA cấu hình TELEGRAM_RESULT_BOT_USERNAME — sẽ nhận file từ BẤT KỲ AI trong group gửi đúng ' +
        'tên file khớp, không kiểm tra người gửi. Nên đặt biến này sớm để tránh nhận nhầm file.',
    );
  }

  void (async () => {
    for (;;) {
      try {
        await pollOnce();
      } catch (err) {
        logger.error('Lỗi khi hỏi Telegram getUpdates:', err);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
      checkTimeouts();
    }
  })();
}
