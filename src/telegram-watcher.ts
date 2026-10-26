import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { NewMessage, type NewMessageEvent } from 'teleproto/events';
import { config } from './config.js';
import { logger } from './logger.js';
import { mergeRiskyResultsIntoMaster, type MergeFileRef } from './risky-merge.js';
import { uploadFinalXlsxToDrive } from './drive.js';

// ⚠️ Đã xác nhận thực tế trên VM: fetch tới api.telegram.org thỉnh thoảng thất bại ngay lúc MỞ
// KẾT NỐI (AggregateError ETIMEDOUT từ node:net internalConnectMultiple) — Node mặc định thử
// song song cả IPv4 lẫn IPv6 ("Happy Eyeballs"), và đường IPv6 trên VM này có vẻ không ổn định/bị
// treo, kéo cả lượt thử thất bại dù IPv4 vẫn dùng được bình thường (curl mặc định ưu tiên IPv4
// nên không gặp vấn đề này). Ép toàn bộ tiến trình ưu tiên IPv4 trước để tránh phải chờ/phụ thuộc
// vào đường IPv6 có vấn đề — áp dụng cho MỌI kết nối mạng ra ngoài của tiến trình, không chỉ
// Telegram, nên đặt ở đây (module luôn được nạp sớm, dùng chung bởi server.ts/merge-risky.ts/...).
dns.setDefaultResultOrder('ipv4first');

const RESULTS_DIR = path.resolve('data/processed/telegram-results');
const PENDING_FILE = path.resolve('data/processed/telegram-pending.json');
// Sau ngần ấy thời gian hoàn toàn không thấy phản hồi (kể cả sau khi đã cảnh báo quá hạn ở trên),
// coi như chắc chắn không còn tới nữa (vd job upload lỗi, bot không bao giờ trả lời) — bỏ hẳn,
// không theo dõi mãi mãi gây phình to file pending.json vô thời hạn. Cố tình đặt rất rộng rãi
// (24 tiếng) vì việc tiếp tục theo dõi không tốn chi phí gì (chỉ so khớp tên file mỗi lần poll).
const HARD_DROP_MS = 24 * 60 * 60_000;
// Đọc lại sổ chờ từ đĩa + kiểm tra quá hạn định kỳ — KHÔNG liên quan gì tới mạng (chỉ đọc file
// local), chạy độc lập bằng setInterval riêng, không liên quan tới client MTProto bên dưới.
const LOCAL_MAINTENANCE_INTERVAL_MS = 60_000;

type ResultKind = 'TEAM' | 'GOOGLE';

interface PendingEntry {
  excelPath: string;
  kind: ResultKind;
  registeredAt: number;
  // Có giá trị khi đã cảnh báo quá hạn chờ (xem `config.telegramResultWarnAfterMinutes`) — CHƯA bỏ
  // theo dõi, vẫn tự động lưu nếu bot trả kết quả muộn hơn dự kiến, chỉ để hiển thị cảnh báo lên
  // web UI (xem `getTelegramWatchStatus`) và tránh log lặp lại cảnh báo mỗi lần poll (~30s/lần).
  warnedAt?: number;
  // ID của RiskyJob (server.ts) sinh ra mục chờ này — dùng để hiện "đã nhận X/Y kết quả" ngay
  // trên trang trạng thái của ĐÚNG job đó (xem `getJobTelegramStatus`). Không có khi gọi từ CLI
  // (`npm run risky`), lúc đó không có job nào trên web UI để gắn tiến trình vào.
  jobId?: string;
}

interface ReceivedEntry {
  kind: ResultKind;
  fileName: string;
  receivedAt: number;
}

type MergeStatus = 'pending' | 'done' | 'error';

interface JobMeta {
  masterXlsxPath: string;
  totalExpected: number;
  mergeStatus: MergeStatus;
  mergeError?: string;
}

export interface TelegramWatchStatus {
  pending: PendingEntry[];
  overdue: PendingEntry[];
}

export interface JobTelegramStatus {
  pendingCount: number;
  received: ReceivedEntry[];
  mergeStatus?: MergeStatus;
  mergeError?: string;
}

