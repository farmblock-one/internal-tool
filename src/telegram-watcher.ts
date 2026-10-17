import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

const RESULTS_DIR = path.resolve('data/processed/telegram-results');
const PENDING_FILE = path.resolve('data/processed/telegram-pending.json');
// Sau ngần ấy thời gian hoàn toàn không thấy phản hồi (kể cả sau khi đã cảnh báo quá hạn ở trên),
// coi như chắc chắn không còn tới nữa (vd job upload lỗi, bot không bao giờ trả lời) — bỏ hẳn,
// không theo dõi mãi mãi gây phình to file pending.json vô thời hạn. Cố tình đặt rất rộng rãi
// (24 tiếng) vì việc tiếp tục theo dõi không tốn chi phí gì (chỉ so khớp tên file mỗi lần poll).
const HARD_DROP_MS = 24 * 60 * 60_000;
// Long-poll Telegram getUpdates — nó tự giữ request mở tới khi có tin nhắn mới hoặc hết 30s,
// không cần tự ý chờ/sleep thêm giữa các lần gọi.
const POLL_TIMEOUT_SECONDS = 30;

type ResultKind = 'TEAM' | 'GOOGLE';

interface PendingEntry {
  excelPath: string;
  kind: ResultKind;
  registeredAt: number;
  // Có giá trị khi đã cảnh báo quá hạn chờ (xem `config.telegramResultWarnAfterMinutes`) — CHƯA bỏ
  // theo dõi, vẫn tự động lưu nếu bot trả kết quả muộn hơn dự kiến, chỉ để hiển thị cảnh báo lên
  // web UI (xem `getTelegramWatchStatus`) và tránh log lặp lại cảnh báo mỗi lần poll (~30s/lần).
  warnedAt?: number;
}

export interface TelegramWatchStatus {
  pending: PendingEntry[];
  overdue: PendingEntry[];
}

/** Dùng cho trang web UI — hiện số file đang chờ + danh sách file đã quá hạn cảnh báo. */
export function getTelegramWatchStatus(): TelegramWatchStatus {
  return { pending, overdue: pending.filter((entry) => entry.warnedAt !== undefined) };
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
 * Đọc lại file sổ chờ từ đĩa, gộp thêm các mục MỚI chưa có trong bộ nhớ — cần thiết vì
 * `registerExpectedTelegramFile` có thể được gọi từ 1 TIẾN TRÌNH NODE KHÁC hoàn toàn với tiến
 * trình đang chạy vòng lặp theo dõi này (vd chạy tay `npm run risky` trong lúc `npm run web` đã
 * đang chạy sẵn) — 2 tiến trình không chia sẻ bộ nhớ, chỉ chia sẻ được qua file trên đĩa. Gọi định
 * kỳ (mỗi vòng lặp poll, ~30s/lần) để không bỏ lỡ các mục được ghi từ tiến trình khác.
 */
function mergePendingFromDisk(): void {
  try {
    if (!fs.existsSync(PENDING_FILE)) return;
    const onDisk = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8')) as PendingEntry[];
    const existingKeys = new Set(pending.map((e) => `${e.excelPath}|${e.kind}`));
    let addedAny = false;
    for (const entry of onDisk) {
      const key = `${entry.excelPath}|${entry.kind}`;
      if (!existingKeys.has(key)) {
        pending.push(entry);
        existingKeys.add(key);
        addedAny = true;
        logger.info(
          `Phát hiện mục chờ Telegram mới (ghi từ tiến trình khác): đợi kết quả ${entry.kind} cho ${path.basename(entry.excelPath)}.`,
        );
      }
    }
    if (addedAny) savePending();
  } catch (err) {
    logger.warn('Không đọc lại được sổ chờ Telegram từ đĩa (bỏ qua, giữ nguyên danh sách hiện có):', err);
  }
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
  const warnAfterMs = config.telegramResultWarnAfterMinutes * 60_000;
  let changed = false;

  const stillPending = pending.filter((entry) => {
    if (now - entry.registeredAt > HARD_DROP_MS) {
      // Chờ quá lâu (24 tiếng) mà vẫn không có phản hồi — gần như chắc chắn sẽ không bao giờ tới
      // nữa (vd job upload bị lỗi phía meetscript.io). Bỏ hẳn, không theo dõi tiếp.
      logger.error(
        `Chờ quá ${Math.round(HARD_DROP_MS / 3_600_000)} tiếng mà KHÔNG thấy kết quả ${entry.kind} cho ` +
          `${path.basename(entry.excelPath)} từ Telegram — BỎ HẲN, không theo dõi tiếp. Cần kiểm tra lại tay ` +
          `(có thể job upload bị lỗi, hoặc file đã được bot gửi nhưng sai tên không khớp được).`,
      );
      changed = true;
      return false;
    }
    if (entry.warnedAt === undefined && now - entry.registeredAt > warnAfterMs) {
      // CHỈ cảnh báo, KHÔNG bỏ theo dõi — nếu bot trả kết quả muộn hơn dự kiến (vd xử lý nhiều
      // file song song khiến backend meetscript.io chậm hơn bình thường), vẫn tự động nhận được
      // bình thường. Đánh dấu `warnedAt` để không lặp lại cảnh báo này mỗi lần poll (~30s/lần).
      logger.warn(
        `Chờ quá ${config.telegramResultWarnAfterMinutes} phút mà chưa thấy kết quả ${entry.kind} cho ` +
          `${path.basename(entry.excelPath)} từ Telegram — VẪN TIẾP TỤC chờ (xem cảnh báo trên web UI), ` +
          `chưa bỏ theo dõi.`,
      );
      entry.warnedAt = now;
      changed = true;
    }
    return true;
  });

  if (changed) {
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
      mergePendingFromDisk();
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
