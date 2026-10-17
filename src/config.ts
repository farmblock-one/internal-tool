import 'dotenv/config';

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Thiếu biến môi trường ${name} trong file .env`);
  return value;
}

export const config = {
  chromeUserDataDir: process.env.CHROME_USER_DATA_DIR ?? './.chrome-profile',
  // Profile Chrome RIÊNG cho Teams/Gmail/meetscript.io — tách khỏi profile Apollo ở trên để 2 hàng
  // đợi (Apollo/Debounce và Risky) chạy được ĐỒNG THỜI, không tranh nhau khoá 1 profile (2 Chrome
  // cùng mở 1 user-data-dir sẽ crash lẫn nhau). Phải đăng nhập riêng profile này bằng `npm run
  // risky:login` trước khi dùng lần đầu — cookie không dùng chung với profile Apollo.
  riskyChromeUserDataDir: process.env.RISKY_CHROME_USER_DATA_DIR ?? './.chrome-profile-risky',
  // Số tab/task xử lý song song tối đa khi upload các phần (chunk) lên meetscript.io — meetscript.io/
  // Teams/Gmail không giới hạn số request đồng thời từ cùng 1 tài khoản (đã xác nhận), nên chạy song
  // song giúp rút ngắn đáng kể thời gian xử lý list lớn (25-30K lead = 25-30 chunk/50-60 lượt upload).
  riskyConcurrency: Number(process.env.RISKY_CONCURRENCY ?? '5'),
  headless: process.env.HEADLESS === 'true',
  get debounceApiKey(): string {
    return required('DEBOUNCE_API_KEY', process.env.DEBOUNCE_API_KEY);
  },
  googleServiceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY ?? './service-account.json',
  get gdriveSafeToSendFolderId(): string {
    return required('GDRIVE_SAFE_TO_SEND_FOLDER_ID', process.env.GDRIVE_SAFE_TO_SEND_FOLDER_ID);
  },
  // IP/domain công khai của server này — dùng để tạo URL host tạm file CSV cho Debounce tải về.
  get publicHost(): string {
    return required('PUBLIC_HOST', process.env.PUBLIC_HOST);
  },
  fileServePort: Number(process.env.FILE_SERVE_PORT ?? '8443'),
  // Mật khẩu dùng chung cho web UI (npm run web) — VM có IP công khai nên LUÔN nên đặt, nếu để
  // trống thì web UI sẽ không yêu cầu đăng nhập (chỉ hợp lý nếu firewall đã tự giới hạn truy cập).
  webuiPassword: process.env.WEBUI_PASSWORD ?? '',
  webuiPort: Number(process.env.WEBUI_PORT ?? '8090'),
  // Mặc định CHỈ lắng nghe trên localhost — đứng sau 1 reverse proxy (Caddy) lo phần HTTPS thật +
  // là cổng public duy nhất, Node không cần (và không nên) lộ trực tiếp ra ngoài Internet nữa.
  webuiHost: process.env.WEBUI_HOST ?? '127.0.0.1',
  // Để trống 1 trong 2 giá trị này -> bộ phận theo dõi kết quả Telegram tự tắt (không bắt buộc
  // phải có để web UI còn lại hoạt động bình thường).
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
  // Username (không cần dấu "@") của bot meetscript.io trong group — dùng để kiểm tra ĐÚNG người
  // gửi, không chỉ dựa vào tên file khớp (group có nhiều người, cần tránh nhận nhầm file của ai
  // đó gửi trùng tên). Để trống vẫn chạy được nhưng KHÔNG an toàn — xem cảnh báo lúc khởi động.
  telegramResultBotUsername: process.env.TELEGRAM_RESULT_BOT_USERNAME ?? '',
};