/** Dùng cho trang web UI — hiện số file đang chờ + danh sách file đã quá hạn cảnh báo. */
export function getTelegramWatchStatus(): TelegramWatchStatus {
  return { pending, overdue: pending.filter((entry) => entry.warnedAt !== undefined) };
}

/**
 * Dùng cho trang trạng thái của 1 RiskyJob cụ thể (xem `renderRiskyJob` trong server.ts) — biết
 * được đã nhận bao nhiêu/kết quả nào rồi, còn bao nhiêu đang chờ, CHỈ TÍNH riêng cho job này.
 */
export function getJobTelegramStatus(jobId: string): JobTelegramStatus {
  const meta = jobMeta.get(jobId);
  return {
    pendingCount: pending.filter((e) => e.jobId === jobId).length,
    received: receivedByJob.get(jobId) ?? [],
    mergeStatus: meta?.mergeStatus,
    mergeError: meta?.mergeError,
  };
}

/**
 * Gọi 1 LẦN DUY NHẤT ngay khi bắt đầu xử lý 1 job Risky (risky-pipeline.ts, trước khi upload) —
 * cho biết job này cần đợi tổng cộng bao nhiêu kết quả (2 × số phần đã tách: Team + Google) và
 * file Excel gốc nào cần cập nhật lại cột RESULT khi đã nhận đủ. Không gọi (jobId rỗng, vd chạy
 * qua CLI `npm run risky`) thì vẫn tải kết quả về bình thường, chỉ là KHÔNG tự động ghép ngược lại
 * file Excel gốc — team phải tự ghép tay.
 */
export function registerRiskyJobMeta(jobId: string, masterXlsxPath: string, totalExpected: number): void {
  jobMeta.set(jobId, { masterXlsxPath, totalExpected, mergeStatus: 'pending' });
  saveJobsState();
}

let onMergeCompleteHandler: ((masterXlsxPath: string) => void) | undefined;

/**
 * Đăng ký 1 callback gọi mỗi khi vừa ghép xong kết quả Risky vào 1 file Excel gốc (dù thành công
 * hay không bước gửi lại Telegram/Drive — 2 việc đó độc lập). Dùng ở server.ts để tự xếp job
 * import ngược lại Apollo vào hàng đợi dùng chung Chrome profile Apollo — KHÔNG gọi thẳng việc mở
 * Chrome ở module này, vì module này không biết (và không nên biết) gì về hàng đợi/Chrome.
 */
export function setOnMergeComplete(handler: (masterXlsxPath: string) => void): void {
  onMergeCompleteHandler = handler;
}

let pending: PendingEntry[] = [];
// Tiến trình nhận kết quả của từng job Risky (đã nhận file nào, cần ghép vào file Excel nào). Lưu
// xuống đĩa vì lịch sử job giờ được giữ qua các lần restart (xem server.ts) — nếu chỉ nằm trong bộ
// nhớ thì restart giữa lúc đang chờ bot trả kết quả sẽ làm mất thông tin này, file về sau sẽ được
// tải nhưng KHÔNG bao giờ được ghép vào file Excel gốc.
const receivedByJob = new Map<string, ReceivedEntry[]>();
const jobMeta = new Map<string, JobMeta>();
const JOBS_STATE_FILE = path.resolve('data/processed/telegram-jobs.json');
let started = false;

function saveJobsState(): void {
  try {
    fs.mkdirSync(path.dirname(JOBS_STATE_FILE), { recursive: true });
    const data = {
      jobMeta: Object.fromEntries(jobMeta),
      receivedByJob: Object.fromEntries(receivedByJob),
    };
    const tmp = `${JOBS_STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, JOBS_STATE_FILE);
  } catch (err) {
    logger.warn(`Không lưu được tiến trình Telegram: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function loadJobsState(): void {
  if (!fs.existsSync(JOBS_STATE_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(JOBS_STATE_FILE, 'utf-8')) as {
      jobMeta?: Record<string, JobMeta>;
      receivedByJob?: Record<string, ReceivedEntry[]>;
    };
    for (const [id, meta] of Object.entries(data.jobMeta ?? {})) jobMeta.set(id, meta);
    for (const [id, list] of Object.entries(data.receivedByJob ?? {})) receivedByJob.set(id, list);
    logger.info(`Đã nạp tiến trình Telegram của ${jobMeta.size} job Risky từ đĩa.`);
  } catch (err) {
    logger.warn(`Không đọc được tiến trình Telegram (${JOBS_STATE_FILE}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

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
 * Bỏ theo dõi THỦ CÔNG 1 mục đang chờ — dùng khi team đã tự tải file kết quả tay trong group
 * Telegram (vd file đó đến TRƯỚC KHI job được đăng ký theo dõi, nên tool không tự bắt được — xem
 * giải thích "Telegram chỉ trả về tin nhắn mới" ở các lần trước), không muốn banner cảnh báo "chờ
 * quá lâu" cứ hiện mãi trên trang chủ. Trả về `true` nếu tìm thấy và đã bỏ, `false` nếu không còn
 * trong danh sách chờ nữa (vd vừa được tool tự nhận được đúng lúc).
 */
export function dismissPendingEntry(excelPath: string, kind: ResultKind): boolean {
  const idx = pending.findIndex((e) => e.excelPath === excelPath && e.kind === kind);
  if (idx === -1) return false;
  pending.splice(idx, 1);
  savePending();
  logger.info(`Đã bỏ theo dõi thủ công (team tự xác nhận đã có file): ${kind} cho ${path.basename(excelPath)}.`);
  return true;
}

/**
 * Gọi ngay sau khi upload lên meetscript.io thành công (tab TEAM hoặc GOOGLE) — ghi vào "sổ chờ"
 * (lưu trên đĩa, sống sót qua restart) để bộ phận theo dõi Telegram (chạy nền, độc lập hoàn toàn
 * với hàng đợi Chrome) biết cần đợi đúng file kết quả nào.
 */
export function registerExpectedTelegramFile(excelPath: string, kind: ResultKind, jobId?: string): void {
  pending.push({ excelPath, kind, registeredAt: Date.now(), jobId });
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

/**
 * Request HTTP tới Telegram có giới hạn thời gian chờ rõ ràng — không đặt giới hạn, 1 kết nối bị
 * "treo" giữa chừng (vd bị 1 thiết bị mạng trung gian âm thầm cắt, đã xác nhận thực tế xảy ra với
 * request long-poll giữ kết nối mở lâu) có thể khiến `fetch` của Node chờ RẤT LÂU (nhiều phút, tuỳ
 * timeout TCP mặc định của hệ điều hành) mới chịu báo lỗi — trong lúc đó tool "mù" hoàn toàn,
 * không nghe được tin nhắn mới nào. Giới hạn ngắn hơn giúp báo lỗi nhanh, thử lại sớm hơn nhiều.
 */
function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

// So username không phân biệt hoa/thường, tự bỏ dấu "@" nếu lỡ dán kèm trong .env.
function normalizeUsername(username: string): string {
  return username.replace(/^@/, '').toLowerCase();
}

let userClient: TelegramClient | undefined;

/**
 * Xử lý ĐÚNG 1 tin nhắn mới trong group — dùng tài khoản người thật (MTProto, xem `startUserClient`
 * bên dưới) để nghe, vì Bot API KHÔNG BAO GIỜ gửi update cho bot của mình về tin nhắn do MỘT BOT
 * KHÁC gửi (giới hạn cố định của Telegram, không liên quan webhook/polling/mạng — xem giải thích
 * ở `config.ts`). Tài khoản người thật thấy được tin nhắn của MỌI bot trong group bình thường.
 */
async function handleIncomingMessage(event: NewMessageEvent): Promise<void> {
  await handleMessage(event.message, event.chatId?.toString());
}

async function handleMessage(message: Api.Message, chatId: string | undefined): Promise<void> {
  const fileName = message.file?.name;
  if (!fileName) return; // không phải tin nhắn có đính kèm file — bỏ qua, không cần log

  if (chatId !== config.telegramChatId) return; // group khác (tài khoản này có thể ở nhiều group) — bỏ qua, không log

  // Group có nhiều người, nhiều tin nhắn — PHẢI kiểm tra đúng người gửi là bot meetscript.io,
  // không chỉ dựa vào tên file khớp (ai gửi đúng tên file trùng ngẫu nhiên cũng sẽ bị nhận nhầm
  // nếu không kiểm tra người gửi). Nếu chưa cấu hình username thì vẫn chạy nhưng không an toàn —
  // đã cảnh báo rõ lúc khởi động.
  if (config.telegramResultBotUsername) {
    const sender = await message.getSender().catch(() => undefined);
    const senderUsername = sender && 'username' in sender ? (sender.username ?? undefined) : undefined;
    if (!senderUsername || normalizeUsername(senderUsername) !== normalizeUsername(config.telegramResultBotUsername)) {
      logger.info(
        `Bỏ qua file "${fileName}" — người gửi @${senderUsername ?? '(không có username)'}, khác TELEGRAM_RESULT_BOT_USERNAME đang cấu hình (@${normalizeUsername(config.telegramResultBotUsername)}).`,
      );
      return;
    }
  }

  const matchIndex = pending.findIndex((entry) => matchesEntry(fileName, entry));
  if (matchIndex === -1) {
    logger.info(
      `File "${fileName}" đúng group/đúng người gửi nhưng KHÔNG khớp tên với bất kỳ mục nào đang chờ ` +
        `(hiện có ${pending.length} mục chờ: ${pending.map((e) => `${path.basename(e.excelPath)}[${e.kind}]`).join(', ') || '(trống)'}).`,
    );
    return;
  }

  const entry = pending[matchIndex];
  try {
    const buffer = await userClient!.downloadMedia(message);
    if (!buffer || typeof buffer === 'string') {
      throw new Error('Không tải được nội dung file (downloadMedia không trả về dữ liệu).');
    }
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(RESULTS_DIR, fileName), buffer);
    logger.info(`Đã nhận + tải kết quả Telegram (${entry.kind}) cho ${path.basename(entry.excelPath)}: ${fileName}`);
    if (entry.jobId) {
      const list = receivedByJob.get(entry.jobId) ?? [];
      list.push({ kind: entry.kind, fileName, receivedAt: Date.now() });
      receivedByJob.set(entry.jobId, list);
      saveJobsState();
      await maybeMergeJob(entry.jobId);
    }
    pending.splice(matchIndex, 1);
    savePending();
  } catch (err) {
    logger.error(`Lỗi khi tải file Telegram "${fileName}":`, err);
  }
}

/**
 * Kết nối tài khoản người thật (MTProto) đã đăng nhập sẵn (`npm run telegram:login`) và bắt đầu
 * nghe mọi tin nhắn mới — lọc lại đúng group/người gửi/tên file khớp ngay trong
 * `handleIncomingMessage`. Gọi 1 lần lúc khởi động; tự kết nối lại khi mất kết nối nhờ
 * `connectionRetries` (xem tham số khởi tạo `TelegramClient`).
 */
async function startUserClient(): Promise<void> {
  userClient = new TelegramClient(new StringSession(config.telegramUserSession), config.telegramApiId, config.telegramApiHash, {
    connectionRetries: 5,
  });
  await userClient.connect();
  logger.info(
    'Đã kết nối tài khoản Telegram (người thật) để theo dõi group — thấy được tin nhắn của MỌI bot trong group, kể cả bot meetscript.io.',
  );
  userClient.addEventHandler((event: NewMessageEvent) => {
    void handleIncomingMessage(event).catch((err) => logger.error('Lỗi khi xử lý tin nhắn Telegram mới:', err));
  }, new NewMessage({}));
  await catchUpMissedMessages();
}

// Số tin nhắn gần nhất trong group được quét lại lúc khởi động.
const CATCH_UP_MESSAGE_LIMIT = 300;

/**
 * Tool chỉ "nghe" tin nhắn MỚI trong lúc đang chạy — file bot gửi đúng lúc service đang tắt/restart
 * sẽ bị lỡ mất. Lúc khởi động, quét lại các tin nhắn gần nhất trong group và xử lý như tin mới
 * (chỉ những file khớp mục đang chờ mới được nhận, nên quét lại không bị nhận trùng).
 */
async function catchUpMissedMessages(): Promise<void> {
  if (!userClient || pending.length === 0) return;
  try {
    const dialogs = await userClient.getDialogs({ limit: 200 });
    const dialog = dialogs.find((d) => d.id?.toString() === config.telegramChatId);
    if (!dialog?.entity) {
      logger.warn(`Không tìm thấy group TELEGRAM_CHAT_ID=${config.telegramChatId} trong danh sách chat — bỏ qua bước quét lại tin nhắn cũ.`);
      return;
    }
    const oldestWaiting = Math.min(...pending.map((e) => e.registeredAt));
    const messages = await userClient.getMessages(dialog.entity, { limit: CATCH_UP_MESSAGE_LIMIT });
    const candidates = messages
      .filter((m) => m.file?.name && m.date * 1000 >= oldestWaiting - 5 * 60_000)
      .sort((a, b) => a.date - b.date);
    logger.info(`Quét lại ${messages.length} tin nhắn gần nhất trong group: ${candidates.length} file gửi sau lúc bắt đầu chờ.`);
    for (const message of candidates) {
      await handleMessage(message, config.telegramChatId);
    }
  } catch (err) {
    logger.error('Lỗi khi quét lại tin nhắn cũ trong group Telegram (vẫn tiếp tục nghe tin nhắn mới):', err);
  }
}

/**
 * Gửi 1 file lên ĐÚNG group Telegram đang theo dõi (cùng chat, cùng bot token dùng để nghe tin
 * nhắn) — dùng sendDocument của Telegram Bot API. Bot cần đã có sẵn trong group đó (chính là bot
 * đang dùng để nghe kết quả meetscript.io) và có quyền gửi tin nhắn/file bình thường trong group.
 * Export để `merge-risky.ts` (lệnh ghép TAY) cũng gửi lại được, nhất quán với luồng tự động.
 */
export async function sendDocumentToTelegram(filePath: string, caption: string): Promise<void> {
  const token = config.telegramBotToken;
  const form = new FormData();
  form.append('chat_id', config.telegramChatId);
  form.append('caption', caption);
  form.append('document', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  const res = await fetchWithTimeout(`https://api.telegram.org/bot${token}/sendDocument`, 45_000, { method: 'POST', body: form });
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!data.ok) {
    throw new Error(`Telegram sendDocument thất bại: ${JSON.stringify(data)}`);
  }
}

/**
 * Khi đã nhận ĐỦ số kết quả mong đợi (2 × số phần đã tách) cho 1 job — tự động ghép ngược lại
 * vào file Excel gốc (xem `mergeRiskyResultsIntoMaster`). Chỉ chạy đúng 1 lần cho mỗi job
 * (`mergeStatus` đổi từ 'pending' ngay khi bắt đầu chạy, dù thành công hay lỗi).
 */
async function maybeMergeJob(jobId: string): Promise<void> {
  const meta = jobMeta.get(jobId);
  if (!meta || meta.mergeStatus !== 'pending') return;
  const received = receivedByJob.get(jobId) ?? [];
  if (received.length < meta.totalExpected) return;

  const resultFiles: MergeFileRef[] = received.map((r) => ({ kind: r.kind, filePath: path.join(RESULTS_DIR, r.fileName) }));
  try {
    const stats = mergeRiskyResultsIntoMaster(meta.masterXlsxPath, resultFiles);
    meta.mergeStatus = 'done';

    // Gửi luôn file Excel gốc ĐÃ CẬP NHẬT ngược lại group Telegram — team không cần tự vào web UI
    // tìm/tải, kết quả cuối cùng xuất hiện ngay tại nơi team vẫn theo dõi kết quả meetscript.io.
    try {
      await sendDocumentToTelegram(
        meta.masterXlsxPath,
        `✅ Đã cập nhật kết quả Risky: ${stats.updatedCount} lead (Safe to Send/Do not Send)` +
          (stats.noMatchCount > 0 ? `, ${stats.noMatchCount} lead chưa khớp được kết quả (vẫn giữ "Risky", cần kiểm tra tay)` : '') +
          '.',
      );
      logger.info(`Đã gửi file Excel gốc (đã cập nhật) vào group Telegram: ${meta.masterXlsxPath}`);
    } catch (sendErr) {
      logger.error(`Ghép file thành công nhưng gửi lại vào Telegram thất bại (tải tay từ web UI thay thế):`, sendErr);
    }

    // Upload luôn file Excel cuối (đã có đủ Safe to Send/Do not Send) lên Google Drive — tự bỏ qua
    // nếu chưa cấu hình GDRIVE_SAFE_TO_SEND_FOLDER_ID, không ảnh hưởng gì tới phần còn lại.
    try {
      await uploadFinalXlsxToDrive(meta.masterXlsxPath);
    } catch (driveErr) {
      logger.error(`Ghép file thành công nhưng upload lên Google Drive thất bại (tải tay từ web UI thay thế):`, driveErr);
    }

    // Báo cho server.ts (nếu có đăng ký, xem `setOnMergeComplete`) để xếp job import ngược lại
    // Apollo vào CHUNG hàng đợi với job Apollo export — bắt buộc phải qua hàng đợi vì 2 việc này
    // dùng CHUNG 1 profile Chrome Apollo, chạy chồng lên nhau sẽ tranh khoá/crash nhau.
    onMergeCompleteHandler?.(meta.masterXlsxPath);
  } catch (err) {
    meta.mergeStatus = 'error';
    meta.mergeError = err instanceof Error ? err.message : String(err);
    logger.error(`Lỗi khi ghép kết quả Risky vào file Excel gốc (job ${jobId}):`, err);
  } finally {
    saveJobsState();
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
 * Bắt đầu theo dõi group Telegram — dùng tài khoản người thật (MTProto, xem `startUserClient`) để
 * nghe tin nhắn, vì Bot API không bao giờ thấy được tin nhắn của bot meetscript.io (xem giải thích
 * ở `config.ts`). Gọi 1 lần lúc server khởi động. Tự bỏ qua (không làm gì) nếu chưa cấu hình đủ
 * TELEGRAM_API_ID/TELEGRAM_API_HASH/TELEGRAM_USER_SESSION/TELEGRAM_CHAT_ID trong .env — không ảnh
 * hưởng tới phần còn lại của web UI.
 */
export function startTelegramWatcher(): void {
  if (started) return;
  if (!config.telegramChatId) {
    logger.info('Chưa cấu hình TELEGRAM_CHAT_ID — bỏ qua theo dõi kết quả Telegram.');
    return;
  }
  if (!config.telegramApiId || !config.telegramApiHash || !config.telegramUserSession) {
    logger.warn(
      'Chưa cấu hình đủ TELEGRAM_API_ID/TELEGRAM_API_HASH/TELEGRAM_USER_SESSION — bỏ qua theo dõi kết quả ' +
        'Telegram. Cần chạy `npm run telegram:login` 1 lần để đăng nhập (nhập SĐT + mã OTP) và lấy ' +
        'TELEGRAM_USER_SESSION dán vào .env — xem hướng dẫn chi tiết trong .env.example.',
    );
    return;
  }
  started = true;
  loadPending();
  loadJobsState();
  logger.info(`Bắt đầu theo dõi kết quả Telegram (đang có ${pending.length} mục chờ từ trước, nếu có).`);
  if (config.telegramResultBotUsername) {
    logger.info(`Chỉ nhận file từ đúng người gửi: @${normalizeUsername(config.telegramResultBotUsername)}.`);
  } else {
    logger.warn(
      'CHƯA cấu hình TELEGRAM_RESULT_BOT_USERNAME — sẽ nhận file từ BẤT KỲ AI trong group gửi đúng ' +
        'tên file khớp, không kiểm tra người gửi. Nên đặt biến này sớm để tránh nhận nhầm file.',
    );
  }

  void startUserClient().catch((err) => {
    logger.error(
      'Lỗi khi kết nối tài khoản Telegram (MTProto) — bộ phận theo dõi kết quả Telegram sẽ KHÔNG hoạt động cho tới khi restart lại thành công. Có thể TELEGRAM_USER_SESSION đã hết hạn/sai, cần chạy lại `npm run telegram:login`.',
      err,
    );
  });

  // Việc dọn dẹp cục bộ (đọc lại sổ chờ từ đĩa + kiểm tra quá hạn) chạy định kỳ riêng, độc lập với
  // kết nối MTProto ở trên — KHÔNG gọi mạng gì cả.
  setInterval(() => {
    mergePendingFromDisk();
    checkTimeouts();
  }, LOCAL_MAINTENANCE_INTERVAL_MS);
}
